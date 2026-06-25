// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
  OrganizationsClient,
  ListInboundResponsibilityTransfersCommand,
} from '@aws-sdk/client-organizations';

// Mock the Organizations client before importing the service
const orgMock = mockClient(OrganizationsClient);

import {
  listDirectBillingTransfers,
  listIndirectBillingTransfers,
  getBillingTransferForAccount,
} from '../../../lib/lambda/common/services/organizations-service.js';

describe('organizations-service', () => {
  beforeEach(() => {
    orgMock.reset();
  });

  describe('listDirectBillingTransfers', () => {
    it('should return active direct billing transfers', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).resolves({
        ResponsibilityTransfers: [
          {
            Id: 'rt-123',
            Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123',
            Source: { ManagementAccountId: '111111111111' },
            Target: { ManagementAccountId: '123456789012' },
            Status: 'ACCEPTED',
            Type: 'BILLING',
            StartTimestamp: new Date('2024-01-01'),
          },
          {
            Id: 'rt-456',
            Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-456',
            Source: { ManagementAccountId: '222222222222' },
            Target: { ManagementAccountId: '123456789012' },
            // Use a non-ACCEPTED status to test filtering - cast to any to avoid SDK type constraints
            Status: 'TERMINATED' as any,
            Type: 'BILLING',
            StartTimestamp: new Date('2024-01-02'),
          },
        ],
      });

      // Act
      const result = await listDirectBillingTransfers();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rt-123');
      expect(result[0].status).toBe('ACCEPTED');
      expect(result[0].billSourceAccountId).toBe('111111111111');
    });

    it('should handle pagination', async () => {
      // Arrange
      orgMock
        .on(ListInboundResponsibilityTransfersCommand)
        .resolvesOnce({
          ResponsibilityTransfers: [
            {
              Id: 'rt-123',
              Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123',
              Source: { ManagementAccountId: '111111111111' },
              Target: { ManagementAccountId: '123456789012' },
              Status: 'ACCEPTED',
              Type: 'BILLING',
              StartTimestamp: new Date('2024-01-01'),
            },
          ],
          NextToken: 'token-1',
        })
        .resolvesOnce({
          ResponsibilityTransfers: [
            {
              Id: 'rt-456',
              Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-456',
              Source: { ManagementAccountId: '222222222222' },
              Target: { ManagementAccountId: '123456789012' },
              Status: 'ACCEPTED',
              Type: 'BILLING',
              StartTimestamp: new Date('2024-01-02'),
            },
          ],
        });

      // Act
      const result = await listDirectBillingTransfers();

      // Assert
      expect(result).toHaveLength(2);
      expect(orgMock.calls()).toHaveLength(2);
    });

    it('should return empty array when no transfers exist', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).resolves({
        ResponsibilityTransfers: [],
      });

      // Act
      const result = await listDirectBillingTransfers();

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should skip transfers with missing required fields', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).resolves({
        ResponsibilityTransfers: [
          {
            Id: 'rt-123',
            // Missing Arn
            Source: { ManagementAccountId: '111111111111' },
            Target: { ManagementAccountId: '123456789012' },
            Status: 'ACCEPTED',
            Type: 'BILLING',
          },
          {
            Id: 'rt-456',
            Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-456',
            Source: { ManagementAccountId: '222222222222' },
            Target: { ManagementAccountId: '123456789012' },
            Status: 'ACCEPTED',
            Type: 'BILLING',
            StartTimestamp: new Date('2024-01-02'),
          },
        ],
      });

      // Act
      const result = await listDirectBillingTransfers();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rt-456');
    });

    it('should throw error on API failure', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).rejects(
        new Error('Service unavailable')
      );

      // Act & Assert
      await expect(listDirectBillingTransfers()).rejects.toThrow('Service unavailable');
    });
  });

  describe('listIndirectBillingTransfers', () => {
    it('should return indirect transfers for a direct transfer', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).resolves({
        ResponsibilityTransfers: [
          {
            Id: 'rt-indirect-1',
            Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-indirect-1',
            Source: { ManagementAccountId: '333333333333' },
            Target: { ManagementAccountId: '111111111111' },
            Status: 'ACCEPTED',
            Type: 'BILLING',
            StartTimestamp: new Date('2024-01-01'),
          },
        ],
      });

      // Act
      const result = await listIndirectBillingTransfers('rt-123');

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rt-indirect-1');
      
      // Verify the Id parameter was passed
      const calls = orgMock.calls();
      expect(calls[0].args[0].input).toMatchObject({ Id: 'rt-123' });
    });
  });

  describe('getBillingTransferForAccount', () => {
    it('should return transfer for matching account', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).resolves({
        ResponsibilityTransfers: [
          {
            Id: 'rt-123',
            Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123',
            Source: { ManagementAccountId: '111111111111' },
            Target: { ManagementAccountId: '123456789012' },
            Status: 'ACCEPTED',
            Type: 'BILLING',
            StartTimestamp: new Date('2024-01-01'),
          },
        ],
      });

      // Act
      const result = await getBillingTransferForAccount('111111111111');

      // Assert
      expect(result).not.toBeNull();
      expect(result?.id).toBe('rt-123');
      expect(result?.billSourceAccountId).toBe('111111111111');
    });

    it('should return null when no matching account found', async () => {
      // Arrange
      orgMock.on(ListInboundResponsibilityTransfersCommand).resolves({
        ResponsibilityTransfers: [
          {
            Id: 'rt-123',
            Arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123',
            Source: { ManagementAccountId: '111111111111' },
            Target: { ManagementAccountId: '123456789012' },
            Status: 'ACCEPTED',
            Type: 'BILLING',
            StartTimestamp: new Date('2024-01-01'),
          },
        ],
      });

      // Act
      const result = await getBillingTransferForAccount('999999999999');

      // Assert
      expect(result).toBeNull();
    });
  });
});
