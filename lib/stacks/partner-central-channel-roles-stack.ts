// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { IdempotentRole } from '../constructs/idempotent-role.js';
import {
  buildRoleSpecs,
  assertValidAccountId,
  HANDSHAKE_APPROVAL_MANAGED_POLICY_ARN,
} from './channel-role-specs.js';

/**
 * Returns `true` when `value` has the shape of an AWS region identifier, e.g.
 * `us-east-1`, `ap-southeast-2`, or `us-gov-west-1` — one or more
 * hyphen-separated lowercase-letter segments followed by a final numeric
 * segment. Validates shape only; it does not check that the region exists.
 *
 * Implemented with a linear scan over hyphen-separated parts rather than a
 * regular expression, so there is no possibility of catastrophic backtracking
 * (ReDoS): each part is validated by a single character-class test.
 */
function isAwsRegionShape(value: string): boolean {
  const parts = value.split('-');
  // Need at least one letter segment plus a trailing numeric segment.
  if (parts.length < 2) {
    return false;
  }
  const last = parts[parts.length - 1];
  const letterParts = parts.slice(0, -1);
  const isLetters = (s: string): boolean =>
    s.length > 0 && [...s].every((c) => c >= 'a' && c <= 'z');
  // Trailing segment is exactly one digit (matches real AWS regions, e.g. -1).
  const isSingleDigit = (s: string): boolean => s.length === 1 && s >= '0' && s <= '9';
  return letterParts.every(isLetters) && isSingleDigit(last);
}

/**
 * Properties for {@link PartnerCentralChannelRolesStack}.
 *
 * All deployment configuration is supplied through props (or the standard CDK
 * `env`); no account id or region is hard-coded anywhere in the stack.
 */
export interface PartnerCentralChannelRolesStackProps extends cdk.StackProps {
  /**
   * REQUIRED. 12-digit account id of the Partner Central Linked Account. No
   * default. Validated as exactly 12 numeric digits before any construct is
   * created.
   */
  readonly partnerCentralLinkedAccountId: string;

  /**
   * When `true`, provision the optional
   * `PartnerCentralChannelBillingTransferManagement` role. Must be an explicit
   * boolean (`true` | `false`); any other value is a deployment error.
   *
   * @default false
   */
  readonly enableManagementRole?: boolean;
}

/**
 * CDK Stack that provisions the AWS Partner Central "Access for the Channel
 * API" IAM roles into a program management (Bill-Transfer / payer) account.
 *
 * Because Partner Central requires roles with exact, fixed names, a native
 * `AWS::IAM::Role` resource fails with `EntityAlreadyExists` when a same-named
 * role already exists out-of-band. To meet the idempotent, skip-if-exists
 * requirement, each role is provisioned through an {@link IdempotentRole}
 * custom resource backed by a shared provider Lambda. The Lambda performs a
 * per-role existence check and creates, updates, or skips the role, failing
 * closed when existence cannot be determined.
 *
 * The stack validates its inputs first — before creating any construct — so an
 * invalid input fails fast and creates no IAM role resources.
 */
export class PartnerCentralChannelRolesStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: PartnerCentralChannelRolesStackProps
  ) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Validate FIRST — before creating any construct — so that an invalid
    // input throws in the constructor and no IAM role resources are added to
    // the template (Requirements 6.2, 6.3, 6.10, 6.11).
    // ---------------------------------------------------------------------

    // Required Partner Central Linked Account id: exactly 12 numeric digits.
    const linkedAccountId = assertValidAccountId(
      props.partnerCentralLinkedAccountId,
      'partnerCentralLinkedAccountId'
    );

    // Program Management Account id (the deployment target) comes from the
    // standard CDK env and must be a 12-digit account id.
    assertValidAccountId(props.env?.account, 'props.env.account');

    // Deployment region must be a well-formed AWS region identifier.
    const region = props.env?.region;
    if (typeof region !== 'string' || !isAwsRegionShape(region)) {
      throw new Error(
        `props.env.region must be a valid AWS region identifier ` +
          `(e.g. "us-east-1"); received: ${
            region === undefined ? 'undefined' : `"${region}"`
          }`
      );
    }

    // enableManagementRole is typed boolean | undefined, but a value sourced
    // from CDK context can arrive as an arbitrary type at runtime. Enforce a
    // strict boolean when present (Requirement 6.3).
    if (
      props.enableManagementRole !== undefined &&
      typeof props.enableManagementRole !== 'boolean'
    ) {
      throw new Error(
        `enableManagementRole must be a boolean (true|false); received: ` +
          `${String(props.enableManagementRole)}`
      );
    }
    const enableManagementRole = props.enableManagementRole === true;

    // ---------------------------------------------------------------------
    // KMS key for the provider Lambda's environment encryption.
    // ---------------------------------------------------------------------
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'KMS key for Partner Central channel roles provider encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      alias: 'partner-central-channel-roles-key',
    });

    // ---------------------------------------------------------------------
    // Provider Lambda handler — performs the per-role existence check and the
    // create / update / skip provisioning, idempotently.
    // ---------------------------------------------------------------------
    const handler = new NodejsFunction(this, 'ChannelRolesProviderHandler', {
      functionName: 'partner-central-channel-roles-provider',
      entry: 'lib/lambda/partner-central-channel-roles/index.ts',
      handler: 'onEvent',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64, // Graviton2 for cost efficiency
      tracing: lambda.Tracing.ACTIVE, // X-Ray tracing
      reservedConcurrentExecutions: 5, // Limit concurrent executions for safety
      environmentEncryption: encryptionKey, // KMS encryption for environment variables
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        format: OutputFormat.ESM,
        mainFields: ['module', 'main'],
        banner:
          "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
        // CRITICAL: bundle all dependencies (including @aws-sdk/client-iam),
        // which is not part of the Lambda runtime.
        externalModules: [],
      },
      environment: {
        LOG_LEVEL: 'INFO',
        POWERTOOLS_SERVICE_NAME: 'PartnerCentralChannelRoles',
        POWERTOOLS_METRICS_NAMESPACE: 'SampleAutomationsForBillingTransfer',
      },
    });

    // ---------------------------------------------------------------------
    // Build the declarative role specs and the exact role-name ARNs the
    // handler is allowed to manage (Requirement 7.3). All ARNs are derived from
    // props/env — no hard-coded account ids.
    // ---------------------------------------------------------------------
    const roleSpecs = buildRoleSpecs({
      partnerCentralLinkedAccountId: linkedAccountId,
      enableManagementRole,
    });

    const managedRoleArns = roleSpecs.map(
      (spec) => `arn:aws:iam::${this.account}:role/${spec.RoleName}`
    );

    // Role lifecycle actions, scoped to ONLY the exact role-name ARNs this
    // stack manages — never '*'. These IAM actions support resource-level
    // permissions, so they are constrained per Requirement 7.3 / Property 9.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ManageChannelRoles',
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:GetRole',
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:TagRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:DetachRolePolicy',
          'iam:UpdateAssumeRolePolicy',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
        ],
        resources: managedRoleArns,
      })
    );

    // AttachRolePolicy is scoped to the same role ARNs AND additionally
    // constrained — via the `iam:PolicyARN` condition key — to only the
    // specific AWS managed channel policy ARNs this stack attaches, so the
    // handler can never attach an arbitrary managed policy. `iam:PassRole` is
    // deliberately NOT granted: the handler attaches policies to the channel
    // roles but never passes a role to a service.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AttachChannelManagedPolicies',
        effect: iam.Effect.ALLOW,
        actions: ['iam:AttachRolePolicy'],
        resources: managedRoleArns,
        conditions: {
          ArnEquals: {
            'iam:PolicyARN': [HANDSHAKE_APPROVAL_MANAGED_POLICY_ARN],
          },
        },
      })
    );

    // ---------------------------------------------------------------------
    // Single shared provider for all role custom resources.
    // ---------------------------------------------------------------------
    const provider = new Provider(this, 'ChannelRolesProvider', {
      onEventHandler: handler,
    });

    // ---------------------------------------------------------------------
    // One IdempotentRole custom resource per spec, wired to the shared
    // provider, plus one CfnOutput per role exposing its outcome and name
    // (Requirement 6.8).
    // ---------------------------------------------------------------------
    for (const spec of roleSpecs) {
      const role = new IdempotentRole(this, `Role${spec.RoleName}`, {
        serviceToken: provider.serviceToken,
        spec,
      });

      new cdk.CfnOutput(this, `Outcome${spec.RoleName}`, {
        value: role.outcome,
        description:
          `Provisioning outcome (created|updated|skipped) for IAM role ` +
          `${spec.RoleName}. "skipped" means a same-named role already existed ` +
          `and was left unchanged.`,
      });
    }

    // ---------------------------------------------------------------------
    // Standard project tags.
    // ---------------------------------------------------------------------
    cdk.Tags.of(this).add('Project', 'SampleAutomationsForBillingTransfer');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Component', 'PartnerCentralChannelRoles');

    // ---------------------------------------------------------------------
    // Documented cdk-nag suppressions (Requirements 7.4, 7.5).
    // ---------------------------------------------------------------------
    this.addCdkNagSuppressions(handler, provider);
  }

  /**
   * Add documented cdk-nag suppressions with non-empty justifications, scoped
   * to the specific resource and `appliesTo` finding where required
   * (Requirements 7.4, 7.5).
   *
   * Note: the Partner Central channel roles (Handshake Approval, Read-Only,
   * and Management) are **not** synthesized as `AWS::IAM::Role` resources —
   * they are created at deploy time by the provider Lambda through custom
   * resources. The cdk-nag findings therefore land on (1) the provider
   * Lambda's own execution role and runtime, and (2) the CDK `Provider`
   * framework's managed Lambda/role wiring. The wildcard-resource
   * justification for the channel roles' inline permission policies — whose
   * `organizations:`/`billingconductor:` list/describe actions do not support
   * resource-level permissions (Requirement 7.4) — is recorded here and is
   * additionally covered for Checkov by the global `CKV_AWS_111` skip in
   * `.checkov.yaml`.
   *
   * No literal account ids appear in any suppression text.
   */
  private addCdkNagSuppressions(handler: NodejsFunction, provider: Provider): void {
    // AwsSolutions-IAM4: the provider handler's execution role uses the AWS
    // managed AWSLambdaBasicExecutionRole for standard CloudWatch Logs access.
    NagSuppressions.addResourceSuppressions(
      handler,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole provides the standard CloudWatch Logs ' +
            'permissions required for Lambda execution. This is an AWS managed ' +
            'policy appropriate for the provider handler.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
      true // apply to the child execution role
    );

    // AwsSolutions-IAM5 (Resource::*): two sources of wildcard resources on the
    // handler's execution role —
    //   (1) the channel roles' inline permission policies that the handler
    //       writes at deploy time grant organizations:/billingconductor:
    //       list/describe actions that DO NOT support resource-level
    //       permissions, so Resource: '*' is required (Requirement 7.4); and
    //   (2) X-Ray ActiveTracing (PutTraceSegments/PutTelemetryRecords) which
    //       only supports a wildcard resource.
    NagSuppressions.addResourceSuppressions(
      handler,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            "Resource '*' is required because: (1) the organizations: and " +
            'billingconductor: list/describe actions granted by the channel ' +
            "roles' inline permission policies do not support resource-level " +
            'permissions (Requirement 7.4); and (2) X-Ray ' +
            'PutTraceSegments/PutTelemetryRecords are standard tracing ' +
            'permissions that only support a wildcard resource. The role ' +
            'lifecycle actions this handler uses (iam:GetRole/CreateRole/etc.) ' +
            'remain scoped to the exact managed role-name ARNs.',
          appliesTo: ['Resource::*'],
        },
      ],
      true // apply to the child execution role / default policy
    );

    // AwsSolutions-L1: the handler runs on Node.js 22.x, the latest LTS.
    NagSuppressions.addResourceSuppressions(handler, [
      {
        id: 'AwsSolutions-L1',
        reason:
          'Using Node.js 22.x which is the latest LTS runtime supported by AWS Lambda.',
      },
    ]);

    // AwsSolutions-IAM5 / IAM4 / L1 on the CDK Provider framework wiring. The
    // custom-resources.Provider synthesizes a framework Lambda + role whose
    // policy contains a lambda:InvokeFunction grant scoped to the onEvent
    // handler (and its versions, hence a wildcard suffix) and the standard
    // managed execution policy. These are emitted by the managed CDK framework
    // construct, not by this stack's own policies; apply to children.
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The CDK custom-resources.Provider framework synthesizes a ' +
            'framework role whose lambda:InvokeFunction grant is scoped to the ' +
            "onEvent handler function (the wildcard suffix covers the function's " +
            'versions). This wildcard originates from the managed framework ' +
            'construct and cannot be further constrained.',
          // The resource reference embeds the handler's generated logical-id
          // hash (e.g. <ChannelRolesProviderHandler....Arn>:*); match it with a
          // regex rather than hard-coding the synth hash.
          appliesTo: [
            { regex: '/^Resource::<ChannelRolesProviderHandler.*\\.Arn>:\\*$/g' },
          ],
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'The CDK custom-resources.Provider framework Lambda uses the AWS ' +
            'managed AWSLambdaBasicExecutionRole for CloudWatch Logs access. ' +
            'This is emitted by the managed framework construct.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'The Lambda runtime of the CDK custom-resources.Provider framework ' +
            'function is managed by the framework construct and is not ' +
            'configurable by this stack.',
        },
      ],
      true // apply to the framework construct's children (Lambda + role)
    );
  }
}
