// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
/**
 * Property-based tests for the Billing Transfer Management permission policy
 * builder (`buildManagementPolicy`) used by the Partner Central channel roles
 * feature.
 *
 * Covers the design's Correctness Property 4: the management permission policy
 * grants exactly the enumerated thirteen-action set.
 *
 * `buildManagementPolicy` is nullary (it takes no arguments and returns a single
 * fixed policy document). To exercise the "for any invocation" wording of the
 * property, fast-check drives repeated invocations with a generated dummy seed:
 * every run re-invokes the builder and asserts the invariants hold, and also
 * asserts the result is stable / deeply equal across independent calls within
 * the same run (idempotent, side-effect free).
 *
 * No AWS account identifiers appear anywhere in this test.
 */

import fc from 'fast-check';
import {
  buildManagementPolicy,
  PolicyDocumentJson,
  PolicyStatementJson,
} from '../../../lib/stacks/channel-role-specs.js';

// --- Constants describing the expected action surface ---

/**
 * The exactly-thirteen actions the management policy must grant: two Billing
 * Conductor actions plus eleven AWS Organizations actions for reading and
 * managing responsibility transfers and handshakes.
 */
const EXPECTED_ACTIONS: readonly string[] = [
  'billingconductor:CreateBillingGroup',
  'billingconductor:ListPricingPlans',
  'organizations:AcceptHandshake',
  'organizations:CancelHandshake',
  'organizations:DeclineHandshake',
  'organizations:DescribeResponsibilityTransfer',
  'organizations:InviteOrganizationToTransferResponsibility',
  'organizations:ListHandshakesForAccount',
  'organizations:ListHandshakesForOrganization',
  'organizations:ListInboundResponsibilityTransfers',
  'organizations:ListOutboundResponsibilityTransfers',
  'organizations:TerminateResponsibilityTransfer',
  'organizations:UpdateResponsibilityTransfer',
];

// --- Arbitraries ---

/**
 * A dummy seed used solely to drive repeated invocations of the nullary
 * builder. Its value is intentionally irrelevant to the output.
 */
const seedArb = fc.integer();

// --- Helpers ---

/** Normalises a statement's `Action` field into a string array. */
function actionsOf(statement: PolicyStatementJson): string[] {
  const action = statement.Action;
  return Array.isArray(action) ? [...action] : [action];
}

describe('buildManagementPolicy - property tests', () => {
  // Feature: partner-central-channel-roles, Property 4: Management permission policy grants exactly the enumerated action set
  it('produces a single Allow statement (Sid BillingTransferManagement, Resource *) granting exactly the thirteen enumerated actions and no others', () => {
    fc.assert(
      fc.property(seedArb, () => {
        const policy: PolicyDocumentJson = buildManagementPolicy();

        // --- Document shape: version + exactly one statement ---
        expect(policy.Version).toBe('2012-10-17');
        expect(Array.isArray(policy.Statement)).toBe(true);
        expect(policy.Statement).toHaveLength(1);

        const statement = policy.Statement[0];

        // --- Statement identity, effect, and resource scope ---
        expect(statement.Sid).toBe('BillingTransferManagement');
        expect(statement.Effect).toBe('Allow');
        expect(statement.Resource).toBe('*');
        // A permission (identity) policy carries no principal.
        expect(statement.Principal).toBeUndefined();

        // --- Action set is EXACTLY the thirteen actions (order-independent) ---
        const actions = actionsOf(statement);
        // Exactly thirteen actions, with no duplicates.
        expect(actions).toHaveLength(EXPECTED_ACTIONS.length);
        expect(new Set(actions).size).toBe(EXPECTED_ACTIONS.length);
        // Set equality: same membership as the expected thirteen.
        expect([...actions].sort()).toEqual([...EXPECTED_ACTIONS].sort());

        // --- No action present outside the enumerated set (no extras) ---
        const expectedSet = new Set(EXPECTED_ACTIONS);
        for (const action of actions) {
          expect(expectedSet.has(action)).toBe(true);
          // Every granted action is one of the two allowed services.
          expect(
            action.startsWith('billingconductor:') ||
              action.startsWith('organizations:')
          ).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: partner-central-channel-roles, Property 4: Management permission policy grants exactly the enumerated action set
  it('is stable and side-effect free: independent invocations are deeply equal', () => {
    fc.assert(
      fc.property(seedArb, () => {
        const first = buildManagementPolicy();
        const second = buildManagementPolicy();

        // Same content on every call (idempotent / deterministic).
        expect(second).toEqual(first);

        // Mutating one result must not affect a subsequent independent call,
        // confirming the builder returns fresh data rather than shared state.
        (first.Statement[0].Action as string[]).push('organizations:TamperedAction');
        const third = buildManagementPolicy();
        expect(actionsOf(third.Statement[0])).toHaveLength(EXPECTED_ACTIONS.length);
        expect(actionsOf(third.Statement[0])).not.toContain('organizations:TamperedAction');
      }),
      { numRuns: 100 }
    );
  });
});
