// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
/**
 * Property-based tests for the Billing Transfer Read-Only permission policy
 * builder (`buildReadOnlyPolicy`) used by the Partner Central channel roles
 * feature.
 *
 * Covers the design's Correctness Property 3: the read-only permission policy
 * grants exactly the four read actions.
 *
 * `buildReadOnlyPolicy` is nullary (it takes no arguments and returns a single
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
  buildReadOnlyPolicy,
  PolicyDocumentJson,
  PolicyStatementJson,
} from '../../../lib/stacks/channel-role-specs.js';

// --- Constants describing the expected (and forbidden) action surface ---

/** The exactly-four read-only actions the policy must grant. */
const EXPECTED_ACTIONS: readonly string[] = [
  'organizations:DescribeResponsibilityTransfer',
  'organizations:ListHandshakesForOrganization',
  'organizations:ListInboundResponsibilityTransfers',
  'organizations:ListOutboundResponsibilityTransfers',
];

/**
 * Verbs that mark a mutating AWS Organizations action. None of these may appear
 * in the read-only policy.
 */
const MUTATING_ORG_VERBS: readonly string[] = [
  'Accept',
  'Cancel',
  'Decline',
  'Create',
  'Invite',
  'Update',
  'Terminate',
  'Delete',
  'Put',
  'Remove',
  'Enable',
  'Disable',
  'Attach',
  'Detach',
  'Move',
  'Tag',
  'Untag',
  'Register',
  'Deregister',
  'Close',
  'Leave',
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

describe('buildReadOnlyPolicy - property tests', () => {
  // Feature: partner-central-channel-roles, Property 3: Read-only permission policy grants exactly the four read actions
  it('produces a single Allow statement (Sid BillingTransferReadOnly, Resource *) granting exactly the four read actions and no mutating/billingconductor action', () => {
    fc.assert(
      fc.property(seedArb, () => {
        const policy: PolicyDocumentJson = buildReadOnlyPolicy();

        // --- Document shape: version + exactly one statement ---
        expect(policy.Version).toBe('2012-10-17');
        expect(Array.isArray(policy.Statement)).toBe(true);
        expect(policy.Statement).toHaveLength(1);

        const statement = policy.Statement[0];

        // --- Statement identity, effect, and resource scope ---
        expect(statement.Sid).toBe('BillingTransferReadOnly');
        expect(statement.Effect).toBe('Allow');
        expect(statement.Resource).toBe('*');
        // A permission (identity) policy carries no principal.
        expect(statement.Principal).toBeUndefined();

        // --- Action set is EXACTLY the four read actions (order-independent) ---
        const actions = actionsOf(statement);
        // Exactly four actions, with no duplicates.
        expect(actions).toHaveLength(EXPECTED_ACTIONS.length);
        expect(new Set(actions).size).toBe(EXPECTED_ACTIONS.length);
        // Set equality: same membership as the expected four.
        expect([...actions].sort()).toEqual([...EXPECTED_ACTIONS].sort());

        // --- No billingconductor action present anywhere ---
        for (const action of actions) {
          expect(action.startsWith('billingconductor:')).toBe(false);
        }

        // --- No mutating organizations action present ---
        for (const action of actions) {
          // Every granted action is an organizations: read action.
          expect(action.startsWith('organizations:')).toBe(true);
          const operation = action.slice('organizations:'.length);
          for (const verb of MUTATING_ORG_VERBS) {
            expect(operation.startsWith(verb)).toBe(false);
          }
        }

        // --- Belt-and-suspenders: scan the serialized document ---
        const serialized = JSON.stringify(policy);
        expect(serialized.includes('billingconductor:')).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: partner-central-channel-roles, Property 3: Read-only permission policy grants exactly the four read actions
  it('is stable and side-effect free: independent invocations are deeply equal', () => {
    fc.assert(
      fc.property(seedArb, () => {
        const first = buildReadOnlyPolicy();
        const second = buildReadOnlyPolicy();

        // Same content on every call (idempotent / deterministic).
        expect(second).toEqual(first);

        // Mutating one result must not affect a subsequent independent call,
        // confirming the builder returns fresh data rather than shared state.
        (first.Statement[0].Action as string[]).push('organizations:TamperedAction');
        const third = buildReadOnlyPolicy();
        expect(actionsOf(third.Statement[0])).toHaveLength(EXPECTED_ACTIONS.length);
        expect(actionsOf(third.Statement[0])).not.toContain('organizations:TamperedAction');
      }),
      { numRuns: 100 }
    );
  });
});
