// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit tests for Lambda handler
 */

import { Context } from 'aws-lambda';
import type { handler as HandlerType } from '../../../lib/lambda/cur-reconciliation/index.js';
import { CURReconciliationEvent } from '../../../lib/lambda/cur-reconciliation/models/lambda-event.js';

// Mock @middy/core before importing the handler.
jest.unstable_mockModule('@middy/core', () => {
  return {
    __esModule: true,
    default: (handler: any) => {
      const middyHandler = (event: any, context: any) => handler(event, context);
      middyHandler.use = () => middyHandler;
      return middyHandler;
    },
  };
});

// Mock the services as constructable classes; tests install per-case
// implementations via mockImplementation.
jest.unstable_mockModule('../../../lib/lambda/cur-reconciliation/services/configuration-service.js', () => ({
  __esModule: true,
  ConfigurationService: jest.fn(),
}));
jest.unstable_mockModule('../../../lib/lambda/cur-reconciliation/services/reconciliation-service.js', () => ({
  __esModule: true,
  ReconciliationService: jest.fn(),
}));

let handler: typeof HandlerType;
let ConfigurationService: jest.Mock;
let ReconciliationService: jest.Mock;

beforeAll(async () => {
  ({ handler } = await import('../../../lib/lambda/cur-reconciliation/index.js'));
  ({ ConfigurationService } = (await import(
    '../../../lib/lambda/cur-reconciliation/services/configuration-service.js'
  )) as unknown as { ConfigurationService: jest.Mock });
  ({ ReconciliationService } = (await import(
    '../../../lib/lambda/cur-reconciliation/services/reconciliation-service.js'
  )) as unknown as { ReconciliationService: jest.Mock });
});

describe('Lambda Handler', () => {
  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
    memoryLimitInMB: '512',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2024/01/01/[$LATEST]test',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Set environment variables
    process.env.CONFIG_BUCKET = 'test-bucket';
    process.env.CONFIG_KEY = 'test-config.json';
  });

  it('should handle scheduled event and return reconciliation result', async () => {
    // Arrange
    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    const mockConfig = {
      version: '1.0',
      myViewReportConfig: {
        dataQuery: {
          queryStatement: 'SELECT * FROM COST_AND_USAGE_REPORT',
          tableConfigurations: {
            timeGranularity: 'DAILY' as const,
            includeResources: false,
            includeSplitCostAllocationData: false,
            includeManualDiscountCompatibility: false,
            includeCapacityReservationData: false,
          },
        },
        destinationConfigurations: {
          s3Bucket: 'test-bucket',
          s3Prefix: 'test-prefix',
          s3Region: 'us-east-1',
          s3OutputConfigurations: {
            overwrite: 'OVERWRITE_REPORT' as const,
            format: 'PARQUET' as const,
            compression: 'PARQUET' as const,
            outputType: 'CUSTOM' as const,
          },
        },
        refreshCadence: {
          frequency: 'SYNCHRONOUS' as const,
        },
      },
    };

    const mockSummary = {
      totalTransfersProcessed: 5,
      myViewReportsCreated: 3,
      myViewReportsAlreadyExisted: 2,
      myViewReportsFailed: 0,
      showbackViewReportsCreated: 0,
      showbackViewReportsAlreadyExisted: 0,
      showbackViewReportsFailed: 0,
      failedTransfers: [],
      supportCasesCreated: 0,
      supportCasesFailed: 0,
    };

    // Mock ConfigurationService
    const mockLoadConfiguration = jest.fn().mockResolvedValue(mockConfig);
    const mockHasMyViewConfig = jest.fn().mockReturnValue(true);
    const mockHasShowbackViewConfig = jest.fn().mockReturnValue(false);

    (ConfigurationService as jest.Mock).mockImplementation(() => ({
      loadConfiguration: mockLoadConfiguration,
      validateConfiguration: jest.fn(),
      hasMyViewConfig: mockHasMyViewConfig,
      hasShowbackViewConfig: mockHasShowbackViewConfig,
      isMyViewEnabled: jest.fn().mockReturnValue(true),
      isShowbackViewEnabled: jest.fn().mockReturnValue(false),
    } as any));

    // Mock ReconciliationService
    const mockReconcileAllTransfers = jest.fn().mockResolvedValue(mockSummary);

    (ReconciliationService as jest.Mock).mockImplementation(() => ({
      reconcileAllTransfers: mockReconcileAllTransfers,
    } as any));

    // Act
    const result = await handler(event, mockContext);

    // Assert
    expect(result).toBeDefined();
    expect(result.summary).toEqual(mockSummary);
    expect(result.timestamp).toBeDefined();
    expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);

    // Verify configuration was loaded from S3
    expect(mockLoadConfiguration).toHaveBeenCalledWith('s3://test-bucket/test-config.json');

    // Verify reconciliation was executed
    expect(mockReconcileAllTransfers).toHaveBeenCalledWith(mockConfig);
  });

  it('should use CONFIG_PATH when provided', async () => {
    // Arrange
    process.env.CONFIG_PATH = '/local/config.json';
    delete process.env.CONFIG_BUCKET;
    delete process.env.CONFIG_KEY;

    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    const mockConfig = {
      version: '1.0',
      myViewReportConfig: {} as any,
    };

    const mockSummary = {
      totalTransfersProcessed: 0,
      myViewReportsCreated: 0,
      myViewReportsAlreadyExisted: 0,
      myViewReportsFailed: 0,
      showbackViewReportsCreated: 0,
      showbackViewReportsAlreadyExisted: 0,
      showbackViewReportsFailed: 0,
      failedTransfers: [],
      supportCasesCreated: 0,
      supportCasesFailed: 0,
    };

    const mockLoadConfiguration = jest.fn().mockResolvedValue(mockConfig);
    const mockHasMyViewConfig = jest.fn().mockReturnValue(true);
    const mockHasShowbackViewConfig = jest.fn().mockReturnValue(false);

    (ConfigurationService as jest.Mock).mockImplementation(() => ({
      loadConfiguration: mockLoadConfiguration,
      validateConfiguration: jest.fn(),
      hasMyViewConfig: mockHasMyViewConfig,
      hasShowbackViewConfig: mockHasShowbackViewConfig,
      isMyViewEnabled: jest.fn().mockReturnValue(true),
      isShowbackViewEnabled: jest.fn().mockReturnValue(false),
    } as any));

    const mockReconcileAllTransfers = jest.fn().mockResolvedValue(mockSummary);

    (ReconciliationService as jest.Mock).mockImplementation(() => ({
      reconcileAllTransfers: mockReconcileAllTransfers,
    } as any));

    // Act
    const result = await handler(event, mockContext);

    // Assert
    expect(mockLoadConfiguration).toHaveBeenCalledWith('/local/config.json');
  });

  it('should throw error for unknown event source', async () => {
    // Arrange
    const event = {
      source: 'unknown',
      action: 'reconcile-all',
    } as any;

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      "Unknown event source: unknown. Expected 'scheduler'"
    );
  });

  it('should throw error for unknown event action', async () => {
    // Arrange
    const event = {
      source: 'scheduler',
      action: 'unknown',
    } as any;

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      "Unknown event action: unknown. Expected 'reconcile-all'"
    );
  });

  it('should throw error when configuration source is not specified', async () => {
    // Arrange
    delete process.env.CONFIG_PATH;
    delete process.env.CONFIG_BUCKET;
    delete process.env.CONFIG_KEY;

    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      'Configuration source not specified'
    );
  });

  it('should throw error when only CONFIG_BUCKET is set', async () => {
    // Arrange
    delete process.env.CONFIG_PATH;
    process.env.CONFIG_BUCKET = 'test-bucket';
    delete process.env.CONFIG_KEY;

    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      'Configuration source not specified'
    );
  });

  it('should throw error when only CONFIG_KEY is set', async () => {
    // Arrange
    delete process.env.CONFIG_PATH;
    delete process.env.CONFIG_BUCKET;
    process.env.CONFIG_KEY = 'test-config.json';

    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      'Configuration source not specified'
    );
  });

  it('should handle configuration loading errors', async () => {
    // Arrange
    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    const mockLoadConfiguration = jest.fn().mockRejectedValue(
      new Error('Failed to load configuration')
    );

    (ConfigurationService as jest.Mock).mockImplementation(() => ({
      loadConfiguration: mockLoadConfiguration,
      validateConfiguration: jest.fn(),
      hasMyViewConfig: jest.fn(),
      hasShowbackViewConfig: jest.fn(),
    } as any));

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      'Failed to load configuration'
    );
  });

  it('should handle reconciliation errors', async () => {
    // Arrange
    const event: CURReconciliationEvent = {
      source: 'scheduler',
      action: 'reconcile-all',
    };

    const mockConfig = {
      version: '1.0',
      myViewReportConfig: {} as any,
    };

    const mockLoadConfiguration = jest.fn().mockResolvedValue(mockConfig);
    const mockHasMyViewConfig = jest.fn().mockReturnValue(true);
    const mockHasShowbackViewConfig = jest.fn().mockReturnValue(false);

    (ConfigurationService as jest.Mock).mockImplementation(() => ({
      loadConfiguration: mockLoadConfiguration,
      validateConfiguration: jest.fn(),
      hasMyViewConfig: mockHasMyViewConfig,
      hasShowbackViewConfig: mockHasShowbackViewConfig,
      isMyViewEnabled: jest.fn().mockReturnValue(true),
      isShowbackViewEnabled: jest.fn().mockReturnValue(false),
    } as any));

    const mockReconcileAllTransfers = jest.fn().mockRejectedValue(
      new Error('Reconciliation failed')
    );

    (ReconciliationService as jest.Mock).mockImplementation(() => ({
      reconcileAllTransfers: mockReconcileAllTransfers,
    } as any));

    // Act & Assert
    await expect(handler(event, mockContext)).rejects.toThrow(
      'Reconciliation failed'
    );
  });
});
