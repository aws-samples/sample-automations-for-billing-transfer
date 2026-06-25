// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Example-based tests for Billing Conductor edge cases used by the event handler.
 *
 * Covers the example scenarios from the design document:
 * - Example 1: Missing BasicPricingPlan error handling (Requirements 5.4)
 * - Example 2: ResourceNotFoundException handling (Requirements 7.2)
 * - Example 3: ConflictException handling (Requirements 7.3)
 */

import { mockClient } from 'aws-sdk-client-mock';
import {
  BillingconductorClient,
  ListPricingPlansCommand,
  ListBillingGroupsCommand,
  CreateBillingGroupCommand,
  ConflictException,
} from '@aws-sdk/client-billingconductor';

const bcMock = mockClient(BillingconductorClient);

import {
  getBasicPricingPlanArn,
  findBillingGroupByAccount,
  ensureBillingGroup,
} from '../../../lib/lambda/common/services/billing-conductor-service.js';

const TRANSFER_ARN =
  'arn:aws:organizations::123456789012:transfer/o-abc123/billing/inbound/rt-xyz789';
const ACCOUNT_ID = '111111111111';

describe('Billing Conductor edge cases (example-based)', () => {
  beforeEach(() => {
    bcMock.reset();
  });

  // Example 1: Missing BasicPricingPlan error handling - Requirements 5.4
  describe('Example 1: Missing BasicPricingPlan', () => {
    it('throws when ListPricingPlans returns an empty list', async () => {
      bcMock.on(ListPricingPlansCommand).resolves({ PricingPlans: [] });

      await expect(getBasicPricingPlanArn()).rejects.toThrow('BasicPricingPlan not found');
    });

    it('throws when ListPricingPlans has no BasicPricingPlan entry', async () => {
      bcMock.on(ListPricingPlansCommand).resolves({
        PricingPlans: [
          { Name: 'CustomPlan', Arn: 'arn:aws:billingconductor::123456789012:pricing-plan/custom' },
        ],
      });

      await expect(getBasicPricingPlanArn()).rejects.toThrow('BasicPricingPlan not found');
    });

    it('surfaces the missing pricing plan as a failed ensureBillingGroup result', async () => {
      // No existing group, then pricing-plan lookup fails -> ensureBillingGroup captures the error
      bcMock.on(ListBillingGroupsCommand).resolves({ BillingGroups: [] });
      bcMock.on(ListPricingPlansCommand).resolves({ PricingPlans: [] });

      const result = await ensureBillingGroup(ACCOUNT_ID, TRANSFER_ARN);

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error?.message).toContain('BasicPricingPlan not found');
      // No creation attempted without a pricing plan
      expect(bcMock.commandCalls(CreateBillingGroupCommand).length).toBe(0);
    });
  });

  // Example 2: ResourceNotFoundException handling - Requirements 7.2
  describe('Example 2: ResourceNotFoundException', () => {
    it('propagates ResourceNotFoundException out of findBillingGroupByAccount', async () => {
      const notFound = Object.assign(new Error('Billing group not found'), {
        name: 'ResourceNotFoundException',
        code: 'ResourceNotFoundException',
      });
      bcMock.on(ListBillingGroupsCommand).rejects(notFound);

      await expect(findBillingGroupByAccount(ACCOUNT_ID)).rejects.toThrow('Billing group not found');
    });

    it('captures ResourceNotFoundException as a failed ensureBillingGroup result with code', async () => {
      const notFound = Object.assign(new Error('Resource not found'), {
        name: 'ResourceNotFoundException',
        code: 'ResourceNotFoundException',
      });
      bcMock.on(ListBillingGroupsCommand).rejects(notFound);

      const result = await ensureBillingGroup(ACCOUNT_ID, TRANSFER_ARN);

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.error?.code).toBe('ResourceNotFoundException');
      expect(result.error?.message).toContain('Resource not found');
    });
  });

  // Example 3: ConflictException handling - Requirements 7.3
  describe('Example 3: ConflictException', () => {
    it('treats CreateBillingGroup ConflictException as success and returns the existing ARN', async () => {
      const existingArn =
        'arn:aws:billingconductor::123456789012:billing-group/bg-111111111111';

      // First check: no group found, so creation is attempted
      // Creation: ConflictException (created concurrently)
      // Recovery lookup: returns the existing group ARN
      bcMock
        .on(ListBillingGroupsCommand)
        .resolvesOnce({ BillingGroups: [] })
        .resolves({
          BillingGroups: [
            { Name: 'bg-111111111111', Arn: existingArn, PrimaryAccountId: ACCOUNT_ID },
          ],
        });
      bcMock.on(ListPricingPlansCommand).resolves({
        PricingPlans: [
          { Name: 'BasicPricingPlan', Arn: 'arn:aws:billingconductor::123456789012:pricing-plan/basic' },
        ],
      });

      const conflict = new ConflictException({
        message: 'Billing group already exists',
        $metadata: {},
        ResourceId: 'bg-111111111111',
        ResourceType: 'billinggroup',
      });
      bcMock.on(CreateBillingGroupCommand).rejects(conflict);

      const result = await ensureBillingGroup(ACCOUNT_ID, TRANSFER_ARN);

      // Conflict is treated as success (idempotent), existing ARN returned
      expect(result.success).toBe(true);
      expect(result.billingGroupArn).toBe(existingArn);
    });
  });
});
