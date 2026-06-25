// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit tests for ReconciliationService
 * 
 * Tests the refactored ReconciliationService that uses TransferAnalysisService
 * for unified transfer discovery and resource matching.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 5.2, 8.2, 8.3, 8.4, 8.5
 */

import type { ReconciliationService as ReconciliationServiceType } from '../../../lib/lambda/cur-reconciliation/services/reconciliation-service.js';
import type { CURReportService } from '../../../lib/lambda/cur-reconciliation/services/cur-report-service.js';
import type { S3ValidationService } from '../../../lib/lambda/cur-reconciliation/services/s3-validation-service.js';
import type { SupportCaseService } from '../../../lib/lambda/cur-reconciliation/services/support-case-service.js';
import type { ConfigurationService } from '../../../lib/lambda/cur-reconciliation/services/configuration-service.js';
import { ReportConfigurationTemplate, ViewReportConfig } from '../../../lib/lambda/common/models/cur-configuration.js';
import { CURReportCreationResult } from '../../../lib/lambda/common/models/cur-report.js';
import { S3ValidationResult } from '../../../lib/lambda/cur-reconciliation/models/s3-validation.js';
import { BillingTransferWithResourcesModel } from '../../../lib/lambda/common/models/billing-transfer-resources.js';
import { AnalysisSummaryModel } from '../../../lib/lambda/common/models/analysis-summary.js';
import type * as TransferAnalysisServiceType from '../../../lib/lambda/common/services/transfer-analysis-service.js';

// Mock TransferAnalysisService
jest.unstable_mockModule('../../../lib/lambda/common/services/transfer-analysis-service.js', () => ({
  __esModule: true,
  analyzeTransfers: jest.fn(),
}));

// Mock tagging service
jest.unstable_mockModule('../../../lib/lambda/common/services/tagging-service.js', () => ({
  __esModule: true,
  ensureCURReportTags: jest.fn<() => Promise<{ action: string }>>().mockResolvedValue({ action: 'tagged' }),
}));

// Mock services with constructable class stubs. Each instance is a Proxy that
// lazily exposes a jest.fn() for any accessed method (mirroring Jest's
// automock behavior under ESM) while still allowing tests to override a
// method by assignment.
const makeClassMock = () =>
  jest.fn().mockImplementation(() => {
    const methods = new Map<string, ReturnType<typeof jest.fn>>();
    return new Proxy(
      {},
      {
        get(target: any, prop: string) {
          if (prop in target) return target[prop];
          if (typeof prop !== 'string') return undefined;
          if (!methods.has(prop)) methods.set(prop, jest.fn());
          return methods.get(prop);
        },
        set(target: any, prop: string, value: unknown) {
          target[prop] = value;
          return true;
        },
      }
    );
  });

jest.unstable_mockModule('../../../lib/lambda/cur-reconciliation/services/cur-report-service.js', () => {
  const ctor = makeClassMock();
  // Pure static helper used by the reconciliation service to derive report names.
  (ctor as any).generateReportName = (
    billSourceAccountId: string,
    viewType: 'my-view' | 'showback-view'
  ) => `billing-transfer-${billSourceAccountId}-${viewType}`;
  return { __esModule: true, CURReportService: ctor };
});
jest.unstable_mockModule('../../../lib/lambda/cur-reconciliation/services/s3-validation-service.js', () => ({
  __esModule: true,
  S3ValidationService: makeClassMock(),
}));
jest.unstable_mockModule('../../../lib/lambda/cur-reconciliation/services/support-case-service.js', () => ({
  __esModule: true,
  SupportCaseService: makeClassMock(),
}));
jest.unstable_mockModule('../../../lib/lambda/cur-reconciliation/services/configuration-service.js', () => ({
  __esModule: true,
  ConfigurationService: makeClassMock(),
}));

let ReconciliationService: typeof ReconciliationServiceType;
let CURReportService: any;
let S3ValidationService: any;
let SupportCaseService: any;
let ConfigurationService: any;
let analyzeTransfers: typeof TransferAnalysisServiceType.analyzeTransfers;

beforeAll(async () => {
  ({ ReconciliationService } = await import('../../../lib/lambda/cur-reconciliation/services/reconciliation-service.js'));
  ({ CURReportService } = await import('../../../lib/lambda/cur-reconciliation/services/cur-report-service.js'));
  ({ S3ValidationService } = await import('../../../lib/lambda/cur-reconciliation/services/s3-validation-service.js'));
  ({ SupportCaseService } = await import('../../../lib/lambda/cur-reconciliation/services/support-case-service.js'));
  ({ ConfigurationService } = await import('../../../lib/lambda/cur-reconciliation/services/configuration-service.js'));
  ({ analyzeTransfers } = await import('../../../lib/lambda/common/services/transfer-analysis-service.js'));
});

describe('ReconciliationService', () => {
  let service: ReconciliationServiceType;
  let mockCURReportService: any;
  let mockS3ValidationService: any;
  let mockSupportCaseService: any;
  let mockConfigurationService: any;
  let mockAnalyzeTransfers: jest.MockedFunction<typeof analyzeTransfers>;

  const mockMyViewConfig: ViewReportConfig = {
    enabled: true,
    timeUnit: 'DAILY',
    format: 'Parquet',
    compression: 'Parquet',
    additionalSchemaElements: ['RESOURCES'],
    s3Bucket: 'test-bucket',
    s3Prefix: 'my-view-reports',
    s3Region: 'us-east-1',
    refreshClosedReports: true,
    reportVersioning: 'OVERWRITE_REPORT',
  };

  const mockConfiguration: ReportConfigurationTemplate = {
    version: '1.0',
    myViewReportConfig: mockMyViewConfig,
  };

  // Helper to create a mock transfer with resources
  const createMockTransferWithResources = (
    accountId: string,
    options: {
      hasBillingGroup?: boolean;
      hasBillingView?: boolean;
      hasCURConfiguration?: boolean;
      hasShowbackView?: boolean;
      hasShowbackCurConfiguration?: boolean;
    } = {}
  ): BillingTransferWithResourcesModel => {
    const {
      hasBillingGroup = true,
      hasBillingView = true,
      hasCURConfiguration = false,
      hasShowbackView = false,
      hasShowbackCurConfiguration = false,
    } = options;
    
    return {
      transfer: {
        id: `transfer-${accountId}`,
        arn: `arn:aws:organizations::210987654321:responsibility-transfer/transfer-${accountId}`,
        name: `Test Transfer ${accountId}`,
        billSourceAccountId: accountId,
        billTransferAccountId: '210987654321',
        status: 'ACCEPTED',
        type: 'BILLING',
        startTimestamp: Date.now(),
        transferType: 'direct',
      },
      resources: {
        billingView: hasBillingView ? {
          arn: `arn:aws:billing::${accountId}:billingview/billing-transfer-${accountId}`,
          name: `billing-transfer-${accountId}`,
          billingViewType: 'BILLING_TRANSFER',
          ownerAccountId: '210987654321',
          sourceAccountId: accountId,
        } : null,
        showbackBillingView: hasShowbackView ? {
          arn: `arn:aws:billing::${accountId}:billingview/billing-transfer-showback-${accountId}`,
          name: `billing-transfer-showback-${accountId}`,
          billingViewType: 'BILLING_TRANSFER_SHOWBACK',
          ownerAccountId: '210987654321',
          sourceAccountId: accountId,
        } : null,
        billingGroup: hasBillingGroup ? {
          arn: `arn:aws:billingconductor::210987654321:billinggroup/${accountId}`,
          name: `billing-group-${accountId}`,
          primaryAccountId: accountId,
          pricingPlanArn: 'arn:aws:billingconductor::210987654321:pricingplan/basic',
        } : null,
        pricingPlan: hasBillingGroup ? {
          arn: 'arn:aws:billingconductor::210987654321:pricingplan/basic',
          name: 'BasicPricingPlan',
        } : null,
        curConfiguration: hasCURConfiguration ? {
          reportName: `billing-transfer-${accountId}-my-view`,
          s3Bucket: 'test-bucket',
          s3Region: 'us-east-1',
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: ['RESOURCES'],
          additionalArtifacts: [],
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        } : null,
        showbackCurConfiguration: hasShowbackCurConfiguration ? {
          reportName: `billing-transfer-${accountId}-showback-view`,
          s3Bucket: 'test-bucket',
          s3Region: 'us-east-1',
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: [],
          additionalArtifacts: [],
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        } : null,
      },
      resourcesFound: {
        billingView: hasBillingView,
        showbackBillingView: hasShowbackView,
        billingGroup: hasBillingGroup,
        pricingPlan: hasBillingGroup,
        curConfiguration: hasCURConfiguration,
        showbackCurConfiguration: hasShowbackCurConfiguration,
      },
      retrievalTimestamp: Date.now(),
    };
  };

  // Helper to create mock analysis summary
  const createMockAnalysisSummary = (
    transfers: BillingTransferWithResourcesModel[]
  ): AnalysisSummaryModel => {
    const directCount = transfers.filter(t => t.transfer.transferType === 'direct').length;
    const indirectCount = transfers.filter(t => t.transfer.transferType === 'indirect').length;
    
    return {
      relationshipState: 'ACCEPTED',
      totalTransfers: transfers.length,
      directTransferCount: directCount,
      indirectTransferCount: indirectCount,
      resourceCounts: {
        withBillingViews: transfers.filter(t => t.resourcesFound.billingView).length,
        withBillingGroups: transfers.filter(t => t.resourcesFound.billingGroup).length,
        withPricingPlans: transfers.filter(t => t.resourcesFound.pricingPlan).length,
        withCURConfigurations: transfers.filter(t => t.resourcesFound.curConfiguration).length,
        missingBillingViews: transfers.filter(t => !t.resourcesFound.billingView).length,
        missingBillingGroups: transfers.filter(t => !t.resourcesFound.billingGroup).length,
        missingPricingPlans: transfers.filter(t => !t.resourcesFound.pricingPlan).length,
        missingCURConfigurations: transfers.filter(t => !t.resourcesFound.curConfiguration).length,
      },
      transfers,
      analysisTimestamp: Date.now(),
      executionTimeMs: 100,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockCURReportService = new CURReportService();
    mockS3ValidationService = new S3ValidationService();
    mockSupportCaseService = new SupportCaseService();
    mockConfigurationService = new ConfigurationService();
    mockAnalyzeTransfers = analyzeTransfers as jest.MockedFunction<typeof analyzeTransfers>;

    service = new ReconciliationService(
      mockCURReportService,
      mockS3ValidationService,
      mockSupportCaseService,
      mockConfigurationService
    );
  });

  describe('reconcileAllTransfers', () => {
    it('should call analyzeTransfers with ACCEPTED relationship state', async () => {
      // Arrange
      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([]),
      });
      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(false);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      // Act
      await service.reconcileAllTransfers(mockConfiguration);

      // Assert - Requirements: 2.1
      expect(mockAnalyzeTransfers).toHaveBeenCalledWith({ relationshipState: 'ACCEPTED' });
    });

    it('should process transfers needing CUR and return summary', async () => {
      // Arrange
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      mockS3ValidationService.validateBucket = jest.fn().mockResolvedValue({
        bucketExists: true,
        policyIsValid: true,
      } as S3ValidationResult);

      mockCURReportService.createReport = jest.fn().mockResolvedValue({
        reportName: 'billing-transfer-123456789012-my-view',
        created: true,
        alreadyExisted: false,
      } as CURReportCreationResult);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert - Requirements: 2.2, 2.5, 5.2
      expect(result.totalTransfersProcessed).toBe(1);
      expect(result.myViewReportsCreated).toBe(1);
      expect(result.failedTransfers).toHaveLength(0);
    });

    it('should skip transfers that already have CUR configurations', async () => {
      // Arrange - Requirements: 2.4
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: true, // Already has CUR
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert
      expect(result.totalTransfersProcessed).toBe(1);
      expect(result.myViewReportsCreated).toBe(0);
      expect(mockCURReportService.createReport).not.toHaveBeenCalled();
    });

    it('should skip transfers missing billing groups and log an error', async () => {
      // Arrange - Requirements: 3.1, 3.2
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: false, // Missing billing group
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert - Transfer should be skipped (no report created), and the
      // missing billing group is surfaced as an error so operators are alerted
      // that the CUR could not be created.
      expect(result.totalTransfersProcessed).toBe(1);
      expect(result.myViewReportsCreated).toBe(0);
      expect(mockCURReportService.createReport).not.toHaveBeenCalled();
    });

    it('should count a not-applicable view type as skipped, not failed', async () => {
      // Arrange - transfer has a My View billing view only, but Showback is
      // also enabled in config. The missing Showback view must be treated as a
      // skip (not a failure), otherwise healthy accounts report false ATTENTION.
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: true,
        billingViewType: 'BILLING_TRANSFER', // My View only, no Showback view
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(true);

      // S3 validation passes so processing reaches the view-type check
      mockS3ValidationService.validateBucket = jest.fn().mockResolvedValue({
        bucketExists: true,
        policyIsValid: true,
      } as S3ValidationResult);

      // My View report creation succeeds (so the catch-all path is not hit)
      mockCURReportService.createReport = jest.fn().mockResolvedValue({
        reportName: 'billing-transfer-123456789012-my-view',
        created: true,
      });

      // Config must define a showback section, otherwise viewConfig would be
      // undefined and fail in S3 validation before the view-type check.
      const configWithShowback: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: mockMyViewConfig,
        showbackViewReportConfig: {
          ...mockMyViewConfig,
          s3Prefix: 'showback-view-reports',
        },
      };

      // Act
      const result = await service.reconcileAllTransfers(configWithShowback);

      // Assert - the missing Showback view is a skip, NOT a failure
      expect(result.showbackViewReportsFailed).toBe(0);
      expect(result.showbackViewReportsSkipped).toBe(1);
      expect(result.failedTransfers).toHaveLength(0);
    });

    it('should create the Showback CUR for a transfer that already has its My View CUR', async () => {
      // Arrange - this is the exact fleet scenario the fix targets: the My View
      // CUR already exists, a Showback billing view exists, but the Showback CUR
      // is missing. Previously the transfer was filtered out (because it had a
      // curConfiguration) and the showback path also resolved the wrong view, so
      // the Showback report was never created.
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: true, // My View CUR already exists
        hasShowbackView: true, // Showback billing view exists
        hasShowbackCurConfiguration: false, // Showback CUR is missing
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(true);

      mockS3ValidationService.validateBucket = jest.fn().mockResolvedValue({
        bucketExists: true,
        policyIsValid: true,
      } as S3ValidationResult);

      mockCURReportService.createReport = jest.fn().mockResolvedValue({
        reportName: 'billing-transfer-123456789012-showback-view',
        created: true,
        alreadyExisted: false,
      } as CURReportCreationResult);

      const configWithShowback: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: mockMyViewConfig,
        showbackViewReportConfig: {
          ...mockMyViewConfig,
          s3Prefix: 'showback-view-reports',
        },
      };

      // Act
      const result = await service.reconcileAllTransfers(configWithShowback);

      // Assert - the Showback report is created against the Showback view ARN
      expect(result.showbackViewReportsCreated).toBe(1);
      expect(result.showbackViewReportsFailed).toBe(0);
      expect(mockCURReportService.createReport).toHaveBeenCalledWith(
        expect.objectContaining({
          billingViewArn: mockTransfer.resources.showbackBillingView!.arn,
        })
      );
    });

    it('should handle disabled views', async () => {
      // Arrange
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(false); // Disabled
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert
      expect(result.totalTransfersProcessed).toBe(1);
      expect(result.myViewReportsCreated).toBe(0);
      expect(mockCURReportService.createReport).not.toHaveBeenCalled();
    });

    it('should use billing view from model for CUR creation', async () => {
      // Arrange - Requirements: 2.3, 8.4
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      mockS3ValidationService.validateBucket = jest.fn().mockResolvedValue({
        bucketExists: true,
        policyIsValid: true,
      } as S3ValidationResult);

      mockCURReportService.createReport = jest.fn().mockResolvedValue({
        reportName: 'billing-transfer-123456789012-my-view',
        created: true,
        alreadyExisted: false,
      } as CURReportCreationResult);

      // Act
      await service.reconcileAllTransfers(mockConfiguration);

      // Assert - Should use billing view ARN from model
      expect(mockCURReportService.createReport).toHaveBeenCalledWith(
        expect.objectContaining({
          billingViewArn: mockTransfer.resources.billingView!.arn,
        })
      );
    });

    it('should skip (not fail) when the My View billing view is absent', async () => {
      // Arrange - a transfer with a billing group but no My View billing view.
      // Under the per-view-type model this is a skip, not a failure: the view
      // type simply does not apply to this transfer.
      const mockTransfer = createMockTransferWithResources('123456789012', {
        hasBillingGroup: true,
        hasBillingView: false, // No My View billing view
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      mockS3ValidationService.validateBucket = jest.fn().mockResolvedValue({
        bucketExists: true,
        policyIsValid: true,
      } as S3ValidationResult);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert - not a failure. With no billing view of any type and no CUR,
      // there is nothing to reconcile, so the transfer is filtered out before
      // processing (neither failed nor a per-view skip), and createReport is
      // never called.
      expect(result.myViewReportsFailed).toBe(0);
      expect(result.failedTransfers).toHaveLength(0);
      expect(mockCURReportService.createReport).not.toHaveBeenCalled();
    });

    it('should continue processing remaining transfers on individual failure', async () => {
      // Arrange - Requirements: 3.4
      const mockTransfer1 = createMockTransferWithResources('111111111111', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });
      const mockTransfer2 = createMockTransferWithResources('222222222222', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer1, mockTransfer2]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      mockS3ValidationService.validateBucket = jest.fn().mockResolvedValue({
        bucketExists: true,
        policyIsValid: true,
      } as S3ValidationResult);

      // First call fails, second succeeds
      mockCURReportService.createReport = jest.fn()
        .mockResolvedValueOnce({
          reportName: 'billing-transfer-111111111111-my-view',
          created: false,
          alreadyExisted: false,
          errorMessage: 'Test error',
        } as CURReportCreationResult)
        .mockResolvedValueOnce({
          reportName: 'billing-transfer-222222222222-my-view',
          created: true,
          alreadyExisted: false,
        } as CURReportCreationResult);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert - Both transfers should be processed
      expect(mockCURReportService.createReport).toHaveBeenCalledTimes(2);
      expect(result.myViewReportsCreated).toBe(1);
      expect(result.myViewReportsFailed).toBe(1);
    });

    it('should return empty summary when no transfers found', async () => {
      // Arrange
      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([]),
      });

      mockConfigurationService.hasMyViewConfig = jest.fn().mockReturnValue(true);
      mockConfigurationService.isMyViewEnabled = jest.fn().mockReturnValue(true);
      mockConfigurationService.hasShowbackViewConfig = jest.fn().mockReturnValue(false);
      mockConfigurationService.isShowbackViewEnabled = jest.fn().mockReturnValue(false);

      // Act
      const result = await service.reconcileAllTransfers(mockConfiguration);

      // Assert
      expect(result.totalTransfersProcessed).toBe(0);
      expect(result.myViewReportsCreated).toBe(0);
      expect(result.failedTransfers).toHaveLength(0);
    });
  });
});
