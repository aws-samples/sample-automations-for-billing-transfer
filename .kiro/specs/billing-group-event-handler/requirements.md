# Requirements Document

## Introduction

This feature implements a real-time, event-driven Lambda function that automatically creates AWS Billing Conductor billing groups when billing transfer relationships are accepted. The system listens for ResponsibilityTransferAccepted events via EventBridge and immediately creates corresponding billing groups using the AWS managed BasicPricingPlan. The implementation includes idempotency checks to prevent duplicates and comprehensive error handling for API operations.

## Glossary

- **Event Handler**: Lambda function that processes billing transfer events in real-time
- **Billing Transfer**: An AWS Organizations feature where a Bill-Transfer Account manages and pays for a Bill-Source Account's consolidated bill
- **Bill-Transfer Account**: The management account that manages and pays for another organization's consolidated bill
- **Bill-Source Account**: The management account that generates a consolidated bill (the customer organization)
- **Billing Group**: A collection of accounts organized for billing purposes in AWS Billing Conductor, associated with a Pricing Plan
- **Pricing Plan**: Configuration that defines how billing is calculated for a Billing Group (AWS managed or customer managed)
- **BasicPricingPlan**: An AWS managed Pricing Plan that calculates pro forma costs pre-discounts, excluding credits, taxes, and support charges
- **AWS Billing Conductor**: AWS service used to create Billing Groups and customize billing details
- **EventBridge**: AWS service for event-driven architecture that delivers events from various sources to targets
- **EventBridge Rule**: A pattern-matching configuration that routes events to targets based on event patterns
- **CloudTrail**: AWS service that captures API calls and delivers them as events to EventBridge
- **Lambda Function**: Serverless compute function that executes the automation logic in response to triggers
- **Dead Letter Queue (DLQ)**: An SQS queue that receives messages from failed Lambda Function invocations after retry attempts
- **CloudWatch Logs**: AWS service for storing, querying, and analyzing log data from AWS resources
- **IAM Role**: AWS Identity and Access Management role that grants permissions to AWS services to perform actions
- **X-Ray**: AWS distributed tracing service for monitoring, debugging, and analyzing distributed applications
- **Structured Logging**: JSON-formatted log entries with consistent fields for timestamp, level, message, and context
- **Service Event**: An AWS API event captured by CloudTrail and delivered to EventBridge for processing
- **Idempotency**: The property that an operation can be performed multiple times with the same result as performing it once
- **Powertools Idempotency**: AWS Lambda Powertools feature that prevents duplicate Lambda executions by storing execution results in DynamoDB and returning cached results for duplicate events
- **Idempotency Table**: DynamoDB table used by Powertools Idempotency to store execution results with TTL-based expiration
- **Exponential Backoff**: A retry strategy where wait time increases exponentially between retry attempts
- **Resource ARN**: Amazon Resource Name, a unique identifier for AWS resources
- **CDK Pipeline**: Self-mutating CI/CD pipeline that automatically deploys infrastructure changes when code is pushed to CodeCommit
- **Application Stage**: CDK Stage that groups feature stacks for deployment through the pipeline
- **Automation System**: The CDK Pipeline and ApplicationStage that automatically deploy and manage infrastructure

## Requirements

### Requirement 1

**User Story:** As a platform engineer, I want to deploy a Lambda function for event-driven billing group creation, so that I can respond to billing transfer events in real-time.

#### Acceptance Criteria

1. WHEN the Automation System deploys the Lambda Function, THEN the Lambda Function SHALL use Node.js 22.x runtime and 256 MB memory allocation
2. WHEN the Lambda Function is invoked with a billing transfer event, THEN the Lambda Function SHALL return a response containing statusCode 200 and details about the billing group operation
3. WHEN the Automation System creates the Lambda Function, THEN the Lambda Function SHALL have a timeout of 2 minutes to allow for API calls
4. WHEN the Automation System creates the Lambda Function, THEN the Lambda Function SHALL enable X-Ray tracing with ACTIVE mode for distributed tracing
5. WHEN the Automation System creates the Lambda Function, THEN the Lambda Function SHALL configure an IAM Role with only the minimum permissions required for execution

### Requirement 2

**User Story:** As a platform engineer, I want the Lambda function to be triggered by billing transfer events, so that billing groups are created immediately when transfers are established.

#### Acceptance Criteria

1. WHEN a ResponsibilityTransferAccepted event occurs in AWS Organizations, THEN the EventBridge Rule SHALL invoke the Lambda Function with the complete event payload within 5 seconds
2. WHEN a ResponsibilityTransferTerminated event occurs in AWS Organizations, THEN the EventBridge Rule SHALL invoke the Lambda Function with the complete event payload within 5 seconds
3. WHEN the Automation System creates the EventBridge Rule, THEN the EventBridge Rule SHALL include an event pattern that filters for source aws.organizations and eventSource organizations.amazonaws.com
4. WHEN the Automation System creates the EventBridge Rule, THEN the EventBridge Rule SHALL include an event pattern that filters for eventType AwsServiceEvent and detail-type AWS Service Event via CloudTrail
5. WHEN the Lambda Function receives an event with source field set to aws.organizations, THEN the Lambda Function SHALL process it as a billing transfer event
6. WHEN the Lambda Function receives an event with source field NOT set to aws.organizations, THEN the Lambda Function SHALL log an error and return a response with statusCode 500
7. WHEN the Lambda Function receives an event from EventBridge, THEN the Lambda Function SHALL write structured JSON log entries to CloudWatch Logs containing timestamp, level, message, and event context fields

### Requirement 3

**User Story:** As a platform engineer, I want comprehensive error handling and observability, so that I can troubleshoot issues and monitor system health.

#### Acceptance Criteria

1. WHEN the Lambda Function executes, THEN the Lambda Function SHALL write structured JSON log entries containing timestamp in ISO 8601 format, level field with values INFO, WARN, ERROR, or DEBUG, message field, and context object with event-specific data
2. WHEN an error occurs during Lambda Function execution, THEN the Lambda Function SHALL write an ERROR level log entry containing error.message field, error.stack field with the complete stack trace, and error.code field for error categorization
3. WHEN the Automation System creates the Lambda Function, THEN the Automation System SHALL configure a Dead Letter Queue with 14-day message retention period and associate it with the Lambda Function
4. WHEN the Dead Letter Queue receives one or more messages, THEN the CloudWatch Alarm SHALL transition to ALARM state within 5 minutes and remain in ALARM state while messages exist
5. WHEN the Automation System creates the EventBridge Rule, THEN the EventBridge Rule SHALL configure 2 retry attempts with exponential backoff and a maximum event age of 2 hours

### Requirement 4

**User Story:** As a billing administrator, I want billing groups automatically created when billing transfers are accepted, so that I can manage billing for customer organizations without manual intervention.

#### Acceptance Criteria

1. WHEN a ResponsibilityTransferAccepted event is received, THEN the Lambda Function SHALL extract the source.managementAccountId field from the serviceEventDetails object and use it as the Bill-Source Account identifier
2. WHEN a ResponsibilityTransferAccepted event is received, THEN the Lambda Function SHALL extract the arn field from the serviceEventDetails object to use as the ResponsibilityTransferArn for billing group creation
3. WHEN creating a Billing Group, THEN the Lambda Function SHALL check if a Billing Group already exists for the Bill-Source Account by listing existing Billing Groups and comparing account IDs
4. WHEN a Billing Group already exists for the Bill-Source Account, THEN the Lambda Function SHALL log the existing Billing Group ARN and return success without creating a duplicate
5. WHEN no Billing Group exists for the Bill-Source Account, THEN the Lambda Function SHALL create a new Billing Group using the ResponsibilityTransferArn in the AccountGrouping parameter with the Bill-Source Account as the primary account
6. WHEN creating a Billing Group, THEN the Lambda Function SHALL use a naming convention of bg-{accountId} where accountId is the Bill-Source Account management account ID

### Requirement 5

**User Story:** As a billing administrator, I want billing groups to use the AWS managed BasicPricingPlan, so that I can get started quickly without creating custom pricing plans.

#### Acceptance Criteria

1. WHEN the Lambda Function needs a Pricing Plan ARN, THEN the Lambda Function SHALL list existing Pricing Plans using the ListPricingPlans API
2. WHEN listing Pricing Plans, THEN the Lambda Function SHALL search for a Pricing Plan with the name BasicPricingPlan
3. WHEN the BasicPricingPlan is found, THEN the Lambda Function SHALL use its ARN for Billing Group creation
4. WHEN the BasicPricingPlan is not found, THEN the Lambda Function SHALL log an error and throw an exception indicating the Pricing Plan is missing
5. WHEN creating a Billing Group, THEN the Lambda Function SHALL associate the Billing Group with the BasicPricingPlan ARN

### Requirement 6

**User Story:** As a platform engineer, I want the Lambda function to have appropriate IAM permissions for Billing Conductor, so that it can create and manage billing groups.

#### Acceptance Criteria

1. WHEN the Automation System creates the IAM Role, THEN the Automation System SHALL grant the billingconductor:ListPricingPlans permission with wildcard resource
2. WHEN the Automation System creates the IAM Role, THEN the Automation System SHALL grant the billingconductor:ListBillingGroups permission with wildcard resource
3. WHEN the Automation System creates the IAM Role, THEN the Automation System SHALL grant the billingconductor:CreateBillingGroup permission with wildcard resource
4. WHEN the Automation System creates the IAM Role, THEN the Automation System SHALL grant CloudWatch Logs write access, X-Ray trace submission, and Dead Letter Queue message sending permissions
5. WHEN CDK Nag checks run, THEN the Automation System SHALL suppress AwsSolutions-IAM5 for Billing Conductor permissions with justification that these APIs do not support resource-level permissions

### Requirement 7

**User Story:** As a platform engineer, I want comprehensive error handling for API calls, so that transient failures are retried and permanent failures are logged appropriately.

#### Acceptance Criteria

1. WHEN a Billing Conductor API call fails with a throttling error, THEN the Lambda Function SHALL retry the operation using exponential backoff with a maximum of 3 attempts
2. WHEN a Billing Conductor API call fails with a ResourceNotFoundException, THEN the Lambda Function SHALL log an error with the resource type and identifier and throw an exception
3. WHEN a Billing Conductor API call fails with a ConflictException indicating a resource already exists, THEN the Lambda Function SHALL treat this as success and log the existing resource ARN
4. WHEN any API call fails after all retry attempts, THEN the Lambda Function SHALL log the error with full details including error code, message, and request parameters
5. WHEN an unhandled exception occurs during Lambda execution, THEN the Lambda Function SHALL log the error with stack trace and allow EventBridge retry mechanism to handle the failure

### Requirement 8

**User Story:** As a platform engineer, I want resources to be tagged for cost allocation and management, so that I can track costs and manage resources effectively.

#### Acceptance Criteria

1. WHEN resources are created, THEN the Automation System SHALL apply a tag with key Project and value BillingTransferAutomation
2. WHEN resources are created, THEN the Automation System SHALL apply a tag with key Environment and value corresponding to the deployment environment
3. WHEN resources are created, THEN the Automation System SHALL apply a tag with key ManagedBy and value CDK
4. WHEN resources are created, THEN the Automation System SHALL apply tags to all taggable resources including Lambda Function, EventBridge Rule, Dead Letter Queue, and CloudWatch Alarm
5. WHEN CDK synthesis occurs, THEN the Automation System SHALL verify that all resources have the required tags applied
