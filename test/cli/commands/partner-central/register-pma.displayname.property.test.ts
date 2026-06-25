// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the default PMA display-name derivation used by the
 * `bt partner-central register-pma` command.
 *
 * Covers the design's Correctness Property 17: for any valid program identifier
 * and 12-digit Account_Id, {@link deriveDefaultDisplayName} returns
 * `{ ok: true, value: 'PMA-<TYPE>-<last4>' }` where `<TYPE>` is the friendly
 * program identifier (`DP`/`SPP`/`DS`) and `<last4>` is the final four digits of
 * the Account_Id; and for any malformed input (unknown program, non-12-digit
 * Account_Id, or `undefined`) it returns `{ ok: false }` with a non-empty reason
 * and never throws — so the command can report the failure and exit non-zero
 * before any AWS call (Requirements 17.4, 17.7).
 *
 * The derivation is a pure, synchronous, AWS-free function (no SDK clients, no
 * streams), so "no AWS call is initiated" holds by construction; the tests
 * additionally assert each call returns a plain (non-Promise) result and never
 * throws to make totality observable.
 */

import fc from 'fast-check';
import { Program } from '@aws-sdk/client-partnercentral-channel';
import {
  deriveDefaultDisplayName,
  type DisplayNameResult,
} from '../../../../cli/commands/partner-central/register-pma.js';
import {
  VALID_PMA_PROGRAMS,
  type PmaProgramType,
} from '../../../../cli/lib/input-validator.js';

// --- Ground-truth mapping ---------------------------------------------------

/**
 * Expected friendly {@link PmaProgramType} for an accepted program input,
 * mirroring the `DP`→DISTRIBUTION / `SPP`→SOLUTION_PROVIDER /
 * `DS`→DISTRIBUTION_SELLER mapping (and the SDK enum forms, which map back to
 * the same friendly identifier) (Req 17.4).
 */
function expectedType(input: string): PmaProgramType {
  switch (input) {
    case 'DP':
    case Program.DISTRIBUTION:
      return 'DP';
    case 'SPP':
    case Program.SOLUTION_PROVIDER:
      return 'SPP';
    case 'DS':
    case Program.DISTRIBUTION_SELLER:
      return 'DS';
    default:
      throw new Error(`not an accepted PMA program input: ${JSON.stringify(input)}`);
  }
}

// --- Arbitraries ------------------------------------------------------------

/** An accepted program identifier: a friendly form or an SDK `Program` enum form. */
const validProgramArb: fc.Arbitrary<string> = fc.constantFrom(...VALID_PMA_PROGRAMS);

/** A valid 12-digit AWS account id, covering the full space including leading zeros. */
const validAccountIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
    minLength: 12,
    maxLength: 12,
  })
  .map((digits) => digits.join(''));

/** The canonical 12-digit shape the derivation requires. */
const TWELVE_DIGITS = /^\d{12}$/;

/**
 * A malformed program identifier: `undefined`, or any string that is not a
 * case-sensitive exact member of the accepted set (including near-misses such as
 * wrong case and whitespace-padded forms).
 */
const invalidProgramArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom('', 'dp', 'spp', 'ds', 'distribution', ' DP', 'DP ', 'PMA', 'DISTRIBUTION_PARTNER'),
  fc.string().filter((s) => !VALID_PMA_PROGRAMS.includes(s)),
  fc.string({ unit: 'binary' }).filter((s) => !VALID_PMA_PROGRAMS.includes(s)),
);

/**
 * A malformed Account_Id: `undefined`, or any string that does not match exactly
 * 12 digits (wrong length, embedded non-digits, signs, whitespace, unicode).
 */
const invalidAccountIdArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  // Digit strings of the wrong length (too short or too long), never exactly 12.
  fc
    .array(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
      minLength: 0,
      maxLength: 20,
    })
    .map((d) => d.join(''))
    .filter((s) => s.length !== 12),
  // 12 characters but containing at least one non-digit.
  fc
    .string({ minLength: 12, maxLength: 12 })
    .filter((s) => !TWELVE_DIGITS.test(s)),
  // Common near-misses: signs, separators, surrounding whitespace.
  fc.constantFrom('', '12345678901', '1234567890123', '+12345678901', '12345678901a', ' 123456789012', '123456789012 '),
  // Arbitrary strings that simply are not 12 digits.
  fc.string().filter((s) => !TWELVE_DIGITS.test(s)),
);

/**
 * A malformed (program, accountId) pair guaranteed to have at least one
 * malformed component, so the derivation must reject it regardless of which
 * component is bad (the program is checked first).
 */
const malformedArb: fc.Arbitrary<{ program: string | undefined; accountId: string | undefined }> = fc.oneof(
  // Bad program, good account id.
  fc.record({ program: invalidProgramArb, accountId: validAccountIdArb }),
  // Good program, bad account id.
  fc.record({ program: validProgramArb, accountId: invalidAccountIdArb }),
  // Both malformed.
  fc.record({ program: invalidProgramArb, accountId: invalidAccountIdArb }),
);

// --- Properties -------------------------------------------------------------

describe('deriveDefaultDisplayName - default PMA display-name derivation (property tests)', () => {
  // Feature: billing-transfer-cli, Property 17: Default PMA display name derivation
  it('derives PMA-<TYPE>-<last4> for every valid program identifier and 12-digit account id', () => {
    fc.assert(
      fc.property(validProgramArb, validAccountIdArb, (program, accountId) => {
        let result!: DisplayNameResult;
        // Pure and total: deriving the name must never throw (Req 17.4, 17.7).
        expect(() => {
          result = deriveDefaultDisplayName(program, accountId);
        }).not.toThrow();

        // Synchronous, AWS-free: no AWS call is initiated (Req 17.7).
        expect(result).not.toBeInstanceOf(Promise);

        // The default display name is exactly PMA-<TYPE>-<last4> (Req 17.4).
        expect(result.ok).toBe(true);
        if (result.ok) {
          const type = expectedType(program);
          const last4 = accountId.slice(-4);
          expect(result.value).toBe(`PMA-${type}-${last4}`);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: billing-transfer-cli, Property 17: Default PMA display name derivation
  it('rejects malformed program or account id with a non-empty reason and never throws', () => {
    fc.assert(
      fc.property(malformedArb, ({ program, accountId }) => {
        let result!: DisplayNameResult;
        // Pure and total: malformed input yields a rejection, never a throw,
        // so the failure is reported before any AWS call (Req 17.7).
        expect(() => {
          result = deriveDefaultDisplayName(program, accountId);
        }).not.toThrow();

        expect(result).not.toBeInstanceOf(Promise);

        // At least one component is malformed, so derivation must fail (Req 17.7).
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.reason).toBe('string');
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
