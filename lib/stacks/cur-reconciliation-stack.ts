// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import { NagSuppressions } from 'cdk-nag';

/**
 * Properties for CURReconciliationStack
 */
export interface CURReconciliationStackProps extends cdk.StackProps {
  /**
   * Schedule expression for CUR reconciliation.
   * Default: cron(15,45 * * * ? *) - every 30 minutes at :15 and :45 (UTC).
   *
   * Runs on the quarter/three-quarter hour, intentionally staggered 15 minutes
   * behind billing group reconciliation (which runs at :00/:30) so the billing
   * group a CUR depends on has been created before this run looks for it.
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

  /**
   * Configuration template key in S3 bucket
   * Default: 'export-configuration-template.json'
   */
  configKey?: string;
}

/**
 * CDK Stack for CUR (Cost and Usage Report) Reconciliation
 * 
 * This stack creates infrastructure to automatically create and manage
 * AWS Cost and Usage Reports for billing transfer relationships using the Legacy CUR API.
 * 
 * Key Components:
 * - S3 bucket for configuration template storage
 * - Lambda function for CUR reconciliation
 * - EventBridge Scheduler for daily execution
 * - Dead Letter Queue for failed invocations
 * - CloudWatch alarms for monitoring
 */
export class CURReconciliationStack extends cdk.Stack {
  public readonly configBucket: s3.Bucket;
  public readonly curDestinationBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly reconciliationFunction: NodejsFunction;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly dlqAlarm: cloudwatch.Alarm;
  public readonly errorAlarm: cloudwatch.Alarm;
  public readonly schedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props?: CURReconciliationStackProps) {
    super(scope, id, props);

    // Get configuration from props or use defaults
    const scheduleExpression = props?.scheduleExpression || 'cron(15,45 * * * ? *)';
    const timeout = props?.timeout || 900; // 15 minutes
    const memory = props?.memory || 512;
    const env = props?.environment || 'dev';
    const configKey = props?.configKey || 'export-configuration-template.json';

    // Create KMS key for encryption of SQS and Lambda environment variables
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'KMS key for CUR Reconciliation encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      alias: 'cur-reconciliation-key',
    });

    // Create S3 bucket for access logs
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // AwsSolutions-S10: require requests to use SSL/TLS
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          // Delete old access logs after 90 days
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // Create S3 bucket for configuration template
    // Let CDK generate a unique bucket name to avoid conflicts
    this.configBucket = new s3.Bucket(this, 'ConfigBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // AwsSolutions-S10: require requests to use SSL/TLS
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain bucket on stack deletion
      autoDeleteObjects: false,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'config-bucket-logs/',
    });

    // Create S3 bucket for CUR report delivery
    // Let CDK generate a unique bucket name to avoid conflicts
    this.curDestinationBucket = new s3.Bucket(this, 'CURDestinationBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // AwsSolutions-S10: require requests to use SSL/TLS
      versioned: true, // Enable versioning for audit trail
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain bucket and data on stack deletion
      autoDeleteObjects: false,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'cur-destination-logs/',
      lifecycleRules: [
        {
          // Transition old reports to cheaper storage classes
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // Add bucket policy to allow Legacy CUR API to write reports
    // Add bucket policy to allow Legacy CUR API to write reports
    // Policy matches AWS documentation: https://docs.aws.amazon.com/cur/latest/userguide/cur-s3.html
    this.curDestinationBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCURToGetBucketInfo',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('billingreports.amazonaws.com')],
        actions: ['s3:GetBucketAcl', 's3:GetBucketPolicy'],
        resources: [this.curDestinationBucket.bucketArn],
        conditions: {
          StringEquals: {
            'aws:SourceArn': `arn:aws:cur:us-east-1:${this.account}:definition/*`,
            'aws:SourceAccount': this.account,
          },
        },
      })
    );

    this.curDestinationBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCURToPutObjects',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('billingreports.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${this.curDestinationBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'aws:SourceArn': `arn:aws:cur:us-east-1:${this.account}:definition/*`,
            'aws:SourceAccount': this.account,
          },
        },
      })
    );

    // Create Dead Letter Queue for failed Lambda invocations with KMS encryption
    this.deadLetterQueue = new sqs.Queue(this, 'CURReconciliationDLQ', {
      queueName: 'cur-reconciliation-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true, // AwsSolutions-SQS4: require requests to use SSL/TLS
    });

    // Create Lambda function for CUR reconciliation
    this.reconciliationFunction = new NodejsFunction(this, 'CURReconciliationFunction', {
      functionName: 'cur-reconciliation',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: 'lib/lambda/cur-reconciliation/index.ts',
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
        // Bundle all AWS SDK dependencies
        // Organizations, Billing Conductor, Billing, Legacy CUR, and Support clients
        // are not in Lambda runtime and must be bundled
        externalModules: [], // Bundle all dependencies
      },
      environment: {
        CONFIG_BUCKET: this.configBucket.bucketName,
        CONFIG_KEY: configKey,
        LOG_LEVEL: 'INFO',
        POWERTOOLS_SERVICE_NAME: 'CURReconciliation',
        POWERTOOLS_METRICS_NAMESPACE: 'SampleAutomationsForBillingTransfer',
      },
    });

    // Grant S3 read permissions to Lambda
    this.configBucket.grantRead(this.reconciliationFunction);

    // Deploy the CUR report configuration template into the config bucket at
    // deploy time. Previously the bucket was created empty and the template had
    // to be uploaded out-of-band, so the Lambda failed with "key does not
    // exist". Generating it here also lets us bind s3Bucket to THIS account's
    // CUR destination bucket instead of a hardcoded bucket name, so every payer
    // writes reports to its own bucket.
    const reportConfigTemplate = {
      version: '1.0',
      myViewReportConfig: {
        enabled: true,
        timeUnit: 'DAILY',
        format: 'Parquet',
        compression: 'Parquet',
        additionalSchemaElements: ['RESOURCES'],
        s3Bucket: this.curDestinationBucket.bucketName,
        s3Prefix: 'my-view-reports',
        s3Region: this.region,
        refreshClosedReports: true,
        reportVersioning: 'OVERWRITE_REPORT',
        tags: {
          ViewType: 'MyView',
          ManagedBy: 'CURReconciliation',
        },
        backfill: {
          enabled: false,
        },
      },
      showbackViewReportConfig: {
        enabled: true,
        timeUnit: 'DAILY',
        format: 'Parquet',
        compression: 'Parquet',
        additionalSchemaElements: [],
        s3Bucket: this.curDestinationBucket.bucketName,
        s3Prefix: 'showback-view-reports',
        s3Region: this.region,
        refreshClosedReports: true,
        reportVersioning: 'OVERWRITE_REPORT',
        tags: {
          ViewType: 'ShowbackView',
          ManagedBy: 'CURReconciliation',
        },
        backfill: {
          enabled: false,
        },
      },
    };

    // Source.jsonData resolves CDK tokens (the destination bucket name) at
    // deploy time, writing the rendered JSON to the config bucket under the
    // same key the Lambda reads (CONFIG_KEY).
    new s3deploy.BucketDeployment(this, 'ConfigDeployment', {
      sources: [s3deploy.Source.jsonData(configKey, reportConfigTemplate)],
      destinationBucket: this.configBucket,
      prune: false, // Don't delete other objects (e.g. access-log prefix artifacts)
    });

    // Organizations - List operations (no resource-level permissions)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OrganizationsListAccess',
        effect: iam.Effect.ALLOW,
        actions: ['organizations:ListInboundResponsibilityTransfers'],
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

    // Billing Conductor - List operations (no resource-level permissions).
    // The shared analyzeTransfers()/listAllResources() path lists both billing
    // groups and pricing plans, so both List actions are required.
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingConductorAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'billingconductor:ListBillingGroups',
          'billingconductor:ListPricingPlans',
        ],
        resources: ['*'],
      })
    );

    // Billing API - Read operations (no resource-level permissions)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingReadAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'billing:ListBillingViews',
          'billing:GetBillingView',
          'billing:ListTagsForResource',
        ],
        resources: ['*'],
      })
    );

    // Billing API - TagResource with ARN pattern
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BillingTagAccess',
        effect: iam.Effect.ALLOW,
        actions: ['billing:TagResource'],
        resources: [`arn:aws:billing::${this.account}:billingview/*`],
      })
    );

    // Legacy CUR API - Read operations (no resource-level permissions)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CURReadAccess',
        effect: iam.Effect.ALLOW,
        actions: ['cur:DescribeReportDefinitions'],
        resources: ['*'],
      })
    );

    // Legacy CUR API - Write operations with ARN pattern
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CURWriteAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'cur:PutReportDefinition',
          'cur:ModifyReportDefinition',
          'cur:TagResource',
        ],
        resources: [`arn:aws:cur:us-east-1:${this.account}:definition/*`],
      })
    );

    // S3 validation - checking bucket policies (read-only, constrained to S3)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'S3ValidationAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetBucketPolicy',
          's3:GetBucketLocation',
          's3:ListBucket',
        ],
        resources: ['arn:aws:s3:::*'],
      })
    );

    // Support API - CreateCase (no resource-level permissions per AWS docs)
    this.reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SupportAccess',
        effect: iam.Effect.ALLOW,
        actions: ['support:CreateCase'],
        resources: ['*'],
      })
    );

    // Create EventBridge Scheduler for daily reconciliation
    this.schedule = new scheduler.Schedule(this, 'CURReconciliationSchedule', {
      scheduleName: 'cur-reconciliation-schedule',
      description: 'Triggers CUR reconciliation on a schedule',
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

    // Create CloudWatch Alarm for DLQ messages
    this.dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      alarmName: 'CURReconciliationDLQAlarm',
      alarmDescription: 'Alert when messages appear in CUR reconciliation DLQ',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Create CloudWatch Alarm for Lambda errors
    this.errorAlarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmName: 'CURReconciliationErrorAlarm',
      alarmDescription: 'Alert when CUR reconciliation Lambda function errors occur',
      metric: this.reconciliationFunction.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Apply tags to all resources
    cdk.Tags.of(this).add('Project', 'SampleAutomationsForBillingTransfer');
    cdk.Tags.of(this).add('Environment', env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Component', 'CURReconciliation');

    // CDK Nag Suppressions
    this.addCdkNagSuppressions();

    // Output important ARNs and values
    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: this.configBucket.bucketName,
      description: 'Name of the S3 bucket for configuration template',
      exportName: 'CURReconciliation-ConfigBucketName',
    });

    new cdk.CfnOutput(this, 'ConfigBucketArn', {
      value: this.configBucket.bucketArn,
      description: 'ARN of the S3 bucket for configuration template',
    });

    new cdk.CfnOutput(this, 'CURDestinationBucketName', {
      value: this.curDestinationBucket.bucketName,
      description: 'Name of the S3 bucket for CUR report delivery',
      exportName: 'CURReconciliation-CURDestinationBucketName',
    });

    new cdk.CfnOutput(this, 'CURDestinationBucketArn', {
      value: this.curDestinationBucket.bucketArn,
      description: 'ARN of the S3 bucket for CUR report delivery',
    });

    new cdk.CfnOutput(this, 'ReconciliationFunctionArn', {
      value: this.reconciliationFunction.functionArn,
      description: 'ARN of the CUR reconciliation Lambda function',
    });

    new cdk.CfnOutput(this, 'ReconciliationFunctionName', {
      value: this.reconciliationFunction.functionName,
      description: 'Name of the CUR reconciliation Lambda function',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the Dead Letter Queue',
    });

    new cdk.CfnOutput(this, 'ScheduleName', {
      value: this.schedule.scheduleName,
      description: 'Name of the EventBridge Schedule',
    });

    new cdk.CfnOutput(this, 'ScheduleExpression', {
      value: scheduleExpression,
      description: 'Schedule expression for CUR reconciliation',
    });
  }

  /**
   * Add CDK Nag suppressions with justifications
   */
  private addCdkNagSuppressions(): void {
    // Suppress AwsSolutions-IAM5 for Organizations wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Organizations APIs (ListInboundResponsibilityTransfers, DescribeResponsibilityTransfer) do not support resource-level permissions. Wildcard is required.',
          appliesTo: ['Resource::*'],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for Billing Conductor wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Billing Conductor APIs (ListBillingGroups) do not support resource-level permissions. Wildcard is required.',
          appliesTo: ['Resource::*'],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for Billing API wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Billing APIs (ListBillingViews, GetBillingView) do not support resource-level permissions. Wildcard is required.',
          appliesTo: ['Resource::*'],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for Data Exports wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Data Exports APIs (CreateExport, ListExports, GetExport, TagResource) do not support resource-level permissions. Wildcard is required.',
          appliesTo: ['Resource::*'],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for S3 validation wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 validation requires checking bucket policies for any S3 bucket specified in configuration. Wildcard is necessary to validate buckets across accounts.',
          appliesTo: ['Resource::arn:aws:s3:::*'],
        },
      ],
      true // Apply to children (role policy)
    );

    // Suppress AwsSolutions-IAM5 for Support API wildcard permissions
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Support APIs (CreateCase) do not support resource-level permissions. Wildcard is required.',
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

    // Suppress AwsSolutions-S1 for S3 access logs bucket (cannot log to itself)
    NagSuppressions.addResourceSuppressions(this.accessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Access logs bucket cannot log to itself. This is a standard pattern for S3 access logging.',
      },
    ]);

    // Suppress findings on the CDK aws-s3-deployment framework singleton
    // (`Custom::CDKBucketDeployment<hash>`). Its handler Lambda, role, and
    // policy are generated by the framework and shared across BucketDeployments
    // in the stack; they are not configurable here. Locate by id prefix to
    // avoid depending on the generated hash.
    for (const child of this.node.findAll()) {
      if (child.node.id.startsWith('Custom::CDKBucketDeployment')) {
        NagSuppressions.addResourceSuppressions(
          child,
          [
            {
              id: 'AwsSolutions-IAM4',
              reason:
                'BucketDeployment is a CDK framework construct; its handler role uses the AWS managed AWSLambdaBasicExecutionRole emitted by the construct.',
              appliesTo: [
                'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
              ],
            },
            {
              id: 'AwsSolutions-IAM5',
              reason:
                'BucketDeployment is a CDK framework construct; its handler policy contains S3 wildcard actions/resources scoped to the CDK asset bucket and the destination config bucket, generated by the construct and not configurable here.',
              appliesTo: [
                'Action::s3:GetObject*',
                'Action::s3:GetBucket*',
                'Action::s3:List*',
                'Action::s3:DeleteObject*',
                'Action::s3:Abort*',
                'Resource::arn:aws:s3:::cdk-hnb659fds-assets-<AWS::AccountId>-<AWS::Region>/*',
                {
                  regex: '/^Resource::arn:aws:s3:::cdk-hnb659fds-assets-.*\\/\\*$/g',
                },
                {
                  regex: '/^Resource::<ConfigBucket.*\\.Arn>\\/\\*$/g',
                },
              ],
            },
            {
              id: 'AwsSolutions-L1',
              reason:
                'The BucketDeployment handler runtime is managed by the CDK aws-s3-deployment framework construct and is not configurable by this stack.',
            },
          ],
          true
        );
      }
    }

    // Suppress AwsSolutions-IAM5 on the CDK-generated EventBridge Scheduler
    // target role. CDK creates this role (a stack-scoped construct whose id is
    // `SchedulerRoleForTarget-<hash>`) with a `<FunctionArn>:*` resource so the
    // scheduler can invoke the target across versions/aliases. Locate it by id
    // prefix rather than depending on the generated hash in a hardcoded path.
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
                  regex: '/^Resource::<CURReconciliationFunction.*\\.Arn>:\\*$/g',
                },
              ],
            },
          ],
          true
        );
      }
    }

    // Suppress AwsSolutions-IAM5 for the CUR function role's resource-scoped
    // ARN wildcards. These are intentional, account-scoped resource patterns
    // for APIs that only accept wildcard sub-resources (transfer/billing-view/
    // CUR-definition trees), plus the S3 read grant on the config bucket.
    NagSuppressions.addResourceSuppressions(
      this.reconciliationFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Resource-scoped ARN wildcards are required for Organizations responsibility-transfer, Billing billing-view, and Legacy CUR report-definition resources, which are addressed by sub-resource path and cannot be enumerated ahead of time. The S3 GetObject*/GetBucket*/List* wildcards are from grantRead on the config bucket. All constrained to this account.',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
            {
              regex: '/^Resource::arn:aws:organizations::\\d+:transfer/\\*/billing/\\*/\\*$/g',
            },
            {
              regex: '/^Resource::arn:aws:billing::\\d+:billingview/\\*$/g',
            },
            {
              regex: '/^Resource::arn:aws:cur:us-east-1:\\d+:definition/\\*$/g',
            },
            {
              regex: '/^Resource::<ConfigBucket.*\\.Arn>\\/\\*$/g',
            },
          ],
        },
      ],
      true
    );
  }
}
