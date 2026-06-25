# Design Document

## Overview

This design implements an event-driven Lambda function that automatically creates AWS Billing Conductor billing groups when billing transfer relationships are accepted. The system uses Amazon EventBridge to listen for ResponsibilityTransferAccepted and ResponsibilityTransferTerminated events from AWS Organizations (delivered via CloudTrail), and immediately creates corresponding billing groups using the AWS managed BasicPricingPlan.

The architecture follows AWS best practices for serverless event-driven systems, including:
- Idempotency to handle duplicate event delivery
- Comprehensive error handling with retries and dead letter queues
- Structured logging for observability
- X-Ray tracing for distributed debugging
- Least-privilege IAM permissions

## Architecture

### High-Level Architecture

```
┌─────────────────┐
│ AWS             │
│ Organizations   │
│ (Billing        │
│ Transfer Events)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   CloudTrail    │
│  (Captures API  │
│     Events)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  EventBridge    │
│     Rule        │
│  (Event Filter) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐       ┌──────────────┐
│     Lambda      │──────▶│ CloudWatch   │
│    Function     │       │    Logs      │
│  (Event Handler)│       └──────────────┘
└────────┬────────┘
         │                ┌──────────────┐
         ├───────────────▶│   X-Ray      │
         │                └──────────────┘
         │
         │                ┌──────────────┐
         ├───────────────▶│     DLQ      │
         │                │   (SQS)      │
         │                └──────────────┘
         │
         ▼
┌─────────────────┐
│ AWS Billing     │
│   Conductor     │
│ (Create Billing │
│     Groups)     │
└─────────────────┘
```

### Component Interaction Flow

1. **Event Capture**: AWS Organizations emits billing transfer events (ResponsibilityTransferAccepted/Terminated)
2. **Event Delivery**: CloudTrail captures these events and delivers them to EventBridge as AWS Service Events
3. **Event Filtering**: EventBridge Rule filters for specific event patterns and invokes Lambda
4. **Event Processing**: Lambda function processes the event:
   - Validates event structure and source
   - Routes based on event name (ResponsibilityTransferAccepted or ResponsibilityTransferTerminated)
   - For Accepted events:
     - Extracts Bill-Source Account ID from source.managementAccountId
     - Extracts ResponsibilityTransferArn from arn field
     - Checks for existing billing group (idempotency)
     - Retrieves BasicPricingPlan ARN
     - Creates billing group if needed using ResponsibilityTransferArn
   - For Terminated events:
     - Logs the termination event with status (DECLINED, WITHDRAWN, EXPIRED, or CANCELED)
     - Returns success (no billing group deletion - groups remain for historical billing data)
5. **Error Handling**: Failed invocations are retried by EventBridge, then sent to DLQ
6. **Observability**: All operations logged to CloudWatch Logs with X-Ray tracing

## Components and Interfaces

### 1. EventBridge Rule

**Purpose**: Filter and route billing transfer events to Lambda function

**Configuration**:
- **Event Pattern**:
  ```json
  {
    "source": ["aws.organizations"],
    "detail-type": ["AWS Service Event via CloudTrail"],
    "detail": {
      "eventSource": ["organizations.amazonaws.com"],
      "eventType": ["AwsServiceEvent"],
      "eventName": [
        "ResponsibilityTransferAccepted",
        "ResponsibilityTransferTerminated"
      ]
    }
  }
  ```
- **Target**: Lambda function
- **Retry Policy**: 2 retry attempts with exponential backoff
- **Maximum Event Age**: 2 hours

**Event Handling Strategy**:
- **ResponsibilityTransferAccepted**: Creates billing group for the new transfer relationship
- **ResponsibilityTransferTerminated**: Logs the termination event but does NOT delete billing groups (groups are retained for historical billing data and audit purposes)

**Interface**:
- Input: CloudTrail service events from AWS Organizations
- Output: Invokes Lambda function with event payload

### 2. Lambda Function

**Purpose**: Process billing transfer events and create billing groups

**Configuration**:
- **Runtime**: Node.js 22.x
- **Memory**: 256 MB
- **Timeout**: 2 minutes (120 seconds)
- **Tracing**: X-Ray ACTIVE mode
- **Dead Letter Queue**: SQS queue with 14-day retention
- **Environment Variables**:
  - `LOG_LEVEL`: INFO (configurable)
  - `AWS_NODEJS_CONNECTION_REUSE_ENABLED`: 1 (for SDK connection pooling)

**Handler Interface**:
```typescript
interface EventBridgeEvent {
  version: string;
  id: string;
  'detail-type': 'AWS Service Event via CloudTrail';
  source: 'aws.organizations';
  account: string;
  time: string;
  region: string;
  detail: BillingTransferEventDetail;
}

interface BillingTransferEventDetail {
  eventVersion: string;
  eventTime: string;
  eventName: 'ResponsibilityTransferAccepted' | 'ResponsibilityTransferTerminated';
  eventSource: 'organizations.amazonaws.com';
  eventType: 'AwsServiceEvent';
  serviceEventDetails: {
    id: string;
    arn: string;                   // Transfer ARN - REQUIRED for CreateBillingGroup
    transferChain: string[];
    type: 'BILLING';
    status: 'ACCEPTED' | 'WITHDRAWN' | 'DECLINED' | 'EXPIRED' | 'CANCELED';
    source: {
      managementAccountId: string; // Bill-Source Account
    };
    target: {
      managementAccountId: string; // Bill-Transfer Account
    };
    requester: string;
    startTimestamp: number;
    endTimestamp?: number;         // Present for terminated transfers
  };
}

interface LambdaResponse {
  statusCode: number;
  body: {
    message: string;
    billingGroupArn?: string;
    accountId: string;
    action: 'created' | 'exists' | 'skipped' | 'terminated';
    eventName: 'ResponsibilityTransferAccepted' | 'ResponsibilityTransferTerminated';
  };
}
```

### 3. Billing Conductor Service

**Purpose**: Encapsulate AWS Billing Conductor API operations

**Interface**:
```typescript
class BillingConductorService {
  /**
   * Get the ARN of the AWS managed BasicPricingPlan
   * @throws Error if BasicPricingPlan not found
   */
  async getBasicPricingPlanArn(): Promise<string>;

  /**
   * Check if a billing group exists for the given account
   * @param accountId - Bill-Source Account management account ID
   * @returns Billing group ARN if exists, null otherwise
   */
  async findBillingGroupByAccount(accountId: string): Promise<string | null>;

  /**
   * Create a new billing group for the Bill-Source Account
   * @param accountId - Bill-Source Account management account ID
   * @param pricingPlanArn - ARN of the pricing plan to associate
   * @param transferArn - ARN of the billing transfer relationship
   * @returns ARN of the created billing group
   */
  async createBillingGroup(
    accountId: string,
    pricingPlanArn: string,
    transferArn: string
  ): Promise<string>;
}
```

**AWS SDK Operations**:
- `ListPricingPlans`: Retrieve BasicPricingPlan ARN
- `ListBillingGroups`: Check for existing billing groups
- `CreateBillingGroup`: Create new billing group

**Important Implementation Detail**:
When creating billing groups for billing transfer relationships, the `AccountGrouping` parameter must use `ResponsibilityTransferArn` instead of `LinkedAccountIds`. This is because billing transfer relationships are managed by AWS Organizations, and the accounts are automatically included through the transfer relationship. Using `LinkedAccountIds` will result in an error: "Accounts are not in the payer account's CB family."

```typescript
// Correct approach for billing transfer relationships
await billingConductor.createBillingGroup({
  Name: `bg-${accountId}`,
  Description: `Billing group for transfer ${transferId}`,
  PricingPlanArn: pricingPlanArn,
  AccountGrouping: {
    ResponsibilityTransferArn: transferArn  // Use transfer ARN, not account IDs
  },
  PrimaryAccountId: accountId
});
```

### 4. Logger Utility (AWS Lambda Powertools)

**Purpose**: Provide structured logging with consistent format using AWS Lambda Powertools

**Usage**:
```typescript
import { logger } from '../common/utils/logger';

// Info/warn/debug
logger.info('Creating billing group', { accountId, transferId });

// Error - pass error in context object
logger.error('Failed to create billing group', { error: err, accountId });
```

**Log Entry Format** (Powertools structured JSON):
```json
{
  "level": "INFO",
  "message": "Creating billing group",
  "timestamp": "2025-11-25T10:30:00.000Z",
  "service": "billing-automation",
  "accountId": "123456789012",
  "transferId": "rt-abc123",
  "eventName": "ResponsibilityTransferAccepted"
}
```

### 5. Dead Letter Queue (DLQ)

**Purpose**: Capture failed Lambda invocations for manual review

**Configuration**:
- **Type**: SQS Standard Queue
- **Message Retention**: 14 days
- **Visibility Timeout**: 30 seconds (default)
- **CloudWatch Alarm**: 
  - Metric: ApproximateNumberOfMessagesVisible
  - Threshold: > 0 messages
  - Evaluation Period: 1 period of 5 minutes
  - Datapoints to Alarm: 1 out of 1
  - Alarm State: ALARM when messages exist, OK when queue is empty
  - Purpose: Alert operations team when Lambda invocations fail after all retries

### 6. IAM Role

**Purpose**: Grant Lambda function minimum required permissions

**Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "billingconductor:ListPricingPlans",
        "billingconductor:ListBillingGroups",
        "billingconductor:CreateBillingGroup"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage"
      ],
      "Resource": "<DLQ_ARN>"
    }
  ]
}
```

**CDK Nag Suppressions**:
- `AwsSolutions-IAM5`: Billing Conductor APIs do not support resource-level permissions
- `AwsSolutions-IAM4`: Lambda basic execution role is appropriate for CloudWatch Logs

## Data Models

### Billing Transfer Event

```typescript
interface BillingTransferEvent {
  version: string;
  id: string;
  'detail-type': 'AWS Service Event via CloudTrail';
  source: 'aws.organizations';
  account: string;
  time: string;
  region: string;
  detail: {
    eventVersion: string;
    eventTime: string;
    eventName: 'ResponsibilityTransferAccepted' | 'ResponsibilityTransferTerminated';
    eventSource: 'organizations.amazonaws.com';
    eventType: 'AwsServiceEvent';
    serviceEventDetails: ServiceEventDetails;
  };
}

interface ServiceEventDetails {
  id: string;                    // Transfer ID (e.g., 'rt-cw7osk66')
  arn: string;                   // Transfer ARN (e.g., 'arn:aws:organizations::...:responsibility-transfer/rt-cw7osk66')
  transferChain: string[];       // Chain of transfer IDs
  type: 'BILLING';
  status: TransferStatus;
  source: {
    managementAccountId: string; // Bill-Source Account
  };
  target: {
    managementAccountId: string; // Bill-Transfer Account
  };
  requester: string;             // Account that initiated transfer
  startTimestamp: number;        // Unix timestamp in milliseconds
  endTimestamp?: number;         // Present for terminated transfers
}

type TransferStatus = 
  | 'ACCEPTED' 
  | 'WITHDRAWN' 
  | 'DECLINED' 
  | 'EXPIRED' 
  | 'CANCELED';
```

### Billing Group

```typescript
interface BillingGroup {
  name: string;                  // Format: bg-{accountId}
  description: string;           // Human-readable description
  pricingPlanArn: string;        // ARN of associated pricing plan
  accountGrouping: {
    // For billing transfer relationships, use ResponsibilityTransferArn
    responsibilityTransferArn?: string;  // ARN of billing transfer relationship
    // For non-transfer billing groups, use LinkedAccountIds
    linkedAccountIds?: string[];  // List of account IDs in group
  };
  primaryAccountId: string;      // Primary account for pro forma visibility
}
```

### Pricing Plan

```typescript
interface PricingPlan {
  arn: string;                   // ARN of the pricing plan
  name: string;                  // Name (e.g., 'BasicPricingPlan')
  description?: string;          // Optional description
}
```

### Log Entry

```typescript
interface LogEntry {
  timestamp: string;             // ISO 8601 format
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;               // Human-readable message
  context?: {                    // Optional context object
    [key: string]: any;
  };
  error?: {                      // Present for ERROR level
    message: string;
    stack: string;
    code?: string;
  };
}
```


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property Reflection

After analyzing all acceptance criteria, I identified the following redundancies:
- **5.3 and 5.5**: Both properties verify that billing groups are created with the BasicPricingPlan ARN. These can be combined into a single comprehensive property.
- **3.1 and 2.5**: Both properties verify structured logging format. Property 3.1 is more comprehensive and subsumes 2.5.

The following properties provide unique validation value and will be implemented:

### Property 1: Lambda response structure

*For any* valid billing transfer event, the Lambda function response should contain statusCode 200 and include fields for message, accountId, and action.

**Validates: Requirements 1.2**

### Property 2: Structured log entry format

*For any* Lambda execution, all log entries should contain timestamp in ISO 8601 format, level field with values INFO, WARN, ERROR, or DEBUG, message field, and context object.

**Validates: Requirements 3.1, 2.5**

### Property 3: Error log completeness

*For any* error during Lambda execution, the ERROR level log entry should contain error.message, error.stack with complete stack trace, and error.code for categorization.

**Validates: Requirements 3.2**

### Property 4: Bill-Source Account extraction

*For any* ResponsibilityTransferAccepted event, the Lambda function should extract the source.managementAccountId field from serviceEventDetails and use it as the Bill-Source Account identifier.

**Validates: Requirements 4.1**

### Property 4a: Transfer ARN extraction

*For any* ResponsibilityTransferAccepted event, the Lambda function should extract the arn field from serviceEventDetails to use as the ResponsibilityTransferArn for billing group creation.

**Validates: Requirements 4.2**

### Property 5: Idempotency check execution

*For any* billing group creation request, the Lambda function should check if a billing group already exists for the Bill-Source Account before attempting creation.

**Validates: Requirements 4.2**

### Property 6: Idempotent duplicate handling

*For any* Bill-Source Account with an existing billing group, the Lambda function should return success without creating a duplicate and log the existing billing group ARN.

**Validates: Requirements 4.3**

### Property 7: Billing group structure

*For any* newly created billing group for a billing transfer relationship, the billing group should use ResponsibilityTransferArn in the AccountGrouping parameter and have the Bill-Source Account as the primary account.

**Validates: Requirements 4.5**

### Property 8: Billing group naming convention

*For any* billing group creation, the billing group name should follow the pattern bg-{accountId} where accountId is the Bill-Source Account management account ID.

**Validates: Requirements 4.5**

### Property 9: BasicPricingPlan discovery

*For any* pricing plan lookup, the Lambda function should search for and return the pricing plan with name BasicPricingPlan when it exists in the list of pricing plans.

**Validates: Requirements 5.2**

### Property 10: Pricing plan association

*For any* billing group creation, the billing group should be associated with the BasicPricingPlan ARN.

**Validates: Requirements 5.3, 5.5**

### Property 11: Throttling retry behavior

*For any* Billing Conductor API call that fails with a throttling error, the Lambda function should retry the operation using exponential backoff with a maximum of 3 attempts.

**Validates: Requirements 7.1**

### Property 12: Failed API call logging

*For any* API call that fails after all retry attempts, the Lambda function should log the error with full details including error code, message, and request parameters.

**Validates: Requirements 7.4**

### Property 13: Unhandled exception logging

*For any* unhandled exception during Lambda execution, the Lambda function should log the error with complete stack trace.

**Validates: Requirements 7.5**

### Example-Based Tests

The following acceptance criteria are best validated with specific example tests rather than property-based tests:

**Example 1: Missing BasicPricingPlan error handling**
- When BasicPricingPlan is not found in the list of pricing plans, the Lambda function should log an error and throw an exception indicating the pricing plan is missing.
- **Validates: Requirements 5.4**

**Example 2: ResourceNotFoundException handling**
- When a Billing Conductor API call fails with ResourceNotFoundException, the Lambda function should log an error with the resource type and identifier, then throw an exception.
- **Validates: Requirements 7.2**

**Example 3: ConflictException handling**
- When a Billing Conductor API call fails with ConflictException indicating a resource already exists, the Lambda function should treat this as success and log the existing resource ARN.
- **Validates: Requirements 7.3**

## Error Handling

### Error Categories

1. **Validation Errors**
   - Invalid event structure
   - Missing required fields
   - Event source not 'aws.organizations'
   - **Handling**: Log error, return 500 status (per requirements 2.6), do not retry

2. **Transient Errors**
   - Throttling (TooManyRequestsException)
   - Service unavailable (ServiceUnavailableException)
   - **Handling**: Retry with exponential backoff (max 3 attempts)

3. **Resource Errors**
   - ResourceNotFoundException (pricing plan or billing group not found)
   - **Handling**: Log error with details, throw exception, allow EventBridge retry

4. **Conflict Errors**
   - ConflictException (resource already exists)
   - **Handling**: Treat as success (idempotent), log existing resource ARN

5. **Unhandled Errors**
   - Unexpected exceptions
   - **Handling**: Log with stack trace, throw exception, send to DLQ after EventBridge retries

### Retry Strategy

**AWS SDK Retry Configuration**:
```typescript
const billingConductorClient = new BillingConductorClient({
  maxAttempts: 3,
  retryMode: 'adaptive',
  retryStrategy: new ConfiguredRetryStrategy(
    3, // max attempts
    (attempt: number) => 100 * Math.pow(2, attempt) // exponential backoff: 100ms, 200ms, 400ms
  )
});
```

**EventBridge Retry Configuration**:
- Retry Attempts: 2
- Retry Policy: Exponential backoff
- Maximum Event Age: 2 hours
- Dead Letter Queue: Enabled for final failures

### Event-Specific Handling

#### ResponsibilityTransferAccepted Events

When processing ResponsibilityTransferAccepted events:
1. Extract Bill-Source Account ID from `source.managementAccountId`
2. Extract ResponsibilityTransferArn from `arn` field
3. Check if billing group already exists (idempotency)
4. Retrieve BasicPricingPlan ARN
5. Create billing group using ResponsibilityTransferArn if needed
6. Return success response with billing group ARN

#### ResponsibilityTransferTerminated Events

When processing ResponsibilityTransferTerminated events:
1. Extract Bill-Source Account ID from `source.managementAccountId`
2. Extract termination status from `status` field (DECLINED, WITHDRAWN, EXPIRED, or CANCELED)
3. Log the termination event with full context
4. Return success response with action 'terminated'
5. **Do NOT delete billing groups** - they are retained for:
   - Historical billing data access
   - Audit and compliance requirements
   - Pro forma cost analysis of past periods

**Rationale for Not Deleting Billing Groups**:
- Billing groups contain historical billing data that may be needed for reconciliation
- Deleting billing groups would lose access to pro forma costs for past billing periods
- Manual deletion can be performed if needed after verifying no historical data is required

### Error Response Format

```typescript
interface ErrorResponse {
  statusCode: number;
  body: {
    error: string;
    message: string;
    accountId?: string;
    eventName?: string;
    details?: {
      errorCode?: string;
      resourceType?: string;
      resourceId?: string;
    };
  };
}
```

### Logging Strategy

**Log Levels**:
- **DEBUG**: Detailed execution flow (disabled in production)
- **INFO**: Normal operations (event received, billing group created)
- **WARN**: Recoverable issues (billing group already exists, retrying API call)
- **ERROR**: Failures requiring attention (API errors, missing resources)

**Error Log Structure**:
```json
{
  "timestamp": "2025-11-25T10:30:00.000Z",
  "level": "ERROR",
  "message": "Failed to create billing group",
  "context": {
    "accountId": "123456789012",
    "transferId": "rt-abc123",
    "operation": "createBillingGroup"
  },
  "error": {
    "message": "Resource not found: BasicPricingPlan",
    "code": "ResourceNotFoundException",
    "stack": "Error: Resource not found...\n    at BillingConductorService.getBasicPricingPlanArn..."
  }
}
```

## Testing Strategy

### Unit Testing

**Framework**: Jest (configured in project)

**Test Coverage**:
1. **Lambda Handler Tests**
   - Test event parsing and validation
   - Test response structure
   - Test error handling paths
   - Mock AWS SDK calls

2. **Billing Conductor Service Tests**
   - Test pricing plan lookup
   - Test billing group existence check
   - Test billing group creation
   - Mock AWS SDK responses

3. **Logger Tests**
   - Test log entry structure
   - Test error logging format
   - Verify all required fields present

4. **CDK Stack Tests**
   - Verify EventBridge rule configuration
   - Verify Lambda function configuration
   - Verify IAM permissions
   - Verify DLQ and alarm configuration
   - Verify CDK Nag suppressions

**Example Unit Test**:
```typescript
describe('BillingConductorService', () => {
  it('should find existing billing group by account ID', async () => {
    const mockClient = mockClient(BillingConductorClient);
    mockClient.on(ListBillingGroupsCommand).resolves({
      BillingGroups: [
        {
          Arn: 'arn:aws:billingconductor::123456789012:billinggroup/bg-111111111111',
          Name: 'bg-111111111111',
          PrimaryAccountId: '111111111111'
        }
      ]
    });

    const service = new BillingConductorService(mockClient);
    const result = await service.findBillingGroupByAccount('111111111111');

    expect(result).toBe('arn:aws:billingconductor::123456789012:billinggroup/bg-111111111111');
  });
});
```

### Property-Based Testing

**Framework**: fast-check (to be installed)

**Configuration**: Minimum 100 iterations per property test

**Property Test Implementation**:

Each property-based test must:
1. Be tagged with a comment referencing the design document property
2. Use the format: `// Feature: billing-group-event-handler, Property {number}: {property_text}`
3. Generate random valid inputs using fast-check arbitraries
4. Verify the property holds for all generated inputs

**Example Property Test**:
```typescript
import fc from 'fast-check';

describe('Property Tests', () => {
  // Feature: billing-group-event-handler, Property 8: Billing group naming convention
  it('should follow naming convention bg-{accountId} for all billing groups', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 12, maxLength: 12, pattern: '[0-9]' }), // AWS account ID
        async (accountId) => {
          const billingGroupName = generateBillingGroupName(accountId);
          expect(billingGroupName).toBe(`bg-${accountId}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 4: Bill-Source Account extraction
  it('should extract source.managementAccountId from all ResponsibilityTransferAccepted events', () => {
    fc.assert(
      fc.property(
        billingTransferEventArbitrary(), // Custom arbitrary for event generation
        (event) => {
          const extractedAccountId = extractBillSourceAccountId(event);
          expect(extractedAccountId).toBe(event.detail.serviceEventDetails.source.managementAccountId);
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

**Custom Arbitraries**:
```typescript
// Generate valid billing transfer events
function billingTransferEventArbitrary(): fc.Arbitrary<BillingTransferEvent> {
  return fc.record({
    version: fc.constant('0'),
    id: fc.uuid(),
    'detail-type': fc.constant('AWS Service Event via CloudTrail'),
    source: fc.constant('aws.organizations'),
    account: fc.string({ minLength: 12, maxLength: 12, pattern: '[0-9]' }),
    time: fc.date().map(d => d.toISOString()),
    region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    detail: fc.record({
      eventVersion: fc.constant('1.11'),
      eventTime: fc.date().map(d => d.toISOString()),
      eventName: fc.constantFrom('ResponsibilityTransferAccepted', 'ResponsibilityTransferTerminated'),
      eventSource: fc.constant('organizations.amazonaws.com'),
      eventType: fc.constant('AwsServiceEvent'),
      serviceEventDetails: fc.record({
        id: fc.string({ minLength: 10, maxLength: 20 }),
        transferChain: fc.array(fc.string({ minLength: 10, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        type: fc.constant('BILLING'),
        status: fc.constantFrom('ACCEPTED', 'WITHDRAWN', 'DECLINED', 'EXPIRED', 'CANCELED'),
        source: fc.record({
          managementAccountId: fc.string({ minLength: 12, maxLength: 12, pattern: '[0-9]' })
        }),
        target: fc.record({
          managementAccountId: fc.string({ minLength: 12, maxLength: 12, pattern: '[0-9]' })
        }),
        requester: fc.string({ minLength: 12, maxLength: 12, pattern: '[0-9]' }),
        startTimestamp: fc.integer({ min: 1600000000000, max: 2000000000000 })
      })
    })
  });
}
```

### Integration Testing

**Scope**: Test complete event flow in AWS environment

**Test Scenarios**:
1. Deploy stack to test account
2. Manually trigger ResponsibilityTransferAccepted event (or use test event)
3. Verify Lambda invocation in CloudWatch Logs
4. Verify billing group created in Billing Conductor
5. Verify idempotency by triggering same event twice
6. Verify error handling by removing BasicPricingPlan (if possible in test)
7. Verify DLQ receives messages for permanent failures

**Test Environment Requirements**:
- Test AWS account with Billing Conductor enabled
- CloudTrail enabled for Organizations events
- Permissions to create billing groups and pricing plans

### Lambda Handler Implementation Pattern

The Lambda handler should route events based on the event name:

```typescript
import { logger } from '../common/utils/logger';  // Powertools singleton
import { ensureBillingGroup } from '../common/services/billing-conductor-service';

export const handler = async (event: EventBridgeEvent, context: Context): Promise<LambdaResponse> => {
  logger.info('Lambda invoked', { 
    requestId: context.requestId,
    eventSource: event.source,
    eventName: event.detail.eventName
  });

  try {
    // Validate event source
    if (event.source !== 'aws.organizations') {
      logger.error('Invalid event source', { 
        error: new Error('Invalid source'),
        source: event.source,
        expected: 'aws.organizations'
      });
      return {
        statusCode: 500,
        body: {
          message: 'Invalid event source',
          accountId: '',
          action: 'skipped',
          eventName: event.detail.eventName
        }
      };
    }

    // Route based on event name
    const eventName = event.detail.eventName;
    
    if (eventName === 'ResponsibilityTransferAccepted') {
      return await handleTransferAccepted(event);
    } else if (eventName === 'ResponsibilityTransferTerminated') {
      return await handleTransferTerminated(event);
    } else {
      throw new Error(`Unknown event name: ${eventName}`);
    }
  } catch (error) {
    logger.error('Handler failed', { 
      error: error as Error,
      requestId: context.requestId 
    });
    throw error;
  }
};

async function handleTransferAccepted(event: EventBridgeEvent): Promise<LambdaResponse> {
  const { source, arn } = event.detail.serviceEventDetails;
  const billSourceAccountId = source.managementAccountId;
  const transferArn = arn;
  
  logger.info('Processing billing transfer accepted', { 
    accountId: billSourceAccountId,
    transferArn 
  });

  const result = await ensureBillingGroup(billSourceAccountId, transferArn);
  
  logger.info('Billing group ensured', { 
    accountId: billSourceAccountId,
    billingGroupArn: result.billingGroupArn,
    action: result.action 
  });

  return {
    statusCode: 200,
    body: {
      message: result.action === 'created' 
        ? 'Billing group created successfully' 
        : 'Billing group already exists',
      billingGroupArn: result.billingGroupArn,
      accountId: billSourceAccountId,
      action: result.action,
      eventName: 'ResponsibilityTransferAccepted'
    }
  };
}

async function handleTransferTerminated(event: EventBridgeEvent): Promise<LambdaResponse> {
  const { source, status } = event.detail.serviceEventDetails;
  const billSourceAccountId = source.managementAccountId;
  
  logger.info('Processing billing transfer terminated', { 
    accountId: billSourceAccountId,
    status,
    reason: 'Billing group retained for historical data'
  });

  return {
    statusCode: 200,
    body: {
      message: `Billing transfer terminated with status: ${status}. Billing group retained for historical data.`,
      accountId: billSourceAccountId,
      action: 'terminated',
      eventName: 'ResponsibilityTransferTerminated'
    }
  };
}
```

### Testing Best Practices

1. **Mock External Dependencies**: Use AWS SDK mocks for unit tests
2. **Test Error Paths**: Ensure all error handling code is covered
3. **Test Idempotency**: Verify operations can be safely retried
4. **Test Edge Cases**: Empty responses, missing fields, malformed events
5. **Test Event Routing**: Verify both ResponsibilityTransferAccepted and ResponsibilityTransferTerminated events are handled correctly
6. **Test Event Source Validation**: Verify non-aws.organizations events return 500 status
7. **Property Tests for Core Logic**: Use property-based testing for business logic
8. **Integration Tests for AWS Integration**: Verify actual AWS service interactions
9. **CDK Tests for Infrastructure**: Verify CloudFormation template correctness

## Resource Tagging

All resources in this stack must be tagged for cost allocation, management, and compliance tracking.

### Required Tags

**Tag Configuration**:
```typescript
const tags = {
  Project: 'BillingTransferAutomation',
  Environment: process.env.ENVIRONMENT || 'dev',
  ManagedBy: 'CDK'
};
```

**Tagged Resources**:
- Lambda Function
- EventBridge Rule
- Dead Letter Queue (SQS)
- CloudWatch Alarms
- IAM Role

**Implementation in CDK**:
```typescript
import * as cdk from 'aws-cdk-lib';

export class BillingGroupEventHandlerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Apply tags to all resources in the stack
    cdk.Tags.of(this).add('Project', 'BillingTransferAutomation');
    cdk.Tags.of(this).add('Environment', process.env.ENVIRONMENT || 'dev');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // Resources will automatically inherit these tags
  }
}
```

**Validation**:
- Tags are automatically applied to all taggable resources during CDK synthesis
- Use `cdk synth` to verify tags in the CloudFormation template
- Tags can be viewed in AWS Console for each resource

**Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**

## Deployment Considerations

### Deployment Architecture

This feature is deployed through a **self-mutating CDK Pipeline** managed by the Automation System. For complete details, see [Deployment Architecture](../common/deployment-architecture.md).

**Key Points:**
- The `BillingGroupEventHandlerStack` is instantiated in the pipeline's `ApplicationStage` (in `lib/stacks/pipeline-stack.ts`)
- Deployment happens automatically when code is pushed to CodeCommit
- The pipeline (Automation System) handles build, test, CDK Nag checks, and deployment
- Feature stacks are NOT deployed directly using `cdk deploy` commands
- The Automation System ensures consistent deployment across environments

**Alignment with Requirements**:
- Requirements refer to "Automation System" creating and configuring resources
- The Automation System is the CDK Pipeline that synthesizes and deploys CloudFormation stacks
- All "WHEN the Automation System creates..." requirements are fulfilled during pipeline deployment

### Prerequisites

1. **AWS Billing Conductor**: Must be enabled in the bill-transfer account
2. **BasicPricingPlan**: AWS managed pricing plan should exist (created automatically by AWS)
3. **CloudTrail**: Must be enabled to capture Organizations events
4. **EventBridge**: Default event bus must be available
5. **CDK Pipeline**: PipelineStack must be deployed
6. **CodeCommit**: Repository must be configured

### Deployment Workflow

1. **Make Code Changes**:
   - Update event handler Lambda code or stack configuration
   - Commit changes to git

2. **Test Locally**:
   ```bash
   npm install
   npm run build
   npm test
   npm run cdk:synth
   ```

3. **Push to CodeCommit**:
   ```bash
   git push codecommit main
   ```

4. **Pipeline Automatically**:
   - Pulls code from CodeCommit repository
   - Runs build: `npm ci`, `npm run build`
   - Runs tests: `npm test`
   - Synthesizes CDK: `npx cdk synth`
   - Runs CDK Nag security checks
   - Updates pipeline itself if needed (self-mutation)
   - Deploys ApplicationStage (includes BillingGroupEventHandlerStack)

5. **Monitor Deployment**:
   - Check CodePipeline console for deployment status
   - Review CloudFormation events for stack updates
   - Verify Lambda function updated in AWS Console

### Initial Stack Addition

The event handler stack was added to the pipeline by:

1. Creating `BillingGroupEventHandlerStack` in `lib/stacks/`
2. Importing it in `lib/stacks/pipeline-stack.ts`
3. Instantiating it in the `ApplicationStage` class:
   ```typescript
   new BillingGroupEventHandlerStack(this, 'BillingGroupEventHandlerStack', {
     env: props.env,
     executionMode: 'events',
     tags: {
       Project: 'SampleAutomationsForBillingTransfer',
       ManagedBy: 'CDK',
     },
   });
   ```
4. Pushing to repository to trigger pipeline deployment

### Verification Steps

After pipeline deployment completes:

- [ ] Check Lambda function exists in AWS Console
- [ ] Verify EventBridge rule is enabled
- [ ] Confirm DLQ and alarm are configured
- [ ] Review CloudWatch Logs for any startup errors
- [ ] Test with sample billing transfer event
- [ ] Verify X-Ray traces are captured

### Monitoring and Alerting

**CloudWatch Metrics**:
- Lambda invocations
- Lambda errors
- Lambda duration
- Lambda throttles
- DLQ message count

**CloudWatch Alarms**:
1. **DLQ Messages Alarm**: Triggers when DLQ receives messages
2. **Lambda Errors Alarm**: Triggers on Lambda function errors
3. **Lambda Throttles Alarm**: Triggers if Lambda is throttled

**CloudWatch Logs Insights Queries**:

```sql
-- Find all billing group creations
fields @timestamp, @message
| filter @message like /Creating billing group/
| sort @timestamp desc

-- Find all errors
fields @timestamp, level, message, error.message, error.code
| filter level = "ERROR"
| sort @timestamp desc

-- Find idempotency cases (billing group already exists)
fields @timestamp, @message, context.accountId
| filter @message like /Billing group already exists/
| sort @timestamp desc
```

### Rollback Strategy

If issues occur after deployment:

1. **Revert Git Commit**:
   ```bash
   git revert HEAD
   git push codecommit main
   ```
   Pipeline will automatically deploy the previous version

2. **Disable EventBridge Rule** (if needed immediately):
   - Manually disable rule in AWS Console
   - Prevents new invocations while investigating
   ```bash
   aws events disable-rule --name BillingTransferEventRule
   ```

3. **Monitor DLQ**: Check for failed events that need manual processing

4. **Fix and Redeploy**:
   - Address issues in code
   - Push fix to CodeCommit (`git push codecommit main`)
   - Pipeline automatically deploys fix

5. **Manual Cleanup**: If billing groups were created incorrectly, manually delete via console or CLI

### Security Considerations

1. **Least Privilege IAM**: Lambda role has minimum required permissions
2. **CDK Nag Compliance**: All security findings addressed or suppressed with justification
3. **Encryption**: CloudWatch Logs encrypted at rest (default)
4. **DLQ Encryption**: SQS queue encrypted at rest (default)
5. **X-Ray Tracing**: Enabled for security audit trail
6. **No Secrets in Code**: No hardcoded credentials or sensitive data

### Cost Considerations

**Estimated Monthly Costs** (assuming 100 billing transfer events/month):

- **Lambda**: ~$0.00 (within free tier)
- **EventBridge**: ~$0.00 (within free tier)
- **CloudWatch Logs**: ~$0.50 (500 MB ingestion)
- **X-Ray**: ~$0.50 (100K traces)
- **SQS DLQ**: ~$0.00 (minimal usage)
- **Billing Conductor**: No additional cost for API calls

**Total**: ~$1.00/month

**Cost Optimization**:
- Use log retention policies (e.g., 7 days for DEBUG logs)
- Archive old DLQ messages
- Monitor Lambda memory usage and adjust if over-provisioned
