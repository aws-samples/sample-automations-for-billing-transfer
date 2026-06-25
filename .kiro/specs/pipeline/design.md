# Design Document

## Overview

The Pipeline Stack implements a self-mutating CDK Pipeline that provides continuous integration and deployment for the Billing Transfer Automation project. The pipeline automatically builds, tests, and deploys all feature stacks when code is pushed to CodeCommit, eliminating the need for manual `cdk deploy` commands and ensuring consistent, auditable deployments.

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         PipelineStack                            │
│                                                                   │
│  ┌────────────────┐      ┌──────────────────┐                  │
│  │   CodeCommit   │─────▶│   CodePipeline   │                  │
│  │   Repository   │      │                   │                  │
│  └────────────────┘      │  ┌─────────────┐ │                  │
│                          │  │   Source    │ │                  │
│                          │  └──────┬──────┘ │                  │
│                          │         │        │                  │
│                          │  ┌──────▼──────┐ │                  │
│                          │  │    Build    │ │                  │
│                          │  │  (CodeBuild)│ │                  │
│                          │  └──────┬──────┘ │                  │
│                          │         │        │                  │
│                          │  ┌──────▼──────┐ │                  │
│                          │  │   Update    │ │                  │
│                          │  │   Pipeline  │ │                  │
│                          │  └──────┬──────┘ │                  │
│                          │         │        │                  │
│                          │  ┌──────▼──────┐ │                  │
│                          │  │   Deploy    │ │                  │
│                          │  │ApplicationStage│                 │
│                          │  └─────────────┘ │                  │
│                          └──────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   │ Deploys
                                   ▼
                    ┌──────────────────────────┐
                    │   ApplicationStage       │
                    │                          │
                    │  ┌────────────────────┐ │
                    │  │ EventHandlerStack  │ │
                    │  └────────────────────┘ │
                    │  ┌────────────────────┐ │
                    │  │ReconciliationStack │ │
                    │  └────────────────────┘ │
                    │  ┌────────────────────┐ │
                    │  │CURReconciliation   │ │
                    │  │     Stack          │ │
                    │  └────────────────────┘ │
                    └──────────────────────────┘
```

### Pipeline Stages

1. **Source Stage**
   - Monitors CodeCommit repository for changes on `main` branch
   - Triggers automatically when code is pushed
   - Provides source code to subsequent stages

2. **Build Stage (Synth)**
   - Installs dependencies: `npm ci --prefer-offline --no-audit`
   - Compiles TypeScript: `npm run build`
   - Runs tests: `npm test`
   - Synthesizes CDK: `npx cdk synth`
   - Produces CloudFormation templates as artifacts

3. **UpdatePipeline Stage (Self-Mutation)**
   - Compares current pipeline with synthesized pipeline
   - Updates pipeline infrastructure if changes detected
   - Restarts pipeline execution after self-mutation
   - Skipped if no pipeline changes detected

4. **Deploy Stage**
   - Deploys ApplicationStage containing all feature stacks
   - Uses CloudFormation change sets for safe deployments
   - Rolls back on failure
   - Provides deployment status and outputs

## Components and Interfaces

### PipelineStack

**Purpose**: Creates and configures the CI/CD pipeline infrastructure

**Key Resources**:
- CodeCommit Repository
- CodePipeline
- CodeBuild Project (for synth)
- S3 Artifact Bucket (managed by CDK Pipelines)
- IAM Roles (managed by CDK Pipelines)

**Configuration**:
```typescript
interface PipelineStackProps extends cdk.StackProps {
  // Uses default StackProps
  // Account and region from environment variables
}
```

**Outputs**:
- `RepositoryName`: CodeCommit repository name
- `RepositoryCloneUrlHttp`: HTTPS clone URL
- `RepositoryCloneUrlSsh`: SSH clone URL
- `PipelineName`: CodePipeline name
- `SetupInstructions`: Instructions for pushing code

### ApplicationStage

**Purpose**: Groups all feature stacks for deployment as a cohesive application

**Key Resources**:
- BillingGroupEventHandlerStack
- BillingGroupReconciliationStack
- CURReconciliationStack

**Configuration**:
```typescript
interface ApplicationStageProps extends cdk.StageProps {
  env: {
    account: string;  // From CDK_DEFAULT_ACCOUNT
    region: string;   // From CDK_DEFAULT_REGION
  };
}
```

**Feature Stack Configuration**:
```typescript
// Event Handler
new BillingGroupEventHandlerStack(this, 'BillingGroupEventHandlerStack', {
  env: props.env,
  executionMode: 'events',
  tags: {
    Project: 'SampleAutomationsForBillingTransfer',
    ManagedBy: 'CDK',
  },
});

// Billing Group Reconciliation
new BillingGroupReconciliationStack(this, 'BillingGroupReconciliationStack', {
  env: props.env,
  scheduleExpression: 'cron(0 0 1 * ? *)', // Monthly
  environment: id.toLowerCase(),
  tags: {
    Project: 'SampleAutomationsForBillingTransfer',
    ManagedBy: 'CDK',
  },
});

// CUR Reconciliation
new CURReconciliationStack(this, 'CURReconciliationStack', {
  env: props.env,
  scheduleExpression: 'cron(0 23 * * ? *)', // Daily at 23:00 UTC
  environment: id.toLowerCase(),
  tags: {
    Project: 'SampleAutomationsForBillingTransfer',
    ManagedBy: 'CDK',
  },
});
```

## Data Models

### Build Environment Configuration

```typescript
{
  computeType: codebuild.ComputeType.SMALL,
  buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
}
```

**Rationale**:
- SMALL compute type: Cost-effective for TypeScript compilation and testing
- STANDARD_7_0 image: Includes Node.js 22 via 'n' tool
- Consistent across all CodeBuild projects

### Install Commands

```typescript
[
  'n 22',              // Switch to Node.js 22
  'node --version',    // Verify Node.js version
  'npm --version',     // Verify npm version
]
```

**Rationale**:
- Explicit Node.js 22 selection ensures consistency with Lambda runtime
- Version verification helps troubleshoot build issues
- Uses 'n' tool included in STANDARD_7_0 image

### Build Commands

```typescript
[
  'npm ci --prefer-offline --no-audit',  // Fast, deterministic install
  'npm run build',                        // Compile TypeScript
  'npm test',                             // Run all tests
  'npx cdk synth',                        // Synthesize CloudFormation
]
```

**Rationale**:
- `npm ci`: Faster and more reliable than `npm install` for CI/CD
- `--prefer-offline`: Uses cache when available
- `--no-audit`: Skips audit for faster builds (audit in separate process)
- Fail-fast: Each command must succeed before next runs

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Pipeline triggers on code push

*For any* code push to the main branch, the pipeline should trigger within 1 minute and begin execution
**Validates: Requirements 3.3**

### Property 2: Build commands execute in order

*For any* build execution, if a command fails, subsequent commands should not execute
**Validates: Requirements 14.1, 14.2, 14.3, 14.4**

### Property 3: Self-mutation before deployment

*For any* pipeline execution where pipeline code changed, the UpdatePipeline stage should complete before the Deploy stage executes
**Validates: Requirements 2.3, 2.4**

### Property 4: All feature stacks deploy together

*For any* deployment, all feature stacks in the ApplicationStage should be deployed in the same CloudFormation operation
**Validates: Requirements 6.5**

### Property 5: Node.js version consistency

*For any* build execution, the Node.js version used should be 22.x as verified by the version check command
**Validates: Requirements 5.2, 5.3**

### Property 6: Docker availability for bundling

*For any* synth execution that requires Docker bundling, Docker should be available in the build environment
**Validates: Requirements 9.2, 9.3**

## Error Handling

### Build Failures

**Scenario**: npm ci, npm run build, npm test, or npx cdk synth fails

**Handling**:
1. CodeBuild captures exit code
2. Pipeline marks build stage as failed
3. Subsequent stages do not execute
4. CloudWatch Logs capture full error output
5. Pipeline status shows failure in console

**Recovery**:
- Developer fixes issue locally
- Runs tests locally to verify fix
- Pushes corrected code to CodeCommit
- Pipeline automatically retries

### Deployment Failures

**Scenario**: CloudFormation stack deployment fails

**Handling**:
1. CloudFormation creates change set
2. Change set execution fails
3. CloudFormation rolls back changes
4. Pipeline marks deploy stage as failed
5. Feature stacks remain in previous stable state

**Recovery**:
- Developer reviews CloudFormation events
- Fixes infrastructure code
- Pushes corrected code to CodeCommit
- Pipeline automatically retries

### Self-Mutation Failures

**Scenario**: Pipeline self-mutation fails

**Handling**:
1. UpdatePipeline stage fails
2. Pipeline stops execution
3. Pipeline infrastructure remains in previous state
4. Error logged to CloudWatch

**Recovery**:
- Developer reviews pipeline code changes
- Fixes pipeline configuration
- Manually deploys PipelineStack: `cdk deploy PipelineStack`
- Pipeline resumes normal operation

## Testing Strategy

### Pipeline Self-Validation

The pipeline stack is infrastructure that self-validates through deployment. Unlike application code, the pipeline's correctness is verified by:

1. **CDK Synthesis**: `npm run cdk:synth` validates the pipeline configuration
2. **Deployment**: Successful deployment confirms the pipeline is correctly configured
3. **Execution**: Each pipeline run validates the build and deployment process
4. **Self-Mutation**: Pipeline updates itself when infrastructure code changes

### Integration Testing (Implicit)

Every code push to CodeCommit triggers an integration test:
- Source stage validates CodeCommit connectivity
- Build stage validates npm install, build, test, and synth
- UpdatePipeline stage validates self-mutation capability
- Deploy stage validates CloudFormation deployment

### Manual Verification

**Initial Setup Verification**:
1. Deploy PipelineStack: `cdk deploy PipelineStack`
2. Verify CloudFormation outputs are correct
3. Follow setup instructions to push code
4. Verify pipeline triggers and completes successfully
5. Verify feature stacks are deployed and functional

**Ongoing Verification**:
- Monitor pipeline executions in CodePipeline console
- Review CloudWatch Logs for build details
- Check CloudFormation stack events for deployment status

## Deployment Architecture

### Initial Deployment

```bash
# 1. Deploy the pipeline (one-time)
npm run cdk deploy PipelineStack

# 2. Add CodeCommit remote
git remote add codecommit <CODECOMMIT-URL>

# 3. Push code to trigger pipeline
git push codecommit main
```

### Ongoing Deployments

```bash
# Make changes to feature stacks
git add .
git commit -m "Update feature"
git push codecommit main

# Pipeline automatically:
# 1. Detects push
# 2. Runs build and tests
# 3. Updates itself if needed
# 4. Deploys feature stacks
```

### Pipeline Updates

```bash
# When pipeline code changes
git add lib/stacks/pipeline-stack.ts
git commit -m "Update pipeline"
git push codecommit main

# Pipeline automatically:
# 1. Detects push
# 2. Runs build and tests
# 3. Updates itself (self-mutation)
# 4. Restarts and deploys feature stacks
```

## Security Considerations

### IAM Permissions

**Pipeline Role**:
- S3: Read/write to artifact bucket
- CodeBuild: Start builds
- CloudFormation: Create/update/delete stacks
- IAM: Pass roles to CloudFormation

**CodeBuild Role**:
- S3: Read source artifacts, write build artifacts
- CloudWatch Logs: Write build logs
- ECR: Pull Docker images (for Lambda bundling)

**CloudFormation Role**:
- Full permissions to create feature stack resources
- Scoped to specific resource types needed by feature stacks

### CDK Nag Suppressions

**AwsSolutions-S1**: Artifact bucket access logging
- **Justification**: Temporary build artifacts don't require access logging
- **Risk**: Low - artifacts are short-lived and contain no sensitive data

**AwsSolutions-IAM5**: Wildcard IAM permissions
- **Justification**: CDK Pipelines requires wildcards for S3 artifacts, logs, and role assumptions
- **Risk**: Medium - mitigated by scoping to pipeline-specific resources

**AwsSolutions-CB4**: CodeBuild encryption
- **Justification**: Default encryption is sufficient for build artifacts
- **Risk**: Low - build artifacts contain no sensitive data

## Performance Considerations

### Build Time Optimization

**Compute Type**: SMALL (2 vCPU, 3 GB RAM)
- Sufficient for TypeScript compilation and testing
- Cost-effective for typical build workloads
- Can be increased to MEDIUM if builds are slow

**Dependency Caching**: Disabled
- Ensures fresh SDK install for each build
- Prevents cache-related issues
- Can be enabled if build times become problematic

**Parallel Execution**: Not applicable
- Pipeline stages execute sequentially
- Feature stacks deploy in parallel within ApplicationStage

### Pipeline Execution Time

**Typical Execution**:
- Source: < 1 minute
- Build: 3-5 minutes (npm ci, build, test, synth)
- UpdatePipeline: < 1 minute (if needed)
- Deploy: 5-10 minutes (CloudFormation deployment)
- **Total**: 10-15 minutes

**Optimization Opportunities**:
- Enable dependency caching (reduces npm ci time)
- Increase compute type (reduces build time)
- Parallelize tests (reduces test time)
- Use incremental builds (reduces compilation time)

## Monitoring and Observability

### CloudWatch Logs

**Build Logs**: `/aws/codebuild/<project-name>`
- npm ci output
- TypeScript compilation output
- Test results
- CDK synthesis output

**Pipeline Execution History**:
- Available in CodePipeline console
- Shows status of each stage
- Links to CloudWatch Logs for build details

### CloudWatch Alarms

**Recommended Alarms**:
- Pipeline execution failures
- Build stage failures
- Deploy stage failures
- Self-mutation failures

### Metrics

**Pipeline Metrics**:
- Execution frequency
- Success rate
- Average execution time
- Stage-specific execution times

## Maintenance and Operations

### Adding New Feature Stacks

1. Create stack in `lib/stacks/`
2. Import in `pipeline-stack.ts`
3. Instantiate in ApplicationStage
4. Push to CodeCommit
5. Pipeline automatically deploys new stack

### Updating Pipeline Configuration

1. Modify `pipeline-stack.ts`
2. Push to CodeCommit
3. Pipeline self-mutates
4. Verify pipeline updated correctly

### Troubleshooting

**Build Failures**:
- Check CodeBuild logs in CloudWatch
- Verify tests pass locally
- Verify CDK synthesis works locally

**Deployment Failures**:
- Check CloudFormation events
- Review CDK Nag findings
- Verify IAM permissions

**Self-Mutation Failures**:
- Review pipeline code changes
- Manually deploy PipelineStack
- Check for circular dependencies

## References

- [CDK Pipelines Documentation](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html)
- [CodePipeline Documentation](https://docs.aws.amazon.com/codepipeline/)
- [CodeBuild Documentation](https://docs.aws.amazon.com/codebuild/)
