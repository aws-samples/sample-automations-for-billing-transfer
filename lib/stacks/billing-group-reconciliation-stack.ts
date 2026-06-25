// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import { NagSuppressions } from 'cdk-nag';

export interface BillingGroupReconciliationStackProps extends cdk.StackProps {
  /**
   * Schedule expression for reconciliation.
   * Default: cron(0,30 * * * ? *) - every 30 minutes at :00 and :30 (UTC).
   *
   * Runs on the hour/half-hour and is intentionally staggered 15 minutes ahead
   * of CUR reconciliation (which runs at :15/:45) so that a billing group
   * created here exists before the CUR run looks for it.
   */
  scheduleExpression?: string;

  /**
   * Lambda timeout in seconds
   * Default: 900 (15 minutes)
   */
  timeout?: number;

  /**
   * Lambda memory in MB
   * Default: 512
   */
  memory?: number;

  /**
   * Environment for tagging
   * Default: 'dev'
   */
  environment?: string;
}

export class BillingGroupReconciliationStack extends cdk.Stack {
  public readonly reconciliationFunction: NodejsFunction;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly dlqAlarm: cloudwatch.Alarm;
  public readonly schedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props?: BillingGroupReconciliationStackProps) {
    super(scope, id, props);

    // Get configuration from props or use defaults
    const scheduleExpression = props?.scheduleExpression || 'cron(0,30 * * * ? *)';
    const timeout = props?.timeout || 900; // 15 minutes
    const memory = props?.memory || 512;
    const env = props?.environment || 'dev';

    // Create KMS key for encryption of SQS and Lambda environment variables
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'KMS key for Billing Group Reconciliation encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      alias: 'billing-group-reconciliation-key',
    });

    // Create Dead Letter Queue for failed Lambda invocations with KMS encryption
    this.deadLetterQueue = new sqs.Queue(this, 'ReconciliationDLQ', {
      queueName: 'billing-reconciliation-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true, // AwsSolutions-SQS4: require requests to use SSL/TLS
    });

    // Create Lambda function for reconciliation
    this.reconciliationFunction = new NodejsFunction(this, 'ReconciliationFunction', {
      functionName: 'billing-group-reconciliation',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: 'lib/lambda/billing-group-reconciliation/index.ts',
      timeout: cdk.Duration.seconds(timeout),
      memorySize: memory,
      architecture: lambda.Architecture.ARM_64, // Graviton2 for cost efficiency
      tracing: lambda.Tracing.ACTIVE, // Enable X-Ray tracing
      deadLetterQueue: this.deadLetterQueue,
      deadLetterQueueEnabled: true,
      reservedConcurrentExecutions: 5, // Limit concurrent executions for safety
      environmentEncryption: encryptionKey, // KMS encryption for environment variables
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        format: OutputFormat.ESM,
        mainFields: ['module', 'main'],
        banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
        // Bundle all dependencies including AWS SDK clients
        // Organizations and Billing Conductor clients are not in Lambda runtime, must be bundled
        externalModules: [], // Don't externalize anything - bundle all dependencies
      },
      environment: {
        LOG_LEVEL: 'INFO',
        PRICING_PLAN_NAME: 'BasicPricingPlan',
        POWERTOOLS_SERVICE_NAME: 'BillingGroupReconciliation',
        POWERTOOLS_METRICS_NAMESPACE: 'SampleAutomationsForBillingTransfer',
        FORCE_UPDATE: '1', // Force Lambda update
      },
    });

    // Create CloudWatch Alarm for DLQ messages
    this.dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      alarmName: 'BillingReconciliationDLQAlarm',
      alarmDescription: 'Alert when messages appear in reconciliation DLQ',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Grant IAM permissions for Organizations API - List operations (no resource-level permissions)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OrganizationsListAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'organizations:ListAccounts',
          'organizations:ListInboundResponsibilityTransfers',
        ],
        resources: ['*'],
      })
    );

    // Organizations - DescribeResponsibilityTransfer with ARN pattern
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OrganizationsDescribeTransfer',
        effect: iam.Effect.ALLOW,
        actions: ['organizations:DescribeResponsibilityTransfer'],
        resources: [`arn:aws:organizations::${this.account}:transfer/*/billing/*/*`],
      })
    );

    // Grant IAM permissions for Billing Conductor API - List operations (no resource-level permissions)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingConductorListAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'billingconductor:ListPricingPlans',
          'billingconductor:ListBillingGroups',
        ],
        resources: ['*'],
      })
    );

    // Billing Conductor - CreateBillingGroup with pricingplan ARN pattern
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingConductorCreateGroup',
        effect: iam.Effect.ALLOW,
        actions: ['billingconductor:CreateBillingGroup'],
        resources: [`arn:aws:billingconductor::${this.account}:pricingplan/*`],
      })
    );

    // Billing Conductor - TagResource with billinggroup ARN pattern
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingConductorTagResource',
        effect: iam.Effect.ALLOW,
        actions: ['billingconductor:TagResource'],
        resources: [`arn:aws:billingconductor::${this.account}:billinggroup/*`],
      })
    );

    // Billing API - Read access for billing views.
    // Reconciliation analyzes existing resources via listAllResources(), which
    // calls billing:ListBillingViews. Billing view APIs do not support
    // resource-level permissions, so a wildcard resource is required.
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingReadAccess',
        effect: iam.Effect.ALLOW,
        actions: ['billing:ListBillingViews'],
        resources: ['*'],
      })
    );

    // Legacy CUR API - Read access for report definitions.
    // listAllResources() also calls cur:DescribeReportDefinitions to detect
    // existing CUR configurations. This API does not support resource-level
    // permissions, so a wildcard resource is required.
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CURReadAccess',
        effect: iam.Effect.ALLOW,
        actions: ['cur:DescribeReportDefinitions'],
        resources: ['*'],
      })
    );

    // Create EventBridge Scheduler
    this.schedule = new scheduler.Schedule(this, 'ReconciliationSchedule', {
      scheduleName: 'billing-group-reconciliation-schedule',
      description: 'Triggers billing group reconciliation on a schedule',
      schedule: scheduler.ScheduleExpression.expression(scheduleExpression),
      target: new targets.LambdaInvoke(this.reconciliationFunction, {
        input: scheduler.ScheduleTargetInput.fromObject({
          source: 'scheduler',
          action: 'reconcile-all',
        }),
        maxEventAge: cdk.Duration.hours(1),
        retryAttempts: 2,
      }),
    });

    // Grant EventBridge Scheduler permission to invoke Lambda
    this.reconciliationFunction.grantInvoke(
      new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
        },
      })
    );

    // Apply tags to all resources
    cdk.Tags.of(this).add('Project', 'SampleAutomationsForBillingTransfer');
    cdk.Tags.of(this).add('Environment', env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Component', 'BillingGroupReconciliation');

    // CDK Nag Suppressions
    this.addCdkNagSuppressions();

    // Output important ARNs
    new cdk.CfnOutput(this, 'ReconciliationFunctionArn', {
      value: this.reconciliationFunction.functionArn,
      description: 'ARN of the reconciliation Lambda function',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the Dead Letter Queue',
    });

    new cdk.CfnOutput(this, 'ScheduleName', {
      value: this.schedule.scheduleName,
      description: 'Name of the EventBridge Schedule',
    });
  }

  /**
   * Add CDK Nag suppressions with justifications
   */
  private addCdkNagSuppressions(): void {
    // Suppress AwsSolutions-IAM5 for Billing Conductor wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Billing Conductor APIs (ListPricingPlans, ListBillingGroups, CreateBillingGroup) do not support resource-level permissions. Wildcard is required.',
          appliesTo: [
            'Resource::*',
            {
              regex: '/^Resource::arn:aws:billingconductor:.*/g',
            },
          ],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for Organizations wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Organizations APIs (ListAccounts, ListInboundResponsibilityTransfers) do not support resource-level permissions. Wildcard is required.',
          appliesTo: [
            'Resource::*',
            {
              regex: '/^Resource::arn:aws:organizations:.*/g',
            },
          ],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for Billing and CUR read wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Billing (ListBillingViews) and Legacy CUR (DescribeReportDefinitions) read APIs do not support resource-level permissions. Wildcard is required to analyze existing billing transfer resources during reconciliation.',
          appliesTo: ['Resource::*'],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM4 for AWSLambdaBasicExecutionRole
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole provides standard CloudWatch Logs permissions required for Lambda execution. This is an AWS managed policy appropriate for this use case.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
      true // Apply to children (role)
    );

    // Suppress AwsSolutions-L1 for Lambda runtime version
    NagSuppressions.addResourceSuppressions(this.reconciliationFunction, [
      {
        id: 'AwsSolutions-L1',
        reason: 'Using Node.js 22.x which is the latest LTS version supported by AWS Lambda.',
      },
    ]);

    // Suppress AwsSolutions-IAM5 on the CDK-generated EventBridge Scheduler
    // target role (stack-scoped construct id `SchedulerRoleForTarget-<hash>`).
    // It uses a `<FunctionArn>:*` resource to invoke the target across
    // versions/aliases. Locate by id prefix to avoid the generated hash.
    for (const child of this.node.findAll()) {
      if (child.node.id.startsWith('SchedulerRoleForTarget')) {
        NagSuppressions.addResourceSuppressions(
          child,
          [
            {
              id: 'AwsSolutions-IAM5',
              reason:
                "CDK-generated EventBridge Scheduler target role uses a function-ARN wildcard (<FunctionArn>:*) to invoke the target Lambda across versions/aliases. Scoped to this stack's function.",
              appliesTo: [
                {
                  regex: '/^Resource::<ReconciliationFunction.*\\.Arn>:\\*$/g',
                },
              ],
            },
          ],
          true
        );
      }
    }
  }
}
