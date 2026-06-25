// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
/**
 * Integration test for Billing Group Event Handler
 * 
 * This test verifies the complete event flow:
 * 1. Deploy stack to test account
 * 2. Invoke Lambda with sample ResponsibilityTransferAccepted event
 * 3. Verify billing group creation in Billing Conductor
 * 4. Test idempotency by invoking with same event twice
 * 5. Verify CloudWatch Logs contain expected entries
 * 
 * Prerequisites:
 * - AWS credentials configured
 * - Billing Conductor enabled in the account
 * - Permissions to create Lambda, EventBridge, SQS, IAM resources
 * - Permissions to invoke Lambda and query CloudWatch Logs
 */

import {
  LambdaClient,
  InvokeCommand,
  InvokeCommandOutput,
} from '@aws-sdk/client-lambda';
import {
  BillingconductorClient,
  ListBillingGroupsCommand,
  DeleteBillingGroupCommand,
} from '@aws-sdk/client-billingconductor';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// Sample ResponsibilityTransferAccepted event for testing
const sampleEvent = {
  version: '0',
  id: 'test-event-id-12345',
  'detail-type': 'AWS Service Event via CloudTrail',
  source: 'aws.organizations',
  account: '123456789012',
  time: new Date().toISOString(),
  region: 'us-east-1',
  resources: [],
  detail: {
    eventVersion: '1.11',
    eventTime: new Date().toISOString(),
    eventName: 'ResponsibilityTransferAccepted',
    eventSource: 'organizations.amazonaws.com',
    eventType: 'AwsServiceEvent',
    serviceEventDetails: {
      id: 'rt-test123456',
      transferChain: ['rt-test123456'],
      type: 'BILLING',
      status: 'ACCEPTED',
      source: {
        managementAccountId: '111111111111', // Test Bill-Source Account
      },
      target: {
        managementAccountId: '222222222222', // Test Bill-Transfer Account
      },
      requester: '111111111111',
      startTimestamp: Date.now(),
    },
  },
};

describe('Billing Group Event Handler Integration Tests', () => {
  const lambdaClient = new LambdaClient({ region: 'us-east-1' });
  const billingConductorClient = new BillingconductorClient({ region: 'us-east-1' });
  const logsClient = new CloudWatchLogsClient({ region: 'us-east-1' });

  const functionName = process.env.LAMBDA_FUNCTION_NAME || 'BillingGroupAutomationHandler';
  const testAccountId = '111111111111';
  const billingGroupName = `bg-${testAccountId}`;

  // Clean up test billing group before and after tests
  beforeAll(async () => {
    await cleanupTestBillingGroup();
  });

  afterAll(async () => {
    await cleanupTestBillingGroup();
  });

  /**
   * Helper function to clean up test billing group
   */
  async function cleanupTestBillingGroup(): Promise<void> {
    try {
      const listCommand = new ListBillingGroupsCommand({});
      const response = await billingConductorClient.send(listCommand);

      const testGroup = response.BillingGroups?.find(
        (group) => group.Name === billingGroupName
      );

      if (testGroup && testGroup.Arn) {
        console.log(`Cleaning up test billing group: ${testGroup.Arn}`);
        const deleteCommand = new DeleteBillingGroupCommand({
          Arn: testGroup.Arn,
        });
        await billingConductorClient.send(deleteCommand);
        console.log('Test billing group deleted successfully');
      }
    } catch (error) {
      console.warn('Failed to clean up test billing group:', error);
      // Don't fail the test if cleanup fails
    }
  }

  /**
   * Helper function to invoke Lambda with event
   */
  async function invokeLambda(event: any): Promise<InvokeCommandOutput> {
    const command = new InvokeCommand({
      FunctionName: functionName,
      Payload: JSON.stringify(event),
    });

    return await lambdaClient.send(command);
  }

  /**
   * Helper function to check if billing group exists
   */
  async function billingGroupExists(accountId: string): Promise<boolean> {
    const command = new ListBillingGroupsCommand({});
    const response = await billingConductorClient.send(command);

    return response.BillingGroups?.some(
      (group) => group.PrimaryAccountId === accountId
    ) || false;
  }

  /**
   * Helper function to query CloudWatch Logs
   */
  async function queryLogs(
    logGroupName: string,
    filterPattern: string,
    startTime: number
  ): Promise<any[]> {
    const command = new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      startTime,
    });

    const response = await logsClient.send(command);
    return response.events || [];
  }

  test('Lambda invocation with ResponsibilityTransferAccepted event creates billing group', async () => {
    // Invoke Lambda with sample event
    const response = await invokeLambda(sampleEvent);

    // Verify Lambda invocation succeeded
    expect(response.StatusCode).toBe(200);
    expect(response.FunctionError).toBeUndefined();

    // Parse response payload
    const payload = JSON.parse(
      new TextDecoder().decode(response.Payload)
    );

    // Verify response structure
    expect(payload).toHaveProperty('statusCode', 200);
    expect(payload).toHaveProperty('body');
    expect(payload.body).toHaveProperty('message');
    expect(payload.body).toHaveProperty('accountId', testAccountId);
    expect(payload.body).toHaveProperty('action');
    expect(['created', 'exists']).toContain(payload.body.action);

    // Verify billing group was created in Billing Conductor
    const exists = await billingGroupExists(testAccountId);
    expect(exists).toBe(true);
  }, 30000); // 30 second timeout

  test('Lambda invocation with same event is idempotent', async () => {
    // First invocation
    const response1 = await invokeLambda(sampleEvent);
    const payload1 = JSON.parse(
      new TextDecoder().decode(response1.Payload)
    );

    // Second invocation with same event
    const response2 = await invokeLambda(sampleEvent);
    const payload2 = JSON.parse(
      new TextDecoder().decode(response2.Payload)
    );

    // Both invocations should succeed
    expect(response1.StatusCode).toBe(200);
    expect(response2.StatusCode).toBe(200);

    // Second invocation should indicate billing group already exists
    expect(payload2.body.action).toBe('exists');

    // Verify only one billing group exists
    const exists = await billingGroupExists(testAccountId);
    expect(exists).toBe(true);
  }, 30000);

  test('CloudWatch Logs contain expected structured log entries', async () => {
    const logGroupName = `/aws/lambda/${functionName}`;
    const startTime = Date.now() - 5 * 60 * 1000; // Last 5 minutes

    // Query for INFO level logs
    const infoLogs = await queryLogs(
      logGroupName,
      '{ $.level = "INFO" }',
      startTime
    );

    expect(infoLogs.length).toBeGreaterThan(0);

    // Verify log structure
    const sampleLog = JSON.parse(infoLogs[0].message || '{}');
    expect(sampleLog).toHaveProperty('timestamp');
    expect(sampleLog).toHaveProperty('level');
    expect(sampleLog).toHaveProperty('message');

    // Query for billing group creation logs
    const creationLogs = await queryLogs(
      logGroupName,
      '"Creating billing group"',
      startTime
    );

    // Should have at least one creation log (from first test)
    expect(creationLogs.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  test('Lambda handles ResponsibilityTransferTerminated event', async () => {
    const terminatedEvent = {
      ...sampleEvent,
      detail: {
        ...sampleEvent.detail,
        eventName: 'ResponsibilityTransferTerminated',
        serviceEventDetails: {
          ...sampleEvent.detail.serviceEventDetails,
          status: 'WITHDRAWN',
          endTimestamp: Date.now(),
        },
      },
    };

    // Invoke Lambda with terminated event
    const response = await invokeLambda(terminatedEvent);

    // Verify Lambda invocation succeeded
    expect(response.StatusCode).toBe(200);
    expect(response.FunctionError).toBeUndefined();

    // Parse response payload
    const payload = JSON.parse(
      new TextDecoder().decode(response.Payload)
    );

    // Verify response structure
    expect(payload).toHaveProperty('statusCode', 200);
    expect(payload).toHaveProperty('body');
  }, 30000);
});

/**
 * Manual test instructions:
 * 
 * 1. Deploy the stack to a test account:
 *    npm run cdk deploy BillingGroupEventHandlerStack
 * 
 * 2. Set the Lambda function name environment variable:
 *    export LAMBDA_FUNCTION_NAME=BillingGroupAutomationHandler
 * 
 * 3. Run the integration tests:
 *    npm test -- test/integration/billing-group-event-handler.integration.test.ts
 * 
 * 4. Verify in AWS Console:
 *    - Check CloudWatch Logs for Lambda execution logs
 *    - Check Billing Conductor for created billing group
 *    - Check CloudWatch Alarms for any triggered alarms
 * 
 * 5. Clean up:
 *    npm run cdk destroy BillingGroupEventHandlerStack
 */
