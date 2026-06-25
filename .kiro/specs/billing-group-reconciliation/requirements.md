# Requirements Document

## Introduction

This feature implements a scheduled Lambda function that performs periodic reconciliation of billing groups for all active billing transfer relationships (both direct and indirect). The system runs on a configurable schedule (default: daily at midnight UTC) via EventBridge Scheduler to ensure all billing transfers have corresponding billing groups, catching any missed events or manually created transfers. The reconciliation process first lists all direct billing transfers, creates billing groups for each direct transfer if missing, then for each direct transfer retrieves its indirect (nested) transfers and creates billing groups for those as well. The implementation reuses the same billing group creation logic as the event-driven handler to maintain consistency.

## Glossary

- **Reconciliation Handler**: Lambda function that performs scheduled checks of all billing transfers
- **Billing Transfer**: An AWS Organizations feature where a Bill-Transfer Account manages and pays for a Bill-Source Account's consolidated bill
- **Direct Billing Transfer**: A billing transfer relationship where the Bill-Transfer Account directly manages the Bill-Source Account
- **Indirect Billing Transfer**: A nested billing transfer where a Bill-Source Account from a direct relationship also manages billing for other accounts
- **Bill-Transfer Account**: The management account that manages and pays for another organization's consolidated bill
- **Bill-Source Account**: The management account that generates a consolidated bill (the customer organization)
- **Billing Group**: A collection of accounts organized for billing purposes in AWS Billing Conductor, associated with a Pricing Plan
- **Pricing Plan**: Configuration that defines how billing is calculated for a Billing Group (AWS managed or customer managed)
- **BasicPricingPlan**: An AWS managed Pricing Plan that calculates pro forma costs pre-discounts, excluding credits, taxes, and support charges
- **AWS Billing Conductor**: AWS service used to create Billing Groups and customize billing details
- **EventBridge Scheduler**: A service that invokes targets on a defined schedule using cron expressions
- **AWS Organizations**: AWS service that manages multiple AWS accounts and billing transfers
- **Lambda Function**: Serverless compute function that executes the reconciliation logic on a schedule
- **Dead Letter Queue (DLQ)**: An SQS queue that receives messages from failed Lambda Function invocations after retry attempts
- **CloudWatch Logs**: AWS service for storing, querying, and analyzing log data from AWS resources
- **IAM Role**: AWS Identity and Access Management role that grants permissions to AWS services to perform actions
- **X-Ray**: AWS distributed tracing service for monitoring, debugging, and analyzing distributed applications
- **Structured Logging**: JSON-formatted log entries with consistent fields for timestamp, level, message, and context
- **Reconciliation**: The process of comparing active billing transfers with existing billing groups to ensure consistency
- **Exponential Backoff**: A retry strategy where wait time increases exponentially between retry attempts
- **Resource ARN**: Amazon Resource Name, a unique identifier for AWS resources
- **CDK Pipeline**: Self-mutating CI/CD pipeline that automatically deploys infrastructure changes when code is pushed to CodeCommit
- **Application Stage**: CDK Stage that groups feature stacks for deployment through the pipeline
- **Automation System**: The CDK Pipeline and ApplicationStage that automatically deploy and manage infrastructure

## Requirements

### Requirement 1

**User Story:** As a platform engineer, I want to deploy a Lambda function for scheduled reconciliation, so that I can ensure all billing transfers have billing groups.

#### Acceptance Criteria

1. WHEN the Lambda Function is deployed, THEN the Lambda Function SHALL use Node.js 22.x runtime and 512 MB memory allocation
2. WHEN the Lambda Function is invoked by the scheduler, THEN the Lambda Function SHALL return a response containing statusCode 200 and a reconciliation summary
3. WHEN the Lambda Function is created, THEN the Lambda Function SHALL have a timeout of 15 minutes to allow for processing multiple transfers
4. WHEN the Lambda Function is created, THEN the Lambda Function SHALL enable X-Ray tracing with ACTIVE mode for distributed tracing
5. WHEN the Lambda Function is created, THEN the Lambda Function SHALL have an IAM Role with only the minimum permissions required for execution

### Requirement 2

**User Story:** As a platform engineer, I want the Lambda function to run on a configurable schedule, so that I can control reconciliation frequency based on operational needs.

#### Acceptance Criteria

1. WHEN the EventBridge Scheduler is created with default configuration, THEN the EventBridge Scheduler SHALL use the cron expression cron(0 0 * * ? *) to trigger daily at 00:00 UTC
2. WHEN the EventBridge Scheduler is created with monthly configuration, THEN the EventBridge Scheduler SHALL use the cron expression cron(0 0 1 * ? *) to trigger on the 1st day of each month at 00:00 UTC
3. WHEN the scheduled time occurs, THEN the EventBridge Scheduler SHALL invoke the Lambda Function with a payload containing source field set to scheduler and action field set to reconcile-all
4. WHEN the Lambda Function receives any event, THEN the Lambda Function SHALL process it as a reconciliation request
5. WHEN the scheduled execution completes successfully, THEN the Lambda Function SHALL write structured JSON log entries to CloudWatch Logs containing execution duration and reconciliation summary

### Requirement 3

**User Story:** As a platform engineer, I want comprehensive error handling and observability, so that I can troubleshoot issues and monitor reconciliation health.

#### Acceptance Criteria

1. WHEN the Lambda Function executes, THEN the Lambda Function SHALL write structured JSON log entries containing timestamp in ISO 8601 format, level field with values INFO, WARN, ERROR, or DEBUG, message field, and context object with reconciliation data
2. WHEN an error occurs during Lambda Function execution, THEN the Lambda Function SHALL write an ERROR level log entry containing error.message field, error.stack field with the complete stack trace, and error.code field for error categorization
3. WHEN the Lambda Function is created, THEN the Automation System SHALL configure a Dead Letter Queue with 14-day message retention period and associate it with the Lambda Function
4. WHEN the Dead Letter Queue receives one or more messages, THEN the CloudWatch Alarm SHALL transition to ALARM state within 5 minutes and remain in ALARM state while messages exist
5. WHEN the EventBridge Scheduler is created, THEN the EventBridge Scheduler SHALL configure retry behavior with exponential backoff

### Requirement 4

**User Story:** As a billing administrator, I want the system to reconcile all billing transfers on schedule, so that any missed events or manual transfers are captured.

#### Acceptance Criteria

1. WHEN the Lambda Function receives a scheduler event, THEN the Lambda Function SHALL list all direct inbound billing transfer relationships using the Organizations API without passing an Id parameter
2. WHEN listing direct billing transfers, THEN the Lambda Function SHALL filter for transfers with status ACCEPTED and type BILLING
3. WHEN processing each direct ACCEPTED transfer, THEN the Lambda Function SHALL check if a corresponding Billing Group exists for the Bill-Source Account
4. WHEN a Billing Group does not exist for a direct transfer, THEN the Lambda Function SHALL create the Billing Group using the same logic as the event-driven handler
5. WHEN processing each direct ACCEPTED transfer, THEN the Lambda Function SHALL call the Organizations API with the transfer Id parameter to retrieve all indirect billing transfers for that relationship
6. WHEN processing indirect billing transfers, THEN the Lambda Function SHALL filter for transfers with status ACCEPTED and type BILLING
7. WHEN processing each indirect ACCEPTED transfer, THEN the Lambda Function SHALL check if a corresponding Billing Group exists for the Bill-Source Account
8. WHEN a Billing Group does not exist for an indirect transfer, THEN the Lambda Function SHALL create the Billing Group using the same logic as the event-driven handler
9. WHEN reconciliation completes, THEN the Lambda Function SHALL log a summary containing the count of direct transfers checked, indirect transfers checked, Billing Groups created, Billing Groups that already existed, and any errors encountered

### Requirement 5

**User Story:** As a billing administrator, I want billing groups created during reconciliation to use the same logic as event-driven creation, so that all billing groups are consistent.

#### Acceptance Criteria

1. WHEN creating a Billing Group during reconciliation, THEN the Lambda Function SHALL use the same naming convention of bg-{accountId} as the event-driven handler
2. WHEN creating a Billing Group during reconciliation, THEN the Lambda Function SHALL use the AWS managed BasicPricingPlan
3. WHEN creating a Billing Group during reconciliation, THEN the Lambda Function SHALL perform the same idempotency checks as the event-driven handler
4. WHEN creating a Billing Group during reconciliation, THEN the Lambda Function SHALL use the same error handling logic as the event-driven handler
5. WHEN a Billing Group already exists during reconciliation, THEN the Lambda Function SHALL skip creation and log the existing Billing Group ARN

### Requirement 6

**User Story:** As a platform engineer, I want the Lambda function to have appropriate IAM permissions for Organizations and Billing Conductor, so that it can list transfers and manage billing groups.

#### Acceptance Criteria

1. WHEN the IAM Role is created, THEN the Automation System SHALL grant the organizations:ListInboundResponsibilityTransfers permission with wildcard resource
2. WHEN the IAM Role is created, THEN the Automation System SHALL grant the billingconductor:ListPricingPlans permission with wildcard resource
3. WHEN the IAM Role is created, THEN the Automation System SHALL grant the billingconductor:ListBillingGroups permission with wildcard resource
4. WHEN the IAM Role is created, THEN the Automation System SHALL grant the billingconductor:CreateBillingGroup permission with wildcard resource
5. WHEN CDK Nag checks run, THEN the Automation System SHALL suppress AwsSolutions-IAM5 for Billing Conductor and Organizations permissions with justification that these APIs do not support resource-level permissions

### Requirement 7

**User Story:** As a platform engineer, I want the reconciliation to handle partial failures gracefully, so that one failed transfer doesn't stop the entire reconciliation.

#### Acceptance Criteria

1. WHEN processing a billing transfer fails, THEN the Lambda Function SHALL log the error with transfer details and continue processing remaining transfers
2. WHEN multiple transfers fail during reconciliation, THEN the Lambda Function SHALL collect all errors and include them in the reconciliation summary
3. WHEN all transfers are processed, THEN the Lambda Function SHALL return success even if some individual transfers failed
4. WHEN the reconciliation summary is logged, THEN the summary SHALL include the count of successful operations and the count of failed operations
5. WHEN a critical error occurs that prevents reconciliation from continuing, THEN the Lambda Function SHALL log the error and throw an exception to trigger EventBridge retry

### Requirement 8

**User Story:** As a platform engineer, I want resources to be tagged for cost allocation and management, so that I can track costs and manage resources effectively.

#### Acceptance Criteria

1. WHEN resources are created, THEN the Automation System SHALL apply a tag with key Project and value BillingTransferAutomation
2. WHEN resources are created, THEN the Automation System SHALL apply a tag with key Environment and value corresponding to the deployment environment
3. WHEN resources are created, THEN the Automation System SHALL apply a tag with key ManagedBy and value CDK
4. WHEN resources are created, THEN the Automation System SHALL apply tags to all taggable resources including Lambda Function, EventBridge Scheduler, Dead Letter Queue, and CloudWatch Alarm
5. WHEN CDK synthesis occurs, THEN the Automation System SHALL verify that all resources have the required tags applied
