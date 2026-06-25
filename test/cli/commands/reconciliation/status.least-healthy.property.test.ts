// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for the per-account reconciliation-status rollup.
 *
 * Covers the design's Correctness Property 13 (Account status is the
 * least-healthy evaluated function status): for any non-empty set of evaluated
 * function statuses, the account's rolled-up status equals the least-healthy
 * member under the ranking `FAILED` < `PENDING` < `ATTENTION` < `DONE`
 * (lower == less healthy).
 *
 * The implementation under test is the pure, exported `leastHealthyStatus` and
 * the `STATUS_RANK` map from `cli/commands/reconciliation/status.ts`. This is
 * the exact function the single-account handler uses to roll up its evaluated
 * functions and the same ordering the Output_Formatter uses to bucket accounts,
 * so the rollup the operator sees cannot drift from this contract.
 *
 * The suite asserts, over arbitrary status arrays, that the result is:
 *  1. CORRECT vs an INDEPENDENT ORACLE — a min-by-rank reduction and a
 *     sort-by-rank, neither of which reuses the production `reduce`.
 *  2. A MEMBER of the input (never invents a status), and MINIMAL (no input
 *     member is strictly less-healthy than the result).
 *  3. IDENTITY on a single-element array (returns that element).
 *  4. ORDER-INDEPENDENT (permuting the input never changes the result).
 *  5. TOTAL — the empty-array case returns `PENDING` rather than throwing.
 *
 * A separate check pins `STATUS_RANK` to the documented least-to-most-healthy
 * ordering the property relies on.
 *
 * Validates: Requirements 12.8, 12.9
 */

import fc from 'fast-check';

import {
  leastHealthyStatus,
  STATUS_RANK,
  type ReconStatus,
} from '../../../../cli/commands/reconciliation/status.js';

// ---------------------------------------------------------------------------
// Independent oracle
//
// A standalone ranking, deliberately NOT importing STATUS_RANK, encoding the
// documented least-to-most-healthy order. The property compares the production
// result against reductions built only on this local table, so a regression in
// either STATUS_RANK or leastHealthyStatus is caught.
// ---------------------------------------------------------------------------

const ALL_STATUSES: readonly ReconStatus[] = ['FAILED', 'PENDING', 'ATTENTION', 'DONE'];

/** Local rank: lower number == less healthy. Mirrors Req 12.10 wording. */
const ORACLE_RANK: Readonly<Record<ReconStatus, number>> = {
  FAILED: 0,
  PENDING: 1,
  ATTENTION: 2,
  DONE: 3,
};

/** Oracle A: a min-by-rank reduction written independently of the production reduce. */
function oracleByReduce(statuses: readonly ReconStatus[]): ReconStatus {
  let worst = statuses[0];
  for (const s of statuses) {
    if (ORACLE_RANK[s] < ORACLE_RANK[worst]) {
      worst = s;
    }
  }
  return worst;
}

/** Oracle B: sort a copy ascending by rank and take the head (least-healthy). */
function oracleBySort(statuses: readonly ReconStatus[]): ReconStatus {
  return [...statuses].sort((a, b) => ORACLE_RANK[a] - ORACLE_RANK[b])[0];
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const statusArb: fc.Arbitrary<ReconStatus> = fc.constantFrom(...ALL_STATUSES);

/** Non-empty arrays of statuses (the precondition the rollup is defined over). */
const nonEmptyStatusesArb: fc.Arbitrary<ReconStatus[]> = fc.array(statusArb, {
  minLength: 1,
  maxLength: 24,
});

/**
 * A non-empty status array paired with a deterministic permutation of itself.
 * The permutation is produced by sorting positions by independently generated
 * integer sort keys, so equal keys still yield a valid (stable) permutation.
 */
const statusesWithPermutationArb: fc.Arbitrary<[ReconStatus[], ReconStatus[]]> =
  nonEmptyStatusesArb.chain((statuses) =>
    fc
      .array(fc.integer(), { minLength: statuses.length, maxLength: statuses.length })
      .map((keys): [ReconStatus[], ReconStatus[]] => {
        const permuted = statuses
          .map((s, i) => ({ s, k: keys[i], i }))
          // Tie-break on original index to keep the map a true permutation.
          .sort((a, b) => a.k - b.k || a.i - b.i)
          .map((x) => x.s);
        return [statuses, permuted];
      }),
  );

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

describe('bt CLI - reconciliation least-healthy account status (Property 13)', () => {
  // Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status
  it('equals the least-healthy member per an independent rank oracle (reduce and sort agree)', () => {
    fc.assert(
      fc.property(nonEmptyStatusesArb, (statuses) => {
        const actual = leastHealthyStatus(statuses);
        // Two independent oracles, neither sharing the production reduction.
        expect(actual).toBe(oracleByReduce(statuses));
        expect(actual).toBe(oracleBySort(statuses));
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status
  it('returns a member of the input and nothing in the input is strictly less healthy', () => {
    fc.assert(
      fc.property(nonEmptyStatusesArb, (statuses) => {
        const actual = leastHealthyStatus(statuses);
        // Membership: the rollup never invents a status the account did not have.
        expect(statuses).toContain(actual);
        // Minimality: no evaluated function is strictly less healthy than the result.
        for (const s of statuses) {
          expect(STATUS_RANK[actual]).toBeLessThanOrEqual(STATUS_RANK[s]);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status
  it('is the identity on a single-element array', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        expect(leastHealthyStatus([status])).toBe(status);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status
  it('is order-independent: permuting the input never changes the result', () => {
    fc.assert(
      fc.property(statusesWithPermutationArb, ([statuses, permuted]) => {
        // Sanity: the permutation preserves the multiset of statuses.
        expect([...permuted].sort()).toEqual([...statuses].sort());
        expect(leastHealthyStatus(permuted)).toBe(leastHealthyStatus(statuses));
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status
  it('is total: the empty array defaults to PENDING rather than throwing', () => {
    expect(leastHealthyStatus([])).toBe('PENDING');
  });

  // Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status
  it('STATUS_RANK encodes the documented FAILED < PENDING < ATTENTION < DONE ordering', () => {
    expect(STATUS_RANK.FAILED).toBeLessThan(STATUS_RANK.PENDING);
    expect(STATUS_RANK.PENDING).toBeLessThan(STATUS_RANK.ATTENTION);
    expect(STATUS_RANK.ATTENTION).toBeLessThan(STATUS_RANK.DONE);
  });
});
