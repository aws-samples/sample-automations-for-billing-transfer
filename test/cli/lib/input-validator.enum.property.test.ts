// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
/**
 * Property-based tests for the Input_Validator enumeration checks
 * (`relationshipState`, `transferType`, `reconciliationTarget`, `pmaProgram`)
 * used by the `bt` CLI.
 *
 * Covers the design's Correctness Property 3: for any string and any of the
 * defined enumerations (Relationship_State, Transfer_Type,
 * Reconciliation_Target, PMA program), the validator accepts the value if and
 * only if it is a case-sensitive exact match of a member of that enumeration;
 * on rejection the reported accepted-values list equals the enumeration, and no
 * AWS call is initiated (Requirements 5.3, 5.4, 5.5, 5.6, 5.7).
 *
 * The validators are pure, synchronous, AWS-free functions (no SDK clients are
 * injected and nothing is awaited), so "no AWS call is initiated" holds by
 * construction; the tests additionally assert each call returns a plain
 * (non-Promise) Result to make that property observable.
 */

import fc from 'fast-check';
import { Program } from '@aws-sdk/client-partnercentral-channel';
import { VALID_STATES, VALID_TYPES } from '../../../lib/lambda/common/models/billing-transfer.js';
import {
  inputValidator,
  Result,
  VALID_RECONCILIATION_TARGETS,
  VALID_PMA_PROGRAMS,
  PmaProgram,
} from '../../../cli/lib/input-validator.js';

// --- Enumeration descriptors under test -------------------------------------

/**
 * Describes a single enumeration validator: how to invoke it, the case-sensitive
 * membership set it accepts, the accepted-values list it must report on
 * rejection, and how to assert the success value's shape.
 */
interface EnumSpec {
  /** Human-readable name for diagnostics. */
  readonly name: string;
  /** The validator under test. */
  readonly validate: (value: string) => Result<unknown>;
  /** The case-sensitive set of accepted members (accept iff exact member). */
  readonly members: readonly string[];
  /** The complete accepted-values list the validator reports on rejection (Req 5.7). */
  readonly reportedAccepted: readonly string[];
  /** Asserts the narrowed success value is correct for the given accepted input. */
  readonly assertValue: (input: string, value: unknown) => void;
}

/**
 * Expected canonical PMA result for an accepted program input, mirroring the
 * `DP`→DISTRIBUTION / `SPP`→SOLUTION_PROVIDER / `DS`→DISTRIBUTION_SELLER mapping
 * (and the SDK enum forms, which map to themselves) (Req 5.6).
 */
function expectedPmaProgram(input: string): PmaProgram {
  switch (input) {
    case 'DP':
    case Program.DISTRIBUTION:
      return { type: 'DP', program: Program.DISTRIBUTION };
    case 'SPP':
    case Program.SOLUTION_PROVIDER:
      return { type: 'SPP', program: Program.SOLUTION_PROVIDER };
    case 'DS':
    case Program.DISTRIBUTION_SELLER:
      return { type: 'DS', program: Program.DISTRIBUTION_SELLER };
    default:
      throw new Error(`not an accepted PMA program input: ${JSON.stringify(input)}`);
  }
}

const ENUM_SPECS: readonly EnumSpec[] = [
  {
    name: 'relationshipState',
    validate: (v) => inputValidator.relationshipState(v),
    members: VALID_STATES,
    reportedAccepted: VALID_STATES,
    // Relationship_State narrows to the input string itself on success.
    assertValue: (input, value) => expect(value).toBe(input),
  },
  {
    name: 'transferType',
    validate: (v) => inputValidator.transferType(v),
    members: VALID_TYPES,
    reportedAccepted: VALID_TYPES,
    assertValue: (input, value) => expect(value).toBe(input),
  },
  {
    name: 'reconciliationTarget',
    validate: (v) => inputValidator.reconciliationTarget(v),
    members: VALID_RECONCILIATION_TARGETS,
    reportedAccepted: VALID_RECONCILIATION_TARGETS,
    assertValue: (input, value) => expect(value).toBe(input),
  },
  {
    name: 'pmaProgram',
    validate: (v) => inputValidator.pmaProgram(v),
    // Both the friendly identifiers and the SDK enum forms are accepted (Req 5.6).
    members: VALID_PMA_PROGRAMS,
    reportedAccepted: VALID_PMA_PROGRAMS,
    // PMA narrows to the canonical {type, program} pair on success.
    assertValue: (input, value) => expect(value).toEqual(expectedPmaProgram(input)),
  },
];

// --- Arbitraries ------------------------------------------------------------

/**
 * Flips the case of the characters of `s` selected by `flips`. Characters with
 * no distinct upper/lower form (digits, symbols) are left unchanged. Used to
 * generate near-miss, wrong-case variants of valid members.
 */
function mutateCase(s: string, flips: readonly boolean[]): string {
  return s
    .split('')
    .map((ch, i) => {
      if (!flips[i]) return ch;
      const upper = ch.toUpperCase();
      const lower = ch.toLowerCase();
      return ch === lower ? upper : lower;
    })
    .join('');
}

/** An exact member of the given enumeration. */
function memberArb(members: readonly string[]): fc.Arbitrary<string> {
  return fc.constantFrom(...members);
}

/** A case-mutated member (often a wrong-case variant; sometimes the member itself). */
function caseMutatedMemberArb(members: readonly string[]): fc.Arbitrary<string> {
  return fc.constantFrom(...members).chain((m) =>
    fc.array(fc.boolean(), { minLength: m.length, maxLength: m.length }).map((flips) => mutateCase(m, flips)),
  );
}

/** A member padded with surrounding whitespace — must be rejected (no trimming). */
function paddedMemberArb(members: readonly string[]): fc.Arbitrary<string> {
  const ws = fc.constantFrom('', ' ', '  ', '\t', '\n');
  return fc.tuple(ws, fc.constantFrom(...members), ws).map(([l, m, r]) => `${l}${m}${r}`);
}

/**
 * A value drawn from the full input space for a given enumeration: exact
 * members, case-mutated members, whitespace-padded members, and arbitrary
 * strings (including the empty string and unicode).
 */
function valueArb(members: readonly string[]): fc.Arbitrary<string> {
  return fc.oneof(
    memberArb(members),
    caseMutatedMemberArb(members),
    paddedMemberArb(members),
    fc.string(),
    fc.string({ unit: 'binary' }),
  );
}

/** A (descriptor, value) pair: pick an enumeration, then a value for it. */
const specAndValueArb: fc.Arbitrary<{ spec: EnumSpec; value: string }> = fc
  .constantFrom(...ENUM_SPECS)
  .chain((spec) => valueArb(spec.members).map((value) => ({ spec, value })));

// --- Property ---------------------------------------------------------------

describe('Input_Validator enumeration validation - property tests', () => {
  // Feature: billing-transfer-cli, Property 3: Enumeration options are accepted exactly on case-sensitive membership
  it('accepts a value iff it is a case-sensitive exact member; on rejection reports the enumeration as the accepted list', () => {
    fc.assert(
      fc.property(specAndValueArb, ({ spec, value }) => {
        const result = spec.validate(value);

        // The check is pure and synchronous: no AWS call is initiated (Req 5.7).
        expect(result).not.toBeInstanceOf(Promise);

        // Ground truth: case-sensitive exact membership.
        const isMember = spec.members.includes(value);

        if (isMember) {
          // Accept exactly when an exact member (Req 5.3, 5.4, 5.5, 5.6).
          expect(result.ok).toBe(true);
          if (result.ok) {
            spec.assertValue(value, result.value);
          }
        } else {
          // Reject everything else, reporting the offending value and the
          // complete accepted-values list equal to the enumeration (Req 5.7).
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.invalidValue).toBe(value);
            expect(result.accepted).toEqual([...spec.reportedAccepted]);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 3: Enumeration options are accepted exactly on case-sensitive membership
  it('accepts every defined member of every enumeration (accept branch is total over members)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENUM_SPECS).chain((spec) => memberArb(spec.members).map((value) => ({ spec, value }))),
        ({ spec, value }) => {
          const result = spec.validate(value);
          expect(result.ok).toBe(true);
          if (result.ok) {
            spec.assertValue(value, result.value);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
