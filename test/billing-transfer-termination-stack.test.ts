// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeEach } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BillingTransferTerminationStack } from '../lib/stacks/billing-transfer-termination-stack.js';

describe('BillingTransferTerminationStack', () => {
  let app: cdk.App;

  beforeEach(() => {
    app = new cdk.App();
  });

  test('Stack synthesizes successfully without email subscriptions', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Core resources exist
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.resourceCountIs('AWS::KMS::Key', 1);

    // No email subscriptions when none provided
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  test('SNS topic is configured with KMS encryption and display name', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SNS::Topic', {
      DisplayName: 'Billing Transfer Termination Notifications',
      TopicName: 'billing-transfer-termination-notifications',
      KmsMasterKeyId: {
        'Fn::GetAtt': [Match.stringLikeRegexp('EncryptionKey'), 'Arn'],
      },
    });
  });

  // Termination spec task 2.6 - Property 4: Multiple email subscriptions created
  test('creates an email subscription for each provided address', () => {
    const emails = [
      'ops-one@example.com',
      'ops-two@example.com',
      'ops-three@example.com',
    ];
    const stack = new BillingTransferTerminationStack(app, 'TestStack', {
      notificationEmails: emails,
    });
    const template = Template.fromStack(stack);

    // One subscription per email
    template.resourceCountIs('AWS::SNS::Subscription', emails.length);

    // Each subscription uses the EMAIL protocol and the correct endpoint
    for (const email of emails) {
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: email,
      });
    }
  });

  test('handles a single email subscription', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack', {
      notificationEmails: ['solo@example.com'],
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Subscription', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'solo@example.com',
    });
  });

  test('handles an explicitly empty email list (topic, no subscriptions)', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack', {
      notificationEmails: [],
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  test('Lambda function has correct runtime, memory, timeout, and tracing', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'billing-transfer-termination-handler',
      Runtime: 'nodejs22.x',
      Timeout: 30,
      MemorySize: 256,
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      ReservedConcurrentExecutions: 10,
    });
  });

  test('Lambda function receives the termination topic ARN as an environment variable', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TERMINATION_TOPIC_ARN: Match.anyValue(),
          LOG_LEVEL: 'INFO',
        }),
      },
    });
  });

  test('Lambda has a Dead Letter Queue with KMS encryption and 14-day retention', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'billing-transfer-termination-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
      KmsMasterKeyId: {
        'Fn::GetAtt': [Match.stringLikeRegexp('EncryptionKey'), 'Arn'],
      },
    });

    // DLQ is wired to the Lambda function
    template.hasResourceProperties('AWS::Lambda::Function', {
      DeadLetterConfig: {
        TargetArn: {
          'Fn::GetAtt': [Match.stringLikeRegexp('TerminationDLQ'), 'Arn'],
        },
      },
    });
  });

  // Termination spec task 2.4 - EventBridge rule for terminated events only
  test('EventBridge rule matches ResponsibilityTransferTerminated events only', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.organizations'],
        'detail-type': ['AWS Service Event via CloudTrail'],
        detail: {
          eventSource: ['organizations.amazonaws.com'],
          eventType: ['AwsServiceEvent'],
          eventName: ['ResponsibilityTransferTerminated'],
        },
      },
    });
  });

  test('EventBridge rule targets the Lambda with retry configuration', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          RetryPolicy: {
            MaximumRetryAttempts: 2,
            MaximumEventAgeInSeconds: 7200, // 2 hours
          },
        }),
      ]),
    });
  });

  // Termination spec task 2.3 - Lambda granted SNS publish permission
  test('Lambda is granted SNS publish permission on the termination topic', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Effect: 'Allow',
            Resource: { Ref: Match.stringLikeRegexp('TerminationTopic') },
          }),
        ]),
      },
    });
  });

  test('KMS key has rotation enabled', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('Stack exposes expected CloudFormation outputs', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');
    const template = Template.fromStack(stack);
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);

    expect(outputKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/TerminationTopicArn/),
        expect.stringMatching(/TerminationHandlerArn/),
        expect.stringMatching(/DLQUrl/),
      ])
    );
  });

  test('Stack exposes public references for topic, handler, and DLQ', () => {
    const stack = new BillingTransferTerminationStack(app, 'TestStack');

    expect(stack.terminationTopic).toBeDefined();
    expect(stack.terminationHandler).toBeDefined();
    expect(stack.deadLetterQueue).toBeDefined();
  });
});
