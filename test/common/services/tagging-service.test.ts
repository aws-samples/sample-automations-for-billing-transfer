// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BillingconductorClient,
  TagResourceCommand as BillingConductorTagCommand,
  ListTagsForResourceCommand as BillingConductorListTagsCommand,
} from '@aws-sdk/client-billingconductor';
import {
  BillingClient,
  TagResourceCommand as BillingTagCommand,
  ListTagsForResourceCommand as BillingListTagsCommand,
} from '@aws-sdk/client-billing';
import {
  CostAndUsageReportServiceClient,
  TagResourceCommand as CURTagCommand,
  DescribeReportDefinitionsCommand,
} from '@aws-sdk/client-cost-and-usage-report-service';

import {
  getStandardTags,
  getBillingGroupTags,
  getBillingViewTags,
  getCURReportTags,
  tagBillingGroup,
  tagBillingView,
  tagCURReport,
  checkBillingGroupTags,
  checkBillingViewTags,
  ensureBillingGroupTags,
  ensureBillingViewTags,
  ensureCURReportTags,
} from '../../../lib/lambda/common/services/tagging-service.js';

// Create mocks
const billingConductorMock = mockClient(BillingconductorClient);
const billingMock = mockClient(BillingClient);
const curMock = mockClient(CostAndUsageReportServiceClient);

describe('tagging-service', () => {
  beforeEach(() => {
    billingConductorMock.reset();
    billingMock.reset();
    curMock.reset();
  });

  describe('getStandardTags', () => {
    it('should return standard project tags', () => {
      const tags = getStandardTags();

      expect(tags.Project).toBe('SampleAutomationsForBillingTransfer');
      expect(tags.ManagedBy).toBe('BillingTransferAutomation');
      expect(tags.CreatedBy).toBe('billing-transfer-automation');
      expect(tags.Purpose).toBe('BillingTransferManagement');
    });
  });

  describe('getBillingGroupTags', () => {
    it('should return billing group tags with account and transfer info', () => {
      const tags = getBillingGroupTags('123456789012', 'arn:aws:organizations::123:transfer/rt-123');

      expect(tags.Project).toBe('SampleAutomationsForBillingTransfer');
      expect(tags.AccountId).toBe('123456789012');
      expect(tags.TransferArn).toBe('arn:aws:organizations::123:transfer/rt-123');
      expect(tags.ResourceType).toBe('BillingGroup');
    });
  });

  describe('getBillingViewTags', () => {
    it('should return billing view tags for BILLING_TRANSFER type', () => {
      const tags = getBillingViewTags('123456789012', 'BILLING_TRANSFER');

      expect(tags.Project).toBe('SampleAutomationsForBillingTransfer');
      expect(tags.SourceAccountId).toBe('123456789012');
      expect(tags.ViewType).toBe('BILLING_TRANSFER');
      expect(tags.ResourceType).toBe('BillingView');
    });

    it('should return billing view tags for BILLING_TRANSFER_SHOWBACK type', () => {
      const tags = getBillingViewTags('123456789012', 'BILLING_TRANSFER_SHOWBACK');

      expect(tags.ViewType).toBe('BILLING_TRANSFER_SHOWBACK');
    });
  });

  describe('getCURReportTags', () => {
    it('should return CUR report tags', () => {
      const tags = getCURReportTags(
        '123456789012',
        'MY_VIEW',
        'arn:aws:billing::123:billingview/billing-transfer-123'
      );

      expect(tags.Project).toBe('SampleAutomationsForBillingTransfer');
      expect(tags.BillSourceAccountId).toBe('123456789012');
      expect(tags.ViewType).toBe('MY_VIEW');
      expect(tags.BillingViewArn).toBe('arn:aws:billing::123:billingview/billing-transfer-123');
      expect(tags.ResourceType).toBe('CURReport');
      expect(tags.CreationTimestamp).toBeDefined();
    });
  });

  describe('tagBillingGroup', () => {
    it('should successfully tag a billing group', async () => {
      billingConductorMock.on(BillingConductorTagCommand).resolves({});

      const result = await tagBillingGroup('arn:aws:billingconductor::123:billinggroup/bg-123', {
        Project: 'Test',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('tagged');
      expect(result.resourceType).toBe('BillingGroup');
      expect(result.tagsApplied).toBe(1);
    });

    it('should handle tagging failure gracefully', async () => {
      billingConductorMock.on(BillingConductorTagCommand).rejects(new Error('Access denied'));

      const result = await tagBillingGroup('arn:aws:billingconductor::123:billinggroup/bg-123', {
        Project: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toContain('Access denied');
    });
  });

  describe('tagBillingView', () => {
    it('should successfully tag a billing view', async () => {
      billingMock.on(BillingTagCommand).resolves({});

      const result = await tagBillingView('arn:aws:billing::123:billingview/billing-transfer-123', {
        Project: 'Test',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('tagged');
      expect(result.resourceType).toBe('BillingView');
    });

    it('should handle tagging failure gracefully', async () => {
      billingMock.on(BillingTagCommand).rejects(new Error('Access denied'));

      const result = await tagBillingView('arn:aws:billing::123:billingview/billing-transfer-123', {
        Project: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
    });
  });

  describe('tagCURReport', () => {
    const mockReportDefinition = {
      ReportName: 'test-report',
      TimeUnit: 'DAILY' as const,
      Format: 'Parquet' as const,
      Compression: 'Parquet' as const,
      AdditionalSchemaElements: ['RESOURCES' as const],
      S3Bucket: 'test-bucket',
      S3Prefix: 'test-prefix',
      S3Region: 'us-east-1' as const,
    };

    it('should successfully tag a CUR report', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [mockReportDefinition],
      });
      curMock.on(CURTagCommand).resolves({});

      const result = await tagCURReport('test-report', { Project: 'Test' });

      expect(result.success).toBe(true);
      expect(result.action).toBe('tagged');
      expect(result.resourceType).toBe('CURReport');
    });

    it('should fail if report not found', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });

      const result = await tagCURReport('non-existent-report', { Project: 'Test' });

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toContain('not found');
    });
  });

  describe('checkBillingGroupTags', () => {
    it('should return true when project tags exist', async () => {
      billingConductorMock.on(BillingConductorListTagsCommand).resolves({
        Tags: { Project: 'SampleAutomationsForBillingTransfer' },
      });

      const result = await checkBillingGroupTags('arn:aws:billingconductor::123:billinggroup/bg-123');

      expect(result.hasProjectTags).toBe(true);
      expect(result.existingTags.Project).toBe('SampleAutomationsForBillingTransfer');
    });

    it('should return false when project tags do not exist', async () => {
      billingConductorMock.on(BillingConductorListTagsCommand).resolves({
        Tags: { OtherTag: 'value' },
      });

      const result = await checkBillingGroupTags('arn:aws:billingconductor::123:billinggroup/bg-123');

      expect(result.hasProjectTags).toBe(false);
    });
  });

  describe('checkBillingViewTags', () => {
    it('should return true when project tags exist', async () => {
      billingMock.on(BillingListTagsCommand).resolves({
        resourceTags: [{ key: 'Project', value: 'SampleAutomationsForBillingTransfer' }],
      });

      const result = await checkBillingViewTags('arn:aws:billing::123:billingview/billing-transfer-123');

      expect(result.hasProjectTags).toBe(true);
    });

    it('should return false when project tags do not exist', async () => {
      billingMock.on(BillingListTagsCommand).resolves({
        resourceTags: [{ key: 'OtherTag', value: 'value' }],
      });

      const result = await checkBillingViewTags('arn:aws:billing::123:billingview/billing-transfer-123');

      expect(result.hasProjectTags).toBe(false);
    });
  });

  describe('ensureBillingGroupTags', () => {
    it('should skip tagging if already tagged', async () => {
      billingConductorMock.on(BillingConductorListTagsCommand).resolves({
        Tags: { Project: 'SampleAutomationsForBillingTransfer' },
      });

      const result = await ensureBillingGroupTags(
        'arn:aws:billingconductor::123:billinggroup/bg-123',
        '123456789012',
        'arn:aws:organizations::123:transfer/rt-123'
      );

      expect(result.action).toBe('already-tagged');
    });

    it('should tag if not already tagged', async () => {
      billingConductorMock.on(BillingConductorListTagsCommand).resolves({
        Tags: {},
      });
      billingConductorMock.on(BillingConductorTagCommand).resolves({});

      const result = await ensureBillingGroupTags(
        'arn:aws:billingconductor::123:billinggroup/bg-123',
        '123456789012',
        'arn:aws:organizations::123:transfer/rt-123'
      );

      expect(result.action).toBe('tagged');
    });
  });

  describe('ensureBillingViewTags', () => {
    it('should skip tagging if already tagged', async () => {
      billingMock.on(BillingListTagsCommand).resolves({
        resourceTags: [{ key: 'Project', value: 'SampleAutomationsForBillingTransfer' }],
      });

      const result = await ensureBillingViewTags(
        'arn:aws:billing::123:billingview/billing-transfer-123',
        '123456789012',
        'BILLING_TRANSFER'
      );

      expect(result.action).toBe('already-tagged');
    });

    it('should tag if not already tagged', async () => {
      billingMock.on(BillingListTagsCommand).resolves({
        resourceTags: [],
      });
      billingMock.on(BillingTagCommand).resolves({});

      const result = await ensureBillingViewTags(
        'arn:aws:billing::123:billingview/billing-transfer-123',
        '123456789012',
        'BILLING_TRANSFER'
      );

      expect(result.action).toBe('tagged');
    });
  });

  describe('ensureCURReportTags', () => {
    const mockReportDefinition = {
      ReportName: 'test-report',
      TimeUnit: 'DAILY' as const,
      Format: 'Parquet' as const,
      Compression: 'Parquet' as const,
      AdditionalSchemaElements: ['RESOURCES' as const],
      S3Bucket: 'test-bucket',
      S3Prefix: 'test-prefix',
      S3Region: 'us-east-1' as const,
    };

    it('should tag CUR report', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [mockReportDefinition],
      });
      curMock.on(CURTagCommand).resolves({});

      const result = await ensureCURReportTags(
        'test-report',
        '123456789012',
        'MY_VIEW',
        'arn:aws:billing::123:billingview/billing-transfer-123'
      );

      expect(result.action).toBe('tagged');
    });
  });
});
