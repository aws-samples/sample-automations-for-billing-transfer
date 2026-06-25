# Implementation Plan

- [x] 1. Set up project structure and core interfaces
  - Create directory structure for CUR automation Lambda (lib/lambda/cur-reconciliation/)
  - Create subdirectories: models/, services/, utils/
  - Define TypeScript interfaces for all data models
  - Set up testing framework configuration for CUR automation
  - _Requirements: 1.1, 2.1, 9.1_

- [x] 2. Implement configuration service
  - Create ViewReportConfig interface for view-specific configurations
  - Create ReportConfigurationTemplate interface with optional myViewReportConfig and showbackViewReportConfig
  - Implement ConfigurationService class with loadConfiguration method
  - Implement JSON schema validation requiring at least one view configuration
  - Implement hasMyViewConfig, hasShowbackViewConfig, isMyViewEnabled, and isShowbackViewEnabled helper methods
  - Add error handling for invalid JSON and missing required fields
  - Validate that at least one of myViewReportConfig or showbackViewReportConfig is present
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.14, 2.15, 10.1, 10.2, 10.3, 10.4_

- [x] 2.1 Write property test for configuration validation
  - **Property 7: Configuration template loads successfully**
  - **Property 8: Configuration validation detects missing view configurations**
  - **Property 9: My View configuration validation**
  - **Property 10: Showback View configuration validation**
  - **Property 42: Configuration is valid JSON**
  - **Property 43: Configuration validates against schema**
  - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 10.1, 10.2, 10.3**

- [x] 3. Implement billing transfer service
  - Create BillingTransferRelationship interface
  - Implement BillingTransferService class
  - Implement listAllInboundTransfers method with pagination handling
  - Implement listIndirectTransfers method for nested transfers
  - Handle Organizations API pagination using Id parameter (not NextToken)
  - _Requirements: 1.1, 3.1, 3.2, 3.4_

- [ ]* 3.1 Write property test for transfer discovery
  - **Property 1: All billing transfers are discovered**
  - **Property 12: Transfer chains are fully processed**
  - **Validates: Requirements 1.1, 3.1, 3.2, 3.3, 3.4**

- [x] 4. Implement billing group validation service
  - Create BillingGroupValidationResult interface
  - Implement BillingGroupValidationService class
  - Implement validateBillingGroupExists method
  - Check billing group status (ACTIVE vs PRIMARY_ACCOUNT_MISSING)
  - Add detailed error messages for missing billing groups
  - _Requirements: 1.2, 6.1_

- [x] 5. Implement billing view service
  - Create BillingView interface
  - Implement BillingViewService class
  - Implement getBillingViewForTransfer method for retrieving specific view types
  - Implement getBillingViewsForTransfer method for retrieving all view types
  - Filter for BILLING_TRANSFER and BILLING_TRANSFER_SHOWBACK view types
  - Extract billing view ARNs correctly
  - _Requirements: 1.2, 4.1, 4.2, 4.3, 4.4_

- [ ]* 5.1 Write property test for billing view retrieval
  - **Property 2: Billing view ARN retrieval is consistent**
  - **Validates: Requirements 1.2, 4.1, 4.2**

- [x] 6. Implement S3 validation service
  - Create S3ValidationResult interface
  - Implement S3ValidationService class
  - Implement validateBucket method to check bucket existence
  - Validate bucket policy for Legacy CUR delivery permissions (billingreports.amazonaws.com service principal)
  - Generate detailed error messages with remediation steps
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ]* 6.1 Write property test for S3 validation
  - **Property 27: S3 bucket existence is verified**
  - **Property 28: S3 bucket policy is validated**
  - **Property 29: S3 validation errors include remediation**
  - **Validates: Requirements 6.1, 6.2, 6.3**

- [x] 7. Implement CUR report service
  - Create CURReportCreationRequest and CURReportCreationResult interfaces
  - Update CURReportCreationRequest to accept ViewReportConfig instead of full template
  - Implement CURReportService class using Legacy CUR API (@aws-sdk/client-cost-and-usage-report-service)
  - Implement checkReportExists method using DescribeReportDefinitions operation
  - Implement createReport method using PutReportDefinition operation with BillingViewArn parameter
  - Implement validateReportConfiguration method
  - Apply view-specific configuration settings (timeUnit, format, compression, additionalSchemaElements, S3 settings)
  - Exclude SPLIT_COST_ALLOCATION_DATA from additionalSchemaElements for showback views
  - Generate report names with account ID and view type
  - _Requirements: 1.3, 1.4, 1.5, 1.6, 2.6, 2.7, 2.10, 2.11, 2.12, 2.13, 4.9, 4.10, 13.4, 13.5, 13.6, 13.7_

- [ ]* 7.1 Write property test for CUR report creation
  - **Property 3: Report existence check is accurate**
  - **Property 4: Reports are created when missing**
  - **Property 5: Billing view ARN is included in report definition**
  - **Property 6: View-specific configuration is applied to reports**
  - **Property 11: Split cost allocation is excluded for showback views**
  - **Property 18: View-specific S3 buckets are used**
  - **Property 19: View-specific S3 prefixes are used**
  - **Property 22: Report naming follows convention**
  - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 2.6, 2.7, 2.10, 2.11, 2.12, 2.13, 4.9, 4.10, 13.4, 13.5**

- [x] 8. Implement support case service
  - Create BackfillRequest and SupportCaseResult interfaces
  - Implement SupportCaseService class
  - Implement createBackfillCase method using Support API CreateCase operation
  - Set appropriate service code and category code for Legacy CUR reports
  - Format subject with report name and backfill request
  - Format communication body with report name, billing view ARN, and billing period range
  - Apply severity code from view-specific configuration
  - Set issue type to customer-service
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10_

- [ ]* 8.1 Write property test for support case creation
  - **Property 50: My View backfill flag is checked**
  - **Property 51: Showback View backfill flag is checked**
  - **Property 52: Support cases created for My View when backfill enabled**
  - **Property 53: Support cases created for Showback View when backfill enabled**
  - **Property 54: Support case uses correct codes**
  - **Property 55: Support case subject includes report details**
  - **Property 56: Support case body includes required information**
  - **Property 57: Support case severity matches view configuration**
  - **Property 58: Support case issue type is customer-service**
  - **Property 59: Support case ID is logged**
  - **Property 60: Support case failures don't block processing**
  - **Property 61: My View backfill disabled prevents case creation**
  - **Property 62: Showback View backfill disabled prevents case creation**
  - **Property 63: Independent backfill handling for view types**
  - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12**

- [x] 9. Implement reconciliation service
  - Create ReconciliationSummary interface with separate counts for My View and Showback View
  - Implement ReconciliationService class
  - Implement reconcileAllTransfers method
  - Implement processTransferForViewType private method for independent view processing
  - Orchestrate full workflow: list transfers, validate billing groups, process each view type conditionally
  - Process My View reports only if myViewReportConfig is present and enabled
  - Process Showback View reports only if showbackViewReportConfig is present and enabled
  - Implement error isolation (continue processing on failures)
  - Generate comprehensive reconciliation summary with view-specific counts
  - Track My View and Showback View reports separately (created, already existed, failed)
  - Track support cases created and failed
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 13.1, 13.2, 13.3_

- [ ]* 9.1 Write property test for reconciliation workflow
  - **Property 13: My View reports created when configured**
  - **Property 14: Showback View reports created when configured**
  - **Property 15: My View reports skipped when not configured**
  - **Property 16: Showback View reports skipped when not configured**
  - **Property 17: Both view types created when both configured**
  - **Property 23: Idempotency prevents duplicate reports**
  - **Property 24: Existing report configuration is validated**
  - **Property 35: Summary includes all view-specific counts**
  - **Property 38: Failures are isolated**
  - **Property 40: Summary object is returned**
  - **Property 41: Failed transfers include view type and error details**
  - **Validates: Requirements 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.2, 5.3, 5.4, 7.7, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 13.1, 13.2, 13.3**

- [x] 10. Use shared retry utility from lambda-core
  - Import `retryWithBackoff` and `RetryConfig` from `../common/utils/retry` (defined in lambda-core spec)
  - Use retryWithBackoff for all AWS API calls (Organizations, Billing Conductor, Billing, CUR, S3, Support)
  - Retry logic handles throttling errors (TooManyRequestsException) with exponential backoff
  - Retry logic handles transient errors (ServiceUnavailableException)
  - Default 3 retry attempts maximum (configurable via RetryConfig)
  - Shared retry utility logs retry attempts and final errors
  - _Requirements: 8.1, 8.2, 8.5_
  - _Note: Uses shared retry utility from lambda-core, no need to create custom retry implementation_

- [ ]* 10.1 Write property test for retry logic
  - **Property 36: Throttling triggers exponential backoff**
  - **Property 37: Transient errors trigger limited retries**
  - **Property 39: Exhausted retries are marked as failed**
  - **Validates: Requirements 8.1, 8.2, 8.5**

- [x] 11. Use shared Logger from lambda-core
  - Import `logger` singleton from `../common/utils/logger` (AWS Lambda Powertools)
  - Logger reads LOG_LEVEL from environment automatically
  - Add logging for execution start and configuration source
  - Add logging for transfer counts
  - Add logging for billing view ARNs and types
  - Add logging for CUR report creation with full details
  - Add logging for skipped operations
  - Add logging for errors with context (account ID, operation)
  - Add logging for execution summary
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - _Note: Uses shared Powertools logger singleton from lambda-core_

- [ ]* 11.1 Write property test for logging
  - **Property 30: Transfer count logging is accurate**
  - **Property 31: Billing view details are logged**
  - **Property 32: Report creation details are logged**
  - **Property 33: Skipped operations are logged**
  - **Property 34: Errors include context**
  - **Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6**

- [x] 12. Implement resource tagging
  - Add tagging logic to CURReportService
  - Apply automation system tag
  - Apply bill-source account ID tag
  - Apply creation timestamp tag
  - Merge view-specific tags with automation tags
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [ ]* 12.1 Write property test for tagging
  - **Property 45: Reports are tagged**
  - **Property 46: Automation tag is present**
  - **Property 47: Account ID tag is present**
  - **Property 48: Timestamp tag is present**
  - **Property 49: View-specific tags are merged**
  - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5**

- [x] 13. Implement Lambda handler
  - Create CURReconciliationEvent and CURReconciliationResult interfaces
  - Implement main handler function
  - Load configuration from S3 or environment
  - Invoke ReconciliationService
  - Return reconciliation summary
  - Handle scheduled event payload
  - _Requirements: 11.3, 11.4_

- [ ]* 13.1 Write property test for Lambda handler
  - **Property 44: Scheduled events trigger workflow**
  - **Validates: Requirements 11.3, 11.4**

- [x] 14. Implement CDK stack
  - Create CURReconciliationStack class
  - Create S3 bucket for configuration template
  - Create managed S3 bucket for CUR report delivery with correct bucket policy for Legacy CUR API (billingreports.amazonaws.com)
  - Add lifecycle policy to managed bucket (transition to Intelligent-Tiering after 30 days)
  - Create Lambda function with NodejsFunction construct
  - Configure Lambda with ARM64 architecture, 15-minute timeout, 512 MB memory
  - Set environment variables for config bucket and key
  - Bundle all AWS SDK dependencies (externalModules: [])
  - Grant S3 read permissions to Lambda
  - Add IAM policies for Organizations, Billing Conductor, Billing, Cost and Usage Report Service (Legacy CUR API), S3, Support APIs
  - Create EventBridge Scheduler with daily schedule
  - Create Dead Letter Queue
  - Create CloudWatch alarms for errors and DLQ messages
  - Add CloudFormation outputs for both bucket names
  - _Requirements: 6.2, 11.1, 11.2, 11.5_

- [x] 14.1 Write unit tests for CDK stack
  - Test EventBridge Scheduler creation
  - Test Lambda function configuration
  - Test IAM permissions
  - Test S3 bucket configuration (both config and CUR destination buckets)
  - Test managed bucket policy for Legacy CUR API (billingreports.amazonaws.com)
  - Test lifecycle policy on managed bucket
  - Test CloudWatch alarms
  - Test CloudFormation outputs
  - _Requirements: 6.2, 11.1, 11.2_

- [x] 15. Create sample configuration template
  - Create export-configuration-template.json file with both view configurations
  - Include version field
  - Add myViewReportConfig section with all required fields including enabled flag
  - Add showbackViewReportConfig section with all required fields including enabled flag
  - Configure timeUnit, format, compression, and additionalSchemaElements for each view
  - Configure S3 destination settings (can use different buckets/prefixes per view)
  - Add sample tags for each view
  - Add backfill configuration for each view (demonstrate independent control)
  - Document all configuration options and flexibility
  - Create example configurations showing: both views enabled, My View only, Showback View only, both disabled
  - _Requirements: 2.1, 2.3, 2.4, 2.6, 2.7, 2.10, 2.11, 2.12, 2.14, 2.15, 13.1, 13.2, 13.3, 13.4, 13.5, 13.8, 14.1, 14.2_

- [x] 16. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Add CDK Nag suppressions
  - Suppress AwsSolutions-IAM5 for wildcard permissions (APIs don't support resource-level)
  - Suppress AwsSolutions-IAM4 for Lambda basic execution role
  - Document all suppressions with clear justifications
  - _Requirements: All (security compliance)_

- [x] 18. Create integration tests
  - Test full reconciliation workflow with mock AWS services
  - Test with myViewReportConfig only (enabled: true)
  - Test with showbackViewReportConfig only (enabled: true)
  - Test with both view configurations enabled
  - Test with both view configurations but one disabled (enabled: false)
  - Test idempotency by running reconciliation multiple times
  - Test error handling with simulated failures
  - Test support case integration when backfill is enabled for My View
  - Test support case integration when backfill is enabled for Showback View
  - Test independent backfill handling (one view enabled, one disabled)
  - _Requirements: All_

- [x] 19. Update project documentation
  - Update README with CUR automation feature description
  - Add deployment instructions for CUR automation stack
  - Document configuration template format and options
  - Add troubleshooting guide
  - _Requirements: All_

- [x] 20. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
