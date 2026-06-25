# Requirements Document

## Introduction

This feature automates the creation and management of AWS Cost and Usage Reports (CUR) for billing transfer relationships using the Legacy CUR API. When a billing transfer relationship is established, the bill-transfer account needs visibility into cost and usage data for each bill-source account. This automation ensures that Cost and Usage Reports are created consistently with standardized configurations, enabling cost analysis, budgeting, and showback/chargeback workflows.

**Note**: This sample uses the **Legacy CUR API** (AWS Cost and Usage Report Service) with the `BillingViewArn` parameter to create reports for billing transfer views. AWS Data Exports (CUR 2.0) also supports billing transfer views (see [Creating exports with billing views](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-billing-view.html)); this sample uses the Legacy CUR API, and adapting it to Data Exports is a reasonable enhancement.

The system operates on a scheduled basis (similar to the reconciliation stack) because Cost and Usage Reports can only be created after the billing transfer relationship becomes active, which occurs on the first day of the month following acceptance.

## Glossary

- **Cost and Usage Report (CUR)**: A comprehensive AWS billing report that provides detailed cost and usage data, delivered to an S3 bucket
- **Legacy CUR API**: The AWS Cost and Usage Report Service API (`@aws-sdk/client-cost-and-usage-report-service`) that supports billing views via the `BillingViewArn` parameter in `ReportDefinition`. This is the API this sample uses.
- **Data Exports API**: AWS CUR 2.0 API (`@aws-sdk/client-bcm-data-exports`). It also supports billing transfer views; this sample uses the Legacy CUR API instead.
- **Report Definition**: A configuration object that defines how a CUR report is generated, including format, granularity, S3 destination, and billing view ARN
- **Bill-Transfer Account**: The management account that manages and pays for another organization's consolidated bill
- **Bill-Source Account**: The management account that generates a consolidated bill (the customer organization)
- **Billing View**: A logical view of billing data that can represent different perspectives (PRIMARY, BILLING_GROUP, BILLING_TRANSFER, BILLING_TRANSFER_SHOWBACK)
- **Billing View ARN**: Amazon Resource Name that uniquely identifies a billing view, required for creating CUR reports scoped to specific billing transfers
- **Cost and Usage Report Service API**: AWS Legacy CUR API for creating, listing, and managing CUR reports with support for billing views via the `BillingViewArn` parameter in `ReportDefinition`
- **Billing Service**: AWS Billing Service that provides APIs for listing and managing billing views
- **Time Unit**: The level of detail for report line items (HOURLY, DAILY, or MONTHLY)
- **Report Format**: The file format for the report (textORcsv or Parquet)
- **Additional Schema Elements**: Optional elements to include in the report (RESOURCES, SPLIT_COST_ALLOCATION_DATA, MANUAL_DISCOUNT_COMPATIBILITY)
- **Report Configuration Template**: A declarative configuration file that defines standardized CUR report settings for the organization
- **My View Report Configuration**: Configuration settings specific to BILLING_TRANSFER view reports (actual costs the bill-transfer account pays)
- **Showback View Report Configuration**: Configuration settings specific to BILLING_TRANSFER_SHOWBACK view reports (showback/chargeback costs configured via Billing Conductor)

## Requirements

### Requirement 1

**User Story:** As a billing administrator, I want CUR reports to be automatically created for each billing transfer relationship, so that I can analyze costs without manual report setup.

#### Acceptance Criteria

1. WHEN the system runs on a schedule THEN the CUR-System SHALL list all active billing transfer relationships
2. WHEN a billing transfer relationship exists THEN the CUR-System SHALL retrieve the billing view ARN for that relationship
3. WHEN a billing view ARN is retrieved THEN the CUR-System SHALL check if a CUR report already exists for that billing view using the Legacy CUR API DescribeReportDefinitions operation
4. WHEN no CUR report exists for a billing view THEN the CUR-System SHALL create a new report using the Legacy CUR API PutReportDefinition operation
5. WHEN creating a CUR report THEN the CUR-System SHALL include the billing view ARN in the ReportDefinition BillingViewArn parameter
6. WHEN a CUR report is created THEN the CUR-System SHALL use configuration settings from the report configuration template

### Requirement 2

**User Story:** As a billing administrator, I want to define separate CUR report settings for "My View" and "Showback View" in a centralized configuration file, so that each view type can have different configurations while following organizational standards.

#### Acceptance Criteria

1. WHEN the CUR-System initializes THEN the CUR-System SHALL load configuration from a Report Configuration Template file
2. WHEN the Report Configuration Template is loaded THEN the CUR-System SHALL validate that the structure contains at least one of myViewReportConfig or showbackViewReportConfig sections
3. WHEN the Report Configuration Template contains myViewReportConfig THEN the CUR-System SHALL validate that all required fields are present for My View reports including the enabled flag
4. WHEN the Report Configuration Template contains showbackViewReportConfig THEN the CUR-System SHALL validate that all required fields are present for Showback View reports including the enabled flag
5. WHEN neither myViewReportConfig nor showbackViewReportConfig is present in the Report Configuration Template THEN the CUR-System SHALL fail validation with a clear error message
6. WHEN creating a My View CUR report THEN the CUR-System SHALL apply configuration settings from the myViewReportConfig section
7. WHEN creating a Showback View CUR report THEN the CUR-System SHALL apply configuration settings from the showbackViewReportConfig section
8. WHEN creating a CUR report THEN the CUR-System SHALL apply the Time Unit value from the view-specific configuration
9. WHEN creating a CUR report THEN the CUR-System SHALL apply the Report Format and Compression values from the view-specific configuration
10. WHEN creating a CUR report THEN the CUR-System SHALL apply the S3 destination settings including bucket name, prefix path, and region from the view-specific configuration
11. WHEN creating a CUR report THEN the CUR-System SHALL apply the Additional Schema Elements list from the view-specific configuration
12. WHEN creating a CUR report THEN the CUR-System SHALL apply the Report Versioning setting from the view-specific configuration
13. WHEN creating a Showback View CUR report THEN the CUR-System SHALL exclude SPLIT_COST_ALLOCATION_DATA from the Additional Schema Elements list
14. WHEN myViewReportConfig has the enabled field set to false THEN the CUR-System SHALL skip My View report creation and log that My View reports are disabled
15. WHEN showbackViewReportConfig has the enabled field set to false THEN the CUR-System SHALL skip Showback View report creation and log that Showback View reports are disabled

### Requirement 3

**User Story:** As a billing administrator, I want the system to handle both direct and indirect billing transfer relationships, so that all transferred accounts have appropriate cost reporting.

#### Acceptance Criteria

1. WHEN listing billing transfers THEN the CUR-System SHALL retrieve all direct inbound billing transfers using the Organizations API
2. WHEN a direct billing transfer is found THEN the CUR-System SHALL list all indirect (nested) transfers associated with that direct transfer
3. WHEN processing transfers THEN the CUR-System SHALL create reports for both direct and indirect billing transfer relationships
4. WHEN multiple transfers exist in a chain THEN the CUR-System SHALL process each transfer independently

### Requirement 4

**User Story:** As a billing administrator, I want the system to optionally create CUR reports for "My View" and/or "Showback/Chargeback View" billing perspectives based on configuration, so that I can track the cost perspectives I need.

#### Acceptance Criteria

1. WHEN a Billing Transfer Relationship is identified THEN the CUR-System SHALL list Billing Views filtered by billing transfer types
2. WHEN listing Billing Views THEN the CUR-System SHALL filter for BILLING_TRANSFER and BILLING_TRANSFER_SHOWBACK view types
3. WHEN myViewReportConfig is present in the Report Configuration Template THEN the CUR-System SHALL retrieve the BILLING_TRANSFER view for the Billing Transfer Relationship
4. WHEN showbackViewReportConfig is present in the Report Configuration Template THEN the CUR-System SHALL retrieve the BILLING_TRANSFER_SHOWBACK view for the Billing Transfer Relationship
5. WHEN myViewReportConfig is present and a BILLING_TRANSFER view is found THEN the CUR-System SHALL create a CUR report for My View
6. WHEN showbackViewReportConfig is present and a BILLING_TRANSFER_SHOWBACK view is found THEN the CUR-System SHALL create a CUR report for Showback View
7. WHEN myViewReportConfig is not present in the Report Configuration Template THEN the CUR-System SHALL skip creation of My View reports
8. WHEN showbackViewReportConfig is not present in the Report Configuration Template THEN the CUR-System SHALL skip creation of Showback View reports
9. WHEN creating a CUR report THEN the CUR-System SHALL include the Billing View ARN in the ReportDefinition BillingViewArn field
10. WHEN generating a report name THEN the CUR-System SHALL use a naming convention that includes the Bill-Source Account ID and the view type identifier

### Requirement 5

**User Story:** As a billing administrator, I want the system to be idempotent, so that running the automation multiple times does not create duplicate reports.

#### Acceptance Criteria

1. WHEN checking for existing reports THEN the CUR-System SHALL list all CUR reports using the Legacy CUR API DescribeReportDefinitions operation
2. WHEN a CUR report with the same name exists THEN the CUR-System SHALL skip creation and log that the report already exists
3. WHEN a CUR report with the same name exists THEN the CUR-System SHALL verify the existing report uses the correct billing view ARN in its ReportDefinition BillingViewArn field
4. WHEN the system runs multiple times THEN the CUR-System SHALL produce the same result without creating duplicate reports
5. WHEN an error occurs during report creation THEN the CUR-System SHALL allow retry without side effects

### Requirement 6

**User Story:** As a billing administrator, I want the system to validate S3 bucket configuration before creating reports, so that report delivery does not fail due to permission issues.

#### Acceptance Criteria

1. WHEN the Report Configuration Template specifies an S3 bucket name THEN the CUR-System SHALL verify that the bucket exists
2. WHEN creating a CUR report THEN the CUR-System SHALL verify that the S3 bucket has a bucket policy allowing the billingreports.amazonaws.com service principal (Legacy CUR API)
3. WHEN S3 bucket validation fails THEN the CUR-System SHALL log a detailed error message including remediation steps
4. WHEN S3 bucket validation succeeds THEN the CUR-System SHALL proceed with CUR report creation

**Note:** The CDK stack automatically creates a managed S3 bucket (`cur-reports-{ACCOUNT_ID}-{REGION}`) with the correct bucket policy for Legacy CUR API. Administrators can use this managed bucket or specify their own bucket in the configuration.

### Requirement 7

**User Story:** As a billing administrator, I want comprehensive logging of all CUR report operations, so that I can audit report creation and troubleshoot issues.

#### Acceptance Criteria

1. WHEN the system starts execution THEN the CUR-System SHALL log the start time and configuration source
2. WHEN listing billing transfers THEN the CUR-System SHALL log the count of transfers found
3. WHEN retrieving billing views THEN the CUR-System SHALL log each billing view ARN and type
4. WHEN creating a CUR report THEN the CUR-System SHALL log the report name, billing view ARN, and configuration settings
5. WHEN a report already exists THEN the CUR-System SHALL log that creation was skipped
6. WHEN an error occurs THEN the CUR-System SHALL log the error with context including account ID and operation
7. WHEN the system completes execution THEN the CUR-System SHALL log a summary including reports created, skipped, and failed

### Requirement 8

**User Story:** As a billing administrator, I want the system to handle API errors gracefully, so that transient failures do not prevent report creation for other accounts.

#### Acceptance Criteria

1. WHEN an API call fails with a throttling error THEN the CUR-System SHALL retry with exponential backoff
2. WHEN an API call fails with a transient error THEN the CUR-System SHALL retry up to three times
3. WHEN processing multiple billing transfers THEN the CUR-System SHALL continue processing remaining transfers if one fails
4. WHEN a report creation fails THEN the CUR-System SHALL log the failure and continue with the next report
5. WHEN all retries are exhausted THEN the CUR-System SHALL log the final error and mark that transfer as failed

### Requirement 9

**User Story:** As a billing administrator, I want the system to generate a reconciliation summary, so that I can verify all billing transfers have corresponding CUR reports.

#### Acceptance Criteria

1. WHEN the CUR-System completes execution THEN the CUR-System SHALL return a Reconciliation Summary object
2. WHEN generating the Reconciliation Summary THEN the CUR-System SHALL include the total count of Billing Transfer Relationships processed
3. WHEN generating the Reconciliation Summary THEN the CUR-System SHALL include the count of CUR reports created
4. WHEN generating the Reconciliation Summary THEN the CUR-System SHALL include the count of CUR reports that already existed
5. WHEN generating the Reconciliation Summary THEN the CUR-System SHALL include the count of CUR reports that failed to create
6. WHEN generating the Reconciliation Summary THEN the CUR-System SHALL include a list of failed transfers with transfer ID, Bill-Source Account ID, view type, and error message

### Requirement 10

**User Story:** As a developer, I want the CUR configuration template to support JSON format, so that it is easy to read, edit, and validate.

#### Acceptance Criteria

1. WHEN the Report Configuration Template is stored THEN the CUR-System SHALL store it in JSON format
2. WHEN the Report Configuration Template is parsed THEN the CUR-System SHALL validate the content against a JSON schema
3. WHEN the Report Configuration Template contains invalid JSON or fails schema validation THEN the CUR-System SHALL terminate execution with a clear validation error message
4. WHEN the Report Configuration Template is valid THEN the CUR-System SHALL load all configuration settings into memory for use during CUR report creation

### Requirement 11

**User Story:** As a billing administrator, I want the system to support scheduled execution via EventBridge Scheduler, so that reports are created automatically without manual intervention.

#### Acceptance Criteria

1. WHEN the CDK stack is deployed THEN the CUR-System SHALL create an EventBridge Scheduler schedule resource
2. WHEN the EventBridge Scheduler schedule is created THEN the CUR-System SHALL configure the schedule to run daily at a specified time
3. WHEN the EventBridge Scheduler schedule triggers THEN the CUR-System SHALL invoke the Lambda function with a scheduled event payload containing source field set to scheduler and action field set to reconcile-all
4. WHEN the Lambda function receives an event THEN the CUR-System SHALL execute the full CUR reconciliation workflow
5. WHEN deploying the CDK stack THEN the CUR-System SHALL allow customization of the schedule expression via CDK context parameters or environment variables

### Requirement 12

**User Story:** As a billing administrator, I want the system to tag all created CUR reports, so that I can track which reports were created by automation.

#### Acceptance Criteria

1. WHEN creating a CUR report THEN the CUR-System SHALL apply resource tags to the CUR report
2. WHEN applying resource tags THEN the CUR-System SHALL include a tag identifying the automation system name
3. WHEN applying resource tags THEN the CUR-System SHALL include a tag containing the Bill-Source Account ID
4. WHEN applying resource tags THEN the CUR-System SHALL include a tag containing the creation timestamp
5. WHEN the view-specific configuration contains tags THEN the CUR-System SHALL merge the view-specific tags with the automation-generated tags

### Requirement 13

**User Story:** As a billing administrator, I want independent control over My View and Showback View report configurations, so that I can enable only the views I need with different settings for each.

#### Acceptance Criteria

1. WHEN only myViewReportConfig is present in the Report Configuration Template THEN the CUR-System SHALL create only My View CUR reports
2. WHEN only showbackViewReportConfig is present in the Report Configuration Template THEN the CUR-System SHALL create only Showback View CUR reports
3. WHEN both myViewReportConfig and showbackViewReportConfig are present in the Report Configuration Template THEN the CUR-System SHALL create both My View and Showback View CUR reports
4. WHEN myViewReportConfig and showbackViewReportConfig specify different S3 bucket names THEN the CUR-System SHALL deliver each CUR report to its configured S3 bucket
5. WHEN myViewReportConfig and showbackViewReportConfig specify different S3 prefix paths THEN the CUR-System SHALL use the appropriate S3 prefix for each CUR report
6. WHEN myViewReportConfig and showbackViewReportConfig specify different Time Unit values THEN the CUR-System SHALL apply the appropriate Time Unit to each CUR report
7. WHEN myViewReportConfig and showbackViewReportConfig specify different Additional Schema Elements lists THEN the CUR-System SHALL apply the appropriate Additional Schema Elements to each CUR report
8. WHEN myViewReportConfig and showbackViewReportConfig specify different backfill settings THEN the CUR-System SHALL process backfill requests independently for each view type

### Requirement 14

**User Story:** As a billing administrator, I want the system to automatically create AWS Support cases for historical data backfill when new reports are created, so that I can analyze costs from before the report was created without manual case creation.

#### Acceptance Criteria

1. WHEN myViewReportConfig includes a backfill configuration section THEN the CUR-System SHALL check whether backfill is enabled for My View reports
2. WHEN showbackViewReportConfig includes a backfill configuration section THEN the CUR-System SHALL check whether backfill is enabled for Showback View reports
3. WHEN backfill is enabled for a view type and a new CUR report is created for that view type THEN the CUR-System SHALL create an AWS Support case using the Support API CreateCase operation
4. WHEN creating an AWS Support case THEN the CUR-System SHALL specify the service code and category code appropriate for Legacy CUR report backfill requests
5. WHEN creating an AWS Support case THEN the CUR-System SHALL set the subject field to include the CUR report name and indicate a backfill request
6. WHEN creating an AWS Support case THEN the CUR-System SHALL set the communication body to include the CUR report name, Billing View ARN, and requested billing period range
7. WHEN creating an AWS Support case THEN the CUR-System SHALL set the severity code to the value specified in the view-specific backfill configuration
8. WHEN creating an AWS Support case THEN the CUR-System SHALL set the issue type field to customer-service
9. WHEN an AWS Support case is created successfully THEN the CUR-System SHALL log the Support case ID for tracking purposes
10. WHEN AWS Support case creation fails THEN the CUR-System SHALL log the error message and continue processing remaining CUR reports
11. WHEN backfill is disabled for a view type THEN the CUR-System SHALL not create AWS Support cases for that view type
12. WHEN myViewReportConfig has backfill enabled and showbackViewReportConfig has backfill disabled THEN the CUR-System SHALL create AWS Support cases only for My View CUR reports
