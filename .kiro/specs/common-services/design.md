# Design Document

## Overview

The Common Services module provides shared utilities and services used by all Lambda functions in the Billing Transfer Automation project. This centralized architecture ensures consistent behavior for logging, error handling, retry logic, observability (tracing and metrics), and AWS service interactions across the entire codebase.

## Architecture

### Directory Structure

```
lib/lambda/common/
├── constants.ts              # Shared constants (regions, names, prefixes)
├── models/                   # Shared data models
│   ├── all-billing-transfer-resources.ts  # Container for all resource types
│   ├── analysis-summary.ts                # Analysis summary model
│   ├── billing-group.ts                   # Billing group model
│   ├── billing-transfer-resources.ts      # Transfer with resources model
│   ├── billing-transfer.ts                # Billing transfer model
│   ├── billing-view.ts                    # Billing view model
│   ├── cur-configuration.ts               # CUR configuration model
│   ├── cur-report.ts                      # CUR report model
│   └── validation-result.ts               # Validation result model
├── services/                 # AWS service wrappers
│   ├── billing-conductor-service.ts
│   ├── billing-service.ts
│   ├── billing-transfer-resources-service.ts
│   ├── organizations-service.ts
│   ├── tagging-service.ts
│   ├── transfer-analysis-service.ts
│   ├── transfer-discovery-service.ts
│   └── validation-service.ts
└── utils/                    # Utility functions
    ├── clients.ts            # Pre-configured AWS SDK clients
    ├── error-handler.ts      # Error categorization and handling
    ├── errors.ts             # Error codes and utilities
    ├── logger.ts             # AWS Lambda Powertools Logger
    ├── metrics.ts            # AWS Lambda Powertools Metrics
    ├── middleware.ts         # Middy middleware stack
    ├── retry.ts              # Exponential backoff retry
    └── tracer.ts             # AWS Lambda Powertools Tracer
```

## Components and Interfaces

### 1. Logger Utility (AWS Lambda Powertools)

**Location**: `lib/lambda/common/utils/logger.ts`

**Implementation**: Thin wrapper over `@aws-lambda-powertools/logger` providing:
- Pre-configured `logger` singleton with `serviceName: 'billing-automation'`
- Re-exported `Logger` class for custom instances

**Usage**:
```typescript
import { logger } from '../common/utils/logger';

// Info/warn/debug - pass context as second argument
logger.info('Processing billing transfer', { accountId, transferId });

// Error - pass error in context object
logger.error('Failed to process', { error: err, accountId });
```

**Log Entry Format** (Powertools structured JSON):
```json
{
  "level": "INFO",
  "message": "Processing billing transfer",
  "timestamp": "2025-12-12T10:30:00.000Z",
  "service": "billing-automation",
  "sampling_rate": 0,
  "accountId": "123456789012",
  "transferId": "rt-abc123"
}
```

**Features**:
- Automatic Lambda context injection via `logger.addContext(context)`
- X-Ray trace ID correlation
- Persistent attributes via `logger.appendKeys()`
- Log sampling support

### 2. Tracer Utility (AWS Lambda Powertools)

**Location**: `lib/lambda/common/utils/tracer.ts`

**Implementation**: Thin wrapper over `@aws-lambda-powertools/tracer` providing:
- Pre-configured `tracer` singleton with `serviceName: 'sample-bt-automation'`
- Re-exported `Tracer` class for custom instances

**Usage**:
```typescript
import { tracer } from '../common/utils/tracer';

// Wrap AWS SDK clients for automatic X-Ray instrumentation
const client = tracer.captureAWSv3Client(new OrganizationsClient({}));

// Create custom subsegments for business logic
const subsegment = tracer.getSegment()?.addNewSubsegment('myOperation');
try {
  await doWork();
  subsegment?.close();
} catch (error) {
  subsegment?.addError(error as Error);
  subsegment?.close();
  throw error;
}
```

**Configuration** (via environment variables):
- `POWERTOOLS_SERVICE_NAME`: Service name for traces (default: sample-bt-automation)
- `POWERTOOLS_TRACER_CAPTURE_RESPONSE`: Capture response in traces (default: true)
- `POWERTOOLS_TRACER_CAPTURE_ERROR`: Capture errors in traces (default: true)

### 3. Metrics Utility (AWS Lambda Powertools)

**Location**: `lib/lambda/common/utils/metrics.ts`

**Implementation**: Thin wrapper over `@aws-lambda-powertools/metrics` providing:
- Pre-configured `metrics` singleton with namespace 'SampleBTAutomation'
- Re-exported `Metrics` class and `MetricUnit` enum

**Usage**:
```typescript
import { metrics, MetricUnit } from '../common/utils/metrics';

// Add metrics
metrics.addMetric('BillingGroupCreated', MetricUnit.Count, 1);
metrics.addMetric('ReconciliationDuration', MetricUnit.Milliseconds, 1500);

// Add dimensions for filtering
metrics.addDimension('Environment', 'production');

// Add metadata (not published as metric, but visible in logs)
metrics.addMetadata('accountId', '123456789012');
```

**Configuration** (via environment variables):
- `POWERTOOLS_SERVICE_NAME`: Service name dimension (default: sample-bt-automation)
- `POWERTOOLS_METRICS_NAMESPACE`: CloudWatch namespace (default: SampleBTAutomation)

### 4. Middleware Stack (Middy + Powertools)

**Location**: `lib/lambda/common/utils/middleware.ts`

**Implementation**: Pre-configured middleware stack combining Logger, Tracer, and Metrics:

**Usage**:
```typescript
import middy from '@middy/core';
import { powertools } from '../common/utils/middleware';

const lambdaHandler = async (event, context) => {
  // Your handler logic - logger, tracer, metrics already configured
};

export const handler = middy(lambdaHandler).use(powertools());
```

**Middleware Stack Includes**:
1. `injectLambdaContext(logger, { clearState: true })` - Logger context injection with state clearing
2. `captureLambdaHandler(tracer)` - X-Ray trace capture
3. `logMetrics(metrics, { captureColdStartMetric: true })` - Metrics logging with cold start tracking

### 5. AWS SDK Clients

**Location**: `lib/lambda/common/utils/clients.ts`

**Implementation**: Pre-configured, shared AWS SDK client instances:

```typescript
import { billingConductorClient, billingClient, organizationsClient, curClient } from '../common/utils/clients';
```

**Client Configuration**:
```typescript
const DEFAULT_CLIENT_CONFIG = {
  region: 'us-east-1',      // Global services endpoint
  maxAttempts: 3,           // Automatic retries
  retryMode: 'adaptive',    // Intelligent backoff
};
```

**Available Clients**:
- `billingConductorClient`: BillingconductorClient for billing groups and pricing plans
- `billingClient`: BillingClient for billing views
- `organizationsClient`: OrganizationsClient for billing transfers
- `curClient`: CostAndUsageReportServiceClient for CUR reports

**Benefits**:
- Lambda warm start optimization (clients created at module level)
- Consistent configuration across all Lambda functions
- Automatic retry with adaptive backoff

### 6. Retry Utility

**Location**: `lib/lambda/common/utils/retry.ts`

**Interface**:
```typescript
interface RetryConfig {
  maxAttempts: number;      // Default: 3
  baseDelay: number;        // Default: 1000ms
  maxDelay: number;         // Default: 30000ms
  backoffMultiplier: number; // Default: 2
  retryableErrors: string[];
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  context?: Record<string, unknown>
): Promise<T>;

function isRetryableError(error: unknown, config?: RetryConfig): boolean;
function calculateBackoffDelay(attemptNumber: number, config?: RetryConfig): number;
```

**Behavior**:
- Exponential backoff with jitter (up to 1 second)
- Configurable max retries (default: 3)
- Checks error codes against RETRYABLE_ERROR_CODES
- Non-retryable errors thrown immediately
- Structured logging of retry attempts

**Backoff Strategy** (with default config):
- Attempt 0: 1s + jitter (0-1s) = 1-2s
- Attempt 1: 2s + jitter (0-1s) = 2-3s
- Attempt 2: 4s + jitter (0-1s) = 4-5s
- Maximum delay: 30s + jitter

### 7. Error Handler

**Location**: `lib/lambda/common/utils/error-handler.ts`

**Interface**:
```typescript
enum ErrorCategory {
  TRANSIENT = 'TRANSIENT',   // Retryable (throttling, timeouts)
  PERMANENT = 'PERMANENT',   // Non-retryable but not critical
  CRITICAL = 'CRITICAL'      // Stops processing (auth failures)
}

interface ErrorDetails {
  code: string;
  message: string;
  accountId?: string;
  transferId?: string;
  stack?: string;
  timestamp: string;
  retryable: boolean;
}

function categorizeError(error: unknown): ErrorCategory;
function toErrorDetails(error: unknown, accountId?: string, transferId?: string): ErrorDetails;
function handleError(error: unknown, context?: Record<string, unknown>): ErrorDetails;
function isConflictError(error: unknown): boolean;
```

**Error Codes** (from `lib/lambda/common/utils/errors.ts`):
```typescript
// Retryable errors
const RETRYABLE_ERROR_CODES = [
  'ThrottlingException', 'TooManyRequestsException',
  'ServiceUnavailableException', 'InternalServerError',
  'RequestTimeout', 'NetworkError',
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'
];

// Critical errors (stop processing)
const CRITICAL_ERROR_CODES = [
  'AccessDeniedException', 'UnauthorizedException',
  'InvalidClientTokenId', 'SignatureDoesNotMatch'
];
```

**Utility Functions** (from `lib/lambda/common/utils/errors.ts`):
```typescript
function getErrorCode(error: unknown): string;
function getErrorMessage(error: unknown): string;
function isRetryableError(error: unknown): boolean;
function isCriticalError(error: unknown): boolean;
function toError(error: unknown): Error;
```

### 8. Billing Conductor Service

**Location**: `lib/lambda/common/services/billing-conductor-service.ts`

**Interface**:
```typescript
interface BillingGroupOperationResult {
  success: boolean;
  billingGroupArn?: string;
  billingGroupName?: string;
  accountId: string;
  action: 'created' | 'exists' | 'failed';
  error?: { code: string; message: string; };
}

async function getBasicPricingPlanArn(): Promise<string>;
async function findBillingGroupByAccount(accountId: string): Promise<string | null>;
async function createBillingGroup(
  accountId: string,
  pricingPlanArn: string,
  transferArn: string
): Promise<string>;
async function ensureBillingGroup(
  accountId: string,
  transferArn: string
): Promise<BillingGroupOperationResult>;
```

**Key Behaviors**:
- Uses ResponsibilityTransferArn in AccountGrouping (required for billing transfers)
- Handles ConflictException as success (idempotent)
- Handles ValidationException for historical records (creates without tags, then adds tags)
- Naming convention: `bg-{accountId}`

### 9. Organizations Service

**Location**: `lib/lambda/common/services/organizations-service.ts`

**Interface**:
```typescript
interface TransferDiscoveryOptions {
  relationshipState?: 'ACCEPTED' | 'PENDING' | 'TERMINATED';
}

async function listDirectBillingTransfers(options?: TransferDiscoveryOptions): Promise<BillingTransfer[]>;
async function listIndirectBillingTransfers(transferId: string, options?: TransferDiscoveryOptions): Promise<BillingTransfer[]>;
async function getBillingTransferForAccount(accountId: string): Promise<BillingTransfer | null>;
```

**API Behavior**:
- `ListInboundResponsibilityTransfers` without Id: Returns direct transfers
- `ListInboundResponsibilityTransfers` with Id: Returns indirect/nested transfers
- Pagination handled automatically via NextToken
- Filters for BILLING type and specified relationship state (default: ACCEPTED)

### 10. Billing Service

**Location**: `lib/lambda/common/services/billing-service.ts`

**Interface**:
```typescript
async function listBillingViews(
  billingViewTypes: BillingViewType[],
  sourceAccountId?: string
): Promise<BillingView[]>;
async function getBillingView(billingViewArn: string): Promise<BillingView>;
async function findBillingViewForTransfer(
  billSourceAccountId: string,
  viewType: 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK',
  transferName?: string
): Promise<BillingView | null>;
```

**Key Behaviors**:
- Lists all views of specified types, filters client-side by sourceAccountId
- Supports transfer name matching when multiple views exist for same source account
- Returns null gracefully when view not found (doesn't throw)

### 11. Transfer Discovery Service

**Location**: `lib/lambda/common/services/transfer-discovery-service.ts`

**Interface**:
```typescript
interface TransferDiscoveryResult {
  transfers: BillingTransferModel[];
  directCount: number;
  indirectCount: number;
  relationshipState: string;
  executionTimeMs: number;
}

async function findDirectTransfers(options?: TransferDiscoveryOptions): Promise<BillingTransferModel[]>;
async function findIndirectTransfers(transferId: string, options?: TransferDiscoveryOptions): Promise<BillingTransferModel[]>;
async function findAllTransfers(options?: TransferDiscoveryOptions): Promise<TransferDiscoveryResult>;
```

**Key Behaviors**:
- Discovers direct transfers first, then indirect for each direct
- Returns standardized BillingTransferModel with transferType ('direct' | 'indirect')
- Handles errors gracefully for indirect transfers (logs warning, continues)

### 12. Transfer Analysis Service

**Location**: `lib/lambda/common/services/transfer-analysis-service.ts`

**Interface**:
```typescript
interface AnalysisOptions {
  relationshipState?: 'ACCEPTED' | 'PENDING' | 'TERMINATED';
  includeValidation?: boolean;
}

interface AnalysisResult {
  summary: AnalysisSummaryModel;
  validation?: ValidationResultModel;
}

async function analyzeTransfers(options?: AnalysisOptions): Promise<AnalysisResult>;
async function validateTransferResources(options?: ValidationOptions): Promise<ValidationResultModel>;
async function analyzeAccountTransfers(accountId: string, options?: AnalysisOptions): Promise<AnalysisResult>;
function getExecutionMetadata(result: AnalysisResult, operation: string, includeValidation: boolean): ExecutionMetadata;
function getPerformanceMetrics(result: AnalysisResult): PerformanceMetrics;
function logAnalysisSummary(result: AnalysisResult, operation: string): void;
```

**Key Behaviors**:
- Orchestrates Transfer Discovery and Billing Transfer Resources services
- Clears resource cache before each analysis for fresh data
- Optionally includes validation results
- Supports account-specific filtering

### 13. Billing Transfer Resources Service

**Location**: `lib/lambda/common/services/billing-transfer-resources-service.ts`

**Interface**:
```typescript
// Resource listing
async function listBillingViews(): Promise<BillingView[]>;
async function listBillingGroups(): Promise<BillingGroup[]>;
async function listPricingPlans(): Promise<PricingPlan[]>;
async function listCURConfigurations(): Promise<CURConfiguration[]>;
async function listAllResources(useCache?: boolean): Promise<AllBillingTransferResources>;

// Resource matching
async function getResourcesForTransfer(transfer: BillingTransferModel): Promise<BillingTransferWithResourcesModel>;
async function getResourcesForTransfers(transfers: BillingTransferModel[]): Promise<BillingTransferWithResourcesModel[]>;
async function getResourcesByAccountId(accountId: string): Promise<{
  billingViews: BillingView[];
  billingGroups: BillingGroup[];
  pricingPlans: PricingPlan[];
  curConfigurations: CURConfiguration[];
}>;

// Cache management
function clearResourceCache(): void;
function getResourceCache(): AllBillingTransferResources | null;
function hasResourceCache(): boolean;
```

**Key Behaviors**:
- Caches all resources during batch operations to minimize API calls
- Matches billing views by source account ID and transfer name
- Matches billing groups by transfer ARN
- Uses null values for missing resources (not omitted fields)

### 14. Validation Service

**Location**: `lib/lambda/common/services/validation-service.ts`

**Interface**:
```typescript
interface MissingResourcesSummary {
  totalTransfers: number;
  missingBillingViews: number;
  missingBillingGroups: number;
  missingPricingPlans: number;
  missingCURConfigurations: number;
}

async function validateTransferConsistency(
  transfers: BillingTransferWithResourcesModel[],
  allResources?: AllBillingTransferResources,
  options?: ValidationOptions
): Promise<ValidationResultModel>;

async function identifyMissingResources(transfers: BillingTransferWithResourcesModel[]): Promise<MissingResourcesSummary>;
function identifyOrphanedResources(transfers: BillingTransferWithResourcesModel[], allResources: AllBillingTransferResources): OrphanedResources;
function detectMissingBillingViews(transfers: BillingTransferWithResourcesModel[]): BillingTransferWithResourcesModel[];
function detectMissingBillingGroups(transfers: BillingTransferWithResourcesModel[]): BillingTransferWithResourcesModel[];
function detectMissingCURConfigurations(transfers: BillingTransferWithResourcesModel[]): BillingTransferWithResourcesModel[];
function detectOrphanedBillingViews(transfers: BillingTransferWithResourcesModel[], allBillingViews: BillingView[]): BillingView[];
function detectOrphanedBillingGroups(transfers: BillingTransferWithResourcesModel[], allBillingGroups: BillingGroup[]): BillingGroup[];
```

**Validation Categories**:
- Missing billing views: Unexpected (AWS manages these)
- Missing billing groups: Critical (needs automation)
- Missing CUR configurations: Warning (optional but recommended)
- Orphaned resources: Resources without active transfers

### 15. Tagging Service

**Location**: `lib/lambda/common/services/tagging-service.ts`

**Interface**:
```typescript
interface TaggingResult {
  success: boolean;
  resourceArn: string;
  resourceType: 'BillingGroup' | 'BillingView' | 'CURReport';
  action: 'tagged' | 'already-tagged' | 'failed';
  tagsApplied?: number;
  error?: string;
}

// Tag generators
function getStandardTags(): StandardTags;
function getBillingGroupTags(accountId: string, transferArn: string): Record<string, string>;
function getBillingViewTags(sourceAccountId: string, viewType: string): Record<string, string>;
function getCURReportTags(billSourceAccountId: string, viewType: string, billingViewArn: string): Record<string, string>;

// Tag operations
async function tagBillingGroup(billingGroupArn: string, tags: Record<string, string>): Promise<TaggingResult>;
async function tagBillingView(billingViewArn: string, tags: Record<string, string>): Promise<TaggingResult>;
async function tagCURReport(reportName: string, tags: Record<string, string>): Promise<TaggingResult>;

// Idempotent tag operations
async function ensureBillingGroupTags(billingGroupArn: string, accountId: string, transferArn: string): Promise<TaggingResult>;
async function ensureBillingViewTags(billingViewArn: string, sourceAccountId: string, viewType: string): Promise<TaggingResult>;
async function ensureCURReportTags(reportName: string, billSourceAccountId: string, viewType: string, billingViewArn: string): Promise<TaggingResult>;
```

**Standard Tags Applied**:
- `Project`: SampleAutomationsForBillingTransfer
- `ManagedBy`: BillingTransferAutomation
- `CreatedBy`: billing-transfer-automation
- `Purpose`: BillingTransferManagement

## Data Models

### Location: `lib/lambda/common/models/`

### BillingTransfer (`billing-transfer.ts`)

```typescript
interface BillingTransfer {
  id: string;
  arn: string;
  name: string;
  billSourceAccountId: string;
  billTransferAccountId: string;
  status: 'ACCEPTED' | 'PENDING' | 'TERMINATED';
  type: 'BILLING';
  startTimestamp: number;
  endTimestamp?: number;
}

interface BillingTransferModel extends BillingTransfer {
  transferType: 'direct' | 'indirect';
  parentTransferId?: string;
}

type RelationshipState = 'ACCEPTED' | 'PENDING' | 'TERMINATED';

interface TransferDiscoveryOptions {
  relationshipState?: RelationshipState;
}

function toBillingTransferModel(transfer: BillingTransfer, transferType: 'direct' | 'indirect', parentTransferId?: string): BillingTransferModel;
```

### BillingView (`billing-view.ts`)

```typescript
interface BillingView {
  arn: string;
  name: string;
  billingViewType: 'PRIMARY' | 'BILLING_GROUP' | 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK';
  ownerAccountId: string;
  sourceAccountId?: string;
}
```

### BillingGroup (`billing-group.ts`)

```typescript
interface BillingGroup {
  arn: string;
  name: string;
  description?: string;
  primaryAccountId: string;
  pricingPlanArn: string;
  responsibilityTransferArn?: string;
  creationTime?: number;
  lastModifiedTime?: number;
  status?: 'ACTIVE' | 'PRIMARY_ACCOUNT_MISSING';
}
```

### BillingTransferResources (`billing-transfer-resources.ts`)

```typescript
interface PricingPlan {
  arn: string;
  name: string;
  description?: string;
  creationTime?: number;
  lastModifiedTime?: number;
}

interface CURConfiguration {
  reportName: string;
  s3Bucket: string;
  s3Prefix?: string;
  s3Region: string;
  timeUnit: 'HOURLY' | 'DAILY' | 'MONTHLY';
  format: 'textORcsv' | 'Parquet';
  compression: 'ZIP' | 'GZIP' | 'Parquet';
  additionalSchemaElements: string[];
  additionalArtifacts: string[];
  refreshClosedReports: boolean;
  reportVersioning: 'CREATE_NEW_REPORT' | 'OVERWRITE_REPORT';
  billingViewArn?: string;
  status: 'ACTIVE' | 'INACTIVE';
}

interface BillingTransferWithResourcesModel {
  transfer: BillingTransferModel;
  resources: {
    billingView: BillingView | null;
    billingGroup: BillingGroup | null;
    pricingPlan: PricingPlan | null;
    curConfiguration: CURConfiguration | null;
  };
  resourcesFound: {
    billingView: boolean;
    billingGroup: boolean;
    pricingPlan: boolean;
    curConfiguration: boolean;
  };
}

function createBillingTransferWithResources(transfer: BillingTransferModel, resources: Partial<Resources>): BillingTransferWithResourcesModel;
function filterMissingResource(transfers: BillingTransferWithResourcesModel[], resourceType: string): BillingTransferWithResourcesModel[];
function filterHasResource(transfers: BillingTransferWithResourcesModel[], resourceType: string): BillingTransferWithResourcesModel[];
```

### AllBillingTransferResources (`all-billing-transfer-resources.ts`)

```typescript
interface AllBillingTransferResources {
  billingViews: BillingView[];
  billingGroups: BillingGroup[];
  pricingPlans: PricingPlan[];
  curConfigurations: CURConfiguration[];
  resourceCounts: {
    billingViews: number;
    billingGroups: number;
    pricingPlans: number;
    curConfigurations: number;
  };
  retrievalTimestamp: number;
}

function createAllBillingTransferResources(...): AllBillingTransferResources;
function findBillingViewBySourceAccountAndName(resources: AllBillingTransferResources, sourceAccountId: string, name: string): BillingView | null;
function findBillingGroupByTransferArn(resources: AllBillingTransferResources, transferArn: string): BillingGroup | null;
function findPricingPlanByArn(resources: AllBillingTransferResources, arn: string): PricingPlan | null;
function findCURConfigurationByBillingViewArn(resources: AllBillingTransferResources, billingViewArn: string): CURConfiguration | null;
```

### AnalysisSummary (`analysis-summary.ts`)

```typescript
interface AnalysisSummaryModel {
  transfers: BillingTransferWithResourcesModel[];
  totalTransfers: number;
  directTransferCount: number;
  indirectTransferCount: number;
  resourceCounts: {
    withBillingViews: number;
    withBillingGroups: number;
    withPricingPlans: number;
    withCURConfigurations: number;
    missingBillingViews: number;
    missingBillingGroups: number;
    missingPricingPlans: number;
    missingCURConfigurations: number;
  };
  relationshipState: RelationshipState;
  analysisTimestamp: number;
  executionTimeMs: number;
}

function createAnalysisSummary(transfers: BillingTransferWithResourcesModel[], relationshipState: RelationshipState, executionTimeMs: number): AnalysisSummaryModel;
function createEmptyAnalysisSummary(relationshipState: RelationshipState): AnalysisSummaryModel;
function filterByAccountId(summary: AnalysisSummaryModel, accountId: string): AnalysisSummaryModel;
```

### ValidationResult (`validation-result.ts`)

```typescript
interface MissingResources {
  billingViews: BillingTransferWithResourcesModel[];
  billingGroups: BillingTransferWithResourcesModel[];
  pricingPlans: BillingTransferWithResourcesModel[];
  curConfigurations: BillingTransferWithResourcesModel[];
}

interface OrphanedResources {
  billingViews: BillingView[];
  billingGroups: BillingGroup[];
}

interface ValidationResultModel {
  isValid: boolean;
  relationshipState: RelationshipState;
  missingResources: MissingResources;
  orphanedResources: OrphanedResources;
  totalIssues: number;
  issuesByType: {
    missingBillingViews: number;
    missingBillingGroups: number;
    missingPricingPlans: number;
    missingCURConfigurations: number;
    orphanedBillingViews: number;
    orphanedBillingGroups: number;
  };
  validationTimestamp: number;
}

function createValidationResult(relationshipState: RelationshipState, missingResources: MissingResources, orphanedResources: OrphanedResources): ValidationResultModel;
function createEmptyValidationResult(relationshipState: RelationshipState): ValidationResultModel;
function getValidationSummary(result: ValidationResultModel): object;
```

## Error Handling

### Error Categories

1. **TRANSIENT**: Retryable errors (throttling, timeouts, service unavailable)
2. **PERMANENT**: Non-retryable errors (validation, not found)
3. **CRITICAL**: Authentication/authorization failures that stop processing

### Retry Strategy

- Maximum 3 retry attempts (configurable)
- Exponential backoff: 1s, 2s, 4s base delays (with up to 1s jitter)
- Maximum delay: 30 seconds
- Only retry TRANSIENT errors
- Non-retryable errors thrown immediately

## Constants

**Location**: `lib/lambda/common/constants.ts`

```typescript
// AWS Region for global services
export const GLOBAL_SERVICES_REGION = 'us-east-1';

// Default pricing plan name
export const DEFAULT_PRICING_PLAN_NAME = 'BasicPricingPlan';

// Project identifier for tagging
export const PROJECT_NAME = 'SampleAutomationsForBillingTransfer';

// Billing group name prefix
export const BILLING_GROUP_PREFIX = 'bg-';
```

## Testing Strategy

### Unit Tests

- Test each utility function in isolation
- Mock AWS SDK clients using `lib/lambda/common/utils/clients.ts`
- Verify error categorization logic
- Verify retry behavior with various error types
- Test model factory functions

### Integration Tests

- Test service interactions with mocked AWS responses
- Verify pagination handling
- Test cache behavior in resources service

## Usage Patterns

### Standard Lambda Handler Pattern

```typescript
import middy from '@middy/core';
import { logger } from '../common/utils/logger';
import { tracer } from '../common/utils/tracer';
import { metrics, MetricUnit } from '../common/utils/metrics';
import { powertools } from '../common/utils/middleware';
import { toError } from '../common/utils/errors';

const lambdaHandler = async (event, context) => {
  logger.info('Lambda invoked', { event });
  metrics.addMetric('EventReceived', MetricUnit.Count, 1);
  
  try {
    // Business logic
    return { statusCode: 200, body: { message: 'Success' } };
  } catch (error) {
    const err = toError(error);
    logger.error('Lambda failed', { error: err });
    throw err;
  }
};

export const handler = middy(lambdaHandler).use(powertools());
```

### AWS SDK Client with Tracing

```typescript
import { tracer } from '../common/utils/tracer';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { GLOBAL_SERVICES_REGION } from '../common/constants';

const client = tracer.captureAWSv3Client(
  new OrganizationsClient({
    region: GLOBAL_SERVICES_REGION,
    maxAttempts: 3,
    retryMode: 'adaptive',
  })
);
```

### Service Import Pattern

```typescript
import { logger } from '../common/utils/logger';
import { retryWithBackoff } from '../common/utils/retry';
import { ensureBillingGroup } from '../common/services/billing-conductor-service';
import { listDirectBillingTransfers } from '../common/services/organizations-service';
import { findBillingViewForTransfer } from '../common/services/billing-service';
import { analyzeTransfers } from '../common/services/transfer-analysis-service';
```
