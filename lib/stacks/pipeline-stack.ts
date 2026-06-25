// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { BillingGroupEventHandlerStack } from './billing-group-event-handler-stack.js';
import { BillingGroupReconciliationStack } from './billing-group-reconciliation-stack.js';
import { BillingTransferTerminationStack } from './billing-transfer-termination-stack.js';
import { CURReconciliationStack } from './cur-reconciliation-stack.js';
import { PartnerCentralChannelRolesStack } from './partner-central-channel-roles-stack.js';

/** Coerce a context- or env-sourced flag to a strict boolean. */
const toBool = (value: unknown): boolean => value === true || value === 'true';

const TWELVE_DIGITS = /^\d{12}$/;

// Obvious non-real account ids that must never reach a real deployment. Covers
// the AWS docs placeholder and this repo's documentation/test placeholders.
// All-identical-digit values (e.g. 111111111111) are caught by the regex check
// in assertValidLinkedAccountId, so they are not listed here. (Epoch-millis
// timestamps used in test fixtures are not account ids and are excluded.)
const PLACEHOLDER_ACCOUNT_IDS = new Set<string>([
  '111122223333',
  '123456789012',
  '210987654321',
  '222233334444',
  '333344445555',
  '987654321098',
  '999888777666',
]);

/**
 * Validate the Partner Central Linked Account id, throwing (and thereby failing
 * `cdk synth` / the pipeline) when it is unset, not a 12-digit number, or an
 * obvious placeholder. This runs at synth time in both contexts:
 *   - the initial local `cdk deploy` (value from `.env`), and
 *   - the pipeline's Synth step (value read from SSM).
 */
function assertValidLinkedAccountId(value: string | undefined): string {
  if (!value) {
    throw new Error(
      'Partner Central linked account id is not set. Set ' +
        'PARTNER_CENTRAL_LINKED_ACCOUNT_ID in .env for the initial local deploy, ' +
        'and ensure the SSM parameter ' +
        '"/billing-transfer/partner-central/linked-account-id" is populated for ' +
        'pipeline runs.'
    );
  }
  if (!TWELVE_DIGITS.test(value)) {
    throw new Error(
      `Partner Central linked account id must be exactly 12 digits; got "${value}".`
    );
  }
  if (PLACEHOLDER_ACCOUNT_IDS.has(value) || /^(\d)\1{11}$/.test(value)) {
    throw new Error(
      `Partner Central linked account id "${value}" is a placeholder. Set the ` +
        'real 12-digit linked account id (in .env for the initial deploy, then ' +
        'in SSM for the pipeline).'
    );
  }
  return value;
}

// SSM Parameter Store is the source of truth for the Partner Central
// channel-roles configuration consumed at pipeline synth time. The pipeline's
// Synth step reads these by name on every run (initial + self-mutation), so the
// values are sourced identically regardless of how the PipelineStack itself was
// deployed. Parameter NAMES are committed (not secret); the linked account id
// VALUE lives only in SSM (and the gitignored local `.env`).
const SSM_PARAM_PREFIX = '/billing-transfer/partner-central';
const LINKED_ACCOUNT_ID_PARAM = `${SSM_PARAM_PREFIX}/linked-account-id`;
const ENABLE_MANAGEMENT_ROLE_PARAM = `${SSM_PARAM_PREFIX}/enable-management-role`;

// Note: CKV_AWS_111 (IAM policy wildcard resources) is suppressed via CDK Nag
// for CDK Pipelines as the pipeline requires these permissions to function.
// The wildcard permissions are scoped to pipeline-specific resources by CDK Pipelines.

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create CodeCommit repository
    const repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: 'sample-automations-for-billing-transfer',
      description: 'Billing Transfer Automation CDK project',
    });

    // Configure CodeCommit as pipeline source
    const source = pipelines.CodePipelineSource.codeCommit(repository, 'main');

    // -----------------------------------------------------------------------
    // Partner Central channel-roles configuration.
    //
    // SSM Parameter Store is the single source of truth for the linked account
    // id and the management-role flag. The flow is:
    //
    //   1. The INITIAL local `cdk deploy` of THIS PipelineStack creates the two
    //      SSM parameters, seeding their values from the local `.env` (via
    //      dotenv in bin/app.ts -> process.env). This is the only time `.env`
    //      is read.
    //   2. Thereafter the pipeline owns all deployments. Its Synth step reads
    //      the parameters from SSM on every run (initial + self-mutation) and
    //      exports them before `cdk synth` (see the Synth `commands` below), so
    //      the channel-roles stack is configured identically every time —
    //      independent of any local `.env`.
    //
    // The SSM parameter NAMES are committed (they are not secrets); the linked
    // account id VALUE lives only in SSM (seeded from the gitignored `.env`),
    // never in the repo.
    //
    // The parameters are created here, in the PipelineStack, so the initial
    // local deploy provisions them. The value is validated first and fails the
    // build if unset, malformed, or a placeholder. Updating the value
    // day-to-day is done directly in SSM (or via
    // `bt partner-central seed-params`); the pipeline always reads the live
    // SSM value, not this synth-time default.
    const linkedAccountId = assertValidLinkedAccountId(
      process.env.PARTNER_CENTRAL_LINKED_ACCOUNT_ID
    );
    const enableManagementRole = toBool(process.env.ENABLE_MANAGEMENT_ROLE);

    // Provision the two channel-roles SSM parameters idempotently.
    //
    // These parameters can also be seeded out-of-band by
    // `bt partner-central seed-params` (`ssm put-parameter --overwrite`),
    // so they may already exist in the target account. A native
    // `ssm.StringParameter` (AWS::SSM::Parameter) is CREATE-only: if the name
    // already exists, CloudFormation fails early validation with "already
    // exists" — which is what broke the pipeline's self-mutation (the Build
    // stage only runs `synth`, so the conflict first surfaces at deploy time in
    // UpdatePipeline/SelfMutate, not in the build logs).
    //
    // Using `PutParameter` with `Overwrite: true` via a custom resource makes
    // provisioning create-or-update — matching this repo's "idempotent,
    // skip-if-exists" convention (see the channel-roles stack) and tolerating a
    // pre-seeded value. The PipelineStack seeds from .env on the initial local
    // deploy; thereafter SSM is the source of truth and the pipeline reads it.
    this.putParameterIdempotent(
      'LinkedAccountIdParam',
      LINKED_ACCOUNT_ID_PARAM,
      linkedAccountId
    );
    this.putParameterIdempotent(
      'EnableManagementRoleParam',
      ENABLE_MANAGEMENT_ROLE_PARAM,
      String(enableManagementRole)
    );

    // Create CDK Pipeline with synth stage
    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'SampleAutomationsForBillingTransferPipeline',
      synth: new pipelines.CodeBuildStep('Synth', {
        input: source,
        commands: [
          // Read Partner Central channel-roles config from SSM at build time.
          // If the linked-account parameter is unset/empty, the export yields an
          // empty string and `cdk synth` fails fast in this stack's constructor
          // (assertValidLinkedAccountId) — by design, since every deployment
          // target is a PMA that must get the channel roles. The parameter
          // NAMES are not secrets; the account id VALUE lives only in SSM.
          `export PARTNER_CENTRAL_LINKED_ACCOUNT_ID="$(aws ssm get-parameter --name ${LINKED_ACCOUNT_ID_PARAM} --query Parameter.Value --output text 2>/dev/null || true)"`,
          `export ENABLE_MANAGEMENT_ROLE="$(aws ssm get-parameter --name ${ENABLE_MANAGEMENT_ROLE_PARAM} --query Parameter.Value --output text 2>/dev/null || true)"`,
          'npm ci --prefer-offline --no-audit',
          'npm run build',
          'npm test',
          'npx cdk synth',
        ],
        // The Synth step's CodeBuild role must be able to read the two channel-
        // roles parameters from SSM in the account/region the pipeline runs in.
        // Scoped to exactly the two parameter ARNs (no wildcard). SSM parameter
        // ARNs take the form `.../parameter/<name without leading slash>`, so
        // the leading '/' is stripped when composing resourceName.
        rolePolicyStatements: [
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: [LINKED_ACCOUNT_ID_PARAM, ENABLE_MANAGEMENT_ROLE_PARAM].map(
              (name) =>
                cdk.Arn.format(
                  {
                    service: 'ssm',
                    resource: 'parameter',
                    resourceName: name.replace(/^\//, ''),
                  },
                  this
                )
            ),
          }),
        ],
        installCommands: [
          // Switch to Node.js 22 explicitly
          'n 22',
          'node --version',
          'npm --version',
        ],
        buildEnvironment: {
          computeType: codebuild.ComputeType.SMALL,
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, // Includes Node.js 22 via 'n' tool
        },
        // Caching disabled to ensure fresh SDK install
        // cache: codebuild.Cache.local(
        //   codebuild.LocalCacheMode.SOURCE,
        //   codebuild.LocalCacheMode.CUSTOM
        // ),
      }),
      selfMutation: true,
      dockerEnabledForSynth: true,
      codeBuildDefaults: {
        buildEnvironment: {
          computeType: codebuild.ComputeType.SMALL,
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, // Node.js 22 via 'n' tool
        },
      },
    });

    // Add deployment stage
    pipeline.addStage(new ApplicationStage(this, 'BT', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      },
      partnerCentralLinkedAccountId: linkedAccountId,
      enableManagementRole,
    }));

    // Create CloudFormation stack outputs
    new cdk.CfnOutput(this, 'RepositoryName', {
      value: repository.repositoryName,
      description: 'CodeCommit repository name',
    });

    new cdk.CfnOutput(this, 'RepositoryCloneUrlHttp', {
      value: repository.repositoryCloneUrlHttp,
      description: 'CodeCommit repository HTTPS clone URL',
    });

    new cdk.CfnOutput(this, 'RepositoryCloneUrlSsh', {
      value: repository.repositoryCloneUrlSsh,
      description: 'CodeCommit repository SSH clone URL',
    });

    // Build the pipeline to finalize its structure
    pipeline.buildPipeline();

    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipeline.pipelineName,
      description: 'Name of the CDK Pipeline',
    });

    new cdk.CfnOutput(this, 'SetupInstructions', {
      value: `Repository created successfully!
To push your code:
1. Install git-remote-codecommit: pip install git-remote-codecommit
2. Add remote: git remote add codecommit codecommit://sample-automations-for-billing-transfer
3. Push code: git push codecommit main

The pipeline will automatically trigger on code pushes to the main branch.`,
      description: 'Instructions for using the CodeCommit repository',
    });

    // CDK Nag Suppressions
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Pipeline artifact bucket does not require access logging - it only stores temporary build artifacts',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK Pipelines requires wildcard permissions for S3 artifacts, CodeBuild logs, and IAM role assumptions. These are necessary for pipeline operation and are scoped to pipeline-specific resources.',
        appliesTo: [
          'Action::s3:Abort*',
          'Action::s3:DeleteObject*',
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          'Resource::<PipelineArtifactsBucketAEA9A052.Arn>/*',
          {
            regex: '/^Action::s3:\\*$/g',
          },
          {
            regex: '/^Resource::arn:aws:logs:.*:log-group:/aws/codebuild/.*$/g',
          },
          {
            regex: '/^Resource::arn:aws:codebuild:.*:report-group/.*$/g',
          },
          {
            regex: '/^Resource::arn:\\*:iam::.*:role/\\*$/g',
          },
          'Resource::*',
        ],
      },
      {
        id: 'AwsSolutions-CB4',
        reason: 'CodeBuild projects use default encryption. Customer-managed KMS keys are not required for this use case.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'The CDK AwsCustomResource framework Lambda (used to provision the ' +
          'channel-roles SSM parameters idempotently) uses the AWS managed ' +
          'AWSLambdaBasicExecutionRole for CloudWatch Logs access. This is ' +
          'emitted by the managed framework construct.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'The Lambda runtime of the CDK AwsCustomResource framework function ' +
          'is managed by the framework construct and is not configurable by ' +
          'this stack.',
      },
    ], true);
  }

  /**
   * Provision an SSM String parameter idempotently (create-or-overwrite).
   *
   * Unlike a native `AWS::SSM::Parameter` (which is create-only and fails with
   * "already exists" when the name is taken — e.g. pre-seeded by
   * `bt partner-central seed-params`), this uses `PutParameter` with
   * `Overwrite: true` via a custom resource so an existing parameter is
   * updated rather than colliding. The `PhysicalResourceId` is the parameter
   * name so updates target the same resource; on stack delete the parameter is
   * intentionally left in place (it is the durable source of truth read by the
   * pipeline Synth step and may be shared with the seed script).
   */
  private putParameterIdempotent(
    id: string,
    name: string,
    value: string
  ): void {
    const parameterArn = cdk.Arn.format(
      {
        service: 'ssm',
        resource: 'parameter',
        resourceName: name.replace(/^\//, ''),
      },
      this
    );

    new cr.AwsCustomResource(this, id, {
      // Re-run PutParameter whenever the value changes (the value is part of
      // the physical id payload below), keeping SSM in sync on every deploy.
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: name,
          Value: value,
          Type: 'String',
          Overwrite: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of(name),
      },
      onUpdate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: name,
          Value: value,
          Type: 'String',
          Overwrite: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of(name),
      },
      // Leave the parameter in place on delete; it is the durable source of
      // truth and may be shared with the out-of-band seed script.
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ssm:PutParameter'],
          resources: [parameterArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
  }

}

// ApplicationStage class - defines what gets deployed
interface ApplicationStageProps extends cdk.StageProps {
  /**
   * 12-digit Partner Central Linked Account id. REQUIRED: every deployment
   * target is a Program Management Account that must receive the channel roles.
   * The value is validated (12 digits, not a placeholder) by the PipelineStack
   * before the stage is created, and is read from SSM by the pipeline Synth
   * step.
   */
  readonly partnerCentralLinkedAccountId: string;
  readonly enableManagementRole?: boolean;
}

class ApplicationStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: ApplicationStageProps) {
    super(scope, id, props);

    // Apply CDK Nag at the stage level so the feature stacks deployed by the
    // pipeline are checked (with their own suppressions) during synth, and a
    // NagReport CSV is emitted per feature stack. The app-level aspect in
    // bin/app.ts only reports on the top-level PipelineStack; the feature
    // stacks live inside this stage, so they need the aspect applied here to
    // produce accurate, suppression-aware compliance evidence.
    cdk.Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true, reports: true }));

    // Instantiate BillingGroupEventHandlerStack (Event-driven handler)
    new BillingGroupEventHandlerStack(this, 'BillingGroupEventHandlerStack', {
      env: props.env,
      executionMode: 'events', // Only event-driven execution
      tags: {
        Project: 'SampleAutomationsForBillingTransfer',
        ManagedBy: 'CDK',
      },
    });

    // Instantiate BillingGroupReconciliationStack (Scheduled reconciliation)
    new BillingGroupReconciliationStack(this, 'BillingGroupReconciliationStack', {
      env: props.env,
      environment: id.toLowerCase(), // Use stage name as environment
      tags: {
        Project: 'SampleAutomationsForBillingTransfer',
        ManagedBy: 'CDK',
      },
    });

    // Instantiate CURReconciliationStack (CUR report reconciliation)
    new CURReconciliationStack(this, 'CURReconciliationStack', {
      env: props.env,
      environment: id.toLowerCase(), // Use stage name as environment
      tags: {
        Project: 'SampleAutomationsForBillingTransfer',
        ManagedBy: 'CDK',
      },
    });

    // Instantiate BillingTransferTerminationStack (Termination notifications)
    new BillingTransferTerminationStack(this, 'BillingTransferTerminationStack', {
      env: props.env,
      notificationEmails: [], // Configure email addresses as needed
      tags: {
        Project: 'SampleAutomationsForBillingTransfer',
        ManagedBy: 'CDK',
      },
    });

    // Instantiate PartnerCentralChannelRolesStack (Partner Central channel
    // roles in this payer account). Always deployed: every target is a Program
    // Management Account that must receive the channel roles. The linked account
    // id is validated upstream in the PipelineStack (12 digits, not a
    // placeholder), so no per-stage gating is needed — the channel-roles stack
    // deploys into THIS stage's account (the payer), the same env the other four
    // stacks use.
    new PartnerCentralChannelRolesStack(this, 'PartnerCentralChannelRolesStack', {
      env: props.env,
      partnerCentralLinkedAccountId: props.partnerCentralLinkedAccountId,
      enableManagementRole: props.enableManagementRole ?? false,
      tags: {
        Project: 'SampleAutomationsForBillingTransfer',
        ManagedBy: 'CDK',
      },
    });
  }
}
