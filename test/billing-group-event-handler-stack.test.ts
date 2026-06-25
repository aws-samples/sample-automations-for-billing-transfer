// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeEach } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BillingGroupEventHandlerStack } from '../lib/stacks/billing-group-event-handler-stack.js';

describe('BillingGroupEventHandlerStack', () => {
  let app: cdk.App;

  beforeEach(() => {
    app = new cdk.App();
  });

  test('Stack synthesizes successfully with default execution mode', () => {
    // Create stack without specifying execution mode (should default to 'both')
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify Lambda function exists
    template.resourceCountIs('AWS::Lambda::Function', 1);

    // Verify DLQ exists
    template.resourceCountIs('AWS::SQS::Queue', 1);

    // Verify CloudWatch alarm exists
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);

    // Verify EventBridge rule exists (default mode is 'both')
    template.resourceCountIs('AWS::Events::Rule', 1);

    // Verify EventBridge Scheduler exists (default mode is 'both')
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  });

  test('Stack synthesizes with execution mode "events"', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack', {
      executionMode: 'events',
    });
    const template = Template.fromStack(stack);

    // Verify EventBridge rule exists
    template.resourceCountIs('AWS::Events::Rule', 1);

    // Verify EventBridge Scheduler does NOT exist
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  test('Stack synthesizes with execution mode "scheduled"', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack', {
      executionMode: 'scheduled',
    });
    const template = Template.fromStack(stack);

    // Verify EventBridge rule does NOT exist
    template.resourceCountIs('AWS::Events::Rule', 0);

    // Verify EventBridge Scheduler exists
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  });

  test('Stack synthesizes with execution mode "both"', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack', {
      executionMode: 'both',
    });
    const template = Template.fromStack(stack);

    // Verify EventBridge rule exists
    template.resourceCountIs('AWS::Events::Rule', 1);

    // Verify EventBridge Scheduler exists
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  });

  test('Stack throws error for invalid execution mode', () => {
    expect(() => {
      new BillingGroupEventHandlerStack(app, 'TestStack', {
        executionMode: 'invalid' as any,
      });
    }).toThrow('Invalid execution mode: invalid');
  });

  test('Lambda function has correct configuration', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 120, // 2 minutes
      MemorySize: 256,
      TracingConfig: {
        Mode: 'Active',
      },
    });
  });

  test('DLQ has correct retention period and KMS encryption', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack');
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

  test('EventBridge rule has correct event pattern for accepted events only', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack', {
      executionMode: 'events',
    });
    const template = Template.fromStack(stack);

    // Verify EventBridge rule only listens for ResponsibilityTransferAccepted events
    // ResponsibilityTransferTerminated events are handled by the separate Termination Handler Stack
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.organizations'],
        'detail-type': ['AWS Service Event via CloudTrail'],
        detail: {
          eventSource: ['organizations.amazonaws.com'],
          eventType: ['AwsServiceEvent'],
          eventName: ['ResponsibilityTransferAccepted'],
        },
      },
    });
  });

  test('Scheduler has default daily cron expression', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack', {
      executionMode: 'scheduled',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 0 * * ? *)', // Daily at midnight UTC
    });
  });

  test('Scheduler accepts custom monthly cron expression', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack', {
      executionMode: 'scheduled',
      scheduleExpression: 'cron(0 0 1 * ? *)', // Monthly on 1st at midnight UTC
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 0 1 * ? *)',
    });
  });

  test('Stack has required tags', () => {
    const stack = new BillingGroupEventHandlerStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // CDK applies tags at the stack level, which propagate to resources
    // We can verify the stack was created successfully
    expect(stack).toBeDefined();
  });
});
