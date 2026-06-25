---
inclusion: always
---

# Development Guide

## Shared Code Structure

**Location:** `lib/lambda/common/`

### Utilities
- **Logger** (`utils/logger.ts`): AWS Lambda Powertools Logger wrapper with pre-configured singleton
- **Retry** (`utils/retry.ts`): Exponential backoff for AWS API calls
- **Errors** (`utils/errors.ts`): Error handling utilities (`toError()`, `getErrorCode()`, `getErrorMessage()`)

### Services (Key)
- **billing-conductor-service.ts**: `ensureBillingGroup()`, `getBasicPricingPlanArn()`, `findBillingGroupByAccount()`
- **organizations-service.ts**: `listDirectBillingTransfers()`, `listIndirectBillingTransfers()`, `getBillingTransferForAccount()`
- **billing-service.ts**: `listBillingViews()`, `findBillingViewForTransfer()`, `getBillingView()`

### Services (Additional)
- **transfer-discovery-service.ts**: Transfer discovery and analysis
- **transfer-analysis-service.ts**: Transfer relationship analysis
- **billing-transfer-resources-service.ts**: Billing transfer resource management
- **validation-service.ts**: Input validation utilities
- **tagging-service.ts**: Resource tagging utilities

### Import Pattern
```typescript
import { logger } from '../common/utils/logger';  // Pre-configured Powertools singleton
import { retryWithBackoff } from '../common/utils/retry';
import { ensureBillingGroup } from '../common/services/billing-conductor-service';
```

## Lambda Configuration (Standard)

```typescript
const handler = new nodejs.NodejsFunction(this, 'Handler', {
  runtime: lambda.Runtime.NODEJS_22_X,  // Latest LTS
  architecture: lambda.Architecture.ARM_64,  // Graviton2
  timeout: cdk.Duration.minutes(2),
  memorySize: 256,
  tracing: lambda.Tracing.ACTIVE,
  bundling: {
    minify: true,
    sourceMap: true,
    target: 'es2022',
    format: OutputFormat.ESM,
    mainFields: ['module', 'main'],
    banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
    externalModules: [],  // ⚠️ CRITICAL: Bundle all (Organizations & Billing Conductor NOT in runtime)
  },
});
```

## EventBridge Patterns

### CloudTrail Event
```typescript
const rule = new events.Rule(this, 'Rule', {
  eventPattern: {
    source: ['aws.organizations'],
    detailType: ['AWS Service Event via CloudTrail'],
    detail: {
      eventSource: ['organizations.amazonaws.com'],
      eventName: ['ResponsibilityTransferAccepted', 'ResponsibilityTransferTerminated']
    }
  }
});
```

### Scheduler
```typescript
const schedule = new scheduler.Schedule(this, 'Schedule', {
  schedule: scheduler.ScheduleExpression.expression('cron(0 0 * * ? *)'),
  target: new schedulerTargets.LambdaInvoke(handler)
});
```

## Lambda Handler Pattern

```typescript
import { logger } from '../common/utils/logger';  // Powertools Logger singleton
import { ensureBillingGroup } from '../common/services/billing-conductor-service';
import { toError } from '../common/utils/errors';

export const handler = async (event, context) => {
  logger.info('Lambda invoked', { requestId: context.awsRequestId });
  
  try {
    // Extract transfer details from CloudTrail event
    const { id: transferId, source } = event.detail.serviceEventDetails;
    const accountId = source.managementAccountId;
    
    // Transfer ARN may need to be looked up via DescribeResponsibilityTransfer
    const transferArn = event.detail.serviceEventDetails.arn;
    
    const result = await ensureBillingGroup(accountId, transferArn);
    logger.info('Success', { billingGroupArn: result.billingGroupArn });
    return result;
  } catch (error) {
    const err = toError(error);
    logger.error('Failed', { error: err, requestId: context.awsRequestId });
    throw err;
  }
};
```

## IAM Permissions

```typescript
// Billing Conductor (no resource-level permissions)
handler.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'billingconductor:ListPricingPlans',
    'billingconductor:ListBillingGroups',
    'billingconductor:CreateBillingGroup',
    'billingconductor:TagResource',
  ],
  resources: ['*']
}));

// Organizations (reconciliation and event handler)
handler.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'organizations:ListAccounts',
    'organizations:ListInboundResponsibilityTransfers',
    'organizations:DescribeResponsibilityTransfer',
  ],
  resources: ['*']
}));
```

## Critical Best Practices

1. ✅ **Bundle AWS SDK**: Set `externalModules: []` (Organizations & Billing Conductor NOT in runtime)
2. ✅ **Use shared utilities**: Import from `lib/lambda/common`
3. ✅ **Use Powertools logger**: Import `logger` singleton, never use `console.log` directly
4. ✅ **Use retryWithBackoff**: For all AWS API calls
5. ✅ **Use idempotent functions**: `ensureBillingGroup()` checks before creating
6. ✅ **ARM64 architecture**: 20% cost savings
7. ✅ **Enable X-Ray tracing**: For distributed tracing
8. ✅ **Implement DLQs**: For all Lambda functions

## Security Configuration (Checkov Compliance)

All stacks implement the following security controls to pass Checkov scans:

### KMS Encryption
Each stack creates a dedicated KMS key with automatic rotation for encrypting:
- SQS Dead Letter Queues (KMS encryption instead of SQS_MANAGED)
- SNS Topics (for termination notifications)
- Lambda environment variables

```typescript
const encryptionKey = new kms.Key(this, 'EncryptionKey', {
  description: 'KMS key for stack encryption',
  enableKeyRotation: true,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  alias: 'my-stack-key',
});

// SQS with KMS
const dlq = new sqs.Queue(this, 'DLQ', {
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: encryptionKey,
});

// Lambda with KMS for env vars
const handler = new nodejs.NodejsFunction(this, 'Handler', {
  environmentEncryption: encryptionKey,
  // ...
});
```

### Lambda Concurrency Limits
All Lambda functions have `reservedConcurrentExecutions` set to prevent runaway invocations:
- Event handlers: 10 concurrent executions
- Reconciliation functions: 5 concurrent executions

```typescript
const handler = new nodejs.NodejsFunction(this, 'Handler', {
  reservedConcurrentExecutions: 10,
  // ...
});
```

### S3 Access Logging
CUR Reconciliation stack includes an access logs bucket for audit trail:
- Config bucket logs to access logs bucket
- CUR destination bucket logs to access logs bucket
- Access logs bucket has 90-day lifecycle policy

```typescript
const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
});

const configBucket = new s3.Bucket(this, 'ConfigBucket', {
  serverAccessLogsBucket: accessLogsBucket,
  serverAccessLogsPrefix: 'config-bucket-logs/',
});
```

### IAM Policy Constraints (CKV_AWS_111)
All IAM policies use resource-level constraints where supported:
- **Billing Conductor**: ARN patterns for pricing plans and billing groups
- **Organizations**: ARN patterns for transfer resources (DescribeResponsibilityTransfer)
- **CodeBuild**: Pipeline stack uses CDK Aspect to constrain CodeBuild actions to stack-specific projects
- **List operations**: Use `Resource: "*"` only where AWS APIs don't support resource-level permissions

### Intentional Checkov Suppressions
The following Checkov findings are intentionally not addressed:
- **CKV_AWS_117 (Lambda VPC)**: Lambdas only call AWS public APIs (Organizations, Billing Conductor) - VPC adds latency and cost without security benefit
- **CKV_AWS_18/21 (S3 access logs)**: Pipeline artifacts bucket managed by CDK Pipelines; access logs bucket cannot log to itself

## Development Workflow

```bash
npm run build          # TypeScript compilation
npm test               # Run tests
npm run cdk:synth      # CDK synthesis + Nag checks
npm run cdk:diff       # Review changes
npm run cdk:deploy     # Deploy
```

## AWS CLI Defaults

⚠️ **Every `aws` command MUST include `--no-cli-pager`.**

Without it, output is piped through a pager (`less`/`more`) that waits for
manual input (pressing `q`), which blocks automation and stalls debugging.

```bash
# ✅ CORRECT
aws organizations list-inbound-responsibility-transfers --type BILLING --output json --no-cli-pager

# ❌ WRONG (hangs waiting for user input)
aws organizations list-inbound-responsibility-transfers --type BILLING --output json
```

## Scripts

Choose the language by whether the script is **committed** (permanent) or
**throwaway** (temporary, never committed).

### Permanent tooling → the `bt` CLI (TypeScript)

Operational tooling lives in the **`bt` CLI** (`cli/`): a single TypeScript
command tree (deploy, push, status, reconciliation, partner-central, test) that
**reuses existing code** instead of reimplementing it. The legacy `*.sh` fleet
scripts, their `scripts/lib/*.sh` helpers, and the standalone analyze script
have all been removed — the `scripts/` directory is gone. Single-account
transfer analysis is now `bt transfers analyze` (still aliased as
`npm run analyze-transfers`).

- Add new operations as `bt` commands under `cli/commands/`, reusing the shared
  `cli/lib` components (Resource_Registry, Profile_Loader, Fleet_Runner,
  Output_Formatter, Error_Reporter) and `lib/lambda/common` (services, models,
  utils) rather than duplicating AWS calls or business logic.
- A standalone TypeScript script (run via `tsx`) is still acceptable for a
  read-only diagnostic that doesn't belong in the CLI, but prefer a `bt`
  command. Any such script should reuse `lib/lambda/common`, carry a
  `#!/usr/bin/env npx tsx` shebang and the standard copyright header, and wire a
  frequently-used entry to an npm alias in `package.json`.
- Keep AWS API calls consistent with the Lambda code: use `retryWithBackoff`
  and the Powertools `logger` where it makes sense.

```bash
npm run bt -- <group> <command>        # e.g. npm run bt -- fleet status --all-profiles
```

> **⚠️ Do not write new shell scripts.** The shell-to-TypeScript migration is
> complete. Add new capability as a `bt` command (or, rarely, a committed `.ts`
> script that reuses `lib/lambda/common` / `cli/lib`), never as a new `.sh` file.

### Temporary scripts → Bash or Python (not committed)

One-off exploration, a quick debugging probe, or a scratch data pull can be
Bash or Python. These are **not committed** — keep them out of version control.

- Put them somewhere git-ignored (e.g. a local `tmp/` or `scratch/` dir) or
  delete them when done.
- If a temporary script proves useful enough to keep, promote it: rewrite it as
  a `bt` command (or a committed `.ts` script) that reuses `lib/lambda/common`.
- Still include `--no-cli-pager` on every `aws` command (see above).
