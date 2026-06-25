# Requirements Document

## Introduction

This feature adds email notification capabilities for billing transfer termination events. When a billing transfer relationship is terminated, stakeholders need to be notified so they can take appropriate action (e.g., update billing arrangements, remove billing groups, update documentation).

## Glossary

- **Billing Transfer**: A relationship where one AWS management account (bill-transfer/payer) manages and pays for another management account's (bill-source/customer) consolidated bill
- **Bill-Transfer Account**: The payer account that manages and pays the customer's bill
- **Bill-Source Account**: The customer account whose bill is being managed by the payer
- **ResponsibilityTransferTerminated Event**: CloudTrail event triggered when a billing transfer relationship ends
- **SNS Topic**: Amazon Simple Notification Service topic used for publishing messages to subscribers
- **Email Subscription**: An SNS subscription that delivers messages to an email address
- **Event Handler Lambda**: The Lambda function that processes billing transfer events from EventBridge

## Requirements

### Requirement 1

**User Story:** As a billing operations team member, I want to receive email notifications when billing transfers are terminated, so that I can take timely action to update billing arrangements and documentation.

#### Acceptance Criteria

1. WHEN a ResponsibilityTransferTerminated event occurs THEN the Event Handler Lambda SHALL publish a notification message to an SNS topic
2. WHEN the SNS topic receives a termination notification THEN the system SHALL deliver the message to all subscribed email addresses
3. WHEN a termination notification is sent THEN the message SHALL include the transfer ID, customer account ID, payer account ID, and termination timestamp
4. WHEN a termination notification is sent THEN the message SHALL include the transfer start date and end date
5. WHEN the Event Handler Lambda publishes to SNS THEN the system SHALL use structured JSON format for the message body

### Requirement 2

**User Story:** As a system administrator, I want to configure email recipients for termination notifications, so that the right people are informed when transfers end.

#### Acceptance Criteria

1. WHEN deploying the stack THEN the system SHALL create an SNS topic for billing transfer termination notifications
2. WHEN the SNS topic is created THEN the system SHALL support email subscription configuration via CDK stack parameters
3. WHEN an email address is subscribed THEN the system SHALL send a confirmation email requiring user action
4. WHEN multiple email addresses are provided THEN the system SHALL create subscriptions for all addresses
5. WHEN no email addresses are provided THEN the system SHALL create the SNS topic without subscriptions

### Requirement 3

**User Story:** As a developer, I want the Event Handler Lambda to have proper IAM permissions for SNS, so that it can publish termination notifications without errors.

#### Acceptance Criteria

1. WHEN the Event Handler Lambda is deployed THEN the system SHALL grant sns:Publish permission for the termination notification topic
2. WHEN the Lambda publishes to SNS THEN the system SHALL use the topic ARN from environment variables
3. WHEN SNS publish fails THEN the Lambda SHALL log the error with structured context
4. WHEN SNS publish fails THEN the Lambda SHALL NOT throw an error that triggers EventBridge retry
5. WHEN SNS publish succeeds THEN the Lambda SHALL log the message ID and topic ARN

### Requirement 4

**User Story:** As a billing operations team member, I want termination notifications to be human-readable, so that I can quickly understand what action is needed.

#### Acceptance Criteria

1. WHEN formatting the email subject THEN the system SHALL use the pattern "Billing Transfer Terminated: Account {accountId}"
2. WHEN formatting the email body THEN the system SHALL include a clear summary of the terminated transfer
3. WHEN formatting the email body THEN the system SHALL include the customer account ID and payer account ID
4. WHEN formatting the email body THEN the system SHALL include the transfer start date and end date in human-readable format
5. WHEN formatting the email body THEN the system SHALL include the transfer ID for reference

### Requirement 5

**User Story:** As a developer, I want the Event Handler Lambda to skip billing group operations for terminated transfers, so that we don't waste resources on transfers that are ending.

#### Acceptance Criteria

1. WHEN a ResponsibilityTransferTerminated event is received THEN the Lambda SHALL NOT call ensureBillingGroup
2. WHEN a ResponsibilityTransferTerminated event is received THEN the Lambda SHALL NOT call DescribeResponsibilityTransfer
3. WHEN a ResponsibilityTransferTerminated event is received THEN the Lambda SHALL log the termination with transfer details
4. WHEN a ResponsibilityTransferTerminated event is received THEN the Lambda SHALL publish to SNS if notifications are enabled
5. WHEN a ResponsibilityTransferTerminated event is received THEN the Lambda SHALL return a success response with action 'skipped'
