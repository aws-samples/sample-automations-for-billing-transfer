// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit tests for Billing Group Reconciliation Lambda Handler
 */

import type { Context } from 'aws-lambda';
import type {
  handler as HandlerType,
  SchedulerEvent,
  ReconciliationResponse,
} from '../../../lib/lambda/billing-group-reconciliation/index.js';
import type * as ReconciliationServiceType from '../../../lib/lambda/billing-group-reconciliation/reconciliation-service.js';

// Mock @middy/core before importing the handler (ESM: register mocks, then
// dynamically import the module under test in beforeAll).
jest.unstable_mockModule('@middy/core', () => ({
  __esModule: true,
  default: (handler: any) => {
    const middyHandler = (event: any, context: any) => handler(event, context);
    middyHandler.use = () => middyHandler;
    return middyHandler;
  },
}));

// Mock the reconciliation service with an auto-mocked function.
jest.unstable_mockModule(
  '../../../lib/lambda/billing-group-reconciliation/reconciliation-service.js',
  () => ({
    __esModule: true,
    reconcileAllTransfers: jest.fn(),
  })
);

let handler: typeof HandlerType;
let reconciliationService: typeof ReconciliationServiceType;

beforeAll(async () => {
  ({ handler } = await import(
    '../../../lib/lambda/billing-group-reconciliation/index.js'
  ));
  reconciliationService = await import(
    '../../../lib/lambda/billing-group-reconciliation/reconciliation-service.js'
  );
});

describe('Billing Group Reconciliation Handler', () => {
  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-reconciliation-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-reconciliation-function',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test-reconciliation-function',
    logStreamName: '2024/01/01/[$LATEST]test',
    getRemainingTimeInMillis: () => 300000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  const getMock = () =>
    reconciliationService.reconcileAllTransfers as jest.MockedFunction<
      typeof reconciliationService.reconcileAllTransfers
    >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isSchedulerEvent (via handler validation)', () => {
    it('should accept valid scheduler event', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      getMock().mockResolvedValue({
        directTransfersChecked: 5,
        indirectTransfersChecked: 10,
        billingGroupsCreated: 3,
        billingGroupsExisted: 12,
        errors: [],
        duration: 5000,
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(getMock()).toHaveBeenCalled();
    });

    it('should reject event with wrong source', async () => {
      // Arrange
      const event = {
        source: 'wrong-source',
        action: 'reconcile-all',
      };

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.summary.errors).toHaveLength(1);
      expect(result.body.summary.errors[0].error).toContain('Invalid event');
      expect(getMock()).not.toHaveBeenCalled();
    });

    it('should reject event with wrong action', async () => {
      // Arrange
      const event = {
        source: 'scheduler',
        action: 'wrong-action',
      };

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(getMock()).not.toHaveBeenCalled();
    });

    it('should reject null event', async () => {
      // Act
      const result = await handler(null, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.summary.errors).toHaveLength(1);
    });

    it('should reject non-object event', async () => {
      // Act
      const result = await handler('invalid', mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
    });

    it('should reject empty object event', async () => {
      // Act
      const result = await handler({}, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
    });
  });

  describe('handler', () => {
    it('should return successful response with reconciliation summary', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      const mockSummary = {
        directTransfersChecked: 3,
        indirectTransfersChecked: 6,
        billingGroupsCreated: 2,
        billingGroupsExisted: 7,
        errors: [],
        duration: 2500,
      };

      getMock().mockResolvedValue(mockSummary);

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body.summary).toEqual(mockSummary);
      expect(result.body.timestamp).toBeDefined();
      expect(new Date(result.body.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('should return summary with errors when some transfers fail', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      const mockSummary = {
        directTransfersChecked: 5,
        indirectTransfersChecked: 10,
        billingGroupsCreated: 3,
        billingGroupsExisted: 10,
        errors: [
          {
            accountId: '111111111111',
            transferId: 'rt-abc123',
            error: 'ValidationException: Invalid parameters',
            timestamp: new Date().toISOString(),
          },
          {
            accountId: '222222222222',
            transferId: 'rt-def456',
            error: 'ThrottlingException: Rate exceeded',
            timestamp: new Date().toISOString(),
          },
        ],
        duration: 8000,
      };

      getMock().mockResolvedValue(mockSummary);

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body.summary.errors).toHaveLength(2);
      expect(result.body.summary.billingGroupsCreated).toBe(3);
    });

    it('should return error response when reconciliation throws', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      getMock().mockRejectedValue(new Error('Critical authentication error'));

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.summary.directTransfersChecked).toBe(0);
      expect(result.body.summary.errors).toHaveLength(1);
      expect(result.body.summary.errors[0].error).toContain('Critical authentication error');
    });

    it('should include timestamp in response', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      getMock().mockResolvedValue({
        directTransfersChecked: 0,
        indirectTransfersChecked: 0,
        billingGroupsCreated: 0,
        billingGroupsExisted: 0,
        errors: [],
        duration: 100,
      });

      const beforeTime = new Date().toISOString();

      // Act
      const result = await handler(event, mockContext);
      const afterTime = new Date().toISOString();

      // Assert
      expect(result.body.timestamp).toBeDefined();
      expect(result.body.timestamp >= beforeTime).toBe(true);
      expect(result.body.timestamp <= afterTime).toBe(true);
    });

    it('should handle reconciliation with no transfers', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      getMock().mockResolvedValue({
        directTransfersChecked: 0,
        indirectTransfersChecked: 0,
        billingGroupsCreated: 0,
        billingGroupsExisted: 0,
        errors: [],
        duration: 50,
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body.summary.directTransfersChecked).toBe(0);
      expect(result.body.summary.billingGroupsCreated).toBe(0);
    });

    it('should pass duration from reconciliation service', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      getMock().mockResolvedValue({
        directTransfersChecked: 1,
        indirectTransfersChecked: 2,
        billingGroupsCreated: 1,
        billingGroupsExisted: 2,
        errors: [],
        duration: 12345,
      });

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.body.summary.duration).toBe(12345);
    });
  });

  describe('error handling', () => {
    it('should handle unknown errors gracefully', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      getMock().mockRejectedValue('string error');

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.summary.errors).toHaveLength(1);
    });

    it('should handle Error objects properly', async () => {
      // Arrange
      const event: SchedulerEvent = {
        source: 'scheduler',
        action: 'reconcile-all',
      };

      const testError = new Error('Test error message');
      getMock().mockRejectedValue(testError);

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.statusCode).toBe(500);
      expect(result.body.summary.errors[0].error).toBe('Test error message');
    });

    it('should include accountId N/A in error response for invalid events', async () => {
      // Arrange
      const event = { invalid: 'event' };

      // Act
      const result = await handler(event, mockContext);

      // Assert
      expect(result.body.summary.errors[0].accountId).toBe('N/A');
    });
  });
});
