// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for BillingGroupEventHandlerStack
 */
export interface BillingGroupEventHandlerStackProps extends cdk.StackProps {
  /**
   * Execution mode for the billing group automation
   * - 'events': Only respond to billing transfer events
   * - 'scheduled': Only run on schedule
   * - 'both': Both event-driven and scheduled execution (default)
   */
  executionMode?: 'events' | 'scheduled' | 'both';
  
  /**
   * Schedule expression for the reconciliation scheduler
   * Default: 'cron(0 0 * * ? *)' (daily at midnight UTC)
   * Example monthly: 'cron(0 0 1 * ? *)' (1st of month at midnight UTC)
   */
  scheduleExpression?: string;
}

/**
 * CDK Stack for Billing Group Event Handler
 * 
 * This stack creates infrastructure to automatically manage billing groups
 * in response to billing transfer events and/or on a scheduled basis.
 */
export class BillingGroupEventHandlerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BillingGroupEventHandlerStackProps) {
    super(scope, id, props);

    // Default execution mode to 'both' if not specified
    const executionMode = props?.executionMode || 'both';
    
    // Default schedule expression to daily at midnight UTC if not specified
    const scheduleExpression = props?.scheduleExpression || 'cron(0 0 * * ? *)';

    // Validate execution mode
    if (!['events', 'scheduled', 'both'].includes(executionMode)) {
      throw new Error(
        `Invalid execution mode: ${executionMode}. Valid values are: 'events', 'scheduled', 'both'`
      );
    }

    // Create KMS key for encryption of SQS and Lambda environment variables
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'KMS key for Billing Group Event Handler encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      alias: 'billing-group-event-handler-key',
    });

    // Create Dead Letter Queue for failed Lambda invocations with KMS encryption
    const dlq = new sqs.Queue(this, 'BillingGroupDLQ', {
      queueName: 'billing-group-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true, // AwsSolutions-SQS4: require requests to use SSL/TLS
    });

    // Create Lambda function using NodejsFunction for automatic TypeScript bundling
    const handler = new nodejs.NodejsFunction(this, 'BillingGroupHandler', {
      functionName: 'billing-group-event-handler',
      entry: 'lib/lambda/billing-group-event-handler/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64, // Graviton2 for better performance and cost
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: dlq,
      deadLetterQueueEnabled: true,
      reservedConcurrentExecutions: 10, // Limit concurrent executions for safety
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
        POWERTOOLS_SERVICE_NAME: 'BillingTransferBillingGroupAutomation',
        POWERTOOLS_METRICS_NAMESPACE: 'BillingTransferBillingGroupAutomation',
        POWERTOOLS_LOGGER_LOG_EVENT: 'true',
        POWERTOOLS_LOGGER_SAMPLE_RATE: '0.1',
        POWERTOOLS_TRACE_ENABLED: 'true',
      },
    });

    // Read/List operations - no resource-level permissions supported
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'billingconductor:ListPricingPlans',
          'billingconductor:ListBillingGroups',
        ],
        resources: ['*'],
      })
    );

    // Write operations with ARN pattern constraints
    // CreateBillingGroup requires pricingplan ARN, TagResource requires billinggroup ARN
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['billingconductor:CreateBillingGroup'],
        resources: [
          `arn:aws:billingconductor::${this.account}:pricingplan/*`,
        ],
      })
    );

    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['billingconductor:TagResource'],
        resources: [
          `arn:aws:billingconductor::${this.account}:billinggroup/*`,
        ],
      })
    );

    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['organizations:DescribeResponsibilityTransfer'],
        resources: [
          `arn:aws:organizations::${this.account}:transfer/*/billing/*/*`,
        ],
      })
    );

    // Add SQS SendMessage permission for DLQ (separate since it has specific resource ARN)
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [dlq.queueArn],
      })
    );

    // Create DynamoDB table for idempotency
    const idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: 'billing-group-idempotency',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiration',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: encryptionKey, // CKV_AWS_119: Use CMK for DynamoDB encryption
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Grant Lambda read/write access to idempotency table
    idempotencyTable.grantReadWriteData(handler);

    // Add idempotency table name to Lambda environment
    handler.addEnvironment('IDEMPOTENCY_TABLE_NAME', idempotencyTable.tableName);

    // Create CloudWatch alarm for DLQ messages
    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      alarmName: 'BillingGroupDLQAlarm',
      alarmDescription: 'Alert when messages appear in the Billing Group DLQ',
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Create EventBridge rule for billing transfer events (conditional)
    if (executionMode === 'events' || executionMode === 'both') {
      const eventRule = new events.Rule(this, 'BillingTransferEventRule', {
        ruleName: 'BillingTransferEventRule',
        description: 'Triggers Lambda when billing transfer accepted events occur',
        eventPattern: {
          source: ['aws.organizations'],
          detailType: ['AWS Service Event via CloudTrail'],
          detail: {
            eventSource: ['organizations.amazonaws.com'],
            eventType: ['AwsServiceEvent'],
            eventName: ['ResponsibilityTransferAccepted'],
          },
        },
      });

      // Add Lambda as target with retry configuration
      eventRule.addTarget(
        new targets.LambdaFunction(handler, {
          retryAttempts: 2,
          maxEventAge: cdk.Duration.hours(2),
        })
      );
    }

    // Create EventBridge Scheduler for reconciliation (conditional)
    if (executionMode === 'scheduled' || executionMode === 'both') {
      const reconciliationSchedule = new scheduler.Schedule(this, 'ReconciliationSchedule', {
        scheduleName: 'BillingGroupReconciliation',
        description: `Reconciliation of billing groups (${scheduleExpression})`,
        schedule: scheduler.ScheduleExpression.expression(scheduleExpression),
        target: new schedulerTargets.LambdaInvoke(handler, {
          input: scheduler.ScheduleTargetInput.fromObject({
            source: 'scheduler',
            action: 'reconcile-all',
          }),
        }),
      });
    }

    // Apply resource tags for cost tracking
    cdk.Tags.of(this).add('Project', 'SampleAutomationsForBillingTransfer');
    cdk.Tags.of(this).add('Environment', props?.env?.account || 'unknown');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Component', 'BillingGroupEventHandler');

    // CDK Nag Suppressions with documented justifications

    // Suppress AwsSolutions-IAM4 for Lambda basic execution role
    NagSuppressions.addResourceSuppressions(
      handler,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole provides standard CloudWatch Logs permissions required for Lambda execution. This is an AWS managed policy that follows best practices.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
      true
    );

    // Suppress AwsSolutions-IAM5 for wildcard permissions
    // X-Ray, Billing Conductor, and Organizations APIs don't support resource-level permissions
    NagSuppressions.addResourceSuppressions(
      handler,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard resources required for: (1) X-Ray PutTraceSegments/PutTelemetryRecords - standard tracing permissions; (2) Billing Conductor List APIs - do not support resource-level permissions; (3) the account-scoped Billing Conductor pricingplan/billinggroup and Organizations responsibility-transfer ARNs are addressed by sub-resource path (wildcard suffix) and cannot be enumerated ahead of time; (4) KMS GenerateDataKey*/ReEncrypt* granted by CDK on the stack KMS key for SQS/Lambda env encryption.',
          appliesTo: [
            'Resource::*',
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
            {
              regex: '/^Resource::arn:aws:billingconductor::\\d+:pricingplan/\\*$/g',
            },
            {
              regex: '/^Resource::arn:aws:billingconductor::\\d+:billinggroup/\\*$/g',
            },
            {
              regex: '/^Resource::arn:aws:organizations::\\d+:transfer/\\*/billing/\\*/\\*$/g',
            },
          ],
        },
      ],
      true
    );

    // Suppress AwsSolutions-L1 for Lambda runtime version
    NagSuppressions.addResourceSuppressions(handler, [
      {
        id: 'AwsSolutions-L1',
        reason: 'Using Node.js 22.x which is the latest LTS version supported by AWS Lambda.',
      },
    ]);

    // Create CloudFormation outputs
    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: handler.functionName,
      description: 'Name of the Billing Group Lambda function',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: handler.functionArn,
      description: 'ARN of the Billing Group Lambda function',
    });

    new cdk.CfnOutput(this, 'DLQUrl', {
      value: dlq.queueUrl,
      description: 'URL of the Dead Letter Queue',
    });

    new cdk.CfnOutput(this, 'ExecutionMode', {
      value: executionMode,
      description: 'Execution mode for the billing group automation',
    });

    new cdk.CfnOutput(this, 'ScheduleExpression', {
      value: scheduleExpression,
      description: 'Schedule expression for reconciliation (if scheduled mode enabled)',
    });

    new cdk.CfnOutput(this, 'IdempotencyTableName', {
      value: idempotencyTable.tableName,
      description: 'Name of the DynamoDB table for idempotency',
    });
  }
}
