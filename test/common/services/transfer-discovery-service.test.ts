// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit tests for TransferDiscoveryService
 */

import type * as TransferDiscoveryServiceType from '../../../lib/lambda/common/services/transfer-discovery-service.js';
import type * as OrganizationsServiceType from '../../../lib/lambda/common/services/organizations-service.js';

jest.unstable_mockModule(
  '../../../lib/lambda/common/services/organizations-service.js',
  () => ({
    __esModule: true,
    listDirectBillingTransfers: jest.fn(),
    listIndirectBillingTransfers: jest.fn(),
    getBillingTransferForAccount: jest.fn(),
  })
);

let findDirectTransfers: typeof TransferDiscoveryServiceType.findDirectTransfers;
let findIndirectTransfers: typeof TransferDiscoveryServiceType.findIndirectTransfers;
let findAllTransfers: typeof TransferDiscoveryServiceType.findAllTransfers;
let mockOrganizationsService: jest.Mocked<typeof OrganizationsServiceType>;

beforeAll(async () => {
  ({ findDirectTransfers, findIndirectTransfers, findAllTransfers } = await import(
    '../../../lib/lambda/common/services/transfer-discovery-service.js'
  ));
  mockOrganizationsService = (await import(
    '../../../lib/lambda/common/services/organizations-service.js'
  )) as unknown as jest.Mocked<typeof OrganizationsServiceType>;
});

describe('TransferDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockDirectTransfer = {
    id: 'direct-1',
    arn: 'arn:aws:organizations::111111111111:transfer/direct-1',
    billSourceAccountId: '222222222222',
    billTransferAccountId: '111111111111',
    relationshipState: 'ACCEPTED' as const,
  };

  const mockIndirectTransfer = {
    id: 'indirect-1',
    arn: 'arn:aws:organizations::111111111111:transfer/indirect-1',
    billSourceAccountId: '333333333333',
    billTransferAccountId: '222222222222',
    relationshipState: 'ACCEPTED' as const,
  };

  describe('findDirectTransfers', () => {
    it('should return direct transfers', async () => {
      mockOrganizationsService.listDirectBillingTransfers.mockResolvedValue([mockDirectTransfer]);

      const result = await findDirectTransfers();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('direct-1');
      expect(result[0].transferType).toBe('direct');
    });


    it('should pass relationship state to organizations service', async () => {
      mockOrganizationsService.listDirectBillingTransfers.mockResolvedValue([]);

      await findDirectTransfers({ relationshipState: 'TERMINATED' });

      expect(mockOrganizationsService.listDirectBillingTransfers).toHaveBeenCalledWith({
        relationshipState: 'TERMINATED',
      });
    });

    it('should throw error when API fails', async () => {
      mockOrganizationsService.listDirectBillingTransfers.mockRejectedValue(new Error('API Error'));

      await expect(findDirectTransfers()).rejects.toThrow('API Error');
    });
  });

  describe('findIndirectTransfers', () => {
    it('should return indirect transfers with parent reference', async () => {
      mockOrganizationsService.listIndirectBillingTransfers.mockResolvedValue([mockIndirectTransfer]);

      const result = await findIndirectTransfers('direct-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('indirect-1');
      expect(result[0].transferType).toBe('indirect');
      expect(result[0].parentTransferId).toBe('direct-1');
    });

    it('should return empty array on error (graceful handling)', async () => {
      mockOrganizationsService.listIndirectBillingTransfers.mockRejectedValue(new Error('API Error'));

      const result = await findIndirectTransfers('direct-1');

      expect(result).toHaveLength(0);
    });
  });

  describe('findAllTransfers', () => {
    it('should return both direct and indirect transfers', async () => {
      mockOrganizationsService.listDirectBillingTransfers.mockResolvedValue([mockDirectTransfer]);
      mockOrganizationsService.listIndirectBillingTransfers.mockResolvedValue([mockIndirectTransfer]);

      const result = await findAllTransfers();

      expect(result.transfers).toHaveLength(2);
      expect(result.directCount).toBe(1);
      expect(result.indirectCount).toBe(1);
      expect(result.relationshipState).toBe('ACCEPTED');
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle no transfers', async () => {
      mockOrganizationsService.listDirectBillingTransfers.mockResolvedValue([]);

      const result = await findAllTransfers();

      expect(result.transfers).toHaveLength(0);
      expect(result.directCount).toBe(0);
      expect(result.indirectCount).toBe(0);
    });

    it('should throw error when direct transfer discovery fails', async () => {
      mockOrganizationsService.listDirectBillingTransfers.mockRejectedValue(new Error('API Error'));

      await expect(findAllTransfers()).rejects.toThrow('API Error');
    });
  });
});
