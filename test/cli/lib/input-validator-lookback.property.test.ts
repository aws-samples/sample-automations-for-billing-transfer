// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the `bt` CLI Input_Validator `lookbackMinutes` check
 * in `cli/lib/input-validator.ts`.
 *
 * Covers the correctness property from the design document:
 * - Property 4: Lookback is accepted exactly when it is an integer in
 *   [1, 10080] (Requirements 12.5)
 *
 * Each property runs a minimum of 100 fast-check iterations.
 *
 * The oracle is intentionally independent of the implementation: the validator
 * uses `Number(value)`, while the oracle decides acceptance via a digit-only
 * regex plus a `BigInt` range comparison. A value should be accepted iff it is
 * a non-empty run of ASCII digits (no sign, decimal point, exponent,
 * whitespace, or thousands separators) whose integer value lies in
 * [LOOKBACK_MIN_MINUTES, LOOKBACK_MAX_MINUTES] inclusive. On rejection the
 * validator must report the offending value and a non-empty accepted-range
 * list, and (being pure) it never initiates an AWS call.
 */

import fc from 'fast-check';

import {
  inputValidator,
  LOOKBACK_MIN_MINUTES,
  LOOKBACK_MAX_MINUTES,
  type Result,
} from '../../../cli/lib/input-validator.js';

// --- Independent oracle ---

const MIN = BigInt(LOOKBACK_MIN_MINUTES);
const MAX = BigInt(LOOKBACK_MAX_MINUTES);

/**
 * Spec oracle: `value` denotes a whole number of minutes in the inclusive
 * accepted range. Independent of the implementation — uses a digit-only shape
 * check and a BigInt range comparison (no `Number`, so no float concerns even
 * for very large inputs).
 */
function denotesInRangeInteger(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) {
    return false;
  }
  const n = BigInt(value);
  return n >= MIN && n <= MAX;
}

/** Asserts the validator's verdict on `value` agrees with the oracle. */
function expectAgrees(value: string): void {
  const result: Result<number> = inputValidator.lookbackMinutes(value);
  if (denotesInRangeInteger(value)) {
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The narrowed value is the integer the string denotes, and is in range.
      expect(result.value).toBe(Number(value));
      expect(Number.isInteger(result.value)).toBe(true);
      expect(result.value).toBeGreaterThanOrEqual(LOOKBACK_MIN_MINUTES);
      expect(result.value).toBeLessThanOrEqual(LOOKBACK_MAX_MINUTES);
    }
  } else {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Rejection echoes the offending value and a non-empty accepted-range list.
      expect(result.invalidValue).toBe(value);
      expect(Array.isArray(result.accepted)).toBe(true);
      expect(result.accepted.length).toBeGreaterThan(0);
    }
  }
}

// --- Arbitraries ---

/** In-range integers rendered canonically (e.g. "1" … "10080"): accepted. */
const inRangeArb = fc.integer({ min: LOOKBACK_MIN_MINUTES, max: LOOKBACK_MAX_MINUTES }).map(String);

/** In-range integers with leading zeros (e.g. "007"): still denote an in-range integer. */
const inRangeLeadingZerosArb = fc
  .integer({ min: LOOKBACK_MIN_MINUTES, max: LOOKBACK_MAX_MINUTES })
  .chain((n) => fc.integer({ min: 1, max: 5 }).map((z) => '0'.repeat(z) + String(n)));

/** Zero in various digit forms: denotes 0, below the range: rejected. */
const zeroArb = fc.constantFrom('0', '00', '000', '0000');

/** Digit strings strictly above the range (up to a large finite bound): rejected. */
const aboveRangeArb = fc.integer({ min: LOOKBACK_MAX_MINUTES + 1, max: 2_147_483_647 }).map(String);

/** Very large digit strings well beyond Number precision: rejected. */
const hugeArb = fc.bigInt({ min: BigInt(LOOKBACK_MAX_MINUTES) + 1n, max: 10n ** 40n }).map(String);

/** Malformed inputs that can never match a digit-only run: always rejected. */
const malformedArb = fc.oneof(
  // Empty / whitespace-only.
  fc.constantFrom('', ' ', '   ', '\t', '\n'),
  // Decimals.
  fc.integer({ min: 1, max: 10080 }).map((n) => `${n}.0`),
  fc.constantFrom('3.5', '0.5', '1.0', '.5', '5.'),
  // Signed values.
  fc.integer({ min: 1, max: 10080 }).chain((n) => fc.constantFrom(`+${n}`, `-${n}`)),
  // Surrounding / internal whitespace around an otherwise valid number.
  fc.integer({ min: 1, max: 10080 }).chain((n) =>
    fc.constantFrom(` ${n}`, `${n} `, ` ${n} `, `\t${n}`, `${n}\n`)
  ),
  // Exponent notation.
  fc.constantFrom('1e3', '1E3', '5e0', '1e4'),
  // Thousands / underscore separators.
  fc.constantFrom('1,000', '1_000', '10,080', '1 000'),
  // Hex / radix prefixes and other non-decimal numerics.
  fc.constantFrom('0x10', '0o17', '0b101', 'Infinity', 'NaN'),
  // Arbitrary non-numeric text (filtered so it never looks like a digit run).
  fc.string({ minLength: 1, maxLength: 16 }).filter((s) => !/^[0-9]+$/.test(s))
);

describe('bt CLI - Input_Validator lookbackMinutes (property tests)', () => {
  // Feature: billing-transfer-cli, Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]
  it('accepts a value iff it is a digit-only integer in [1, 10080] (oracle agreement over arbitrary strings)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 24 }), (value) => {
        expectAgrees(value);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: billing-transfer-cli, Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]
  it('accepts canonical in-range integers and returns the parsed minutes', () => {
    fc.assert(
      fc.property(inRangeArb, (value) => {
        const result = inputValidator.lookbackMinutes(value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(Number(value));
          expect(result.value).toBeGreaterThanOrEqual(LOOKBACK_MIN_MINUTES);
          expect(result.value).toBeLessThanOrEqual(LOOKBACK_MAX_MINUTES);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: billing-transfer-cli, Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]
  it('accepts in-range integers written with leading zeros (they still denote an in-range integer)', () => {
    fc.assert(
      fc.property(inRangeLeadingZerosArb, (value) => {
        const result = inputValidator.lookbackMinutes(value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(Number(value));
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: billing-transfer-cli, Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]
  it('rejects out-of-range integers (zero, above 10080, and very large values) reporting the value', () => {
    fc.assert(
      fc.property(fc.oneof(zeroArb, aboveRangeArb, hugeArb), (value) => {
        const result = inputValidator.lookbackMinutes(value);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.invalidValue).toBe(value);
          expect(result.accepted.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  // Feature: billing-transfer-cli, Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]
  it('rejects malformed inputs (decimals, signs, whitespace, exponent, separators, non-numeric, empty)', () => {
    fc.assert(
      fc.property(malformedArb, (value) => {
        // Guard: the generator must never produce a digit-only in-range integer.
        expect(denotesInRangeInteger(value)).toBe(false);

        const result = inputValidator.lookbackMinutes(value);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.invalidValue).toBe(value);
          expect(result.accepted.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 }
    );
  });
});
