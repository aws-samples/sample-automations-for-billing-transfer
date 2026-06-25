---
inclusion: manual
---

# CDK Nag Guide

> Generic CDK-NAG guidance (rule explanations, best practices, compliance
> checking) is covered by the **aws-infrastructure-as-code** power. This file
> only documents the **project-specific suppressions** for this repo and why
> they apply.

## Setup

CDK Nag runs automatically during synthesis. It is wired up in **two** places:

1. **App level** (`bin/app.ts`) — checks the top-level `PipelineStack`:

```typescript
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new cdk.App();
// ... create stacks ...
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

2. **Stage level** (`pipeline-stack.ts`, in `ApplicationStage`) — checks the
   five feature stacks the pipeline deploys. The feature stacks live inside the
   pipeline's `ApplicationStage`, so the app-level aspect does **not** traverse
   them; without this a normal `cdk synth` would only emit a NagReport for
   `PipelineStack` and the feature stacks would go unchecked.

```typescript
// Inside ApplicationStage's constructor
cdk.Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true, reports: true }));
```

Run it with `npm run cdk:synth`. With `reports: true` at the stage, a
NagReport CSV is emitted for **all six stacks**:
- `cdk.out/AwsSolutions-...-PipelineStack-NagReport.csv`
- `cdk.out/assembly-...-PipelineStack-BT/AwsSolutions-BT-<FeatureStack>-NagReport.csv` (×5)

These suppression-aware CSVs are the artifacts to attach to a security review.

## Project-Specific Suppressions

These are the suppressions this project intentionally applies. Always suppress
at the resource level (not stack level) and keep the reason text accurate.

### IAM Wildcard — Billing Conductor / Organizations (AwsSolutions-IAM5)

Billing Conductor and several Organizations list actions do not support
resource-level permissions, so a `Resource::*` is required.

```typescript
NagSuppressions.addResourceSuppressions(lambdaRole, [{
  id: 'AwsSolutions-IAM5',
  reason: 'Billing Conductor/Organizations APIs do not support resource-level permissions',
  appliesTo: ['Resource::*']
}], true);
```

### AWS Managed Policy — Lambda Execution Role (AwsSolutions-IAM4)

```typescript
NagSuppressions.addResourceSuppressions(lambdaRole, [{
  id: 'AwsSolutions-IAM4',
  reason: 'AWSLambdaBasicExecutionRole provides standard CloudWatch Logs permissions',
  appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
}]);
```

### Lambda Reserved Concurrency (AwsSolutions-Lambda2)

This project sets `reservedConcurrentExecutions` on its functions (see
`development-guide.md`), so this rule is normally satisfied without suppression.
Only suppress for a genuinely low-volume function where concurrency limits add
no value:

```typescript
NagSuppressions.addResourceSuppressions(handler, [{
  id: 'AwsSolutions-Lambda2',
  reason: 'Reserved concurrency not required for low-volume function'
}]);
```

### SSL Enforcement — fixed, not suppressed (AwsSolutions-SQS4 / S10)

These are **real fixes**, not suppressions. All DLQs set `enforceSSL: true`
and all CUR S3 buckets set `enforceSSL: true`, which adds an
`aws:SecureTransport` deny to the resource policy and clears the findings:

```typescript
new sqs.Queue(this, 'DLQ', { /* ... */ enforceSSL: true });   // SQS4
new s3.Bucket(this, 'Bucket', { /* ... */ enforceSSL: true }); // S10
```

### CDK framework-generated singletons (BucketDeployment, Scheduler role)

Some findings are on constructs CDK generates at **stack scope** (not as
children of the construct you instantiated): the `aws-s3-deployment`
`Custom::CDKBucketDeployment<hash>` handler, and the EventBridge Scheduler
`SchedulerRoleForTarget-<hash>` role. Their logical ids embed a CDK hash that
can change, so a hardcoded `addResourceSuppressionsByPath` is fragile and will
throw `Suppression path ... did not match any resource` when the hash shifts.

Locate them by **id prefix** via the construct tree instead:

```typescript
for (const child of this.node.findAll()) {
  if (child.node.id.startsWith('Custom::CDKBucketDeployment')) {
    NagSuppressions.addResourceSuppressions(child, [
      { id: 'AwsSolutions-IAM4', reason: '...framework managed policy...', appliesTo: [/* ... */] },
      { id: 'AwsSolutions-IAM5', reason: '...framework S3 wildcards scoped to asset+dest bucket...', appliesTo: [/* ... */] },
      { id: 'AwsSolutions-L1',  reason: '...framework-managed runtime...' },
    ], true);
  }
  if (child.node.id.startsWith('SchedulerRoleForTarget')) {
    NagSuppressions.addResourceSuppressions(child, [
      { id: 'AwsSolutions-IAM5', reason: 'Scheduler target role uses <FunctionArn>:* to invoke across versions/aliases', appliesTo: [/* regex on the function arn */] },
    ], true);
  }
}
```

### Granular `appliesTo` for resource-scoped ARNs

`AwsSolutions-IAM5` reports **per finding** — a blanket `Resource::*` does not
cover an intentional account-scoped ARN like
`arn:aws:billingconductor::<acct>:pricingplan/*`. List each one explicitly
(literal or regex) in `appliesTo`, including CDK grant artifacts such as KMS
`Action::kms:GenerateDataKey*` / `Action::kms:ReEncrypt*` and S3
`Action::s3:GetObject*` from `grantRead`.

## Related Compliance

This project also passes Checkov scans. See the "Security Configuration
(Checkov Compliance)" section in `development-guide.md` for KMS encryption,
concurrency limits, S3 access logging, and the list of intentional Checkov
suppressions.

## Best Practices

1. ✅ **Document suppressions** - Always provide a clear, accurate reason
2. ✅ **Suppress at resource level** - Not stack level when possible
3. ✅ **Review regularly** - Remove suppressions that are no longer needed
4. ✅ **Run in CI/CD** - Synthesis (and therefore CDK Nag) runs in the pipeline build stage
