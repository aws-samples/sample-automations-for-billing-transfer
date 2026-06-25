// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
import {
  BillingTransfer,
  filterActiveTransfers,
} from '../../../lib/lambda/common/models/billing-transfer.js';

describe('billing-transfer model', () => {
  describe('filterActiveTransfers', () => {
    it('should return only ACCEPTED BILLING transfers', () => {
      // Arrange
      const transfers: BillingTransfer[] = [
        {
          id: 'rt-1',
          arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-1',
          name: 'Transfer 1',
          billSourceAccountId: '111111111111',
          billTransferAccountId: '123456789012',
          status: 'ACCEPTED',
          type: 'BILLING',
          startTimestamp: Date.now(),
        },
        {
          id: 'rt-2',
          arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-2',
          name: 'Transfer 2',
          billSourceAccountId: '222222222222',
          billTransferAccountId: '123456789012',
          status: 'PENDING',
          type: 'BILLING',
          startTimestamp: Date.now(),
        },
        {
          id: 'rt-3',
          arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-3',
          name: 'Transfer 3',
          billSourceAccountId: '333333333333',
          billTransferAccountId: '123456789012',
          status: 'TERMINATED',
          type: 'BILLING',
          startTimestamp: Date.now(),
          endTimestamp: Date.now(),
        },
      ];

      // Act
      const result = filterActiveTransfers(transfers);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rt-1');
      expect(result[0].status).toBe('ACCEPTED');
    });

    it('should return empty array when no active transfers', () => {
      // Arrange
      const transfers: BillingTransfer[] = [
        {
          id: 'rt-1',
          arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-1',
          name: 'Transfer 1',
          billSourceAccountId: '111111111111',
          billTransferAccountId: '123456789012',
          status: 'PENDING',
          type: 'BILLING',
          startTimestamp: Date.now(),
        },
      ];

      // Act
      const result = filterActiveTransfers(transfers);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should return empty array for empty input', () => {
      // Act
      const result = filterActiveTransfers([]);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should return all transfers when all are active', () => {
      // Arrange
      const transfers: BillingTransfer[] = [
        {
          id: 'rt-1',
          arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-1',
          name: 'Transfer 1',
          billSourceAccountId: '111111111111',
          billTransferAccountId: '123456789012',
          status: 'ACCEPTED',
          type: 'BILLING',
          startTimestamp: Date.now(),
        },
        {
          id: 'rt-2',
          arn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-2',
          name: 'Transfer 2',
          billSourceAccountId: '222222222222',
          billTransferAccountId: '123456789012',
          status: 'ACCEPTED',
          type: 'BILLING',
          startTimestamp: Date.now(),
        },
      ];

      // Act
      const result = filterActiveTransfers(transfers);

      // Assert
      expect(result).toHaveLength(2);
    });
  });
});
