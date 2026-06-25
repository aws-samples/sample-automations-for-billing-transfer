// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BillingClient,
  ListBillingViewsCommand,
  GetBillingViewCommand,
} from '@aws-sdk/client-billing';

// Mock the Billing client before importing the service
const billingMock = mockClient(BillingClient);

import {
  listBillingViews,
  getBillingView,
  findBillingViewForTransfer,
} from '../../../lib/lambda/common/services/billing-service.js';

describe('billing-service', () => {
  beforeEach(() => {
    billingMock.reset();
  });

  describe('listBillingViews', () => {
    it('should return billing views filtered by type', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).resolves({
        billingViews: [
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-111',
            name: 'Transfer View 1',
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
            sourceAccountId: '111111111111',
          },
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-222',
            name: 'Transfer View 2',
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
            sourceAccountId: '222222222222',
          },
        ],
      });

      // Act
      const result = await listBillingViews(['BILLING_TRANSFER']);

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0].billingViewType).toBe('BILLING_TRANSFER');
      expect(result[1].billingViewType).toBe('BILLING_TRANSFER');
    });

    it('should handle pagination', async () => {
      // Arrange
      billingMock
        .on(ListBillingViewsCommand)
        .resolvesOnce({
          billingViews: [
            {
              arn: 'arn:aws:billing::123456789012:billingview/bt-111',
              name: 'Transfer View 1',
              billingViewType: 'BILLING_TRANSFER',
              ownerAccountId: '123456789012',
            },
          ],
          nextToken: 'token-1',
        })
        .resolvesOnce({
          billingViews: [
            {
              arn: 'arn:aws:billing::123456789012:billingview/bt-222',
              name: 'Transfer View 2',
              billingViewType: 'BILLING_TRANSFER',
              ownerAccountId: '123456789012',
            },
          ],
        });

      // Act
      const result = await listBillingViews(['BILLING_TRANSFER']);

      // Assert
      expect(result).toHaveLength(2);
      expect(billingMock.calls()).toHaveLength(2);
    });

    it('should return empty array when no views exist', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).resolves({
        billingViews: [],
      });

      // Act
      const result = await listBillingViews(['BILLING_TRANSFER']);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should skip views with missing required fields', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).resolves({
        billingViews: [
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-111',
            // Missing name
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
          },
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-222',
            name: 'Transfer View 2',
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
          },
        ],
      });

      // Act
      const result = await listBillingViews(['BILLING_TRANSFER']);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Transfer View 2');
    });

    it('should throw error on API failure', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).rejects(new Error('Service unavailable'));

      // Act & Assert
      await expect(listBillingViews(['BILLING_TRANSFER'])).rejects.toThrow('Service unavailable');
    });
  });

  describe('getBillingView', () => {
    it('should return billing view details', async () => {
      // Arrange
      const viewArn = 'arn:aws:billing::123456789012:billingview/bt-111';
      billingMock.on(GetBillingViewCommand).resolves({
        billingView: {
          arn: viewArn,
          name: 'Transfer View 1',
          billingViewType: 'BILLING_TRANSFER',
          ownerAccountId: '123456789012',
          sourceAccountId: '111111111111',
        },
      });

      // Act
      const result = await getBillingView(viewArn);

      // Assert
      expect(result.arn).toBe(viewArn);
      expect(result.name).toBe('Transfer View 1');
      expect(result.billingViewType).toBe('BILLING_TRANSFER');
      expect(result.sourceAccountId).toBe('111111111111');
    });

    it('should throw error when response is missing required fields', async () => {
      // Arrange
      billingMock.on(GetBillingViewCommand).resolves({
        billingView: {
          arn: 'arn:aws:billing::123456789012:billingview/bt-111',
          // Missing name, billingViewType, ownerAccountId
        },
      });

      // Act & Assert
      await expect(
        getBillingView('arn:aws:billing::123456789012:billingview/bt-111')
      ).rejects.toThrow('Billing view response missing required fields');
    });

    it('should throw error on API failure', async () => {
      // Arrange
      billingMock.on(GetBillingViewCommand).rejects(new Error('Not found'));

      // Act & Assert
      await expect(
        getBillingView('arn:aws:billing::123456789012:billingview/bt-111')
      ).rejects.toThrow('Not found');
    });
  });

  describe('findBillingViewForTransfer', () => {
    it('should return billing view for matching source account', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).resolves({
        billingViews: [
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-111',
            name: 'Transfer View 1',
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
            sourceAccountId: '111111111111',
          },
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-222',
            name: 'Transfer View 2',
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
            sourceAccountId: '222222222222',
          },
        ],
      });

      // Act
      const result = await findBillingViewForTransfer('111111111111', 'BILLING_TRANSFER');

      // Assert
      expect(result).not.toBeNull();
      expect(result?.sourceAccountId).toBe('111111111111');
    });

    it('should return null when no matching view found', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).resolves({
        billingViews: [
          {
            arn: 'arn:aws:billing::123456789012:billingview/bt-222',
            name: 'Transfer View 2',
            billingViewType: 'BILLING_TRANSFER',
            ownerAccountId: '123456789012',
            sourceAccountId: '222222222222',
          },
        ],
      });

      // Act
      const result = await findBillingViewForTransfer('111111111111', 'BILLING_TRANSFER');

      // Assert
      expect(result).toBeNull();
    });

    it('should return null on API error (graceful handling)', async () => {
      // Arrange
      billingMock.on(ListBillingViewsCommand).rejects(new Error('Service unavailable'));

      // Act
      const result = await findBillingViewForTransfer('111111111111', 'BILLING_TRANSFER');

      // Assert
      expect(result).toBeNull();
    });
  });
});
