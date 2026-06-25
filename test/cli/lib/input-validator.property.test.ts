// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the `bt` CLI Input_Validator account-id check
 * (`inputValidator.accountId`) in `cli/lib/input-validator.ts`.
 *
 * Covers the design's Correctness Property:
 * - Property 2: Account IDs are accepted exactly when they are 12 digits
 *   (Requirements 5.1, 5.2, 5.7, 17.3, 18.3)
 *
 * The validator must accept a string if and only if it consists of exactly 12
 * ASCII digits (`0`-`9`) and nothing else — no whitespace, sign, separators,
 * non-digit characters, Unicode (non-ASCII) digits, or wrong length. On
 * rejection it must return a `Result` carrying the offending value and a
 * non-empty accepted-values list, and — being a pure, AWS-free function — it
 * must do so synchronously without initiating any AWS call.
 *
 * Each property runs a minimum of 100 fast-check iterations. No real AWS account
 * number is hard-coded: valid ids are generated as random 12-digit strings.
 */

import fc from 'fast-check';

import { inputValidator } from '../../../cli/lib/input-validator.js';

// The canonical acceptance oracle: exactly 12 ASCII digits, anchored. This is
// the precise accept/reject boundary the validator must implement (Req 5.1).
// JavaScript's `\d` (and this explicit `[0-9]`) matches ASCII digits only, so
// Unicode digits such as Arabic-Indic or fullwidth forms are NOT accepted.
const TWELVE_ASCII_DIGITS = /^[0-9]{12}$/;

// --- Arbitraries ---

/** A well-formed account id: exactly 12 ASCII digits (never a real id). */
const validAccountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** ASCII-digit strings whose length is anything except exactly 12. */
const wrongLengthDigitsArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 24 })
  .map((digits) => digits.join(''))
  .filter((s) => s.length !== 12);

/**
 * Length-12 strings built entirely from non-ASCII Unicode "digit" characters
 * (Arabic-Indic, Devanagari, and fullwidth forms). These look numeric but must
 * be rejected because `\d`/`[0-9]` matches ASCII only (Req 5.1, 5.2).
 */
const unicodeDigitsArb = fc
  .array(
    fc.constantFrom(
      '\u0660', '\u0661', '\u0662', '\u0663', '\u0664', // Arabic-Indic ٠-٤
      '\u0669', // Arabic-Indic ٩
      '\u0966', '\u0967', '\u096F', // Devanagari ०-१, ९
      '\uFF10', '\uFF11', '\uFF15', '\uFF19', // Fullwidth ０１５９
    ),
    { minLength: 12, maxLength: 12 },
  )
  .map((chars) => chars.join(''));

/**
 * Length-12 strings that are a valid id with exactly one digit replaced by a
 * non-(ASCII-digit) character: signs, separators, whitespace, letters, and
 * Unicode digits. Correct length, but must be rejected (Req 5.2).
 */
const oneCharCorruptedArb = validAccountIdArb.chain((id) =>
  fc
    .tuple(
      fc.integer({ min: 0, max: 11 }),
      fc.constantFrom('+', '-', ' ', '.', ',', '_', '/', 'a', 'Z', '\t', '\n', '\u0660', '\uFF10'),
    )
    .map(([i, ch]) => id.slice(0, i) + ch + id.slice(i + 1)),
);

/**
 * A valid id decorated with leading/trailing/embedded whitespace, signs, or
 * separators. Mix of length-12 (e.g. 11 digits + a space) and longer strings,
 * all of which must be rejected (Req 5.1, 5.2).
 */
const decoratedArb = validAccountIdArb.chain((id) =>
  fc.constantFrom(
    ` ${id}`,
    `${id} `,
    ` ${id} `,
    `\t${id}`,
    `${id}\n`,
    `+${id}`,
    `-${id}`,
    `${id.slice(0, 6)} ${id.slice(6)}`, // embedded space, length 13
    `${id.slice(0, 4)},${id.slice(4)}`, // embedded comma, length 13
    `${id.slice(0, 3)}-${id.slice(3)}`, // embedded dash, length 13
    `${id.slice(0, 11)} `, // 11 digits + a space => length 12 but non-numeric
  ),
);

/**
 * Union covering the entire input space: valid ids plus every flavor of invalid
 * input, plus arbitrary/Unicode strings so the accept/reject boundary is
 * exercised across unconstrained text. Re-checking `result.ok` against the
 * regex oracle proves the "if and only if" precisely on whatever is generated.
 */
const anyStringArb = fc.oneof(
  validAccountIdArb,
  wrongLengthDigitsArb,
  unicodeDigitsArb,
  oneCharCorruptedArb,
  decoratedArb,
  fc.string({ minLength: 0, maxLength: 20 }),
  fc.string({ unit: 'binary', minLength: 0, maxLength: 20 }),
);

describe('bt CLI Input_Validator - account-id validation (property tests)', () => {
  // Feature: billing-transfer-cli, Property 2: Account IDs are accepted exactly when they are 12 digits
  it('accepts a string iff it is exactly 12 ASCII digits (precise accept/reject boundary)', () => {
    fc.assert(
      fc.property(anyStringArb, (value) => {
        const result = inputValidator.accountId(value);
        const expectedAccept = TWELVE_ASCII_DIGITS.test(value);

        // The validator's verdict matches the canonical oracle exactly (iff).
        expect(result.ok).toBe(expectedAccept);

        if (result.ok) {
          // On accept, the validated value is returned unchanged.
          expect(result.value).toBe(value);
        } else {
          // On reject, the offending value and a non-empty accepted list are
          // reported so the Error_Reporter can render them (Req 5.7).
          expect(result.invalidValue).toBe(value);
          expect(Array.isArray(result.accepted)).toBe(true);
          expect(result.accepted.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 2: Account IDs are accepted exactly when they are 12 digits
  it('accepts every well-formed 12-ASCII-digit string and returns it unchanged', () => {
    fc.assert(
      fc.property(validAccountIdArb, (accountId) => {
        // Guard: the generator only ever produces canonical 12-digit ids.
        expect(TWELVE_ASCII_DIGITS.test(accountId)).toBe(true);

        const result = inputValidator.accountId(accountId);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(accountId);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: billing-transfer-cli, Property 2: Account IDs are accepted exactly when they are 12 digits
  it('rejects malformed inputs (wrong length, non-digits, Unicode digits, whitespace, signs, separators) without initiating any AWS call', () => {
    const invalidArb = fc
      .oneof(
        fc.constant(''),
        wrongLengthDigitsArb,
        unicodeDigitsArb,
        oneCharCorruptedArb,
        decoratedArb,
        fc.string({ minLength: 0, maxLength: 20 }),
      )
      // Keep only genuinely invalid inputs (the broad string arb could, very
      // rarely, emit a valid 12-digit id).
      .filter((s) => !TWELVE_ASCII_DIGITS.test(s));

    fc.assert(
      fc.property(invalidArb, (value) => {
        // The validator is a pure, synchronous, AWS-free function: it returns a
        // plain Result (never a Promise), so a rejection cannot have initiated
        // any AWS/network call (Req 5.2, 5.7).
        const result = inputValidator.accountId(value);
        expect(result).not.toBeInstanceOf(Promise);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.invalidValue).toBe(value);
          expect(result.accepted.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
