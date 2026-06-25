# Requirements Document

## Introduction

This feature implements a self-mutating CDK Pipeline for continuous integration and deployment of the Billing Transfer Automation project. The pipeline automatically builds, tests, and deploys all feature stacks when code is pushed to the CodeCommit repository. Unlike traditional deployment where developers run `cdk deploy` manually, this pipeline provides automated, consistent, and auditable deployments with built-in testing and security checks. The pipeline is self-mutating, meaning it can update its own infrastructure when pipeline code changes.

## Glossary

- **CDK Pipeline**: AWS CDK construct that creates a CodePipeline for deploying CDK applications
- **Self-Mutating Pipeline**: A pipeline that can update its own infrastructure when pipeline code changes
- **PipelineStack**: The CDK stack that defines the CI/CD pipeline infrastructure
- **ApplicationStage**: A CDK Stage that groups all feature stacks for deployment
- **Feature Stack**: Individual CDK stacks that define application resources (e.g., BillingGroupEventHandlerStack)
- **CodeCommit**: AWS managed source control service using Git
- **CodePipeline**: AWS managed CI/CD service that orchestrates build and deployment
- **CodeBuild**: AWS managed build service that compiles code and runs tests
- **Synth Stage**: Pipeline stage that synthesizes CDK templates from TypeScript code
- **Deploy Stage**: Pipeline stage that deploys CloudFormation stacks to AWS
- **UpdatePipeline Stage**: Self-mutation stage that updates the pipeline itself
- **Artifact Bucket**: S3 bucket that stores pipeline artifacts between stages
- **Build Environment**: CodeBuild environment configuration including compute type and build image
- **CDK Nag**: Security and best practices validation tool for CDK applications

## Requirements

### Requirement 1

**User Story:** As a platform engineer, I want a CodeCommit repository for source control, so that I can trigger automated deployments when code is pushed.

#### Acceptance Criteria

1. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL create a CodeCommit repository named sample-automations-for-billing-transfer
2. WHEN the CodeCommit repository is created THEN the repository SHALL have a description Billing Transfer Automation CDK project
3. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL output the repository name as a CloudFormation output
4. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL output the HTTPS clone URL as a CloudFormation output
5. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL output the SSH clone URL as a CloudFormation output
6. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL output setup instructions for pushing code to the repository

### Requirement 2

**User Story:** As a platform engineer, I want a self-mutating CDK Pipeline, so that the pipeline can update itself when infrastructure code changes.

#### Acceptance Criteria

1. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL create a CodePipeline named SampleAutomationsForBillingTransferPipeline
2. WHEN the pipeline is created THEN the pipeline SHALL have selfMutation enabled
3. WHEN pipeline code changes are pushed to CodeCommit THEN the pipeline SHALL update its own infrastructure before deploying feature stacks
4. WHEN the pipeline updates itself THEN the pipeline SHALL continue with deployment after self-mutation completes
5. WHEN the PipelineStack is deployed THEN the PipelineStack SHALL output the pipeline name as a CloudFormation output

### Requirement 3

**User Story:** As a platform engineer, I want the pipeline to use CodeCommit as the source, so that code pushes trigger automated builds and deployments.

#### Acceptance Criteria

1. WHEN the pipeline is created THEN the pipeline SHALL use CodeCommit as the source provider
2. WHEN the pipeline is created THEN the pipeline SHALL monitor the main branch for changes
3. WHEN code is pushed to the main branch THEN the pipeline SHALL automatically trigger within 1 minute
4. WHEN the source stage completes THEN the pipeline SHALL pass the source code to the build stage
5. WHEN the source stage fails THEN the pipeline SHALL stop execution and report the failure

### Requirement 4

**User Story:** As a platform engineer, I want the pipeline to build and test code before deployment, so that broken code is not deployed to production.

#### Acceptance Criteria

1. WHEN the build stage executes THEN the build stage SHALL run npm ci --prefer-offline --no-audit to install dependencies
2. WHEN the build stage executes THEN the build stage SHALL run npm run build to compile TypeScript code
3. WHEN the build stage executes THEN the build stage SHALL run npm test to execute all tests
4. WHEN the build stage executes THEN the build stage SHALL run npx cdk synth to synthesize CloudFormation templates
5. WHEN any build command fails THEN the pipeline SHALL stop execution and report the failure
6. WHEN all build commands succeed THEN the pipeline SHALL pass synthesized templates to the deploy stage

### Requirement 5

**User Story:** As a platform engineer, I want the pipeline to use Node.js 22.x, so that the build environment matches the Lambda runtime.

#### Acceptance Criteria

1. WHEN the build stage executes THEN the build environment SHALL use CodeBuild STANDARD_7_0 build image with Node.js 22.x
2. WHEN the build stage starts THEN the build stage SHALL run node --version to verify Node.js 22.x version
3. WHEN the build stage starts THEN the build stage SHALL run npm --version to verify npm version
4. WHEN the build environment is configured THEN the compute type SHALL be SMALL for cost optimization
5. WHEN Lambda functions are deployed THEN the Lambda functions SHALL use Node.js 22.x runtime

### Requirement 6

**User Story:** As a platform engineer, I want the pipeline to deploy all feature stacks through an ApplicationStage, so that stacks are deployed together as a cohesive application.

#### Acceptance Criteria

1. WHEN the PipelineStack is created THEN the PipelineStack SHALL define an ApplicationStage class
2. WHEN the ApplicationStage is instantiated THEN the ApplicationStage SHALL create a BillingGroupEventHandlerStack
3. WHEN the ApplicationStage is instantiated THEN the ApplicationStage SHALL create a BillingGroupReconciliationStack
4. WHEN the ApplicationStage is instantiated THEN the ApplicationStage SHALL create a CURReconciliationStack
5. WHEN the pipeline deploys THEN the pipeline SHALL deploy all feature stacks in the ApplicationStage together
6. WHEN a feature stack deployment fails THEN the pipeline SHALL stop and report the failure

### Requirement 7

**User Story:** As a platform engineer, I want feature stacks to receive proper configuration, so that they deploy with correct settings.

#### Acceptance Criteria

1. WHEN the BillingGroupEventHandlerStack is instantiated THEN the stack SHALL receive executionMode set to events
2. WHEN the BillingGroupReconciliationStack is instantiated THEN the stack SHALL receive scheduleExpression set to cron(0 0 1 * ? *)
3. WHEN the CURReconciliationStack is instantiated THEN the stack SHALL receive scheduleExpression set to cron(0 23 * * ? *)
4. WHEN feature stacks are instantiated THEN all stacks SHALL receive environment from the stage props
5. WHEN feature stacks are instantiated THEN all stacks SHALL receive tags including Project and ManagedBy
6. WHEN feature stacks are instantiated THEN the environment tag SHALL use the stage name in lowercase

### Requirement 8

**User Story:** As a platform engineer, I want the pipeline to use the default AWS account and region, so that deployment targets are determined by AWS credentials.

#### Acceptance Criteria

1. WHEN the ApplicationStage is added to the pipeline THEN the stage SHALL use CDK_DEFAULT_ACCOUNT for the account
2. WHEN the ApplicationStage is added to the pipeline THEN the stage SHALL use CDK_DEFAULT_REGION for the region
3. WHEN the pipeline deploys THEN feature stacks SHALL deploy to the account and region from environment variables
4. WHEN CDK_DEFAULT_ACCOUNT is not set THEN the pipeline SHALL use the account from AWS credentials
5. WHEN CDK_DEFAULT_REGION is not set THEN the pipeline SHALL use the region from AWS credentials

### Requirement 9

**User Story:** As a platform engineer, I want Docker enabled for synthesis, so that CDK can use Docker-based bundling for Lambda functions.

#### Acceptance Criteria

1. WHEN the pipeline is created THEN the pipeline SHALL have dockerEnabledForSynth set to true
2. WHEN the synth stage executes THEN the synth stage SHALL have access to Docker for Lambda bundling
3. WHEN Lambda functions use esbuild bundling THEN the bundling SHALL execute successfully
4. WHEN Docker is not available THEN the synth stage SHALL fail with a clear error message
5. WHEN Docker bundling completes THEN the bundled Lambda code SHALL be included in the CloudFormation template

### Requirement 10

**User Story:** As a platform engineer, I want CDK Nag suppressions for pipeline resources, so that security checks pass for legitimate pipeline patterns.

#### Acceptance Criteria

1. WHEN CDK Nag checks run THEN the PipelineStack SHALL suppress AwsSolutions-S1 for the artifact bucket with justification that access logging is not required for temporary build artifacts
2. WHEN CDK Nag checks run THEN the PipelineStack SHALL suppress AwsSolutions-IAM5 for pipeline IAM roles with justification that wildcard permissions are necessary for pipeline operation
3. WHEN CDK Nag checks run THEN the PipelineStack SHALL suppress AwsSolutions-CB4 for CodeBuild projects with justification that default encryption is sufficient
4. WHEN CDK Nag checks run THEN all suppressions SHALL apply to the entire stack using the recursive flag
5. WHEN CDK Nag checks run THEN the PipelineStack SHALL pass all security checks after suppressions

### Requirement 11

**User Story:** As a platform engineer, I want the pipeline to build itself during deployment, so that the pipeline structure is finalized before deployment.

#### Acceptance Criteria

1. WHEN the PipelineStack is synthesized THEN the PipelineStack SHALL call pipeline.buildPipeline() to finalize the pipeline structure
2. WHEN buildPipeline is called THEN the pipeline SHALL create all necessary stages and actions
3. WHEN buildPipeline is called THEN the pipeline SHALL validate the pipeline configuration
4. WHEN buildPipeline is not called THEN CDK synthesis SHALL fail with an error
5. WHEN the pipeline is built THEN the pipeline SHALL be ready for deployment

### Requirement 12

**User Story:** As a platform engineer, I want clear setup instructions in CloudFormation outputs, so that developers know how to push code to trigger deployments.

#### Acceptance Criteria

1. WHEN the PipelineStack is deployed THEN the CloudFormation outputs SHALL include setup instructions
2. WHEN setup instructions are displayed THEN the instructions SHALL include how to install git-remote-codecommit
3. WHEN setup instructions are displayed THEN the instructions SHALL include how to add the CodeCommit remote
4. WHEN setup instructions are displayed THEN the instructions SHALL include how to push code to trigger the pipeline
5. WHEN setup instructions are displayed THEN the instructions SHALL explain that the pipeline triggers automatically on pushes to main

### Requirement 13

**User Story:** As a platform engineer, I want the pipeline to use consistent build settings, so that all CodeBuild projects have the same configuration.

#### Acceptance Criteria

1. WHEN the pipeline is created THEN the pipeline SHALL set codeBuildDefaults for all CodeBuild projects
2. WHEN codeBuildDefaults are set THEN the compute type SHALL be SMALL
3. WHEN codeBuildDefaults are set THEN the build image SHALL be STANDARD_7_0
4. WHEN a new CodeBuild project is added to the pipeline THEN the project SHALL inherit the default settings
5. WHEN default settings are overridden THEN the override SHALL take precedence over defaults

### Requirement 14

**User Story:** As a platform engineer, I want the pipeline to fail fast on errors, so that issues are detected early in the deployment process.

#### Acceptance Criteria

1. WHEN npm ci fails THEN the build stage SHALL stop immediately and report the failure
2. WHEN npm run build fails THEN the build stage SHALL stop immediately and report the failure
3. WHEN npm test fails THEN the build stage SHALL stop immediately and report the failure
4. WHEN npx cdk synth fails THEN the build stage SHALL stop immediately and report the failure
5. WHEN any stage fails THEN subsequent stages SHALL not execute

### Requirement 15

**User Story:** As a platform engineer, I want the pipeline to be deployed only once, so that the pipeline infrastructure is stable and managed separately from feature stacks.

#### Acceptance Criteria

1. WHEN deploying the project THEN the PipelineStack SHALL be deployed manually using cdk deploy PipelineStack
2. WHEN the PipelineStack is deployed THEN feature stacks SHALL NOT be deployed directly
3. WHEN feature stacks need updates THEN developers SHALL push code to CodeCommit instead of running cdk deploy
4. WHEN the pipeline is deployed THEN the pipeline SHALL manage all subsequent deployments automatically
5. WHEN the PipelineStack needs updates THEN developers SHALL run cdk deploy PipelineStack to update the pipeline infrastructure
