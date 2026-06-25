// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for BillingTransferTerminationStack
 */
export interface BillingTransferTerminationStackProps extends cdk.StackProps {
  /**
   * Email addresses to receive termination notifications.
   * Each email address will receive a confirmation email that must be accepted
   * before notifications are delivered.
   * @default - No email subscriptions created
   */
  notificationEmails?: string[];
}

/**
 * CDK Stack for Billing Transfer Termination Notifications
 *
 * This stack creates infrastructure to send email notifications when billing
 * transfer relationships are terminated. It includes:
 * - SNS Topic for fanout to multiple subscribers
 * - Email subscriptions (require manual confirmation)
 * - Lambda function to process termination events
 * - EventBridge rule to trigger on ResponsibilityTransferTerminated events
 * - Dead Letter Queue for failed invocations
 */
export class BillingTransferTerminationStack extends cdk.Stack {
  /** SNS Topic for termination notifications */
  public readonly terminationTopic: sns.Topic;

  /** Lambda function that processes termination events */
  public readonly terminationHandler: nodejs.NodejsFunction;

  /** Dead Letter Queue for failed Lambda invocations */
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: BillingTransferTerminationStackProps) {
    super(scope, id, props);

    // Create KMS key for encryption of SQS, SNS, and Lambda environment variables
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'KMS key for Billing Transfer Termination encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      alias: 'billing-transfer-termination-key',
    });

    // Create Dead Letter Queue for failed Lambda invocations with KMS encryption
    this.deadLetterQueue = new sqs.Queue(this, 'TerminationDLQ', {
      queueName: 'billing-transfer-termination-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true, // AwsSolutions-SQS4: require requests to use SSL/TLS
    });

    // Create SNS Topic for termination notifications with KMS encryption
    this.terminationTopic = new sns.Topic(this, 'TerminationTopic', {
      displayName: 'Billing Transfer Termination Notifications',
      topicName: 'billing-transfer-termination-notifications',
      masterKey: encryptionKey,
    });

    // Add email subscriptions if provided
    // Each subscription requires manual confirmation by the recipient
    if (props?.notificationEmails && props.notificationEmails.length > 0) {
      props.notificationEmails.forEach((email, index) => {
        this.terminationTopic.addSubscription(
          new subscriptions.EmailSubscription(email)
        );
      });
    }

    // Create Lambda function for processing termination events
    this.terminationHandler = new nodejs.NodejsFunction(this, 'TerminationHandler', {
      functionName: 'billing-transfer-termination-handler',
      entry: 'lib/lambda/billing-transfer-termination-handler/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64, // Graviton2 for better performance and cost
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: this.deadLetterQueue,
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
        externalModules: [],
      },
      environment: {
        TERMINATION_TOPIC_ARN: this.terminationTopic.topicArn,
        LOG_LEVEL: 'INFO',
        POWERTOOLS_SERVICE_NAME: 'BillingTransferTerminationHandler',
        POWERTOOLS_METRICS_NAMESPACE: 'BillingTransferTerminationHandler',
        POWERTOOLS_LOGGER_LOG_EVENT: 'true',
        POWERTOOLS_LOGGER_SAMPLE_RATE: '0.1',
        POWERTOOLS_TRACE_ENABLED: 'true',
      },
    });

    // Grant SNS publish permission to Lambda
    this.terminationTopic.grantPublish(this.terminationHandler);

    // Create EventBridge rule for ResponsibilityTransferTerminated events only
    const terminationEventRule = new events.Rule(this, 'TerminationEventRule', {
      ruleName: 'BillingTransferTerminatedRule',
      description: 'Triggers Lambda when billing transfer is terminated',
      eventPattern: {
        source: ['aws.organizations'],
        detailType: ['AWS Service Event via CloudTrail'],
        detail: {
          eventSource: ['organizations.amazonaws.com'],
          eventType: ['AwsServiceEvent'],
          eventName: ['ResponsibilityTransferTerminated'],
        },
      },
    });

    // Add Lambda as target with retry configuration
    terminationEventRule.addTarget(
      new targets.LambdaFunction(this.terminationHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Apply resource tags for cost tracking
    cdk.Tags.of(this).add('Project', 'SampleAutomationsForBillingTransfer');
    cdk.Tags.of(this).add('Environment', props?.env?.account || 'unknown');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Component', 'BillingTransferTerminationNotifications');

    // CDK Nag Suppressions with documented justifications
    this.addCdkNagSuppressions();

    // Create CloudFormation outputs
    new cdk.CfnOutput(this, 'TerminationTopicArn', {
      value: this.terminationTopic.topicArn,
      description: 'ARN of the SNS topic for termination notifications',
    });

    new cdk.CfnOutput(this, 'TerminationHandlerArn', {
      value: this.terminationHandler.functionArn,
      description: 'ARN of the Termination Handler Lambda function',
    });

    new cdk.CfnOutput(this, 'DLQUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the Dead Letter Queue',
    });
  }

  /**
   * Add CDK Nag suppressions with justifications
   */
  private addCdkNagSuppressions(): void {
    // Suppress AwsSolutions-IAM4 for Lambda basic execution role
    NagSuppressions.addResourceSuppressions(
      this.terminationHandler,
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

    // Suppress AwsSolutions-IAM5 for SNS publish wildcard (topic ARN with wildcard suffix)
    NagSuppressions.addResourceSuppressions(
      this.terminationHandler,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'SNS grantPublish creates a policy with the specific topic ARN. The wildcard applies to X-Ray tracing permissions which do not support resource-level permissions, and to KMS GenerateDataKey*/ReEncrypt* granted by CDK on the stack KMS key used to encrypt the SNS topic and DLQ.',
          appliesTo: [
            'Resource::*',
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
      ],
      true
    );

    // Suppress AwsSolutions-L1 for Lambda runtime version
    NagSuppressions.addResourceSuppressions(this.terminationHandler, [
      {
        id: 'AwsSolutions-L1',
        reason: 'Using Node.js 22.x which is the latest LTS version supported by AWS Lambda.',
      },
    ]);

    // Suppress AwsSolutions-SNS3 for SNS topic without SSL enforcement
    NagSuppressions.addResourceSuppressions(this.terminationTopic, [
      {
        id: 'AwsSolutions-SNS3',
        reason:
          'SNS topic is used for email notifications only. SSL enforcement is not applicable for email protocol subscriptions.',
      },
    ]);
  }
}
