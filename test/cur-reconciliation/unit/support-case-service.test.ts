// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SupportClient, CreateCaseCommand } from '@aws-sdk/client-support';
import { mockClient } from 'aws-sdk-client-mock';
import { SupportCaseService } from '../../../lib/lambda/cur-reconciliation/services/support-case-service.js';
import { BackfillRequest } from '../../../lib/lambda/cur-reconciliation/models/support-case.js';

const supportMock = mockClient(SupportClient);

describe('SupportCaseService', () => {
  let service: SupportCaseService;

  beforeEach(() => {
    supportMock.reset();
    service = new SupportCaseService(supportMock as unknown as SupportClient);
  });

  describe('createBackfillCase', () => {
    it('should create a support case with correct parameters', async () => {
      const request: BackfillRequest = {
        exportName: 'billing-transfer-123456789012-my-view',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/billing-transfer-uuid',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-12',
        },
        severityCode: 'normal',
      };

      supportMock.on(CreateCaseCommand).resolves({
        caseId: 'case-12345',
      });

      const result = await service.createBackfillCase(request);

      expect(result.created).toBe(true);
      expect(result.caseId).toBe('case-12345');
      expect(result.errorMessage).toBeUndefined();

      // Verify the command was called with correct parameters
      const calls = supportMock.commandCalls(CreateCaseCommand);
      expect(calls).toHaveLength(1);
      
      const commandInput = calls[0].args[0].input;
      expect(commandInput.subject).toBe('Data Export Backfill Request - billing-transfer-123456789012-my-view');
      expect(commandInput.serviceCode).toBe('billing');
      expect(commandInput.categoryCode).toBe('data-exports');
      expect(commandInput.severityCode).toBe('normal');
      expect(commandInput.issueType).toBe('customer-service');
      expect(commandInput.language).toBe('en');
      expect(commandInput.communicationBody).toContain('billing-transfer-123456789012-my-view');
      expect(commandInput.communicationBody).toContain('arn:aws:billing::123456789012:billingview/billing-transfer-uuid');
      expect(commandInput.communicationBody).toContain('2024-01 to 2024-12');
    });

    it('should format subject with export name', async () => {
      const request: BackfillRequest = {
        exportName: 'test-export-name',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-06',
        },
        severityCode: 'high',
      };

      supportMock.on(CreateCaseCommand).resolves({
        caseId: 'case-67890',
      });

      await service.createBackfillCase(request);

      const calls = supportMock.commandCalls(CreateCaseCommand);
      const commandInput = calls[0].args[0].input;
      
      expect(commandInput.subject).toBe('Data Export Backfill Request - test-export-name');
    });

    it('should include all required information in communication body', async () => {
      const request: BackfillRequest = {
        exportName: 'my-export',
        billingViewArn: 'arn:aws:billing::999888777666:billingview/view-id',
        billingPeriodRange: {
          start: '2023-01',
          end: '2023-12',
        },
        severityCode: 'low',
      };

      supportMock.on(CreateCaseCommand).resolves({
        caseId: 'case-abc',
      });

      await service.createBackfillCase(request);

      const calls = supportMock.commandCalls(CreateCaseCommand);
      const body = calls[0].args[0].input.communicationBody;
      
      expect(body).toContain('Export Name: my-export');
      expect(body).toContain('Billing View ARN: arn:aws:billing::999888777666:billingview/view-id');
      expect(body).toContain('Requested Billing Period Range: 2023-01 to 2023-12');
      expect(body).toContain('historical data backfill');
    });

    it('should apply severity code from configuration', async () => {
      const severityCodes: Array<'low' | 'normal' | 'high' | 'urgent' | 'critical'> = [
        'low',
        'normal',
        'high',
        'urgent',
        'critical',
      ];

      for (const severity of severityCodes) {
        supportMock.reset();
        supportMock.on(CreateCaseCommand).resolves({
          caseId: `case-${severity}`,
        });

        const request: BackfillRequest = {
          exportName: 'test-export',
          billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
          billingPeriodRange: {
            start: '2024-01',
            end: '2024-12',
          },
          severityCode: severity,
        };

        await service.createBackfillCase(request);

        const calls = supportMock.commandCalls(CreateCaseCommand);
        expect(calls[0].args[0].input.severityCode).toBe(severity);
      }
    });

    it('should set issue type to customer-service', async () => {
      const request: BackfillRequest = {
        exportName: 'test-export',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-12',
        },
        severityCode: 'normal',
      };

      supportMock.on(CreateCaseCommand).resolves({
        caseId: 'case-123',
      });

      await service.createBackfillCase(request);

      const calls = supportMock.commandCalls(CreateCaseCommand);
      expect(calls[0].args[0].input.issueType).toBe('customer-service');
    });

    it('should use correct service code and category code for Data Exports', async () => {
      const request: BackfillRequest = {
        exportName: 'test-export',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-12',
        },
        severityCode: 'normal',
      };

      supportMock.on(CreateCaseCommand).resolves({
        caseId: 'case-123',
      });

      await service.createBackfillCase(request);

      const calls = supportMock.commandCalls(CreateCaseCommand);
      expect(calls[0].args[0].input.serviceCode).toBe('billing');
      expect(calls[0].args[0].input.categoryCode).toBe('data-exports');
    });

    it('should handle errors gracefully', async () => {
      const request: BackfillRequest = {
        exportName: 'test-export',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-12',
        },
        severityCode: 'normal',
      };

      supportMock.on(CreateCaseCommand).rejects(new Error('Support API unavailable'));

      const result = await service.createBackfillCase(request);

      expect(result.created).toBe(false);
      expect(result.caseId).toBeUndefined();
      expect(result.errorMessage).toBe('Support API unavailable');
    });

    it('should handle non-Error exceptions', async () => {
      const request: BackfillRequest = {
        exportName: 'test-export',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-12',
        },
        severityCode: 'normal',
      };

      supportMock.on(CreateCaseCommand).rejects('String error');

      const result = await service.createBackfillCase(request);

      expect(result.created).toBe(false);
      expect(result.errorMessage).toBe('String error');
    });

    it('should return case ID when successfully created', async () => {
      const request: BackfillRequest = {
        exportName: 'test-export',
        billingViewArn: 'arn:aws:billing::123456789012:billingview/test',
        billingPeriodRange: {
          start: '2024-01',
          end: '2024-12',
        },
        severityCode: 'normal',
      };

      const expectedCaseId = 'case-xyz-123';
      supportMock.on(CreateCaseCommand).resolves({
        caseId: expectedCaseId,
      });

      const result = await service.createBackfillCase(request);

      expect(result.created).toBe(true);
      expect(result.caseId).toBe(expectedCaseId);
    });
  });
});
