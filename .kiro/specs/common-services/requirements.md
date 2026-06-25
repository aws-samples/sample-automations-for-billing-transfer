# Requirements Document

## Introduction

This specification defines the shared services and utilities architecture for the Billing Transfer Automation project. The common module (`lib/lambda/common/`) provides reusable components that all Lambda functions import, ensuring consistent behavior for logging, error handling, retry logic, observability, and AWS service interactions across the entire project.

## Glossary

- **Common Module**: Shared code directory at `lib/lambda/common/` containing utilities, services, and models used by all Lambda functions
- **AWS Lambda Powertools**: AWS-maintained library providing structured logging, tracing, and metrics for Lambda functions
- **Logger**: AWS Lambda Powertools Logger providing structured JSON logging with Lambda context injection
- **Tracer**: AWS Lambda Powertools Tracer providing X-Ray distributed tracing and AWS SDK instrumentation
- **Metrics**: AWS Lambda Powertools Metrics providing CloudWatch EMF (Embedded Metric Format) metrics
- **Middleware**: Middy middleware stack combining Logger, Tracer, and Metrics for consistent Lambda instrumentation
- **Retry Utility**: Exponential backoff retry mechanism for handling transient AWS API failures
- **Error Handler**: Utility for categorizing errors (TRANSIENT, PERMANENT, CRITICAL) and standardizing error responses
- **AWS SDK Clients**: Pre-configured, shared AWS SDK client instances for Lambda warm start optimization
- **Billing Conductor Service**: Service wrapper for AWS Billing Conductor API operations (billing groups, pricing plans)
- **Organizations Service**: Service wrapper for AWS Organizations API operations (billing transfers)
- **Billing Service**: Service wrapper for AWS Billing API operations (billing views)
- **Transfer Discovery Service**: Service for discovering active billing transfers (direct and indirect)
- **Transfer Analysis Service**: Orchestration service that combines discovery and resource matching
- **Billing Transfer Resources Service**: Service for matching billing transfers with their associated resources
- **Validation Service**: Service for validating consistency between transfers and billing resources
- **Tagging Service**: Service for applying consistent resource tags
- **Data Models**: TypeScript interfaces and types defining the structure of billing transfers, resources, and analysis results

## Requirements

### Requirement 1

**User Story:** As a developer, I want a unified Logger implementation, so that all Lambda functions produce consistent structured logs.

#### Acceptance Criteria

1. WHEN any Lambda function logs a message THEN the Lambda function SHALL use the `logger` singleton from `lib/lambda/common/utils/logger.ts` (AWS Lambda Powertools)
2. WHEN the Logger outputs a log entry THEN the Logger SHALL include timestamp, level, message, service name, and context attributes in JSON format
3. WHEN the Logger is configured with a LOG_LEVEL environment variable THEN the Logger SHALL only output messages at or above that level
4. WHEN a Lambda function logs an error THEN the Logger SHALL accept error objects in the context parameter (e.g., `logger.error('Failed', { error: err })`)
5. THE Logger SHALL support INFO, WARN, ERROR, and DEBUG log levels
6. THE Logger SHALL provide Lambda context injection via `addContext()` method
7. THE Logger SHALL re-export the PowertoolsLogger class for cases where custom instances are needed
8. THE Logger SHALL use a configurable service name defaulting to 'sample-bt-automation'

### Requirement 2

**User Story:** As a developer, I want a unified retry utility, so that all Lambda functions handle transient failures consistently.

#### Acceptance Criteria

1. WHEN any Lambda function encounters a retryable error THEN the Lambda function SHALL use retryWithBackoff from `lib/lambda/common/utils/retry.ts`
2. WHEN the retry utility determines if an error is retryable THEN the utility SHALL check the error code against RETRYABLE_ERROR_CODES
3. WHEN the retry utility performs a retry THEN the utility SHALL apply exponential backoff with jitter
4. WHEN the retry utility exhausts all retry attempts THEN the utility SHALL throw the last error encountered
5. THE retry utility SHALL support configurable maximum retry attempts with a default of 3

### Requirement 3

**User Story:** As a developer, I want a unified error handler, so that all Lambda functions categorize and handle errors consistently.

#### Acceptance Criteria

1. WHEN any Lambda function handles errors THEN the Lambda function SHALL use utilities from `lib/lambda/common/utils/error-handler.ts`
2. WHEN categorizing errors THEN the error handler SHALL classify errors as TRANSIENT, PERMANENT, or CRITICAL
3. WHEN an error is CRITICAL THEN the error handler SHALL log the error and throw to stop processing
4. WHEN an error is TRANSIENT THEN the error handler SHALL indicate the operation is retryable
5. WHEN an error is a ConflictException THEN the error handler SHALL treat it as success for idempotent operations

### Requirement 4

**User Story:** As a developer, I want a Billing Conductor Service, so that all Lambda functions interact with AWS Billing Conductor consistently.

#### Acceptance Criteria

1. WHEN any Lambda function needs Billing Conductor operations THEN the Lambda function SHALL use `lib/lambda/common/services/billing-conductor-service.ts`
2. WHEN creating a billing group THEN the service SHALL check if the billing group already exists before attempting creation
3. WHEN creating a billing group for a billing transfer THEN the service SHALL use ResponsibilityTransferArn in the AccountGrouping parameter
4. WHEN retrieving the BasicPricingPlan THEN the service SHALL return the ARN of the AWS-managed pricing plan
5. THE Billing Conductor Service SHALL use the us-east-1 region and adaptive retry mode

### Requirement 5

**User Story:** As a developer, I want an Organizations Service, so that all Lambda functions interact with AWS Organizations consistently.

#### Acceptance Criteria

1. WHEN any Lambda function needs Organizations operations THEN the Lambda function SHALL use `lib/lambda/common/services/organizations-service.ts`
2. WHEN listing inbound responsibility transfers THEN the service SHALL paginate through all results using NextToken
3. WHEN listing direct transfers THEN the service SHALL call ListInboundResponsibilityTransfers without an Id parameter
4. WHEN listing indirect transfers THEN the service SHALL call ListInboundResponsibilityTransfers with the parent transfer Id
5. THE Organizations Service SHALL filter for ACCEPTED status and BILLING type by default

### Requirement 6

**User Story:** As a developer, I want a Billing Service, so that all Lambda functions interact with AWS Billing API consistently.

#### Acceptance Criteria

1. WHEN any Lambda function needs Billing API operations THEN the Lambda function SHALL use `lib/lambda/common/services/billing-service.ts`
2. WHEN listing billing views THEN the service SHALL support filtering by billing view type
3. WHEN listing billing views THEN the service SHALL support filtering by source account ID
4. WHEN retrieving a billing view THEN the service SHALL return complete billing view details including ARN and type
5. THE Billing Service SHALL use the us-east-1 region

### Requirement 7

**User Story:** As a developer, I want a Transfer Discovery Service, so that I can discover all active billing transfers consistently.

#### Acceptance Criteria

1. WHEN discovering transfers THEN the service SHALL retrieve all direct inbound billing transfers
2. WHEN discovering transfers THEN the service SHALL retrieve all indirect transfers for each direct transfer
3. WHEN discovering transfers THEN the service SHALL handle API pagination automatically
4. WHEN discovering transfers THEN the service SHALL use retryWithBackoff for API calls
5. WHEN discovery completes THEN the service SHALL return standardized transfer models with relationship metadata

### Requirement 8

**User Story:** As a developer, I want a Billing Transfer Resources Service, so that I can match transfers with their billing resources.

#### Acceptance Criteria

1. WHEN matching resources for a transfer THEN the service SHALL search for the corresponding billing view
2. WHEN matching resources for a transfer THEN the service SHALL search for the associated billing group using the transfer ARN
3. WHEN a billing group is found THEN the service SHALL retrieve the associated pricing plan
4. WHEN a billing group is found THEN the service SHALL search for associated CUR configurations
5. WHEN resources are not found THEN the service SHALL use null values rather than omitting fields

### Requirement 9

**User Story:** As a developer, I want a Transfer Analysis Service, so that I can perform comprehensive transfer analysis with a simple interface.

#### Acceptance Criteria

1. WHEN analyzing transfers THEN the service SHALL orchestrate Transfer Discovery Service and Billing Transfer Resources Service
2. WHEN analyzing transfers THEN the service SHALL return transfers with all associated resources
3. WHEN configured for validation THEN the service SHALL include Validation Service results
4. WHEN analysis completes THEN the service SHALL provide execution metadata and statistics
5. THE Transfer Analysis Service SHALL cache resources to minimize API calls within a single invocation

### Requirement 10

**User Story:** As a developer, I want a Validation Service, so that I can validate consistency between transfers and billing resources.

#### Acceptance Criteria

1. WHEN validating transfers THEN the service SHALL identify transfers missing billing views
2. WHEN validating transfers THEN the service SHALL identify transfers missing billing groups
3. WHEN validating transfers THEN the service SHALL identify transfers missing CUR configurations
4. WHEN validating transfers THEN the service SHALL identify orphaned billing views without active transfers
5. WHEN validation completes THEN the service SHALL return a standardized validation result model

### Requirement 11

**User Story:** As a developer, I want all Lambda functions to import from the common directory, so that changes propagate automatically.

#### Acceptance Criteria

1. WHEN a Lambda function needs logging THEN the Lambda function SHALL import from `../common/utils/logger`
2. WHEN a Lambda function needs retry logic THEN the Lambda function SHALL import from `../common/utils/retry`
3. WHEN a Lambda function needs error handling THEN the Lambda function SHALL import from `../common/utils/errors` or `../common/utils/error-handler`
4. WHEN a Lambda function needs AWS service operations THEN the Lambda function SHALL import from `../common/services/`
5. WHEN the NodejsFunction bundler runs THEN the bundler SHALL automatically include common directory code in the deployment bundle

### Requirement 12

**User Story:** As a developer, I want a unified Tracer implementation, so that all Lambda functions have consistent X-Ray distributed tracing.

#### Acceptance Criteria

1. WHEN any Lambda function needs tracing THEN the Lambda function SHALL use the `tracer` singleton from `lib/lambda/common/utils/tracer.ts` (AWS Lambda Powertools)
2. WHEN the Tracer wraps an AWS SDK client THEN the Tracer SHALL use `tracer.captureAWSv3Client()` for automatic X-Ray instrumentation
3. WHEN the Tracer is configured THEN the Tracer SHALL use a service name matching the Logger service name
4. WHEN the Tracer captures responses THEN the Tracer SHALL respect POWERTOOLS_TRACER_CAPTURE_RESPONSE environment variable
5. WHEN the Tracer captures errors THEN the Tracer SHALL respect POWERTOOLS_TRACER_CAPTURE_ERROR environment variable
6. THE Tracer SHALL re-export the Tracer class for cases where custom instances are needed

### Requirement 13

**User Story:** As a developer, I want a unified Metrics implementation, so that all Lambda functions emit consistent CloudWatch metrics.

#### Acceptance Criteria

1. WHEN any Lambda function needs to emit metrics THEN the Lambda function SHALL use the `metrics` singleton from `lib/lambda/common/utils/metrics.ts` (AWS Lambda Powertools)
2. WHEN the Metrics utility emits metrics THEN the Metrics utility SHALL use CloudWatch EMF (Embedded Metric Format)
3. WHEN the Metrics utility is configured THEN the Metrics utility SHALL use a namespace of 'SampleBTAutomation'
4. WHEN the Metrics utility adds a metric THEN the Metrics utility SHALL support MetricUnit enum values (Count, Milliseconds, etc.)
5. WHEN the Metrics utility adds dimensions THEN the Metrics utility SHALL support custom dimensions for filtering
6. THE Metrics utility SHALL re-export the Metrics class and MetricUnit enum for convenience

### Requirement 14

**User Story:** As a developer, I want a pre-configured middleware stack, so that all Lambda functions have consistent instrumentation with minimal boilerplate.

#### Acceptance Criteria

1. WHEN any Lambda function needs instrumentation THEN the Lambda function SHALL use the `powertools()` middleware from `lib/lambda/common/utils/middleware.ts`
2. WHEN the middleware stack is applied THEN the middleware stack SHALL include Logger context injection with state clearing
3. WHEN the middleware stack is applied THEN the middleware stack SHALL include Tracer Lambda handler capture
4. WHEN the middleware stack is applied THEN the middleware stack SHALL include Metrics logging with cold start tracking
5. WHEN a Lambda handler uses the middleware THEN the Lambda handler SHALL wrap with Middy: `middy(handler).use(powertools())`
6. THE middleware module SHALL re-export logger, tracer, and metrics for convenience imports

### Requirement 15

**User Story:** As a developer, I want pre-configured AWS SDK clients, so that all Lambda functions use consistent client configuration and benefit from warm start optimization.

#### Acceptance Criteria

1. WHEN any Lambda function needs an AWS SDK client THEN the Lambda function SHALL import from `lib/lambda/common/utils/clients.ts`
2. WHEN the clients module initializes clients THEN the clients module SHALL use us-east-1 region for global services (Organizations, Billing Conductor, Billing, CUR)
3. WHEN the clients module initializes clients THEN the clients module SHALL configure maxAttempts of 3 for automatic retries
4. WHEN the clients module initializes clients THEN the clients module SHALL configure adaptive retry mode
5. THE clients module SHALL export billingConductorClient for Billing Conductor operations
6. THE clients module SHALL export billingClient for Billing API operations
7. THE clients module SHALL export organizationsClient for Organizations API operations
8. THE clients module SHALL export curClient for Cost and Usage Report Service operations
9. WHEN clients are created THEN the clients SHALL be created at module level for Lambda warm start optimization

### Requirement 16

**User Story:** As a developer, I want shared data models, so that all Lambda functions use consistent type definitions for billing transfers and resources.

#### Acceptance Criteria

1. WHEN any Lambda function needs billing transfer types THEN the Lambda function SHALL import from `lib/lambda/common/models/billing-transfer.ts`
2. WHEN any Lambda function needs billing view types THEN the Lambda function SHALL import from `lib/lambda/common/models/billing-view.ts`
3. WHEN any Lambda function needs billing group types THEN the Lambda function SHALL import from `lib/lambda/common/models/billing-group.ts`
4. WHEN any Lambda function needs transfer resources types THEN the Lambda function SHALL import from `lib/lambda/common/models/billing-transfer-resources.ts`
5. WHEN any Lambda function needs all resources container THEN the Lambda function SHALL import from `lib/lambda/common/models/all-billing-transfer-resources.ts`
6. WHEN any Lambda function needs analysis summary types THEN the Lambda function SHALL import from `lib/lambda/common/models/analysis-summary.ts`
7. WHEN any Lambda function needs validation result types THEN the Lambda function SHALL import from `lib/lambda/common/models/validation-result.ts`
8. WHEN any Lambda function needs CUR configuration types THEN the Lambda function SHALL import from `lib/lambda/common/models/cur-configuration.ts`
9. THE models SHALL include factory functions for creating model instances with proper defaults

### Requirement 17

**User Story:** As a developer, I want shared constants, so that all Lambda functions use consistent configuration values.

#### Acceptance Criteria

1. WHEN any Lambda function needs constants THEN the Lambda function SHALL import from `lib/lambda/common/constants.ts`
2. THE constants module SHALL export GLOBAL_SERVICES_REGION as 'us-east-1'
3. THE constants module SHALL export DEFAULT_PRICING_PLAN_NAME as 'BasicPricingPlan'
4. THE constants module SHALL export PROJECT_NAME for resource tagging
5. THE constants module SHALL export BILLING_GROUP_PREFIX as 'bg-'
