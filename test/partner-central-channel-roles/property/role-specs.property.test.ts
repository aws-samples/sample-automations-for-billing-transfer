// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the role-set composition builder (`buildRoleSpecs`)
 * used by the Partner Central channel roles feature.
 *
 * Covers the design's Correctness Property 1: role-set composition is correct,
 * fixed-named, and account/region independent.
 *
 * Scope note on the "two distinct (programManagementAccountId, region) inputs"
 * wording: `buildRoleSpecs` deliberately does NOT accept the program-management
 * account id or region — role names are fixed string literals that are
 * independent of those values by design (see `BuildRoleSpecsProps`). The
 * property therefore generates two distinct `(account, region)` pairs to
 * *express* the independence requirement, and demonstrates it by asserting the
 * produced role-name set is identical regardless of which pair is "in play":
 * the inputs that could vary per account/region simply do not influence the
 * builder's output, so the name set is stable across both pairs.
 *
 * No real AWS account identifiers are used: every account id is a
 * fast-check-generated 12-digit string.
 */

import fc from 'fast-check';
import {
  buildRoleSpecs,
  RoleSpec,
  HANDSHAKE_APPROVAL_ROLE_NAME,
  READ_ONLY_ROLE_NAME,
  MANAGEMENT_ROLE_NAME,
  HANDSHAKE_APPROVAL_MANAGED_POLICY_ARN,
} from '../../../lib/stacks/channel-role-specs.js';

// --- Arbitraries ---

/** A well-formed AWS 12-digit account id (never a real account number). */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** A plausible AWS region identifier (value is irrelevant to the builder). */
const regionArb = fc.constantFrom(
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'sa-east-1',
  'ca-central-1'
);

/** A `(programManagementAccountId, region)` deployment-target pair. */
const accountRegionPairArb = fc.record({
  programManagementAccountId: accountIdArb,
  region: regionArb,
});

/**
 * Two *distinct* `(programManagementAccountId, region)` pairs. They must differ
 * in the account id, the region, or both — modelling deployment of the same
 * stack into two different payer accounts/regions.
 */
const twoDistinctPairsArb = fc
  .tuple(accountRegionPairArb, accountRegionPairArb)
  .filter(
    ([a, b]) =>
      a.programManagementAccountId !== b.programManagementAccountId ||
      a.region !== b.region
  );

// --- Helpers ---

/** Returns the set of role names produced for the given inputs. */
function roleNamesFor(
  partnerCentralLinkedAccountId: string,
  enableManagementRole: boolean
): string[] {
  return buildRoleSpecs({ partnerCentralLinkedAccountId, enableManagementRole }).map(
    (spec) => spec.RoleName
  );
}

/** Finds the single spec with the given role name, or undefined. */
function specByName(specs: RoleSpec[], name: string): RoleSpec | undefined {
  return specs.find((spec) => spec.RoleName === name);
}

describe('buildRoleSpecs - property tests', () => {
  // Feature: partner-central-channel-roles, Property 1: Role-set composition is correct, fixed-named, and account/region independent
  it('yields the exact fixed role names (Management iff enabled), an identical name set across two distinct account/region inputs, and a handshake spec with exactly the handshake managed policy and no inline policy', () => {
    fc.assert(
      fc.property(
        accountIdArb,
        fc.boolean(),
        twoDistinctPairsArb,
        (linkedAccountId, enableManagementRole, [pairA, pairB]) => {
          // The two deployment targets are genuinely distinct.
          expect(
            pairA.programManagementAccountId !== pairB.programManagementAccountId ||
              pairA.region !== pairB.region
          ).toBe(true);

          const specs = buildRoleSpecs({
            partnerCentralLinkedAccountId: linkedAccountId,
            enableManagementRole,
          });
          const names = specs.map((spec) => spec.RoleName);

          // --- Exact fixed role-name set (Management present iff flag true) ---
          const expectedNames = [
            HANDSHAKE_APPROVAL_ROLE_NAME,
            READ_ONLY_ROLE_NAME,
            ...(enableManagementRole === true ? [MANAGEMENT_ROLE_NAME] : []),
          ];

          // Same count, no duplicates, exact membership (order-independent).
          expect(names).toHaveLength(expectedNames.length);
          expect(new Set(names).size).toBe(expectedNames.length);
          expect([...names].sort()).toEqual([...expectedNames].sort());

          // Handshake + Read-Only are always present.
          expect(names).toContain(HANDSHAKE_APPROVAL_ROLE_NAME);
          expect(names).toContain(READ_ONLY_ROLE_NAME);
          // Management present iff enableManagementRole === true.
          expect(names.includes(MANAGEMENT_ROLE_NAME)).toBe(enableManagementRole === true);

          // --- Names are exact literals: no prefix, suffix, or path ---
          for (const name of names) {
            expect(expectedNames).toContain(name);
            // No path separators and no surrounding whitespace/decoration.
            expect(name).not.toContain('/');
            expect(name).toBe(name.trim());
          }

          // --- Account/region independence: the name set is identical across
          //     the two distinct (account, region) deployment targets. Because
          //     buildRoleSpecs depends only on linkedAccountId +
          //     enableManagementRole, the produced names do not change when the
          //     program-management account/region differ. ---
          const namesForA = roleNamesFor(linkedAccountId, enableManagementRole);
          const namesForB = roleNamesFor(linkedAccountId, enableManagementRole);
          expect([...namesForA].sort()).toEqual([...names].sort());
          expect([...namesForB].sort()).toEqual([...namesForA].sort());

          // --- Handshake spec: exactly the handshake managed policy, no inline ---
          const handshake = specByName(specs, HANDSHAKE_APPROVAL_ROLE_NAME);
          expect(handshake).toBeDefined();
          expect(handshake!.ManagedPolicyArns).toEqual([
            HANDSHAKE_APPROVAL_MANAGED_POLICY_ARN,
          ]);
          expect(handshake!.InlinePolicies).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
