# Design Document

## Overview

This feature adds a dedicated Lambda function and SNS-based email notifications for billing transfer termination events. When a `ResponsibilityTransferTerminated` event is received, a separate Termination Handler Lambda publishes a notification to an SNS topic, which delivers emails to subscribed recipients. This follows the single responsibility principle by separating termination handling from billing group creation.

Additionally, the existing Event Handler Lambda will be updated to only process `ResponsibilityTransferAccepted` events, with its EventBridge rule modified accordingly.

## Architecture

### High-Level Flow

```
                                    ┌─────────────────────────────────────┐
                                    │         EventBridge Rules           │
                                    └─────────────────────────────────────┘
                                                    │
                    ┌───────────────────────────────┴───────────────────────────────┐
                    │                                                               │
                    ▼                                                               ▼
    ┌───────────────────────────────┐                           ┌───────────────────────────────┐
    │  ResponsibilityTransfer       │                           │  ResponsibilityTransfer       │
    │  Accepted Rule                │                           │  Terminated Rule              │
    └───────────────────────────────┘                           └───────────────────────────────┘
                    │                                                               │
                    ▼                                                               ▼
    ┌───────────────────────────────┐                           ┌───────────────────────────────┐
    │  Event Handler Lambda         │                           │  Termination Handler Lambda   │
    │  (billing-group-event-handler)│                           │  (billing-transfer-termination│
    │                               │                           │   -handler)                   │
    │  - Creates billing groups     │                           │  - Publishes to SNS           │
    │  - Uses Billing Conductor API │                           │  - Logs termination           │
    └───────────────────────────────┘                           └───────────────────────────────┘
                                                                                │
                                                                                ▼
                                                                ┌───────────────────────────────┐
                                                                │  SNS Topic                    │
                                                                │  (termination-notifications)  │
                                                                └───────────────────────────────┘
                                                                                │
                                                                                ▼
                                                                ┌───────────────────────────────┐
                                                                │  Email Subscribers            │
                                                                └───────────────────────────────┘
```

### Components

1. **Termination Handler Lambda** (NEW): `billing-transfer-termination-handler`
   - Purpose: Process termination events and publish SNS notifications
   - Permissions: `sns:Publish` only
   - Trigger: EventBridge rule for `ResponsibilityTransferTerminated` events

2. **SNS Topic** (NEW): `billing-transfer-termination-notifications`
   - Purpose: Fanout termination notifications to multiple subscribers
   - Encryption: AWS managed KMS key
   - Access: Lambda publish permission only

3. **Event Handler Lambda** (MODIFIED): `billing-group-event-handler`
   - Change: Update EventBridge rule to only trigger on `ResponsibilityTransferAccepted`
   - Change: Remove handling for terminated events

4. **Email Subscriptions** (NEW):
   - Configured via CDK stack parameter
   - Requires manual confirmation by recipients
   - Multiple addresses supported

5. **New CDK Stack** (NEW): `BillingTransferTerminationStack`
   - Contains: Termination Handler Lambda, SNS Topic, EventBridge Rule, Email Subscriptions
   - Optional: Can be deployed independently of existing stacks

## Components and Interfaces

### Termination Handler Lambda

```typescript
// lib/lambda/billing-transfer-termination-handler/index.ts

import { logger } from '../common/utils/logger';  // Powertools singleton

export interface TerminationEvent {
  version: string;
  id: string;
  'detail-type': 'AWS Service Event via CloudTrail';
  source: 'aws.organizations';
  detail: {
    eventName: 'ResponsibilityTransferTerminated';
    serviceEventDetails: {
      id: string;
      type: 'BILLING';
      status: 'WITHDRAWN' | 'EXPIRED' | 'DECLINED' | 'CANCELED';
      source: { managementAccountId: string };
      target: { managementAccountId: string };
      startTimestamp: number;
      endTimestamp?: number;
    };
  };
}

export interface HandlerResponse {
  statusCode: number;
  body: {
    message: string;
    accountId: string;
    action: 'notified' | 'skipped';
    messageId?: string;
  };
}

export const handler = async (event: TerminationEvent, context: any): Promise<HandlerResponse> => {
  // Implementation details below
};
```

### SNS Message Format

```typescript
interface TerminationNotification {
  eventType: 'ResponsibilityTransferTerminated';
  transferId: string;
  billSourceAccountId: string;
  billTransferAccountId: string;
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
  status: 'WITHDRAWN' | 'EXPIRED' | 'DECLINED' | 'CANCELED';
  timestamp: string; // ISO 8601
}
```

### Email Format

**Subject:**
```
Billing Transfer Terminated: Account {billSourceAccountId}
```

**Body:**
```
Billing Transfer Termination Notice

A billing transfer relationship has been terminated.

Transfer Details:
- Transfer ID: {transferId}
- Customer Account: {billSourceAccountId}
- Payer Account: {billTransferAccountId}
- Status: {status}
- Start Date: {startDate}
- End Date: {endDate}

Action Required:
- Review billing group configuration
- Update billing documentation
- Notify relevant stakeholders

This is an automated notification from the Billing Transfer Automation system.
```

### CDK Stack Structure

```typescript
// lib/stacks/billing-transfer-termination-stack.ts

export interface BillingTransferTerminationStackProps extends cdk.StackProps {
  /**
   * Email addresses to receive termination notifications
   */
  notificationEmails?: string[];
}

export class BillingTransferTerminationStack extends cdk.Stack {
  public readonly terminationTopic: sns.Topic;
  public readonly terminationHandler: lambda.Function;
  
  constructor(scope: Construct, id: string, props?: BillingTransferTerminationStackProps) {
    // Creates:
    // - SNS Topic
    // - Email Subscriptions
    // - Termination Handler Lambda
    // - EventBridge Rule for ResponsibilityTransferTerminated
    // - DLQ for failed invocations
  }
}
```

## Data Models

### TerminationNotification Interface

```typescript
interface TerminationNotification {
  eventType: 'ResponsibilityTransferTerminated';
  transferId: string;
  billSourceAccountId: string;
  billTransferAccountId: string;
  startDate: string; // ISO 8601 format
  endDate: string; // ISO 8601 format
  status: 'WITHDRAWN' | 'EXPIRED' | 'DECLINED' | 'CANCELED';
  timestamp: string; // ISO 8601 format
}
```

### Lambda Handler Response

```typescript
interface HandlerResponse {
  statusCode: number;
  body: {
    message: string;
    accountId: string;
    action: 'notified' | 'skipped';
    messageId?: string; // SNS message ID when notification sent
  };
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: SNS publish called for all termination events
*For any* ResponsibilityTransferTerminated event received by the Termination Handler Lambda, the Lambda should call SNS publish with the termination topic ARN
**Validates: Requirements 1.1**

### Property 2: Notification message contains required fields
*For any* termination notification, the message should include transferId, billSourceAccountId, billTransferAccountId, and timestamp fields
**Validates: Requirements 1.3**

### Property 3: Notification message includes dates
*For any* termination notification, the message should include both startDate and endDate fields
**Validates: Requirements 1.4**

### Property 4: Multiple email subscriptions created
*For any* non-empty list of email addresses, the CDK stack should create a subscription resource for each address
**Validates: Requirements 2.4**

### Property 5: SNS failures are caught
*For any* SNS publish failure, the Lambda should catch the error, log it, and not throw an exception that would trigger EventBridge retry
**Validates: Requirements 3.4**

### Property 6: Success logging includes message ID
*For any* successful SNS publish, the Lambda should log the returned MessageId and topic ARN
**Validates: Requirements 3.5**

### Property 7: Email subject format
*For any* account ID, the email subject should match the pattern "Billing Transfer Terminated: Account {accountId}"
**Validates: Requirements 4.1**

### Property 8: Email body contains account IDs
*For any* termination notification, the formatted email body should contain both the customer account ID and payer account ID
**Validates: Requirements 4.3**

### Property 9: Email body contains transfer ID
*For any* termination notification, the formatted email body should contain the transfer ID
**Validates: Requirements 4.5**

### Property 10: Termination logging includes details
*For any* ResponsibilityTransferTerminated event, the Lambda should log the transferId, accountId, and status
**Validates: Requirements 6.3**

### Property 11: Response action is 'notified' on success
*For any* ResponsibilityTransferTerminated event where SNS publish succeeds, the Lambda response should have action field set to 'notified'
**Validates: Requirements 6.5**

## Error Handling

### SNS Publishing Errors

- **Scenario**: SNS publish fails due to network issues, throttling, or permissions
- **Handling**: Catch error, log with structured context, return success with action 'skipped'
- **Rationale**: Notification failure should not trigger EventBridge retries

### Missing Topic ARN

- **Scenario**: TERMINATION_TOPIC_ARN environment variable is not set
- **Handling**: Log error, return 500 status code
- **Rationale**: This indicates a deployment configuration error

### Invalid Event Format

- **Scenario**: Event doesn't match expected structure
- **Handling**: Log error with event details, return 500 status code
- **Rationale**: Unexpected events should be investigated

### Message Formatting Errors

- **Scenario**: Timestamp conversion or string formatting fails
- **Handling**: Use fallback values (e.g., "N/A" for missing dates)
- **Rationale**: Partial notification is better than no notification

## Testing Strategy

### Unit Tests

1. **Event Processing**
   - Test handler processes valid termination events
   - Test handler rejects invalid event formats
   - Test extraction of transfer details from event

2. **Message Formatting**
   - Test formatEmailBody with various notification objects
   - Test subject line formatting with different account IDs
   - Test date formatting with various timestamps
   - Test handling of missing endTimestamp

3. **SNS Publishing**
   - Mock SNS client and verify PublishCommand parameters
   - Test error handling when SNS publish fails
   - Test logging on success and failure

### Property-Based Tests

Property-based tests will use fast-check library to generate random inputs and verify properties hold across all inputs.

1. **Test Configuration**: Minimum 100 iterations per property test
2. **Generators**: Create generators for:
   - Random ResponsibilityTransferTerminated events
   - Random account IDs (12-digit strings)
   - Random timestamps
   - Random transfer IDs (rt-XXXXXXXX format)
   - Random termination statuses

### CDK Synthesis Tests

1. **Stack Creation**
   - Test that stack creates SNS topic
   - Test that stack creates Lambda function
   - Test that stack creates EventBridge rule
   - Test that stack creates DLQ

2. **Email Subscriptions**
   - Test that providing emails creates subscriptions
   - Test that empty email list creates no subscriptions
   - Test that multiple emails create multiple subscriptions

3. **IAM Permissions**
   - Test that Lambda has sns:Publish permission
   - Test that Lambda has CloudWatch Logs permissions
   - Test that Lambda has SQS SendMessage for DLQ

## Deployment Considerations

### New Stack Structure

```typescript
// lib/stacks/billing-transfer-termination-stack.ts

export class BillingTransferTerminationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BillingTransferTerminationStackProps) {
    super(scope, id, props);

    // Create DLQ
    const dlq = new sqs.Queue(this, 'TerminationDLQ', {
      queueName: 'billing-transfer-termination-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Create SNS Topic
    const terminationTopic = new sns.Topic(this, 'TerminationTopic', {
      displayName: 'Billing Transfer Termination Notifications',
      topicName: 'billing-transfer-termination-notifications',
    });

    // Add email subscriptions
    props?.notificationEmails?.forEach((email, index) => {
      new sns.Subscription(this, `EmailSubscription${index}`, {
        topic: terminationTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: email,
      });
    });

    // Create Lambda
    const handler = new nodejs.NodejsFunction(this, 'TerminationHandler', {
      functionName: 'billing-transfer-termination-handler',
      entry: 'lib/lambda/billing-transfer-termination-handler/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: dlq,
      environment: {
        TERMINATION_TOPIC_ARN: terminationTopic.topicArn,
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });

    // Grant SNS publish permission
    terminationTopic.grantPublish(handler);

    // Create EventBridge rule for terminated events only
    const rule = new events.Rule(this, 'TerminationEventRule', {
      ruleName: 'BillingTransferTerminatedRule',
      eventPattern: {
        source: ['aws.organizations'],
        detailType: ['AWS Service Event via CloudTrail'],
        detail: {
          eventSource: ['organizations.amazonaws.com'],
          eventName: ['ResponsibilityTransferTerminated'],
        },
      },
    });

    rule.addTarget(new targets.LambdaFunction(handler, {
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(2),
    }));
  }
}
```

### Existing Stack Modification

Update `BillingGroupEventHandlerStack` to only listen for `ResponsibilityTransferAccepted`:

```typescript
// In billing-group-event-handler-stack.ts
const eventRule = new events.Rule(this, 'BillingTransferEventRule', {
  eventPattern: {
    source: ['aws.organizations'],
    detailType: ['AWS Service Event via CloudTrail'],
    detail: {
      eventSource: ['organizations.amazonaws.com'],
      eventName: ['ResponsibilityTransferAccepted'], // Remove ResponsibilityTransferTerminated
    },
  },
});
```

### Backward Compatibility

- New stack is independent and can be deployed separately
- Existing Event Handler stack continues to work
- No breaking changes to existing functionality
- Email subscriptions require manual confirmation

### Rollout Strategy

1. **Phase 1**: Deploy new Termination Stack to non-production
2. **Phase 2**: Update existing Event Handler stack to remove terminated event handling
3. **Phase 3**: Test with real termination events
4. **Phase 4**: Deploy to production
5. **Phase 5**: Confirm email subscriptions

## Security Considerations

### IAM Permissions (Least Privilege)

- Termination Handler Lambda only needs `sns:Publish` for specific topic
- No Billing Conductor or Organizations permissions required
- Separate from Event Handler Lambda permissions

### Data Sensitivity

- Notification messages contain account IDs (not sensitive)
- No PII or credentials in notifications
- Transfer IDs are internal identifiers (low sensitivity)

### Email Security

- SNS email subscriptions require confirmation
- Prevents unauthorized email addresses from receiving notifications
- Email addresses stored in CDK code (not in Lambda)

## Monitoring and Observability

### CloudWatch Metrics

- Lambda invocation count
- Lambda error rate
- SNS publish success/failure
- DLQ message count

### CloudWatch Logs

- Structured logging for all termination events
- SNS publish success with MessageId
- SNS publish failures with error details

### Alarms

- Alert on Lambda error rate > 10%
- Alert on DLQ messages > 0
- Alert on SNS delivery failures (optional)
