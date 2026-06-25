// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BillingconductorClient,
  ListPricingPlansCommand,
  ListBillingGroupsCommand,
  CreateBillingGroupCommand,
} from '@aws-sdk/client-billingconductor';

// Mock the Billing Conductor client before importing the service
const bcMock = mockClient(BillingconductorClient);

import {
  getBasicPricingPlanArn,
  findBillingGroupByAccount,
  createBillingGroup,
  ensureBillingGroup,
} from '../../../lib/lambda/common/services/billing-conductor-service.js';

describe('billing-conductor-service', () => {
  beforeEach(() => {
    bcMock.reset();
  });

  describe('getBasicPricingPlanArn', () => {
    it('should return BasicPricingPlan ARN when found', async () => {
      // Arrange
      const expectedArn = 'arn:aws:billingconductor::123456789012:pricing-plan/basic';
      bcMock.on(ListPricingPlansCommand).resolves({
        PricingPlans: [
          { Name: 'CustomPlan', Arn: 'arn:aws:billingconductor::123456789012:pricing-plan/custom' },
          { Name: 'BasicPricingPlan', Arn: expectedArn },
        ],
      });

      // Act
      const result = await getBasicPricingPlanArn();

      // Assert
      expect(result).toBe(expectedArn);
    });

    it('should throw error when BasicPricingPlan not found', async () => {
      // Arrange
      bcMock.on(ListPricingPlansCommand).resolves({
        PricingPlans: [
          { Name: 'CustomPlan', Arn: 'arn:aws:billingconductor::123456789012:pricing-plan/custom' },
        ],
      });

      // Act & Assert
      await expect(getBasicPricingPlanArn()).rejects.toThrow('BasicPricingPlan not found');
    });

    it('should throw error when pricing plans list is empty', async () => {
      // Arrange
      bcMock.on(ListPricingPlansCommand).resolves({
        PricingPlans: [],
      });

      // Act & Assert
      await expect(getBasicPricingPlanArn()).rejects.toThrow('BasicPricingPlan not found');
    });
  });

  describe('findBillingGroupByAccount', () => {
    it('should return billing group ARN when found', async () => {
      // Arrange
      const expectedArn = 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111';
      bcMock.on(ListBillingGroupsCommand).resolves({
        BillingGroups: [
          { Name: 'bg-111111111111', Arn: expectedArn, PrimaryAccountId: '111111111111' },
          { Name: 'bg-222222222222', Arn: 'arn:aws:billingconductor::123456789012:billing-group/bg-222222222222', PrimaryAccountId: '222222222222' },
        ],
      });

      // Act
      const result = await findBillingGroupByAccount('111111111111');

      // Assert
      expect(result).toBe(expectedArn);
    });

    it('should return null when billing group not found', async () => {
      // Arrange
      bcMock.on(ListBillingGroupsCommand).resolves({
        BillingGroups: [
          { Name: 'bg-222222222222', Arn: 'arn:aws:billingconductor::123456789012:billing-group/bg-222222222222', PrimaryAccountId: '222222222222' },
        ],
      });

      // Act
      const result = await findBillingGroupByAccount('111111111111');

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when no billing groups exist', async () => {
      // Arrange
      bcMock.on(ListBillingGroupsCommand).resolves({
        BillingGroups: [],
      });

      // Act
      const result = await findBillingGroupByAccount('111111111111');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('createBillingGroup', () => {
    it('should create billing group and return ARN', async () => {
      // Arrange
      const expectedArn = 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111';
      bcMock.on(CreateBillingGroupCommand).resolves({
        Arn: expectedArn,
      });

      // Act
      const result = await createBillingGroup(
        '111111111111',
        'arn:aws:billingconductor::123456789012:pricing-plan/basic',
        'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123'
      );

      // Assert
      expect(result).toBe(expectedArn);

      // Verify the command was called with correct parameters
      const calls = bcMock.calls();
      expect(calls[0].args[0].input).toMatchObject({
        Name: 'bg-111111111111',
        AccountGrouping: {
          ResponsibilityTransferArn: 'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123',
        },
      });
    });

    it('should throw error when CreateBillingGroup returns no ARN', async () => {
      // Arrange
      bcMock.on(CreateBillingGroupCommand).resolves({});

      // Act & Assert
      await expect(
        createBillingGroup(
          '111111111111',
          'arn:aws:billingconductor::123456789012:pricing-plan/basic',
          'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123'
        )
      ).rejects.toThrow('CreateBillingGroup did not return an ARN');
    });
  });

  describe('ensureBillingGroup - error handling', () => {
    it('should return failed result with error details on API failure', async () => {
      // Arrange
      const apiError = new Error('Service unavailable');
      (apiError as any).code = 'ServiceUnavailableException';
      bcMock.on(ListBillingGroupsCommand).rejects(apiError);

      // Act
      const result = await ensureBillingGroup(
        '111111111111',
        'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123'
      );

      // Assert - error is captured in result, not thrown
      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Service unavailable');
    });
  });

  describe('ensureBillingGroup', () => {
    it('should return exists when billing group already exists', async () => {
      // Arrange
      const existingArn = 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111';
      bcMock.on(ListBillingGroupsCommand).resolves({
        BillingGroups: [
          { Name: 'bg-111111111111', Arn: existingArn, PrimaryAccountId: '111111111111' },
        ],
      });

      // Act
      const result = await ensureBillingGroup(
        '111111111111',
        'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123'
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.action).toBe('exists');
      expect(result.billingGroupArn).toBe(existingArn);
    });

    it('should create billing group when it does not exist', async () => {
      // Arrange
      const newArn = 'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111';
      const pricingPlanArn = 'arn:aws:billingconductor::123456789012:pricing-plan/basic';
      
      bcMock.on(ListBillingGroupsCommand).resolves({ BillingGroups: [] });
      bcMock.on(ListPricingPlansCommand).resolves({
        PricingPlans: [{ Name: 'BasicPricingPlan', Arn: pricingPlanArn }],
      });
      bcMock.on(CreateBillingGroupCommand).resolves({ Arn: newArn });

      // Act
      const result = await ensureBillingGroup(
        '111111111111',
        'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123'
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(result.billingGroupArn).toBe(newArn);
    });

    it('should return failed result on error', async () => {
      // Arrange
      bcMock.on(ListBillingGroupsCommand).rejects(new Error('Access denied'));

      // Act
      const result = await ensureBillingGroup(
        '111111111111',
        'arn:aws:organizations::123456789012:transfer/o-abc/billing/inbound/rt-123'
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Access denied');
    });
  });
});
