// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit tests for Billing Group Event Handler Lambda
 */

import type { Context } from 'aws-lambda';
import type * as BillingConductorServiceType from '../../../lib/lambda/common/services/billing-conductor-service.js';
import type {
  handler as HandlerType,
  BillingTransferEvent,
  HandlerResponse,
} from '../../../lib/lambda/billing-group-event-handler/index.js';

// Module-scoped mock fns referenced by both the mock factories and the tests.
const mockOrgSend = jest.fn();
const mockEnsureBillingGroup = jest.fn();

// Tracer: prevent X-Ray initialization.
jest.unstable_mockModule('../../../lib/lambda/common/utils/tracer.js', () => ({
  tracer: {
    captureAWSv3Client: jest.fn((client) => client),
    getSegment: jest.fn(),
    setSegment: jest.fn(),
    annotateColdStart: jest.fn(),
    addServiceNameAnnotation: jest.fn(),
  },
}));

// Middy: pass-through wrapper.
jest.unstable_mockModule('@middy/core', () => ({
  __esModule: true,
  default: (handler: any) => {
    const middyHandler = (event: any, context: any) => handler(event, context);
    middyHandler.use = () => middyHandler;
    return middyHandler;
  },
}));

// Idempotency: bypass persistence.
jest.unstable_mockModule('@aws-lambda-powertools/idempotency', () => ({
  __esModule: true,
  makeIdempotent: (fn: any) => fn,
  IdempotencyConfig: jest.fn().mockImplementation(() => ({})),
}));
jest.unstable_mockModule('@aws-lambda-powertools/idempotency/dynamodb', () => ({
  __esModule: true,
  DynamoDBPersistenceLayer: jest.fn().mockImplementation(() => ({})),
}));

// Shared clients: organizations client send is the one the tests drive.
jest.unstable_mockModule('../../../lib/lambda/common/utils/clients.js', () => ({
  billingConductorClient: { send: jest.fn() },
  billingClient: { send: jest.fn() },
  organizationsClient: { send: mockOrgSend },
  curClient: { send: jest.fn() },
}));

// Billing conductor service: only ensureBillingGroup is asserted on.
jest.unstable_mockModule(
  '../../../lib/lambda/common/services/billing-conductor-service.js',
  () => ({
    __esModule: true,
    ensureBillingGroup: mockEnsureBillingGroup,
    findBillingGroupByAccount: jest.fn(),
    getBasicPricingPlanArn: jest.fn(),
  })
);

// Organizations SDK client.
jest.unstable_mockModule('@aws-sdk/client-organizations', () => ({
  OrganizationsClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  DescribeResponsibilityTransferCommand: jest.fn().mockImplementation((params) => params),
}));

let handler: typeof HandlerType;
let billingConductorService: typeof BillingConductorServiceType;

beforeAll(async () => {
  ({ handler } = await import('../../../lib/lambda/billing-group-event-handler/index.js'));
  billingConductorService = await import(
    '../../../lib/lambda/common/services/billing-conductor-service.js'
  );
});

describe('Billing Group Event Handler', () => {
  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2024/01/01/[$LATEST]test',
    getRemainingTimeInMillis: () => 120000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('detectEventSource (via handler routing)', () => {
    it('should route aws.organizations events correctly', async () => {
      // Arrange
      const event: BillingTransferEvent = createMockBillingTransferEvent();
      mockEnsureBillingGroup.mockResolvedValue({
        success: true,
        billingGroupArn: 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111',
        billingGroupName: 'bg-111111111111',
        accountId: '111111111111',
        action: 'created',
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body.action).toBe('created');
      expect(mockEnsureBillingGroup).toHaveBeenCalled();
    });

    it('should handle unknown event sources', async () => {
      // Arrange
      const event = {
        source: 'unknown-source',
        data: 'some-data',
      };

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.message).toContain('unknown event source');
    });

    it('should handle null events', async () => {
      // Act
      const result = await handler(null, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.action).toBe('skipped');
    });

    it('should handle non-object events', async () => {
      // Act
      const result = await handler('invalid-event', mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
    });
  });

  describe('handleBillingTransferEvent', () => {
    it('should create billing group for ResponsibilityTransferAccepted event with ARN', async () => {
      // Arrange
      const event = createMockBillingTransferEvent({
        eventName: 'ResponsibilityTransferAccepted',
        transferArn: 'arn:aws:organizations::123456789012:transfer/o-abc123/billing/inbound/rt-xyz789',
      });

      mockEnsureBillingGroup.mockResolvedValue({
        success: true,
        billingGroupArn: 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111',
        billingGroupName: 'bg-111111111111',
        accountId: '111111111111',
        action: 'created',
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body.action).toBe('created');
      expect(result.body.billingGroupArn).toBe(
        'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111'
      );
      expect(mockEnsureBillingGroup).toHaveBeenCalledWith(
        '111111111111',
        'arn:aws:organizations::123456789012:transfer/o-abc123/billing/inbound/rt-xyz789'
      );
    });

    it('should lookup transfer ARN when not present in event', async () => {
      // Arrange
      const event = createMockBillingTransferEvent({
        eventName: 'ResponsibilityTransferAccepted',
        transferArn: undefined, // No ARN in event
      });

      const mockTransferArn = 'arn:aws:organizations::123456789012:transfer/o-abc123/billing/inbound/rt-xyz789';
      mockOrgSend.mockResolvedValue({
        ResponsibilityTransfer: {
          Arn: mockTransferArn,
        },
      });

      mockEnsureBillingGroup.mockResolvedValue({
        success: true,
        billingGroupArn: 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111',
        billingGroupName: 'bg-111111111111',
        accountId: '111111111111',
        action: 'created',
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(mockEnsureBillingGroup).toHaveBeenCalledWith('111111111111', mockTransferArn);
    });

    it('should return exists action when billing group already exists', async () => {
      // Arrange
      const event = createMockBillingTransferEvent();

      mockEnsureBillingGroup.mockResolvedValue({
        success: true,
        billingGroupArn: 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111',
        billingGroupName: 'bg-111111111111',
        accountId: '111111111111',
        action: 'exists',
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body.action).toBe('exists');
      expect(result.body.message).toContain('exists');
    });

    it('should throw error when ensureBillingGroup fails', async () => {
      // Arrange
      const event = createMockBillingTransferEvent();

      mockEnsureBillingGroup.mockResolvedValue({
        success: false,
        accountId: '111111111111',
        action: 'failed',
        error: {
          code: 'ValidationException',
          message: 'Invalid parameters',
        },
      });

      // Act & Assert
      await expect(handler(event, mockContext)).rejects.toThrow(
        'Failed to ensure billing group: Invalid parameters'
      );
    });

    // Note: Testing ARN lookup failure requires different mocking strategy
    // since organizationsClient is instantiated at module level.
    // The ARN lookup scenario is covered by integration tests.

    it('should extract correct accountId from source.managementAccountId', async () => {
      // Arrange
      const event = createMockBillingTransferEvent({
        sourceAccountId: '999888777666',
        targetAccountId: '123456789012',
      });

      mockEnsureBillingGroup.mockResolvedValue({
        success: true,
        billingGroupArn: 'arn:aws:billingconductor::123456789012:billing-group/bg-999888777666',
        billingGroupName: 'bg-999888777666',
        accountId: '999888777666',
        action: 'created',
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.body.accountId).toBe('999888777666');
      expect(mockEnsureBillingGroup).toHaveBeenCalledWith(
        '999888777666',
        expect.any(String)
      );
    });
  });

  describe('handleUnknownEvent', () => {
    it('should return 500 error for unknown source', async () => {
      // Arrange
      const event = { source: 'invalid', data: 'test' };

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.message).toContain('unknown event source');
      expect(result.body.action).toBe('skipped');
    });

    it('should reject scheduler events (use BillingGroupReconciliationStack instead)', async () => {
      // Arrange - scheduler events should be handled by dedicated reconciliation stack
      const event = { source: 'scheduler', action: 'reconcile-all' };

      // Act
      const result = await handler(event, mockContext);

      // Assert - scheduler events are now treated as unknown
      expect(result.statusCode).toBe(500);
      expect(result.body.message).toContain('unknown event source');
    });

    it('should handle events with no source property', async () => {
      // Arrange
      const event = { data: 'test-data' };

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
    });
  });

  describe('error handling', () => {
    it('should propagate errors from ensureBillingGroup', async () => {
      // Arrange
      const event = createMockBillingTransferEvent();
      mockEnsureBillingGroup.mockRejectedValue(new Error('Service unavailable'));

      // Act & Assert
      await expect(handler(event, mockContext)).rejects.toThrow('Service unavailable');
    });

    // Note: Testing Organizations API errors requires different mocking strategy
    // since organizationsClient is instantiated at module level.
    // This scenario is covered by integration tests.
  });
});

/**
 * Helper function to create mock billing transfer events
 */
function createMockBillingTransferEvent(options?: {
  eventName?: 'ResponsibilityTransferAccepted' | 'ResponsibilityTransferTerminated';
  transferArn?: string;
  sourceAccountId?: string;
  targetAccountId?: string;
}): BillingTransferEvent {
  const {
    eventName = 'ResponsibilityTransferAccepted',
    transferArn = 'arn:aws:organizations::123456789012:transfer/o-abc123/billing/inbound/rt-xyz789',
    sourceAccountId = '111111111111',
    targetAccountId = '123456789012',
  } = options || {};

  return {
    version: '0',
    id: 'test-event-id',
    'detail-type': 'AWS Service Event via CloudTrail',
    source: 'aws.organizations',
    account: targetAccountId,
    time: new Date().toISOString(),
    region: 'us-east-1',
    detail: {
      eventVersion: '1.08',
      eventTime: new Date().toISOString(),
      eventName,
      eventSource: 'organizations.amazonaws.com',
      eventType: 'AwsServiceEvent',
      serviceEventDetails: {
        id: 'rt-xyz789',
        arn: transferArn,
        transferChain: [sourceAccountId, targetAccountId],
        type: 'BILLING',
        status: 'ACCEPTED',
        source: {
          managementAccountId: sourceAccountId,
        },
        target: {
          managementAccountId: targetAccountId,
        },
        requester: `arn:aws:iam::${sourceAccountId}:root`,
        startTimestamp: Date.now(),
      },
    },
  };
}
