---
inclusion: manual
---

# Pipeline Guide

## Overview

This project uses **AWS CodePipeline** with AWS CDK Pipelines for CI/CD. The pipeline is self-mutating and automatically updates itself when infrastructure changes.

**IMPORTANT**: This project uses **CodePipeline** (not GitLab CI/CD or GitHub Actions). Always check CodePipeline for build failures and deployment status.

## Pipeline Architecture

```
CodeCommit → CodeBuild (Build & Test) → UpdatePipeline → Assets → Deploy Stacks (BT)
```

### Pipeline Stages

1. **Source**: Monitors CodeCommit repository for changes
2. **Build**: Runs `npm ci`, `npm run build`, `npm test`, `npx cdk synth`
3. **UpdatePipeline**: Self-mutates the pipeline if infrastructure changes
4. **Assets**: Publishes Lambda function code and other assets to S3
5. **BT**: Deploys all application stacks (BillingGroupEventHandler, BillingGroupReconciliation, CURReconciliation, BillingTransferTermination)

## Setup

### Initial Deployment

```bash
# Deploy the pipeline stack
npm run cdk:deploy SampleAutomationsForBillingTransfer-PipelineStack

# Push to both remotes (triggers pipeline)
git push all main
```

### Multi-Remote Strategy

This project uses three git remotes:

- **origin**: GitLab (primary development)
- **codecommit**: CodeCommit (triggers CI/CD pipeline)
- **all**: Pushes to both origin and codecommit

```bash
# Normal workflow - push to both remotes
git add .
git commit -m "Your changes"
git push all main

# Push to specific remote if needed
git push origin main        # GitLab only
git push codecommit main    # CodeCommit only (triggers pipeline)

# Fetch from all remotes
git fetch --all
```

### CodeCommit Authentication

```bash
# HTTPS credential helper
git config --global credential.helper '!aws codecommit credential-helper $@'
git config --global credential.UseHttpPath true

# Or for AWS SSO users
pip install git-remote-codecommit
git remote add codecommit codecommit://sample-automations-for-billing-transfer
```

## Pipeline Optimization

### Build Optimizations

**npm Install:**
```typescript
commands: [
  'npm ci --prefer-offline --no-audit',  // Faster, uses cache
  'npm run build',
  'npm test',
  'npx cdk synth',
]
```

**CodeBuild Caching:**
```typescript
cache: codebuild.Cache.local(
  codebuild.LocalCacheMode.SOURCE,
  codebuild.LocalCacheMode.CUSTOM
),
partialBuildSpec: codebuild.BuildSpec.fromObject({
  cache: {
    paths: ['node_modules/**/*', '.npm/**/*'],
  },
}),
```

**Performance Impact:**
- First build: ~4-5 minutes
- Subsequent builds: ~2-3 minutes (50-60% faster)

### Lambda Optimizations

- **ARM64 architecture**: 20% cost savings, 19% better performance
- **ES Module format**: Better tree-shaking, smaller bundles
- **Bundle all dependencies**: Required for Organizations/Billing Conductor clients

## Troubleshooting

### CRITICAL: Always Check CodePipeline First

**This project uses AWS CodePipeline, NOT GitLab CI/CD or GitHub Actions.**

When debugging build or deployment failures:
1. ✅ Check AWS CodePipeline console or CLI
2. ✅ Review CodeBuild logs in CloudWatch
3. ✅ Check CloudFormation stack events for deployment failures
4. ❌ Don't look for GitLab CI/CD pipelines
5. ❌ Don't look for GitHub Actions workflows

### Checking Pipeline Status

```bash
# Get overall pipeline state
aws codepipeline get-pipeline-state \
  --name SampleAutomationsForBillingTransferPipeline \
  --no-cli-pager \
  --output json | jq '.stageStates[] | {stageName, status: .latestExecution.status}'

# Get detailed stage information
aws codepipeline get-pipeline-state \
  --name SampleAutomationsForBillingTransferPipeline \
  --no-cli-pager \
  --output json | jq '.stageStates[] | select(.stageName == "BT")'
```

### Pipeline Not Triggering

**Symptom:** Push to CodeCommit doesn't trigger pipeline

**Solution:**
```bash
# Verify remote
git remote -v

# Check pipeline state
aws codepipeline get-pipeline-state \
  --name SampleAutomationsForBillingTransferPipeline \
  --no-cli-pager

# Check recent executions
aws codepipeline list-pipeline-executions \
  --pipeline-name SampleAutomationsForBillingTransferPipeline \
  --max-results 5 \
  --no-cli-pager
```

### Build Failures

**Symptom:** Pipeline fails during Build stage

**Debugging Steps:**
1. Check CodePipeline console for error details
2. Review CodeBuild logs in CloudWatch
3. Run build locally to reproduce

**Solution:**
```bash
# Run locally first
npm run build
npm test
npm run cdk:synth

# Check CodeBuild logs (get log group from pipeline)
aws logs tail /aws/codebuild/PipelineBuildSynthCdkBuildP-<BUILD_ID> \
  --since 10m \
  --no-cli-pager \
  --follow
```

### Deployment Failures (BT Stage)

**Symptom:** Pipeline fails during BT stage deployment

**Common Causes:**
1. **Resource conflicts**: Old stacks with different names still exist
2. **CloudFormation validation errors**: Early validation hooks failing
3. **IAM permission issues**: Lambda roles missing required permissions
4. **Resource limits**: Account quotas exceeded

**Debugging:**
```bash
# Check CloudFormation change set details
aws cloudformation describe-change-set \
  --change-set-name <CHANGE_SET_ARN> \
  --no-cli-pager

# Check CloudFormation stack events
aws cloudformation describe-stack-events \
  --stack-name BT-BillingGroupEventHandlerStack \
  --max-items 20 \
  --no-cli-pager

# List existing stacks that might conflict
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --no-cli-pager | jq '.StackSummaries[] | select(.StackName | contains("BillingGroup") or contains("CUR"))'
```

### Resource Conflicts

**Symptom:** CloudFormation fails with "ResourceExistenceCheck" or resource already exists errors

**Common Scenario:** Pipeline stage name changed (e.g., "Deploy" → "BT"), but old stacks still exist

**Solution:**
```bash
# List old stacks
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --no-cli-pager

# Delete old stacks (if safe to do so). Feature stacks deployed by the
# pipeline use the "BT-" prefix (the ApplicationStage id); older deployments
# may have used a "Deploy-" prefix.
aws cloudformation delete-stack --stack-name BT-BillingGroupEventHandlerStack
aws cloudformation delete-stack --stack-name BT-BillingGroupReconciliationStack
aws cloudformation delete-stack --stack-name BT-CURReconciliationStack
aws cloudformation delete-stack --stack-name BT-BillingTransferTerminationStack

# Check for retained resources (S3 buckets with Retain policy)
aws s3 ls | grep -i "cur\|billing"

# Delete retained S3 buckets if needed (after verifying it's safe)
aws s3 rb s3://<bucket-name> --force
```

### CDK Nag Violations

**Symptom:** Synthesis fails with CDK Nag errors

**Solution:**
1. Run `npm run cdk:synth` locally
2. Fix violations or add documented suppressions
3. See `.kiro/steering/cdk-nag-guide.md` for common suppressions

### Node.js Version Issues

**Symptom:** Build uses wrong Node.js version

**Solution:** Pipeline uses the `STANDARD_7_0` build image and explicitly switches to Node.js 22 via `n 22` in the synth step's install commands. After updating the pipeline stack, push to trigger self-mutation.

### Lambda Runtime Errors

**Symptom:** Lambda invocation fails after a successful deployment; errors appear in CloudWatch

**Debug:**
```bash
# Tail logs for a specific function (replace with the target function name)
aws logs tail /aws/lambda/billing-group-reconciliation \
  --since 10m \
  --no-cli-pager | grep -i "error\|fail"
```

1. Check the Lambda logs in CloudWatch for the specific error
2. Verify IAM permissions (Billing Conductor / Organizations actions)
3. Verify environment variables are set as expected

**Common Causes:** Missing IAM permissions, AWS SDK errors (ensure `externalModules: []` so the SDK is bundled), missing upstream resources.

## Debugging Workflow

A quick end-to-end loop when something fails:

1. **Identify failure point** - Check pipeline state (`get-pipeline-state`)
2. **Get error details** - Check the relevant logs (CodeBuild / CloudFormation / Lambda)
3. **Fix issue** - Make code changes
4. **Test locally** - `npm run build && npm test && npm run cdk:synth`
5. **Deploy** - Commit and `git push all main` (or `git push codecommit main` to trigger only the pipeline)
6. **Verify** - Monitor the pipeline through to the BT stage

## Monitoring

### Pipeline Status

```bash
# Get overall pipeline state
aws codepipeline get-pipeline-state \
  --name SampleAutomationsForBillingTransferPipeline \
  --query 'stageStates[*].[stageName,latestExecution.status]' \
  --output table

# Get detailed error information
aws codepipeline get-pipeline-state \
  --name SampleAutomationsForBillingTransferPipeline \
  --query 'stageStates[?stageName==`Build`].actionStates[0].latestExecution' \
  --output json
```

### CloudWatch Logs

All CodeBuild logs are in CloudWatch Logs:
- Log Group: `/aws/codebuild/PipelineBuildSynthCdkBuildP-<BUILD_PROJECT_ID>`
- Retention: 30 days (default)

## Self-Mutation

The pipeline automatically updates itself when you change `pipeline-stack.ts`:

1. Push changes to CodeCommit
2. UpdatePipeline stage runs
3. Next execution uses updated configuration

No manual intervention required.

## Security Best Practices

### Avoid Exposing Sensitive Information

When working with this project, **NEVER** include sensitive information in:
- Code comments
- Commit messages
- Documentation
- Steering files
- Log messages (use placeholders)
- Error messages

**Sensitive Information Includes:**
- AWS Account IDs
- Account numbers
- Organization IDs
- Transfer ARNs (contain account info)
- Billing group ARNs (contain account info)
- S3 bucket names (if they contain account IDs)
- IAM role ARNs (contain account IDs)
- Any customer-specific identifiers

**Use Placeholders Instead:**
```bash
# ❌ BAD - Exposes account ID
aws cloudformation describe-stacks --stack-name BT-Stack --account 123456789012

# ✅ GOOD - Uses placeholder
aws cloudformation describe-stacks --stack-name BT-Stack --account <ACCOUNT_ID>

# ❌ BAD - Exposes account in commit message
git commit -m "Fixed billing group for account 123456789012"

# ✅ GOOD - Uses generic description
git commit -m "Fixed billing group creation for direct transfers"
```

**In Documentation:**
- Use `<ACCOUNT_ID>` instead of actual account IDs
- Use `<TRANSFER_ID>` instead of actual transfer IDs
- Use `<BUCKET_NAME>` instead of actual bucket names
- Use `<REGION>` instead of specific regions when not relevant

## Best Practices

1. **Test locally first**: Run `npm run build`, `npm test`, `npm run cdk:synth` before pushing
2. **Monitor first build**: Watch the first build after pipeline changes
3. **Use caching**: Configured by default for faster builds
4. **Keep dependencies updated**: Regularly update npm packages
5. **Review logs**: Check CodeBuild logs for detailed error messages
6. **Check CodePipeline**: Always check AWS CodePipeline for build/deployment status, not GitLab or GitHub
7. **Protect sensitive data**: Never commit account IDs, ARNs, or other sensitive information
8. **Use --no-cli-pager**: Always include `--no-cli-pager` flag in AWS CLI commands to prevent hanging
