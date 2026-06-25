# Implementation Plan

## Core Implementation (Completed)

- [x] 1. Set up Lambda function structure and dependencies
  - Create Lambda handler directory at `lib/lambda/billing-group-event-handler/`
  - Install required dependencies: `@aws-sdk/client-billingconductor`
  - Configure TypeScript for Lambda compilation
  - Set up basic handler entry point with event type definitions
  - _Requirements: 1.1, 1.3, 1.4_

- [x] 2. Implement Logger utility for structured logging
  - Use shared `logger` singleton from `lib/lambda/common/utils/logger.ts` (AWS Lambda Powertools)
  - Logger includes timestamp (ISO 8601), level, message, service name, and context
  - Error logging includes error.message, error.stack, and error.code fields
  - _Requirements: 2.5, 3.1, 3.2_

- [x] 3. Implement Billing Conductor Service
  - Use shared service from `lib/lambda/common/services/billing-conductor-service.ts`
  - Implements `getBasicPricingPlanArn()` method to find BasicPricingPlan
  - Implements `findBillingGroupByAccount()` method for idempotency checks
  - Implements `createBillingGroup()` method with accountId, pricingPlanArn, and transferArn parameters
  - Uses ResponsibilityTransferArn in AccountGrouping parameter for billing transfer relationships
  - Configured with retry strategy (max 3 attempts, exponential backoff)
  - _Requirements: 4.2, 4.3, 4.5, 4.6, 5.1, 5.2, 5.3, 7.1_

- [x] 4. Implement Lambda handler with event processing logic
  - Created main handler function in `lib/lambda/billing-group-event-handler/index.ts`
  - Parses and validates EventBridge event structure
  - Extracts Bill-Source Account ID from `source.managementAccountId`
  - Extracts ResponsibilityTransferArn from `arn` field in serviceEventDetails
  - Implements event routing for ResponsibilityTransferAccepted and ResponsibilityTransferTerminated
  - Returns proper response structure with statusCode 200 and operation details
  - _Requirements: 1.2, 2.1, 2.2, 4.1, 4.2_

- [x] 5. Implement idempotency logic
  - Uses `ensureBillingGroup()` which checks for existing billing groups
  - Logs existing billing group ARN when found
  - Returns success response without creating duplicate
  - Handles ConflictException as success case
  - _Requirements: 4.3, 4.4, 7.3_

- [x] 5a. Implement Powertools Idempotency for duplicate event prevention
  - Added `@aws-lambda-powertools/idempotency` package
  - Configured DynamoDBPersistenceLayer with idempotency table
  - Set `eventKeyJmesPath: 'detail.serviceEventDetails.id'` to use transfer ID as idempotency key
  - Configured 24-hour expiration to align with billing periods
  - Wrapped `handleBillingTransferEvent` with `makeIdempotent`
  - Created DynamoDB table with TTL attribute for automatic cleanup
  - _Requirements: 4.3, 4.4_

- [x] 6. Implement comprehensive error handling
  - Try-catch blocks for all API calls in shared services
  - Throttling retry logic with exponential backoff via `retryWithBackoff()`
  - Handles ResourceNotFoundException with proper logging and exception
  - Logs all API failures with error code, message, and request parameters
  - Unhandled exceptions are logged with stack trace
  - _Requirements: 7.1, 7.2, 7.4, 7.5_

- [x] 7. Create CDK stack for billing group event handler
  - Created `lib/stacks/billing-group-event-handler-stack.ts`
  - Lambda function with Node.js 22.x runtime, 256 MB memory, 2-minute timeout
  - X-Ray tracing enabled with ACTIVE mode
  - Dead Letter Queue with 14-day retention
  - DLQ associated with Lambda function
  - DynamoDB idempotency table with TTL and point-in-time recovery
  - Lambda environment variable IDEMPOTENCY_TABLE_NAME configured
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 3.3_

- [x] 8. Configure EventBridge rule for billing transfer events
  - EventBridge Rule with event pattern for aws.organizations source
  - Filters for ResponsibilityTransferAccepted and ResponsibilityTransferTerminated events
  - Event pattern includes eventSource organizations.amazonaws.com
  - Event pattern includes eventType AwsServiceEvent and detail-type AWS Service Event via CloudTrail
  - Lambda function added as target
  - Configured with 2 retry attempts with exponential backoff and 2-hour max event age
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.5_

- [x] 9. Configure IAM permissions for Lambda function
  - IAM role created for Lambda execution
  - Granted billingconductor:ListPricingPlans permission with wildcard resource
  - Granted billingconductor:ListBillingGroups permission with wildcard resource
  - Granted billingconductor:CreateBillingGroup permission with wildcard resource
  - Granted CloudWatch Logs write permissions
  - Granted X-Ray trace submission permissions
  - Granted SQS SendMessage permission for DLQ
  - CDK Nag suppression for AwsSolutions-IAM5 with justification
  - CDK Nag suppression for AwsSolutions-IAM4 with justification
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 10. Configure CloudWatch monitoring and alarms
  - CloudWatch Alarm for DLQ message count (threshold > 0)
  - Alarm configured to trigger within 5 minutes of message arrival
  - Alarm remains in ALARM state while messages exist
  - _Requirements: 3.4_

- [x] 11. Apply resource tags
  - Tag with key Project and value SampleAutomationsForBillingTransfer
  - Tag with key Environment and value from deployment context
  - Tag with key ManagedBy and value CDK
  - Tags applied to Lambda Function, EventBridge Rule, DLQ, and CloudWatch Alarms
  - Tags verified during CDK synthesis
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 12. Create unit tests for CDK stack
  - Created `test/billing-group-event-handler-stack.test.ts`
  - Tests for stack synthesis with different execution modes
  - Tests for Lambda configuration (runtime, memory, timeout, tracing)
  - Tests for DLQ configuration (retention period, encryption)
  - Tests for EventBridge rule event pattern
  - Tests for Scheduler configuration
  - Tests for resource tags
  - _Requirements: All_

- [x] 13. Create integration test script
  - Created `test/integration/billing-group-event-handler.integration.test.ts`
  - Tests Lambda invocation with sample ResponsibilityTransferAccepted event
  - Tests billing group creation in Billing Conductor
  - Tests idempotency by invoking with same event twice
  - Tests CloudWatch Logs contain expected entries
  - Tests ResponsibilityTransferTerminated event handling
  - _Requirements: All_

## Bug Fixes

- [x] 14. Fix invalid event source status code
  - Updated `handleUnknownEvent()` to return statusCode 500 instead of 400
  - Aligns with requirements 2.6: "SHALL log an error and return a response with statusCode 500"
  - Updated function documentation to reflect correct status code
  - _Requirements: 2.6_

## Optional Testing Tasks

- [ ]* 14. Implement property-based tests for correctness properties
- [ ]* 14.1 Set up fast-check testing framework
  - Install fast-check as dev dependency
  - Configure test runner to support property-based tests
  - Create test utilities for generating valid test data
  - _Requirements: All_

- [ ]* 14.2 Write property test for Lambda response structure (Property 1)
  - **Property 1: Lambda response structure**
  - **Validates: Requirements 1.2**
  - Generate random valid billing transfer events
  - Verify response contains statusCode 200, message, accountId, and action fields
  - Run 100 iterations minimum

- [ ]* 14.3 Write property test for structured log entry format (Property 2)
  - **Property 2: Structured log entry format**
  - **Validates: Requirements 3.1, 2.5**
  - Generate random log contexts and messages
  - Verify all log entries contain timestamp (ISO 8601), level, message, and context
  - Run 100 iterations minimum

- [ ]* 14.4 Write property test for error log completeness (Property 3)
  - **Property 3: Error log completeness**
  - **Validates: Requirements 3.2**
  - Generate random errors with different properties
  - Verify ERROR logs contain error.message, error.stack, and error.code
  - Run 100 iterations minimum

- [ ]* 14.5 Write property test for Bill-Source Account extraction (Property 4)
  - **Property 4: Bill-Source Account extraction**
  - **Validates: Requirements 4.1**
  - Generate random ResponsibilityTransferAccepted events
  - Verify extracted accountId matches source.managementAccountId
  - Run 100 iterations minimum

- [ ]* 14.6 Write property test for Transfer ARN extraction (Property 4a)
  - **Property 4a: Transfer ARN extraction**
  - **Validates: Requirements 4.2**
  - Generate random ResponsibilityTransferAccepted events
  - Verify extracted transferArn matches serviceEventDetails.arn
  - Run 100 iterations minimum

- [ ]* 14.7 Write property test for idempotency check execution (Property 5)
  - **Property 5: Idempotency check execution**
  - **Validates: Requirements 4.2**
  - Generate random account IDs
  - Verify findBillingGroupByAccount is called before createBillingGroup
  - Run 100 iterations minimum

- [ ]* 14.8 Write property test for idempotent duplicate handling (Property 6)
  - **Property 6: Idempotent duplicate handling**
  - **Validates: Requirements 4.3**
  - Generate random existing billing groups
  - Verify function returns success without creating duplicate
  - Verify existing ARN is logged
  - Run 100 iterations minimum

- [ ]* 14.9 Write property test for billing group structure (Property 7)
  - **Property 7: Billing group structure**
  - **Validates: Requirements 4.5**
  - Generate random transfer ARNs and account IDs
  - Verify billing group uses ResponsibilityTransferArn in AccountGrouping
  - Verify primaryAccountId matches bill-source account
  - Run 100 iterations minimum

- [ ]* 14.10 Write property test for billing group naming convention (Property 8)
  - **Property 8: Billing group naming convention**
  - **Validates: Requirements 4.5**
  - Generate random account IDs (12-digit strings)
  - Verify billing group name follows pattern bg-{accountId}
  - Run 100 iterations minimum

- [ ]* 14.11 Write property test for BasicPricingPlan discovery (Property 9)
  - **Property 9: BasicPricingPlan discovery**
  - **Validates: Requirements 5.2**
  - Generate random pricing plan lists containing BasicPricingPlan
  - Verify function finds and returns BasicPricingPlan ARN
  - Run 100 iterations minimum

- [ ]* 14.12 Write property test for pricing plan association (Property 10)
  - **Property 10: Pricing plan association**
  - **Validates: Requirements 5.3, 5.5**
  - Generate random billing group creation requests
  - Verify billing group is associated with BasicPricingPlan ARN
  - Run 100 iterations minimum

- [ ]* 14.13 Write property test for throttling retry behavior (Property 11)
  - **Property 11: Throttling retry behavior**
  - **Validates: Requirements 7.1**
  - Generate random throttling errors
  - Verify retry occurs with exponential backoff up to 3 attempts
  - Run 100 iterations minimum

- [ ]* 14.14 Write property test for failed API call logging (Property 12)
  - **Property 12: Failed API call logging**
  - **Validates: Requirements 7.4**
  - Generate random API failures with different error codes
  - Verify error logs contain error code, message, and request parameters
  - Run 100 iterations minimum

- [ ]* 14.15 Write property test for unhandled exception logging (Property 13)
  - **Property 13: Unhandled exception logging**
  - **Validates: Requirements 7.5**
  - Generate random unhandled exceptions
  - Verify error logs contain complete stack trace
  - Run 100 iterations minimum

- [ ]* 15. Implement example-based tests for edge cases
- [ ]* 15.1 Write example test for missing BasicPricingPlan error handling
  - **Example 1: Missing BasicPricingPlan error handling**
  - **Validates: Requirements 5.4**
  - Mock ListPricingPlans to return empty list
  - Verify function logs error and throws exception

- [ ]* 15.2 Write example test for ResourceNotFoundException handling
  - **Example 2: ResourceNotFoundException handling**
  - **Validates: Requirements 7.2**
  - Mock API to throw ResourceNotFoundException
  - Verify function logs error with resource type and identifier
  - Verify exception is thrown

- [ ]* 15.3 Write example test for ConflictException handling
  - **Example 3: ConflictException handling**
  - **Validates: Requirements 7.3**
  - Mock CreateBillingGroup to throw ConflictException
  - Verify function treats as success
  - Verify existing resource ARN is logged

- [ ]* 16. Final checkpoint - Ensure all tests pass
  - Run all unit tests and verify they pass
  - Run all property-based tests and verify they pass
  - Run all example-based tests and verify they pass
  - Ensure test coverage meets project standards
  - Ask the user if questions arise
