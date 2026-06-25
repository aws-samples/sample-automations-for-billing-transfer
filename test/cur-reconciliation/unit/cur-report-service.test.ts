// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Unit tests for CURReportService
 */

import { mockClient } from 'aws-sdk-client-mock';
import {
  CostAndUsageReportServiceClient,
  DescribeReportDefinitionsCommand,
  PutReportDefinitionCommand,
} from '@aws-sdk/client-cost-and-usage-report-service';
import { CURReportService } from '../../../lib/lambda/cur-reconciliation/services/cur-report-service.js';
import { CURReportCreationRequest } from '../../../lib/lambda/common/models/cur-report.js';

const curMock = mockClient(CostAndUsageReportServiceClient);

describe('CURReportService', () => {
  let service: CURReportService;

  beforeEach(() => {
    curMock.reset();
    service = new CURReportService('us-east-1');
  });

  const baseRequest: CURReportCreationRequest = {
    reportName: 'billing-transfer-123456789012-my-view',
    billingViewArn: 'arn:aws:billing::123456789012:billingview/billing-transfer-my-view',
    configuration: {
      timeUnit: 'DAILY',
      format: 'Parquet',
      compression: 'Parquet',
      additionalSchemaElements: ['RESOURCES', 'SPLIT_COST_ALLOCATION_DATA'],
      s3Bucket: 'test-bucket',
      s3Prefix: 'cur-reports',
      s3Region: 'us-east-1',
      refreshClosedReports: true,
      reportVersioning: 'OVERWRITE_REPORT',
    },
  };

  describe('checkReportExists', () => {
    it('should return true when report exists', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [
          { ReportName: 'billing-transfer-123456789012-my-view' },
          { ReportName: 'other-report' },
        ],
      });

      const result = await service.checkReportExists('billing-transfer-123456789012-my-view');
      expect(result).toBe(true);
    });

    it('should return false when report does not exist', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [{ ReportName: 'other-report' }],
      });

      const result = await service.checkReportExists('billing-transfer-123456789012-my-view');
      expect(result).toBe(false);
    });

    it('should return false when no reports exist', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: undefined,
      });

      const result = await service.checkReportExists('billing-transfer-123456789012-my-view');
      expect(result).toBe(false);
    });

    it('should throw error on API failure', async () => {
      curMock.on(DescribeReportDefinitionsCommand).rejects(new Error('API Error'));

      await expect(service.checkReportExists('test-report')).rejects.toThrow('API Error');
    });
  });

  describe('createReport', () => {
    it('should create report successfully when it does not exist', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });
      curMock.on(PutReportDefinitionCommand).resolves({});

      const result = await service.createReport(baseRequest);

      expect(result.created).toBe(true);
      expect(result.alreadyExisted).toBe(false);
      expect(result.reportName).toBe(baseRequest.reportName);
    });

    it('should return alreadyExisted when report exists', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [{ ReportName: baseRequest.reportName }],
      });

      const result = await service.createReport(baseRequest);

      expect(result.created).toBe(false);
      expect(result.alreadyExisted).toBe(true);
      expect(curMock.commandCalls(PutReportDefinitionCommand)).toHaveLength(0);
    });

    it('should exclude SPLIT_COST_ALLOCATION_DATA for showback views', async () => {
      const showbackRequest: CURReportCreationRequest = {
        ...baseRequest,
        reportName: 'billing-transfer-123456789012-showback-view',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/billing-transfer-showback-view',
      };

      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });
      curMock.on(PutReportDefinitionCommand).resolves({});

      await service.createReport(showbackRequest);

      const putCall = curMock.commandCalls(PutReportDefinitionCommand)[0];
      const reportDef = putCall.args[0].input.ReportDefinition;
      expect(reportDef?.AdditionalSchemaElements).not.toContain('SPLIT_COST_ALLOCATION_DATA');
      expect(reportDef?.AdditionalSchemaElements).toContain('RESOURCES');
    });

    it('should include SPLIT_COST_ALLOCATION_DATA for my-view reports', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });
      curMock.on(PutReportDefinitionCommand).resolves({});

      await service.createReport(baseRequest);

      const putCall = curMock.commandCalls(PutReportDefinitionCommand)[0];
      const reportDef = putCall.args[0].input.ReportDefinition;
      expect(reportDef?.AdditionalSchemaElements).toContain('SPLIT_COST_ALLOCATION_DATA');
    });

    it('should apply tags when provided', async () => {
      const requestWithTags: CURReportCreationRequest = {
        ...baseRequest,
        tags: {
          Environment: 'test',
          Project: 'billing-transfer',
        },
      };

      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });
      curMock.on(PutReportDefinitionCommand).resolves({});

      await service.createReport(requestWithTags);

      const putCall = curMock.commandCalls(PutReportDefinitionCommand)[0];
      expect(putCall.args[0].input.Tags).toEqual([
        { Key: 'Environment', Value: 'test' },
        { Key: 'Project', Value: 'billing-transfer' },
      ]);
    });

    it('should return error result on API failure', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });
      curMock.on(PutReportDefinitionCommand).rejects(new Error('CreateReport failed'));

      const result = await service.createReport(baseRequest);

      expect(result.created).toBe(false);
      expect(result.alreadyExisted).toBe(false);
      expect(result.errorMessage).toBe('CreateReport failed');
    });
  });

  describe('validateReportConfiguration', () => {
    it('should return true when billing view ARN matches', async () => {
      const expectedArn = 'arn:aws:billing::123456789012:billingview/test-view';
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [
          {
            ReportName: 'test-report',
            BillingViewArn: expectedArn,
          },
        ],
      });

      const result = await service.validateReportConfiguration('test-report', expectedArn);
      expect(result).toBe(true);
    });

    it('should return false when billing view ARN does not match', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [
          {
            ReportName: 'test-report',
            BillingViewArn: 'arn:aws:billing::123456789012:billingview/different-view',
          },
        ],
      });

      const result = await service.validateReportConfiguration(
        'test-report',
        'arn:aws:billing::123456789012:billingview/expected-view'
      );
      expect(result).toBe(false);
    });

    it('should return false when report does not exist', async () => {
      curMock.on(DescribeReportDefinitionsCommand).resolves({
        ReportDefinitions: [],
      });

      const result = await service.validateReportConfiguration('nonexistent-report', 'some-arn');
      expect(result).toBe(false);
    });

    it('should return false on API error', async () => {
      curMock.on(DescribeReportDefinitionsCommand).rejects(new Error('API Error'));

      const result = await service.validateReportConfiguration('test-report', 'some-arn');
      expect(result).toBe(false);
    });
  });

  describe('generateReportName', () => {
    it('should generate correct name for my-view', () => {
      const result = CURReportService.generateReportName('123456789012', 'my-view');
      expect(result).toBe('billing-transfer-123456789012-my-view');
    });

    it('should generate correct name for showback-view', () => {
      const result = CURReportService.generateReportName('987654321098', 'showback-view');
      expect(result).toBe('billing-transfer-987654321098-showback-view');
    });
  });
});
