// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
/**
 * Property-based tests for the Billing Conductor service used by the event handler.
 *
 * Covers service-level correctness properties from the design document:
 * - Property 5: Idempotency check execution (Requirements 4.2)
 * - Property 7: Billing group structure (Requirements 4.5)
 * - Property 8: Billing group naming convention (Requirements 4.5)
 * - Property 9: BasicPricingPlan discovery (Requirements 5.2)
 * - Property 10: Pricing plan association (Requirements 5.3, 5.5)
 * - Property 11: Throttling retry behavior (Requirements 7.1)
 *
 * Each property runs a minimum of 100 iterations.
 */

import fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BillingconductorClient,
  ListPricingPlansCommand,
  ListBillingGroupsCommand,
  CreateBillingGroupCommand,
} from '@aws-sdk/client-billingconductor';

const bcMock = mockClient(BillingconductorClient);

import {
  getBasicPricingPlanArn,
  createBillingGroup,
  ensureBillingGroup,
} from '../../../lib/lambda/common/services/billing-conductor-service.js';

// --- Arbitraries ---

/** AWS 12-digit account ID */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

const transferArnArb = accountIdArb.map(
  (acct) => `arn:aws:organizations::${acct}:transfer/o-abc123/billing/inbound/rt-test`
);

const pricingPlanArnArb = accountIdArb.map(
  (acct) => `arn:aws:billingconductor::${acct}:pricing-plan/basic`
);

describe('Billing Conductor service - property tests', () => {
  beforeEach(() => {
    bcMock.reset();
  });

  // Feature: billing-group-event-handler, Property 5: Idempotency check execution
  // Feature: billing-group-event-handler, Property 8: Billing group naming convention
  it('checks for an existing billing group (by name bg-{accountId}) before creating', async () => {
    await fc.assert(
      fc.asyncProperty(accountIdArb, transferArnArb, async (accountId, transferArn) => {
        bcMock.reset();

        const expectedName = `bg-${accountId}`;
        const existingArn = `arn:aws:billingconductor::123456789012:billing-group/${expectedName}`;

        bcMock.on(ListBillingGroupsCommand).resolves({
          BillingGroups: [
            { Name: expectedName, Arn: existingArn, PrimaryAccountId: accountId },
          ],
        });

        const result = await ensureBillingGroup(accountId, transferArn);

        // Idempotency check ran (ListBillingGroups called)
        expect(bcMock.commandCalls(ListBillingGroupsCommand).length).toBeGreaterThanOrEqual(1);
        // No creation attempted since the group already exists
        expect(bcMock.commandCalls(CreateBillingGroupCommand).length).toBe(0);
        expect(result.action).toBe('exists');
        expect(result.billingGroupName).toBe(expectedName);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 7: Billing group structure
  // Feature: billing-group-event-handler, Property 10: Pricing plan association
  it('creates billing groups using ResponsibilityTransferArn and the BasicPricingPlan ARN', async () => {
    await fc.assert(
      fc.asyncProperty(
        accountIdArb,
        transferArnArb,
        pricingPlanArnArb,
        async (accountId, transferArn, pricingPlanArn) => {
          bcMock.reset();

          const createdArn = `arn:aws:billingconductor::123456789012:billing-group/bg-${accountId}`;
          bcMock.on(CreateBillingGroupCommand).resolves({ Arn: createdArn });

          const result = await createBillingGroup(accountId, pricingPlanArn, transferArn);

          expect(result).toBe(createdArn);

          const createCalls = bcMock.commandCalls(CreateBillingGroupCommand);
          expect(createCalls.length).toBe(1);

          const input = createCalls[0].args[0].input as any;
          // Property 7: uses ResponsibilityTransferArn (not LinkedAccountIds)
          expect(input.AccountGrouping?.ResponsibilityTransferArn).toBe(transferArn);
          expect(input.AccountGrouping?.LinkedAccountIds).toBeUndefined();
          // Property 8: name follows bg-{accountId}
          expect(input.Name).toBe(`bg-${accountId}`);
          // Property 10: associated with the provided BasicPricingPlan ARN
          expect(input.ComputationPreference?.PricingPlanArn).toBe(pricingPlanArn);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 9: BasicPricingPlan discovery
  it('finds and returns the BasicPricingPlan ARN regardless of its position in the list', async () => {
    const otherPlanArb = fc.record({
      Name: fc
        .string({ minLength: 1, maxLength: 15 })
        .filter((n) => n !== 'BasicPricingPlan'),
      Arn: pricingPlanArnArb,
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(otherPlanArb, { maxLength: 6 }),
        pricingPlanArnArb,
        fc.nat(),
        async (otherPlans, basicArn, insertAt) => {
          bcMock.reset();

          const basicPlan = { Name: 'BasicPricingPlan', Arn: basicArn };
          const plans = [...otherPlans];
          const index = otherPlans.length === 0 ? 0 : insertAt % (otherPlans.length + 1);
          plans.splice(index, 0, basicPlan);

          bcMock.on(ListPricingPlansCommand).resolves({ PricingPlans: plans });

          const result = await getBasicPricingPlanArn();
          expect(result).toBe(basicArn);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 11: Throttling retry behavior
  it('retries throttled list operations with up to 3 attempts before succeeding', async () => {
    // Stub setTimeout so exponential-backoff sleeps resolve instantly (keeps 100 runs fast).
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((cb: (...args: any[]) => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      });

    try {
      await fc.assert(
        fc.asyncProperty(
          accountIdArb,
          transferArnArb,
          fc.constantFrom('ThrottlingException', 'TooManyRequestsException', 'ServiceUnavailableException'),
          async (accountId, transferArn, throttleCode) => {
            bcMock.reset();

            const throttleError = Object.assign(new Error(`${throttleCode} occurred`), {
              name: throttleCode,
              code: throttleCode,
            });

            // Fail twice with a throttling error, then succeed on the 3rd attempt
            bcMock
              .on(ListBillingGroupsCommand)
              .rejectsOnce(throttleError)
              .rejectsOnce(throttleError)
              .resolves({
                BillingGroups: [
                  {
                    Name: `bg-${accountId}`,
                    Arn: `arn:aws:billingconductor::123456789012:billing-group/bg-${accountId}`,
                    PrimaryAccountId: accountId,
                  },
                ],
              });

            const result = await ensureBillingGroup(accountId, transferArn);

            // 3 attempts total (2 failures + 1 success) confirms exponential-backoff retry
            expect(bcMock.commandCalls(ListBillingGroupsCommand).length).toBe(3);
            expect(result.success).toBe(true);
            expect(result.action).toBe('exists');
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
