// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Unit tests for ValidationService
 */

import {
  validateTransferConsistency,
  identifyMissingResources,
  identifyOrphanedResources,
  detectMissingBillingViews,
  detectMissingBillingGroups,
  detectMissingCURConfigurations,
  detectOrphanedBillingViews,
  detectOrphanedBillingGroups,
} from '../../../lib/lambda/common/services/validation-service.js';
import { BillingTransferWithResourcesModel } from '../../../lib/lambda/common/models/billing-transfer-resources.js';
import { AllBillingTransferResources } from '../../../lib/lambda/common/models/all-billing-transfer-resources.js';
import { BillingView } from '../../../lib/lambda/common/models/billing-view.js';

describe('ValidationService', () => {
  // Helper to create a mock transfer with resources
  const createMockTransfer = (
    id: string,
    options: {
      hasBillingView?: boolean;
      hasBillingGroup?: boolean;
      hasCurConfiguration?: boolean;
      sourceAccountId?: string;
      transferArn?: string;
    } = {}
  ): BillingTransferWithResourcesModel => {
    const {
      hasBillingView = true,
      hasBillingGroup = true,
      hasCurConfiguration = true,
      sourceAccountId = '123456789012',
      transferArn = `arn:aws:organizations::111111111111:transfer/${id}`,
    } = options;

    return {
      transfer: {
        id,
        arn: transferArn,
        billSourceAccountId: sourceAccountId,
        billTransferAccountId: '111111111111',
        relationshipState: 'ACCEPTED',
        transferType: 'direct',
      },
      resources: {
        billingView: hasBillingView
          ? { arn: `arn:aws:billing::${sourceAccountId}:billingview/view-${id}`, name: `view-${id}`, billingViewType: 'BILLING_TRANSFER' }
          : null,
        billingGroup: hasBillingGroup
          ? { arn: `arn:aws:billingconductor::111111111111:billinggroup/group-${id}`, name: `group-${id}`, responsibilityTransferArn: transferArn, primaryAccountId: '111111111111', pricingPlanArn: 'arn:aws:billingconductor::111111111111:pricingplan/BasicPricingPlan' }
          : null,
        pricingPlan: hasBillingGroup
          ? { arn: 'arn:aws:billingconductor::111111111111:pricingplan/BasicPricingPlan', name: 'BasicPricingPlan' }
          : null,
        curConfiguration: hasCurConfiguration
          ? { reportName: `report-${id}`, s3Bucket: 'test-bucket', s3Region: 'us-east-1', timeUnit: 'DAILY', format: 'Parquet', compression: 'Parquet', additionalSchemaElements: [], additionalArtifacts: [], refreshClosedReports: true, reportVersioning: 'OVERWRITE_REPORT' } as any
          : null,
      },
      retrievalTimestamp: Date.now(),
      resourcesFound: {
        billingView: hasBillingView,
        billingGroup: hasBillingGroup,
        pricingPlan: hasBillingGroup,
        curConfiguration: hasCurConfiguration,
      },
    };
  };

  describe('detectMissingBillingViews', () => {
    it('should return empty array when all transfers have billing views', () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingView: true }),
        createMockTransfer('t2', { hasBillingView: true }),
      ];

      const result = detectMissingBillingViews(transfers);
      expect(result).toHaveLength(0);
    });

    it('should return transfers missing billing views', () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingView: true }),
        createMockTransfer('t2', { hasBillingView: false }),
        createMockTransfer('t3', { hasBillingView: false }),
      ];

      const result = detectMissingBillingViews(transfers);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.transfer.id)).toEqual(['t2', 't3']);
    });
  });

  describe('detectMissingBillingGroups', () => {
    it('should return empty array when all transfers have billing groups', () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingGroup: true }),
        createMockTransfer('t2', { hasBillingGroup: true }),
      ];

      const result = detectMissingBillingGroups(transfers);
      expect(result).toHaveLength(0);
    });

    it('should return transfers missing billing groups (only those with billing views)', () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingView: true, hasBillingGroup: true }),
        createMockTransfer('t2', { hasBillingView: true, hasBillingGroup: false }),
        createMockTransfer('t3', { hasBillingView: false, hasBillingGroup: false }), // Should not be included
      ];

      const result = detectMissingBillingGroups(transfers);
      expect(result).toHaveLength(1);
      expect(result[0].transfer.id).toBe('t2');
    });
  });

  describe('detectMissingCURConfigurations', () => {
    it('should return empty array when all transfers have CUR configurations', () => {
      const transfers = [
        createMockTransfer('t1', { hasCurConfiguration: true }),
        createMockTransfer('t2', { hasCurConfiguration: true }),
      ];

      const result = detectMissingCURConfigurations(transfers);
      expect(result).toHaveLength(0);
    });

    it('should return transfers missing CUR configurations (only those with billing groups)', () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingGroup: true, hasCurConfiguration: true }),
        createMockTransfer('t2', { hasBillingGroup: true, hasCurConfiguration: false }),
        createMockTransfer('t3', { hasBillingGroup: false, hasCurConfiguration: false }), // Should not be included
      ];

      const result = detectMissingCURConfigurations(transfers);
      expect(result).toHaveLength(1);
      expect(result[0].transfer.id).toBe('t2');
    });
  });

  describe('detectOrphanedBillingViews', () => {
    it('should return empty array when no orphaned views', () => {
      const transfers = [
        createMockTransfer('t1', { sourceAccountId: '111111111111' }),
        createMockTransfer('t2', { sourceAccountId: '222222222222' }),
      ];

      const allViews: BillingView[] = [
        { arn: 'arn:aws:billing::111111111111:billingview/v1', name: 'v1', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '111111111111' },
        { arn: 'arn:aws:billing::222222222222:billingview/v2', name: 'v2', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '222222222222' },
      ];

      const result = detectOrphanedBillingViews(transfers, allViews);
      expect(result).toHaveLength(0);
    });

    it('should return orphaned billing views', () => {
      const transfers = [
        createMockTransfer('t1', { sourceAccountId: '111111111111' }),
      ];

      const allViews: BillingView[] = [
        { arn: 'arn:aws:billing::111111111111:billingview/v1', name: 'v1', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '111111111111' },
        { arn: 'arn:aws:billing::999999999999:billingview/v2', name: 'v2', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '999999999999' }, // Orphaned
      ];

      const result = detectOrphanedBillingViews(transfers, allViews);
      expect(result).toHaveLength(1);
      expect(result[0].sourceAccountId).toBe('999999999999');
    });

    it('should ignore non-BILLING_TRANSFER views', () => {
      const transfers: BillingTransferWithResourcesModel[] = [];

      const allViews: BillingView[] = [
        { arn: 'arn:aws:billing::111111111111:billingview/v1', name: 'v1', billingViewType: 'PRIMARY', sourceAccountId: '111111111111' },
      ];

      const result = detectOrphanedBillingViews(transfers, allViews);
      expect(result).toHaveLength(0);
    });
  });

  describe('detectOrphanedBillingGroups', () => {
    it('should return empty array when no orphaned groups', () => {
      const transferArn = 'arn:aws:organizations::111111111111:transfer/t1';
      const transfers = [
        createMockTransfer('t1', { transferArn }),
      ];

      const allGroups = [
        { arn: 'arn:aws:billingconductor::111111111111:billinggroup/g1', name: 'g1', responsibilityTransferArn: transferArn },
      ];

      const result = detectOrphanedBillingGroups(transfers, allGroups);
      expect(result).toHaveLength(0);
    });

    it('should return orphaned billing groups', () => {
      const transfers = [
        createMockTransfer('t1', { transferArn: 'arn:aws:organizations::111111111111:transfer/t1' }),
      ];

      const allGroups = [
        { arn: 'arn:aws:billingconductor::111111111111:billinggroup/g1', name: 'g1', responsibilityTransferArn: 'arn:aws:organizations::111111111111:transfer/t1' },
        { arn: 'arn:aws:billingconductor::111111111111:billinggroup/g2', name: 'g2', responsibilityTransferArn: 'arn:aws:organizations::111111111111:transfer/orphaned' }, // Orphaned
      ];

      const result = detectOrphanedBillingGroups(transfers, allGroups);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('g2');
    });

    it('should ignore groups without responsibilityTransferArn', () => {
      const transfers: BillingTransferWithResourcesModel[] = [];

      const allGroups = [
        { arn: 'arn:aws:billingconductor::111111111111:billinggroup/g1', name: 'g1' }, // No responsibilityTransferArn
      ];

      const result = detectOrphanedBillingGroups(transfers, allGroups);
      expect(result).toHaveLength(0);
    });
  });

  describe('identifyOrphanedResources', () => {
    it('should identify both orphaned views and groups', () => {
      const transfers = [
        createMockTransfer('t1', { 
          sourceAccountId: '111111111111',
          transferArn: 'arn:aws:organizations::111111111111:transfer/t1'
        }),
      ];

      const allResources: AllBillingTransferResources = {
        billingViews: [
          { arn: 'arn:aws:billing::111111111111:billingview/v1', name: 'v1', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '111111111111' },
          { arn: 'arn:aws:billing::999999999999:billingview/v2', name: 'v2', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '999999999999' },
        ],
        billingGroups: [
          { arn: 'arn:aws:billingconductor::111111111111:billinggroup/g1', name: 'g1', responsibilityTransferArn: 'arn:aws:organizations::111111111111:transfer/t1' },
          { arn: 'arn:aws:billingconductor::111111111111:billinggroup/g2', name: 'g2', responsibilityTransferArn: 'arn:aws:organizations::111111111111:transfer/orphaned' },
        ],
        pricingPlans: [],
        curConfigurations: [],
      };

      const result = identifyOrphanedResources(transfers, allResources);
      expect(result.billingViews).toHaveLength(1);
      expect(result.billingGroups).toHaveLength(1);
    });
  });

  describe('identifyMissingResources', () => {
    it('should return summary of missing resources', async () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingView: true, hasBillingGroup: true, hasCurConfiguration: true }),
        createMockTransfer('t2', { hasBillingView: true, hasBillingGroup: false, hasCurConfiguration: false }),
        createMockTransfer('t3', { hasBillingView: false, hasBillingGroup: false, hasCurConfiguration: false }),
      ];

      const result = await identifyMissingResources(transfers);

      expect(result.totalTransfers).toBe(3);
      expect(result.missingBillingViews).toBe(1);
      expect(result.missingBillingGroups).toBe(1);
    });
  });

  describe('validateTransferConsistency', () => {
    it('should return empty result for no transfers', async () => {
      const result = await validateTransferConsistency([]);

      expect(result.isValid).toBe(true);
      expect(result.totalIssues).toBe(0);
    });

    it('should validate transfers and identify issues', async () => {
      const transfers = [
        createMockTransfer('t1', { hasBillingView: true, hasBillingGroup: true, hasCurConfiguration: true }),
        createMockTransfer('t2', { hasBillingView: true, hasBillingGroup: false, hasCurConfiguration: false }),
      ];

      const result = await validateTransferConsistency(transfers);

      expect(result.missingResources.billingGroups).toHaveLength(1);
      expect(result.issuesByType.missingBillingGroups).toBe(1);
    });

    it('should include orphaned resources when allResources provided', async () => {
      const transfers = [
        createMockTransfer('t1', { 
          sourceAccountId: '111111111111',
          transferArn: 'arn:aws:organizations::111111111111:transfer/t1'
        }),
      ];

      const allResources: AllBillingTransferResources = {
        billingViews: [
          { arn: 'arn:aws:billing::999999999999:billingview/v2', name: 'v2', billingViewType: 'BILLING_TRANSFER', sourceAccountId: '999999999999' },
        ],
        billingGroups: [],
        pricingPlans: [],
        curConfigurations: [],
      };

      const result = await validateTransferConsistency(transfers, allResources);

      expect(result.orphanedResources.billingViews).toHaveLength(1);
    });

    it('should accept custom relationship state option', async () => {
      const transfers = [createMockTransfer('t1')];

      const result = await validateTransferConsistency(transfers, undefined, {
        relationshipState: 'TERMINATED',
      });

      expect(result.relationshipState).toBe('TERMINATED');
    });
  });
});
