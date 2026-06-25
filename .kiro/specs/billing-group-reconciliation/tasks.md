# Implementation Plan

- [x] 1. Set up Lambda function structure and shared services
  - Create directory structure for reconciliation Lambda handler
  - Import and configure shared BillingConductorService from event handler
  - Set up structured logging utility with JSON format
  - Configure error handling utilities with retry logic
  - _Requirements: 1.1, 1.5, 3.1_

- [x] 2. Update Organizations service to support direct and indirect transfer listing
  - Update existing OrganizationsService in lib/lambda/billing-group-reconciliation/services/
  - Rename listAccountsWithBillingTransfers to listDirectBillingTransfers (calls API without Id parameter)
  - Add new listIndirectBillingTransfers method (calls API with Id parameter for nested transfers)
  - Update filtering logic to work for both direct and indirect transfers (ACCEPTED status and BILLING type)
  - Ensure error handling with retry works for both methods
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 3. Update reconciliation service to process direct and indirect transfers
  - Update ReconciliationService to call listDirectBillingTransfers first
  - For each direct ACCEPTED transfer, call listIndirectBillingTransfers with the transfer Id
  - Process only indirect ACCEPTED transfers for billing group creation
  - Update reconciliation summary to track directTransfersChecked and indirectTransfersChecked
  - Maintain existing logic for checking billing groups and creating with bg-{accountId} naming
  - Keep idempotency checks and partial failure handling
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 7.1_

- [x] 4. Implement Lambda handler entry point
  - Create index.ts handler function
  - Add scheduler event parsing and validation
  - Integrate ReconciliationService and OrganizationsService
  - Implement response formatting with statusCode 200 and summary
  - Add execution duration tracking
  - _Requirements: 1.2, 2.4_

- [x] 5. Implement comprehensive error handling and logging
  - Add error categorization (transient, permanent, critical)
  - Implement exponential backoff retry logic for transient errors
  - Add error collection in reconciliation summary
  - Implement structured logging for all operations
  - Add ERROR level logging with error.message, error.stack, and error.code
  - Implement critical error handling with exception throwing
  - _Requirements: 3.1, 3.2, 7.2, 7.4, 7.5_

- [x] 6. Implement reconciliation summary generation
  - Create summary data structure with all required fields
  - Add counts for transfersChecked, billingGroupsCreated, billingGroupsExisted
  - Include errors array with accountId, error message, and timestamp
  - Add execution duration to summary
  - Implement summary logging at completion
  - _Requirements: 4.5, 7.4_

- [x] 7. Create CDK stack for reconciliation infrastructure
  - Create BillingGroupReconciliationStack class
  - Define Lambda function with Node.js 22.x runtime and 512 MB memory
  - Set timeout to 15 minutes (900 seconds)
  - Enable X-Ray tracing with ACTIVE mode
  - Configure environment variables (LOG_LEVEL, PRICING_PLAN_NAME)
  - _Requirements: 1.1, 1.3, 1.4_

- [x] 8. Configure IAM permissions for Lambda function
  - Create IAM role for Lambda execution
  - Grant organizations:ListAccounts permission with wildcard resource
  - Grant billingconductor:ListPricingPlans permission with wildcard resource
  - Grant billingconductor:ListBillingGroups permission with wildcard resource
  - Grant billingconductor:CreateBillingGroup permission with wildcard resource
  - Add AWSLambdaBasicExecutionRole for CloudWatch Logs
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4_

- [x] 9. Create EventBridge Scheduler for daily execution
  - Create EventBridge Schedule with cron expression cron(0 0 * * ? *)
  - Configure target as Lambda function
  - Set input payload with source: "scheduler" and action: "reconcile-all"
  - Configure retry policy with exponential backoff (2 max attempts)
  - Create IAM role for scheduler to invoke Lambda
  - _Requirements: 2.1, 2.3, 3.5_

- [x] 10. Configure Dead Letter Queue and CloudWatch Alarm
  - Create SQS Dead Letter Queue with 14-day retention
  - Associate DLQ with Lambda function
  - Create CloudWatch Alarm for DLQ message count > 0
  - Set alarm evaluation period to 5 minutes
  - Configure alarm to remain in ALARM state while messages exist
  - _Requirements: 3.3, 3.4_

- [x] 11. Apply resource tags to all infrastructure
  - Add tag Project: BillingTransferAutomation to all resources
  - Add tag Environment: {env} to all resources
  - Add tag ManagedBy: CDK to all resources
  - Apply tags to Lambda, EventBridge Scheduler, DLQ, and CloudWatch Alarm
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 12. Add CDK Nag suppressions with justifications
  - Suppress AwsSolutions-IAM5 for Billing Conductor wildcard permissions
  - Add justification: "Billing Conductor APIs do not support resource-level permissions"
  - Suppress AwsSolutions-IAM5 for Organizations wildcard permissions
  - Add justification: "Organizations APIs do not support resource-level permissions"
  - Suppress AwsSolutions-IAM4 for AWSLambdaBasicExecutionRole
  - Add justification: "AWS managed policy appropriate for CloudWatch Logs access"
  - _Requirements: 6.5_

- [ ]* 13. Write unit tests for reconciliation service
- [ ]* 13.1 Test scheduler event validation
  - Test valid scheduler event parsing
  - Test invalid event handling (wrong source, missing action)
  - Test event validation edge cases
  - _Requirements: 2.4_

- [ ]* 13.2 Test billing transfer filtering logic
  - Test filtering for ACCEPTED status transfers
  - Test filtering for BILLING type transfers
  - Test exclusion of TERMINATED transfers
  - Test exclusion of PENDING transfers
  - _Requirements: 4.2, 4.4_

- [ ]* 13.3 Test reconciliation summary generation
  - Test summary structure with all required fields
  - Test counts calculation (created, existed, errors)
  - Test error collection in summary
  - Test duration tracking
  - _Requirements: 4.5, 7.4_

- [ ]* 13.4 Write property test for transfer filtering
  - **Property 6: Only ACCEPTED BILLING direct transfers are processed**
  - **Validates: Requirements 4.2**

- [ ]* 13.5 Write property test for indirect transfer filtering
  - **Property 7: Only ACCEPTED BILLING indirect transfers are processed**
  - **Validates: Requirements 4.4**

- [ ]* 13.6 Write property test for idempotency
  - **Property 10: Billing group creation is idempotent**
  - **Validates: Requirements 5.3, 5.5**

- [ ]* 13.7 Write property test for partial failure handling
  - **Property 11: Partial failures don't stop reconciliation**
  - **Validates: Requirements 7.1, 7.3**

- [ ]* 13.8 Write property test for error collection
  - **Property 12: All errors are collected in summary**
  - **Validates: Requirements 7.2, 7.4**

- [ ]* 14. Write integration tests for reconciliation stack
- [ ]* 14.1 Test CDK stack synthesis
  - Verify stack synthesizes without errors
  - Verify all resources are created
  - Verify CDK Nag checks pass
  - _Requirements: 1.1, 6.5_

- [ ]* 14.2 Test Lambda function configuration
  - Verify Node.js 22.x runtime
  - Verify 512 MB memory allocation
  - Verify 15-minute timeout
  - Verify X-Ray tracing enabled
  - Verify environment variables set correctly
  - _Requirements: 1.1, 1.3, 1.4_

- [ ]* 14.3 Test IAM permissions
  - Verify Organizations permissions granted
  - Verify Billing Conductor permissions granted
  - Verify CloudWatch Logs permissions granted
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4_

- [ ]* 14.4 Test EventBridge Scheduler configuration
  - Verify schedule expression is correct
  - Verify Lambda target configured
  - Verify input payload structure
  - Verify retry policy configured
  - _Requirements: 2.1, 2.3, 3.5_

- [ ]* 14.5 Test Dead Letter Queue and alarm
  - Verify DLQ created with 14-day retention
  - Verify DLQ associated with Lambda
  - Verify CloudWatch alarm configured
  - Verify alarm threshold set to 1
  - _Requirements: 3.3, 3.4_

- [x] 15. Add reconciliation stack to pipeline deployment
  - Verify BillingGroupReconciliationStack is imported in lib/stacks/pipeline-stack.ts
  - Verify stack is instantiated in ApplicationStage with appropriate configuration
  - Verify environment-specific settings are configured (scheduleExpression, environment tag)
  - Verify stack is included in pipeline's deployment stage
  - Note: This project uses CDK Pipeline architecture - see .kiro/specs/common/deployment-architecture.md
  - _Requirements: 1.1_



## Implementation Status

All core implementation tasks have been completed. The billing group reconciliation feature is fully implemented and deployed through the CDK Pipeline.

### What's Been Implemented

✅ **Core Lambda Function**: Reconciliation handler with event validation and error handling
✅ **Organizations Service**: Direct and indirect billing transfer listing with pagination
✅ **Reconciliation Service**: Orchestrates reconciliation of all transfers with partial failure handling
✅ **Billing Conductor Integration**: Reuses shared service for billing group creation
✅ **Error Handling**: Comprehensive error categorization, retry logic, and structured logging
✅ **CDK Infrastructure**: Complete stack with Lambda, EventBridge Scheduler, DLQ, and CloudWatch Alarm
✅ **IAM Permissions**: Least privilege permissions for Organizations and Billing Conductor
✅ **Pipeline Integration**: Stack is instantiated in ApplicationStage for automatic deployment
✅ **Security Compliance**: CDK Nag suppressions with proper justifications
✅ **Monitoring**: CloudWatch Logs, X-Ray tracing, and DLQ alarm configured

### Testing Status

⚠️ **Optional Testing Tasks (13-14)**: Marked as optional per spec workflow. These include:
- Unit tests for reconciliation service components
- Property-based tests for correctness properties
- Integration tests for CDK stack

These tests can be implemented if comprehensive testing coverage is desired, but are not required for core functionality.

### Next Steps

The feature is ready for use. To test the reconciliation:

1. **Manual Invocation**: Use the AWS Lambda console or CLI to invoke the function with a test event:
   ```json
   {
     "source": "scheduler",
     "action": "reconcile-all"
   }
   ```

2. **Monitor Execution**: Check CloudWatch Logs at `/aws/lambda/billing-group-reconciliation`

3. **Verify Results**: Check Billing Conductor console for created billing groups

4. **Schedule Execution**: The EventBridge Scheduler is configured to run monthly (1st of each month at midnight UTC)

### Documentation Tasks (Not Included)

The following documentation tasks were removed as they are not coding tasks:
- CloudWatch Logs Insights queries documentation
- Deployment and operations documentation

These can be created separately as operational documentation if needed.
