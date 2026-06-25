// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Integration tests for CUR Reconciliation Service
 * 
 * These tests verify the full reconciliation workflow with mock AWS services.
 * They test various configuration scenarios and error handling.
 * 
 * Note: These tests use mocked AWS SDK clients and do not make actual AWS API calls.
 * 
 * Updated to use TransferAnalysisService instead of BillingTransferService and
 * BillingGroupValidationService per the reconciliation-refactor spec.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 5.2, 8.2, 8.3, 8.4
 */

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import type { ReconciliationService as ReconciliationServiceType } from '../../../lib/lambda/cur-reconciliation/services/reconciliation-service.js';
import type { CURReportService } from '../../../lib/lambda/cur-reconciliation/services/cur-report-service.js';
import type { S3ValidationService } from '../../../lib/lambda/cur-reconciliation/services/s3-validation-service.js';
import type { SupportCaseService } from '../../../lib/lambda/cur-reconciliation/services/support-case-service.js';
import { ReportConfigurationTemplate } from '../../../lib/lambda/common/models/cur-configuration.js';
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

let ReconciliationService: typeof ReconciliationServiceType;
let analyzeTransfers: typeof TransferAnalysisServiceType.analyzeTransfers;

beforeAll(async () => {
  ({ ReconciliationService } = await import('../../../lib/lambda/cur-reconciliation/services/reconciliation-service.js'));
  ({ analyzeTransfers } = await import('../../../lib/lambda/common/services/transfer-analysis-service.js'));
});

describe('CUR Reconciliation Integration Tests', () => {
  let reconciliationService: ReconciliationServiceType;
  let mockCURReportService: jest.Mocked<CURReportService>;
  let mockS3ValidationService: jest.Mocked<S3ValidationService>;
  let mockSupportCaseService: jest.Mocked<SupportCaseService>;
  let mockAnalyzeTransfers: jest.MockedFunction<typeof analyzeTransfers>;

  // Helper to create a mock transfer with resources
  const createMockTransferWithResources = (
    accountId: string,
    options: {
      hasBillingGroup?: boolean;
      hasBillingView?: boolean;
      hasCURConfiguration?: boolean;
      billingViewType?: 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK';
    } = {}
  ): BillingTransferWithResourcesModel => {
    const { 
      hasBillingGroup = true, 
      hasBillingView = true, 
      hasCURConfiguration = false,
      billingViewType = 'BILLING_TRANSFER'
    } = options;

    const view = hasBillingView ? {
      arn: `arn:aws:billing::123456789012:billingview/${billingViewType.toLowerCase()}-${accountId}`,
      name: `${billingViewType} View`,
      billingViewType,
      ownerAccountId: '123456789012',
      sourceAccountId: accountId,
    } : null;
    // Route the view to the field matching its type. The resources model now
    // carries My View and Showback views separately.
    const isShowback = billingViewType === 'BILLING_TRANSFER_SHOWBACK';
    const myView = isShowback ? null : view;
    const showbackView = isShowback ? view : null;

    const curConfig = hasCURConfiguration ? {
      reportName: `billing-transfer-${accountId}-${isShowback ? 'showback-view' : 'my-view'}`,
      s3Bucket: 'test-bucket',
      s3Region: 'us-east-1',
      timeUnit: 'DAILY' as const,
      format: 'Parquet' as const,
      compression: 'Parquet' as const,
      additionalSchemaElements: ['RESOURCES'],
      additionalArtifacts: [],
      refreshClosedReports: true,
      reportVersioning: 'OVERWRITE_REPORT' as const,
    } : null;

    return {
      transfer: {
        id: `rt-${accountId}`,
        arn: `arn:aws:organizations::123456789012:responsibility-transfer/rt-${accountId}`,
        name: `Test Transfer ${accountId}`,
        billSourceAccountId: accountId,
        billTransferAccountId: '123456789012',
        status: 'ACCEPTED',
        type: 'BILLING',
        startTimestamp: Date.now(),
        transferType: 'direct',
      },
      resources: {
        billingView: myView,
        showbackBillingView: showbackView,
        billingGroup: hasBillingGroup ? {
          arn: `arn:aws:billingconductor::123456789012:billinggroup/bg-${accountId}`,
          name: `billing-group-${accountId}`,
          primaryAccountId: accountId,
          pricingPlanArn: 'arn:aws:billingconductor::123456789012:pricingplan/basic',
        } : null,
        pricingPlan: hasBillingGroup ? {
          arn: 'arn:aws:billingconductor::123456789012:pricingplan/basic',
          name: 'BasicPricingPlan',
        } : null,
        curConfiguration: isShowback ? null : curConfig,
        showbackCurConfiguration: isShowback ? curConfig : null,
      },
      resourcesFound: {
        billingView: myView !== null,
        showbackBillingView: showbackView !== null,
        billingGroup: hasBillingGroup,
        pricingPlan: hasBillingGroup,
        curConfiguration: (!isShowback && hasCURConfiguration),
        showbackCurConfiguration: (isShowback && hasCURConfiguration),
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

    mockCURReportService = {
      checkReportExists: jest.fn(),
      createReport: jest.fn(),
      validateReportConfiguration: jest.fn(),
    } as any;

    mockS3ValidationService = {
      validateBucket: jest.fn(),
    } as any;

    mockSupportCaseService = {
      createBackfillCase: jest.fn(),
    } as any;

    mockAnalyzeTransfers = analyzeTransfers as jest.MockedFunction<typeof analyzeTransfers>;

    // Create reconciliation service with mocked dependencies
    reconciliationService = new ReconciliationService(
      mockCURReportService,
      mockS3ValidationService,
      mockSupportCaseService
    );
  });

  describe('Full Reconciliation Workflow', () => {
    it('should successfully reconcile with My View only configuration', async () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: {
          enabled: true,
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: ['RESOURCES'],
          s3Bucket: 'test-bucket',
          s3Prefix: 'my-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        },
      };

      const mockTransfer = createMockTransferWithResources('111111111111', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockS3ValidationService.validateBucket.mockResolvedValue({
        bucketExists: true,
        hasBucketPolicy: true,
        policyIsValid: true,
      });

      mockCURReportService.createReport.mockResolvedValue({
        reportName: 'billing-transfer-111111111111-my-view',
        created: true,
        alreadyExisted: false,
      });

      const summary = await reconciliationService.reconcileAllTransfers(config);

      expect(summary.totalTransfersProcessed).toBe(1);
      expect(summary.myViewReportsCreated).toBe(1);
      expect(summary.myViewReportsAlreadyExisted).toBe(0);
      expect(summary.myViewReportsFailed).toBe(0);
      expect(summary.showbackViewReportsCreated).toBe(0);
      expect(summary.failedTransfers).toHaveLength(0);
    });

    it('should successfully reconcile with Showback View only configuration', async () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        showbackViewReportConfig: {
          enabled: true,
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: [],
          s3Bucket: 'test-bucket',
          s3Prefix: 'showback-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        },
      };

      const mockTransfer = createMockTransferWithResources('222222222222', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
        billingViewType: 'BILLING_TRANSFER_SHOWBACK',
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockS3ValidationService.validateBucket.mockResolvedValue({
        bucketExists: true,
        hasBucketPolicy: true,
        policyIsValid: true,
      });

      mockCURReportService.createReport.mockResolvedValue({
        reportName: 'billing-transfer-222222222222-showback-view',
        created: true,
        alreadyExisted: false,
      });

      const summary = await reconciliationService.reconcileAllTransfers(config);

      expect(summary.totalTransfersProcessed).toBe(1);
      expect(summary.myViewReportsCreated).toBe(0);
      expect(summary.showbackViewReportsCreated).toBe(1);
      expect(summary.showbackViewReportsAlreadyExisted).toBe(0);
      expect(summary.showbackViewReportsFailed).toBe(0);
      expect(summary.failedTransfers).toHaveLength(0);
    });

    it('should handle configuration with one view disabled', async () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: {
          enabled: true,
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: ['RESOURCES'],
          s3Bucket: 'test-bucket',
          s3Prefix: 'my-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        },
        showbackViewReportConfig: {
          enabled: false, // Disabled
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: [],
          s3Bucket: 'test-bucket',
          s3Prefix: 'showback-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        },
      };

      const mockTransfer = createMockTransferWithResources('444444444444', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockS3ValidationService.validateBucket.mockResolvedValue({
        bucketExists: true,
        hasBucketPolicy: true,
        policyIsValid: true,
      });

      mockCURReportService.createReport.mockResolvedValue({
        reportName: 'billing-transfer-444444444444-my-view',
        created: true,
        alreadyExisted: false,
      });

      const summary = await reconciliationService.reconcileAllTransfers(config);

      expect(summary.totalTransfersProcessed).toBe(1);
      expect(summary.myViewReportsCreated).toBe(1);
      expect(summary.showbackViewReportsCreated).toBe(0); // Disabled
      expect(summary.failedTransfers).toHaveLength(0);
    });
  });

  describe('Idempotency Testing', () => {
    it('should skip report creation when report already exists', async () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: {
          enabled: true,
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: ['RESOURCES'],
          s3Bucket: 'test-bucket',
          s3Prefix: 'my-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        },
      };

      const mockTransfer = createMockTransferWithResources('555555555555', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockS3ValidationService.validateBucket.mockResolvedValue({
        bucketExists: true,
        hasBucketPolicy: true,
        policyIsValid: true,
      });

      // Report already exists
      mockCURReportService.createReport.mockResolvedValue({
        reportName: 'billing-transfer-555555555555-my-view',
        created: false,
        alreadyExisted: true,
      });

      const summary = await reconciliationService.reconcileAllTransfers(config);

      expect(summary.totalTransfersProcessed).toBe(1);
      expect(summary.myViewReportsCreated).toBe(0);
      expect(summary.myViewReportsAlreadyExisted).toBe(1);
      expect(summary.myViewReportsFailed).toBe(0);
      expect(summary.failedTransfers).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should continue processing when one transfer fails', async () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: {
          enabled: true,
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: ['RESOURCES'],
          s3Bucket: 'test-bucket',
          s3Prefix: 'my-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
        },
      };

      // First transfer succeeds, second fails (missing billing group)
      const successTransfer = createMockTransferWithResources('666666666666', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });
      const failTransfer = createMockTransferWithResources('777777777777', {
        hasBillingGroup: false, // Missing billing group
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([successTransfer, failTransfer]),
      });

      mockS3ValidationService.validateBucket.mockResolvedValue({
        bucketExists: true,
        hasBucketPolicy: true,
        policyIsValid: true,
      });

      mockCURReportService.createReport.mockResolvedValue({
        reportName: 'billing-transfer-666666666666-my-view',
        created: true,
        alreadyExisted: false,
      });

      const summary = await reconciliationService.reconcileAllTransfers(config);

      // Both transfers processed, but only one needs CUR (the one with billing group)
      expect(summary.totalTransfersProcessed).toBe(2);
      expect(summary.myViewReportsCreated).toBe(1);
      // The transfer missing billing group is filtered out before processing
      expect(mockCURReportService.createReport).toHaveBeenCalledTimes(1);
    });
  });

  describe('Support Case Integration', () => {
    it('should create support case when backfill is enabled for My View', async () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: {
          enabled: true,
          timeUnit: 'DAILY',
          format: 'Parquet',
          compression: 'Parquet',
          additionalSchemaElements: ['RESOURCES'],
          s3Bucket: 'test-bucket',
          s3Prefix: 'my-view',
          s3Region: 'us-east-1',
          refreshClosedReports: true,
          reportVersioning: 'OVERWRITE_REPORT',
          backfill: {
            enabled: true,
            billingPeriodRange: {
              start: '2024-01',
              end: '2024-12',
            },
            severityCode: 'normal',
          },
        },
      };

      const mockTransfer = createMockTransferWithResources('888888888888', {
        hasBillingGroup: true,
        hasBillingView: true,
        hasCURConfiguration: false,
      });

      mockAnalyzeTransfers.mockResolvedValue({
        summary: createMockAnalysisSummary([mockTransfer]),
      });

      mockS3ValidationService.validateBucket.mockResolvedValue({
        bucketExists: true,
        hasBucketPolicy: true,
        policyIsValid: true,
      });

      mockCURReportService.createReport.mockResolvedValue({
        reportName: 'billing-transfer-888888888888-my-view',
        created: true,
        alreadyExisted: false,
      });

      mockSupportCaseService.createBackfillCase.mockResolvedValue({
        caseId: 'case-123',
        created: true,
      });

      const summary = await reconciliationService.reconcileAllTransfers(config);

      expect(summary.totalTransfersProcessed).toBe(1);
      expect(summary.myViewReportsCreated).toBe(1);
      expect(summary.supportCasesCreated).toBe(1);
      expect(mockSupportCaseService.createBackfillCase).toHaveBeenCalledTimes(1);
    });
  });
});
