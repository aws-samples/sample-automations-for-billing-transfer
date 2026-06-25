// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit tests for Billing Group Reconciliation Service
 *
 * Tests the reconciliation-service.ts which uses TransferAnalysisService
 * to discover transfers and create billing groups for those missing them.
 *
 * Requirements: 8.5 - Ensure all existing tests are updated to reflect the new implementation
 */

import type { reconcileAllTransfers as ReconcileAllTransfersType } from '../../../lib/lambda/billing-group-reconciliation/reconciliation-service.js';
import type * as TransferAnalysisServiceType from '../../../lib/lambda/common/services/transfer-analysis-service.js';
import type * as BillingConductorServiceType from '../../../lib/lambda/common/services/billing-conductor-service.js';
import { AnalysisSummaryModel } from '../../../lib/lambda/common/models/analysis-summary.js';
import { BillingTransferWithResourcesModel } from '../../../lib/lambda/common/models/billing-transfer-resources.js';

jest.unstable_mockModule(
  '../../../lib/lambda/common/services/transfer-analysis-service.js',
  () => ({ __esModule: true, analyzeTransfers: jest.fn() })
);
jest.unstable_mockModule(
  '../../../lib/lambda/common/services/billing-conductor-service.js',
  () => ({
    __esModule: true,
    ensureBillingGroup: jest.fn(),
    tagBillingGroup: jest.fn(),
    getBillingGroupTags: jest.fn(),
    findBillingGroupByAccount: jest.fn(),
    getBasicPricingPlanArn: jest.fn(),
  })
);
jest.unstable_mockModule('../../../lib/lambda/common/utils/logger.js', () => ({
  __esModule: true,
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
  })),
}));

let reconcileAllTransfers: typeof ReconcileAllTransfersType;
let transferAnalysisService: typeof TransferAnalysisServiceType;
let billingConductorService: typeof BillingConductorServiceType;

beforeAll(async () => {
  ({ reconcileAllTransfers } = await import(
    '../../../lib/lambda/billing-group-reconciliation/reconciliation-service.js'
  ));
  transferAnalysisService = await import(
    '../../../lib/lambda/common/services/transfer-analysis-service.js'
  );
  billingConductorService = await import(
    '../../../lib/lambda/common/services/billing-conductor-service.js'
  );
});

describe('Billing Group Reconciliation Service', () => {
  const mockAnalyzeTransfers = () =>
    transferAnalysisService.analyzeTransfers as jest.MockedFunction<
      typeof transferAnalysisService.analyzeTransfers
    >;
  const mockEnsureBillingGroup = () =>
    billingConductorService.ensureBillingGroup as jest.MockedFunction<
      typeof billingConductorService.ensureBillingGroup
    >;
  const mockTagBillingGroup = () =>
    billingConductorService.tagBillingGroup as jest.MockedFunction<
      typeof billingConductorService.tagBillingGroup
    >;
  const mockGetBillingGroupTags = () =>
    billingConductorService.getBillingGroupTags as jest.MockedFunction<
      typeof billingConductorService.getBillingGroupTags
    >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBillingGroupTags().mockReturnValue({ key: 'value' });
    mockTagBillingGroup().mockResolvedValue(undefined);
  });

  /**
   * Helper to create a mock BillingTransferWithResourcesModel
   */
  function createMockTransferWithResources(
    accountId: string,
    transferId: string,
    transferType: 'direct' | 'indirect',
    hasBillingGroup: boolean,
    billingGroupArn?: string
  ): BillingTransferWithResourcesModel {
    return {
      transfer: {
        id: transferId,
        arn: `arn:aws:organizations::${accountId}:transfer/${transferId}`,
        name: `transfer-${transferId}`,
        billSourceAccountId: accountId,
        billTransferAccountId: '999999999999',
        status: 'ACCEPTED',
        type: 'BILLING',
        transferType,
        startTimestamp: Date.now(),
      },
      resources: {
        billingView: null,
        billingGroup: hasBillingGroup
          ? {
              arn: billingGroupArn || `arn:aws:billingconductor::${accountId}:billinggroup/${accountId}`,
              name: `bg-${accountId}`,
              primaryAccountId: accountId,
              pricingPlanArn: 'arn:aws:billingconductor::123456789012:pricingplan/BasicPricingPlan',
            }
          : null,
        pricingPlan: null,
        curConfiguration: null,
      },
      resourcesFound: {
        billingView: false,
        billingGroup: hasBillingGroup,
        pricingPlan: false,
        curConfiguration: false,
      },
      retrievalTimestamp: Date.now(),
    };
  }

  /**
   * Helper to create a mock AnalysisSummaryModel
   */
  function createMockAnalysisSummary(
    transfers: BillingTransferWithResourcesModel[]
  ): AnalysisSummaryModel {
    const directTransfers = transfers.filter((t) => t.transfer.transferType === 'direct');
    const indirectTransfers = transfers.filter((t) => t.transfer.transferType === 'indirect');
    const withBillingGroups = transfers.filter((t) => t.resourcesFound.billingGroup);

    return {
      relationshipState: 'ACCEPTED',
      totalTransfers: transfers.length,
      directTransferCount: directTransfers.length,
      indirectTransferCount: indirectTransfers.length,
      resourceCounts: {
        withBillingViews: 0,
        withBillingGroups: withBillingGroups.length,
        withPricingPlans: 0,
        withCURConfigurations: 0,
        missingBillingViews: transfers.length,
        missingBillingGroups: transfers.length - withBillingGroups.length,
        missingPricingPlans: transfers.length,
        missingCURConfigurations: transfers.length,
      },
      transfers,
      analysisTimestamp: Date.now(),
      executionTimeMs: 100,
    };
  }

  describe('reconcileAllTransfers', () => {
    it('should call analyzeTransfers with ACCEPTED relationship state', async () => {
      // Arrange
      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([]),
      });

      // Act
      await reconcileAllTransfers();

      // Assert - Requirements: 1.1, 8.1
      expect(mockAnalyzeTransfers()).toHaveBeenCalledWith({
        relationshipState: 'ACCEPTED',
      });
    });

    it('should return empty summary when no transfers found', async () => {
      // Arrange
      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([]),
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert
      expect(result.directTransfersChecked).toBe(0);
      expect(result.indirectTransfersChecked).toBe(0);
      expect(result.billingGroupsCreated).toBe(0);
      expect(result.billingGroupsExisted).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(mockEnsureBillingGroup()).not.toHaveBeenCalled();
    });

    it('should filter transfers missing billing groups and create them', async () => {
      // Arrange - Requirements: 1.2, 1.3
      const transferMissingBG = createMockTransferWithResources(
        '111111111111',
        'rt-missing',
        'direct',
        false
      );
      const transferWithBG = createMockTransferWithResources(
        '222222222222',
        'rt-existing',
        'direct',
        true,
        'arn:aws:billingconductor::222222222222:billinggroup/existing'
      );

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([transferMissingBG, transferWithBG]),
      });

      mockEnsureBillingGroup().mockResolvedValue({
        success: true,
        action: 'created',
        accountId: '111111111111',
        billingGroupArn: 'arn:aws:billingconductor::111111111111:billinggroup/new',
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert - Only the transfer missing billing group should trigger ensureBillingGroup
      expect(mockEnsureBillingGroup()).toHaveBeenCalledTimes(1);
      expect(mockEnsureBillingGroup()).toHaveBeenCalledWith(
        '111111111111',
        'arn:aws:organizations::111111111111:transfer/rt-missing'
      );
      expect(result.billingGroupsCreated).toBe(1);
      expect(result.billingGroupsExisted).toBe(1);
    });

    it('should track direct and indirect transfer counts from analysis summary', async () => {
      // Arrange - Requirements: 1.4, 5.1
      const directTransfer = createMockTransferWithResources(
        '111111111111',
        'rt-direct',
        'direct',
        true
      );
      const indirectTransfer1 = createMockTransferWithResources(
        '222222222222',
        'rt-indirect-1',
        'indirect',
        true
      );
      const indirectTransfer2 = createMockTransferWithResources(
        '333333333333',
        'rt-indirect-2',
        'indirect',
        true
      );

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([directTransfer, indirectTransfer1, indirectTransfer2]),
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert - Requirements: 1.4, 5.1
      expect(result.directTransfersChecked).toBe(1);
      expect(result.indirectTransfersChecked).toBe(2);
    });

    it('should handle ensureBillingGroup returning exists (race condition)', async () => {
      // Arrange
      const transferMissingBG = createMockTransferWithResources(
        '111111111111',
        'rt-race',
        'direct',
        false
      );

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([transferMissingBG]),
      });

      // Simulate race condition - billing group was created between analysis and create
      mockEnsureBillingGroup().mockResolvedValue({
        success: true,
        action: 'exists',
        accountId: '111111111111',
        billingGroupArn: 'arn:aws:billingconductor::111111111111:billinggroup/race',
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert
      expect(result.billingGroupsCreated).toBe(0);
      expect(result.billingGroupsExisted).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle ensureBillingGroup failure and continue processing', async () => {
      // Arrange - Requirements: 3.4
      const transfer1 = createMockTransferWithResources(
        '111111111111',
        'rt-fail',
        'direct',
        false
      );
      const transfer2 = createMockTransferWithResources(
        '222222222222',
        'rt-success',
        'direct',
        false
      );

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([transfer1, transfer2]),
      });

      mockEnsureBillingGroup()
        .mockResolvedValueOnce({
          success: false,
          action: 'failed',
          accountId: '111111111111',
          error: { code: 'ValidationException', message: 'ValidationException: Invalid parameters' },
        })
        .mockResolvedValueOnce({
          success: true,
          action: 'created',
          accountId: '222222222222',
          billingGroupArn: 'arn:aws:billingconductor::222222222222:billinggroup/success',
        });

      // Act
      const result = await reconcileAllTransfers();

      // Assert - Error isolation: first fails, second succeeds
      expect(mockEnsureBillingGroup()).toHaveBeenCalledTimes(2);
      expect(result.billingGroupsCreated).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].accountId).toBe('111111111111');
    });

    it('should include error details with accountId, transferId, and timestamp', async () => {
      // Arrange - Requirements: 5.3
      const transfer = createMockTransferWithResources(
        '111111111111',
        'rt-error',
        'direct',
        false
      );

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([transfer]),
      });

      mockEnsureBillingGroup().mockResolvedValue({
        success: false,
        action: 'failed',
        accountId: '111111111111',
        error: { code: 'TestError', message: 'Test error message' },
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert - Requirements: 5.3
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].accountId).toBe('111111111111');
      expect(result.errors[0].transferId).toBe('rt-error');
      expect(result.errors[0].timestamp).toBeDefined();
      expect(new Date(result.errors[0].timestamp).getTime()).toBeGreaterThan(0);
    });

    it('should return summary with duration', async () => {
      // Arrange
      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([]),
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle analyzeTransfers throwing critical error', async () => {
      // Arrange - Requirements: 5.4
      const criticalError = new Error('AccessDeniedException: Not authorized');
      (criticalError as Error & { code: string }).code = 'AccessDeniedException';
      mockAnalyzeTransfers().mockRejectedValue(criticalError);

      // Act & Assert - Critical errors should be thrown to trigger EventBridge retry
      await expect(reconcileAllTransfers()).rejects.toThrow('AccessDeniedException');
    });

    it('should return error summary for non-critical analyzeTransfers errors', async () => {
      // Arrange
      const nonCriticalError = new Error('ServiceUnavailable: Temporary failure');
      mockAnalyzeTransfers().mockRejectedValue(nonCriticalError);

      // Act
      const result = await reconcileAllTransfers();

      // Assert
      expect(result.directTransfersChecked).toBe(0);
      expect(result.indirectTransfersChecked).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('ServiceUnavailable');
    });

    it('should tag existing billing groups', async () => {
      // Arrange
      const transferWithBG = createMockTransferWithResources(
        '111111111111',
        'rt-existing',
        'direct',
        true,
        'arn:aws:billingconductor::111111111111:billinggroup/existing'
      );

      // Simulate a transfer that analysis says has no billing group but reconcileTransfer finds one
      const transferMissingBG = createMockTransferWithResources(
        '222222222222',
        'rt-missing',
        'direct',
        false
      );

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary([transferWithBG, transferMissingBG]),
      });

      mockEnsureBillingGroup().mockResolvedValue({
        success: true,
        action: 'created',
        accountId: '222222222222',
        billingGroupArn: 'arn:aws:billingconductor::222222222222:billinggroup/new',
      });

      // Act
      await reconcileAllTransfers();

      // Assert - ensureBillingGroup only called for missing, not for existing
      expect(mockEnsureBillingGroup()).toHaveBeenCalledTimes(1);
      expect(mockEnsureBillingGroup()).toHaveBeenCalledWith(
        '222222222222',
        expect.any(String)
      );
    });

    it('should process multiple transfers missing billing groups', async () => {
      // Arrange
      const transfers = [
        createMockTransferWithResources('111111111111', 'rt-1', 'direct', false),
        createMockTransferWithResources('222222222222', 'rt-2', 'indirect', false),
        createMockTransferWithResources('333333333333', 'rt-3', 'direct', false),
      ];

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary(transfers),
      });

      mockEnsureBillingGroup().mockResolvedValue({
        success: true,
        action: 'created',
        accountId: 'test',
        billingGroupArn: 'arn:aws:billingconductor::test:billinggroup/new',
      });

      // Act
      const result = await reconcileAllTransfers();

      // Assert
      expect(mockEnsureBillingGroup()).toHaveBeenCalledTimes(3);
      expect(result.billingGroupsCreated).toBe(3);
      expect(result.directTransfersChecked).toBe(2);
      expect(result.indirectTransfersChecked).toBe(1);
    });

    it('should handle mixed success and failure scenarios', async () => {
      // Arrange
      const transfers = [
        createMockTransferWithResources('111111111111', 'rt-1', 'direct', false),
        createMockTransferWithResources('222222222222', 'rt-2', 'direct', true),
        createMockTransferWithResources('333333333333', 'rt-3', 'indirect', false),
      ];

      mockAnalyzeTransfers().mockResolvedValue({
        summary: createMockAnalysisSummary(transfers),
      });

      mockEnsureBillingGroup()
        .mockResolvedValueOnce({
          success: true,
          action: 'created',
          accountId: '111111111111',
          billingGroupArn: 'arn:aws:billingconductor::111111111111:billinggroup/new',
        })
        .mockResolvedValueOnce({
          success: false,
          action: 'failed',
          accountId: '333333333333',
          error: { code: 'CreateError', message: 'Failed to create' },
        });

      // Act
      const result = await reconcileAllTransfers();

      // Assert
      expect(result.billingGroupsCreated).toBe(1);
      expect(result.billingGroupsExisted).toBe(1); // The one that already had billing group
      expect(result.errors).toHaveLength(1);
      expect(result.directTransfersChecked).toBe(2);
      expect(result.indirectTransfersChecked).toBe(1);
    });
  });
});
