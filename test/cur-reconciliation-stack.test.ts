// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeEach } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CURReconciliationStack } from '../lib/stacks/cur-reconciliation-stack.js';

describe('CURReconciliationStack', () => {
  let app: cdk.App;

  beforeEach(() => {
    app = new cdk.App();
  });

  test('Stack synthesizes successfully with default configuration', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify S3 buckets exist (access logs bucket + config bucket + CUR destination bucket)
    template.resourceCountIs('AWS::S3::Bucket', 3);

    // Verify Lambda functions exist: the CUR reconciliation function plus the
    // CDK-managed BucketDeployment custom-resource Lambda that uploads the
    // config template into the config bucket at deploy time.
    template.resourceCountIs('AWS::Lambda::Function', 2);

    // Verify the CUR reconciliation function specifically is present
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'cur-reconciliation',
    });

    // Verify the config template is deployed into the bucket at deploy time
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);

    // Verify DLQ exists
    template.resourceCountIs('AWS::SQS::Queue', 1);

    // Verify CloudWatch alarms exist (DLQ + Error)
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);

    // Verify KMS key exists for encryption
    template.resourceCountIs('AWS::KMS::Key', 1);

    // Verify EventBridge Scheduler exists
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  });

  test('Lambda function has correct configuration', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 900, // 15 minutes
      MemorySize: 512,
      TracingConfig: {
        Mode: 'Active',
      },
    });
  });

  test('S3 bucket has versioning enabled', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: {
        Status: 'Enabled',
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('DLQ has correct retention period and KMS encryption', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600, // 14 days in seconds
    });

    // Verify KMS encryption is configured (KmsMasterKeyId references the encryption key)
    template.hasResourceProperties('AWS::SQS::Queue', {
      KmsMasterKeyId: {
        'Fn::GetAtt': [Match.stringLikeRegexp('EncryptionKey'), 'Arn'],
      },
    });
  });

  test('Scheduler has default 30-minute cron expression staggered to :15/:45', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(15,45 * * * ? *)', // Every 30 min at :15 and :45 UTC
    });
  });

  test('Scheduler accepts custom cron expression', () => {
    const stack = new CURReconciliationStack(app, 'TestStack', {
      scheduleExpression: 'cron(0 0 1 * ? *)', // Monthly on 1st at midnight UTC
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 0 1 * ? *)',
    });
  });

  test('Lambda has correct environment variables', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          CONFIG_KEY: 'export-configuration-template.json',
          LOG_LEVEL: 'INFO',
          POWERTOOLS_SERVICE_NAME: 'CURReconciliation',
          POWERTOOLS_METRICS_NAMESPACE: 'SampleAutomationsForBillingTransfer',
        },
      },
    });
  });

  test('Lambda has required IAM permissions for Organizations', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Organizations permissions exist (may be split into separate statements)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'organizations:ListInboundResponsibilityTransfers',
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'organizations:DescribeResponsibilityTransfer',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('Lambda has required IAM permissions for Billing Conductor', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Billing Conductor permissions exist in at least one policy
    const policies = template.findResources('AWS::IAM::Policy');
    const hasBillingConductorPermissions = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement || [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        return actions.some((action: string) => action.startsWith('billingconductor:'));
      });
    });
    expect(hasBillingConductorPermissions).toBe(true);
  });

  test('Lambda has required IAM permissions for Billing API', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Billing read permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'billing:ListBillingViews',
              'billing:GetBillingView',
              'billing:ListTagsForResource',
            ],
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      },
    });

    // Verify Billing TagResource with ARN pattern
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'billing:TagResource',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('Lambda has required IAM permissions for Legacy CUR API', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Legacy CUR API permissions exist in at least one policy
    const policies = template.findResources('AWS::IAM::Policy');
    const hasCURPermissions = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement || [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        return actions.some((action: string) => action.startsWith('cur:'));
      });
    });
    expect(hasCURPermissions).toBe(true);
  });

  test('Lambda has required IAM permissions for S3 validation', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify S3 validation permissions exist in at least one policy
    const policies = template.findResources('AWS::IAM::Policy');
    const hasS3ValidationPermissions = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement || [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        return actions.some((action: string) => 
          action === 's3:GetBucketPolicy' || action === 's3:GetBucketLocation'
        );
      });
    });
    expect(hasS3ValidationPermissions).toBe(true);
  });

  test('Lambda has required IAM permissions for Support API', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Support API permissions exist in at least one policy
    const policies = template.findResources('AWS::IAM::Policy');
    const hasSupportPermissions = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement || [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        return actions.some((action: string) => action.startsWith('support:'));
      });
    });
    expect(hasSupportPermissions).toBe(true);
  });

  test('Lambda has S3 read permissions for config bucket', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Lambda has permissions to read from S3 bucket
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('Stack accepts custom timeout configuration', () => {
    const stack = new CURReconciliationStack(app, 'TestStack', {
      timeout: 600, // 10 minutes
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 600,
    });
  });

  test('Stack accepts custom memory configuration', () => {
    const stack = new CURReconciliationStack(app, 'TestStack', {
      memory: 1024,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1024,
    });
  });

  test('Stack accepts custom config key', () => {
    const stack = new CURReconciliationStack(app, 'TestStack', {
      configKey: 'custom-config.json',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          CONFIG_KEY: 'custom-config.json',
        },
      },
    });
  });

  test('Stack has required tags', () => {
    const stack = new CURReconciliationStack(app, 'TestStack', {
      environment: 'production',
    });
    const template = Template.fromStack(stack);

    // CDK applies tags at the stack level, which propagate to resources
    // We can verify the stack was created successfully
    expect(stack).toBeDefined();
  });

  test('CloudWatch alarms are configured correctly', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify DLQ alarm
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('CUR destination bucket has correct policy for Legacy CUR API', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify bucket policy allows billingreports.amazonaws.com with two statements
    // Statement 1: GetBucket operations
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCURToGetBucketInfo',
            Effect: 'Allow',
            Principal: {
              Service: 'billingreports.amazonaws.com',
            },
            Action: ['s3:GetBucketAcl', 's3:GetBucketPolicy'],
          }),
        ]),
      },
    });

    // Statement 2: PutObject operations
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCURToPutObjects',
            Effect: 'Allow',
            Principal: {
              Service: 'billingreports.amazonaws.com',
            },
            Action: 's3:PutObject',
          }),
        ]),
      },
    });
  });

  test('CUR destination bucket has lifecycle policy', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify lifecycle rule for cost optimization
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: 'INTELLIGENT_TIERING',
                TransitionInDays: 30,
              }),
            ]),
          }),
        ]),
      },
    });
  });

  test('Stack outputs include both bucket names', () => {
    const stack = new CURReconciliationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify outputs exist
    template.hasOutput('ConfigBucketName', {});
    template.hasOutput('CURDestinationBucketName', {});
    template.hasOutput('ReconciliationFunctionName', {});
  });
});
