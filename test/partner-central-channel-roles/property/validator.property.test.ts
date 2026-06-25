// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the Partner Central channel-roles account-id
 * validator (`isValidAccountId` / `assertValidAccountId`) in
 * `lib/stacks/channel-role-specs.ts`.
 *
 * Covers the correctness property from the design document:
 * - Property 5: Account-id validation accepts exactly 12-digit numeric strings
 *   (Requirements 6.2, 6.10, 6.11)
 *
 * The property runs a minimum of 100 iterations.
 *
 * No real AWS account number is ever hard-coded: valid ids are generated as
 * random 12-digit strings via fast-check, and invalid inputs span empty,
 * non-numeric, wrong-length, whitespace-bearing strings and non-string values.
 */

import fc from 'fast-check';

import { isValidAccountId, assertValidAccountId } from '../../../lib/stacks/channel-role-specs.js';

// --- Arbitraries ---

/** A well-formed AWS account id: exactly 12 numeric digits (never a real id). */
const validAccountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** Numeric digit strings whose length is anything except exactly 12. */
const wrongLengthDigitsArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 24 })
  .map((digits) => digits.join(''))
  .filter((s) => s.length !== 12);

/** Arbitrary strings that are not a 12-digit numeric string (often non-numeric). */
const nonNumericStringArb = fc
  .string({ minLength: 0, maxLength: 20 })
  .filter((s) => !/^\d{12}$/.test(s));

/** A valid id wrapped/interrupted with whitespace, so it no longer matches. */
const whitespaceArb = validAccountIdArb.chain((id) =>
  fc.constantFrom(
    ` ${id}`,
    `${id} `,
    ` ${id} `,
    `${id.slice(0, 6)} ${id.slice(6)}`,
    `\t${id}`,
    `${id}\n`,
    `${id.slice(0, 11)} ` // 11 digits + a space => length 12 but non-numeric
  )
);

/** Union of every kind of invalid *string* input. */
const invalidStringArb = fc.oneof(
  fc.constant(''),
  wrongLengthDigitsArb,
  nonNumericStringArb,
  whitespaceArb
);

/** Non-string values that must always be rejected. */
const nonStringArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.float(),
  // A 12-digit *number* (not a string) — must still be rejected.
  fc.constant(123456789012),
  fc.boolean(),
  fc.constant(NaN),
  fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 12 }),
  fc.object(),
  fc.record({ accountId: validAccountIdArb })
);

const LABEL = 'partnerCentralLinkedAccountId';

/**
 * The textual representation of `value` that the validator's error message is
 * expected to contain, so we can assert the offending input is identified.
 */
function representation(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value; // appears inside the quoted form in the message
  }
  // Mirror the implementation's safe-stringify fallback exactly so the computed
  // substring matches what `describeValue` produces. `String(value)` can throw
  // `TypeError: Cannot convert object to primitive value` for null-prototype
  // objects, so guard it with the same try/catch fallback chain.
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return typeof value;
    }
  }
}

describe('Partner Central channel roles - account-id validator (property tests)', () => {
  // Feature: partner-central-channel-roles, Property 5: Account-id validation accepts exactly 12-digit numeric strings
  it('accepts exactly 12-digit numeric strings and returns them from assertValidAccountId', () => {
    fc.assert(
      fc.property(validAccountIdArb, (accountId) => {
        // isValidAccountId is true iff the input is exactly 12 digits.
        expect(isValidAccountId(accountId)).toBe(true);
        // assertValidAccountId returns the validated string unchanged (fail-open path).
        expect(assertValidAccountId(accountId, LABEL)).toBe(accountId);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: partner-central-channel-roles, Property 5: Account-id validation accepts exactly 12-digit numeric strings
  it('rejects invalid strings (empty, non-numeric, wrong-length, whitespace) with an error identifying the input', () => {
    fc.assert(
      fc.property(invalidStringArb, (value) => {
        // Guard: the generator must never produce a valid 12-digit id.
        expect(/^\d{12}$/.test(value)).toBe(false);

        expect(isValidAccountId(value)).toBe(false);

        let threw = false;
        try {
          assertValidAccountId(value, LABEL);
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(Error);
          const message = (err as Error).message;
          // The error names the offending input (label + the value itself).
          expect(message).toContain(LABEL);
          expect(message).toContain(representation(value));
        }
        // A rejected input always throws (so no IAM role would be constructed).
        expect(threw).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: partner-central-channel-roles, Property 5: Account-id validation accepts exactly 12-digit numeric strings
  it('rejects non-string values (undefined, null, numbers, booleans, arrays, objects) with a descriptive error', () => {
    fc.assert(
      fc.property(nonStringArb, (value) => {
        expect(isValidAccountId(value)).toBe(false);

        let threw = false;
        try {
          assertValidAccountId(value, LABEL);
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(Error);
          const message = (err as Error).message;
          expect(message).toContain(LABEL);
          expect(message).toContain(representation(value));
        }
        expect(threw).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
