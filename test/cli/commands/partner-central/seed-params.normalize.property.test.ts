// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for {@link normalizeEnableManagementRole}, the pure
 * helper that maps a resolved `enable-management-role` value to the literal
 * string written as the SSM parameter value for
 * `bt partner-central seed-params`.
 *
 * Covers the design's Correctness Property 14: for any resolved
 * enable-management-role value — including an absent value (`undefined`),
 * near-miss case/whitespace variants, and arbitrary text — the written
 * parameter value is the string `'true'` if and only if the resolved value is
 * exactly the string `'true'`, and the string `'false'` in every other case
 * (Requirement 18.6).
 *
 * The helper is pure and total, so the property is asserted directly against it
 * without invoking the handler or any AWS client.
 */

import fc from 'fast-check';
import { normalizeEnableManagementRole } from '../../../../cli/commands/partner-central/seed-params.js';

// --- Arbitraries ------------------------------------------------------------

/**
 * Near-miss variants that are deliberately *not* the exact string `'true'`:
 * wrong case, surrounding whitespace, alternative truthy spellings, and the
 * literal `'false'`. Every one of these must normalize to `'false'`.
 */
const NEAR_MISS_VALUES: readonly string[] = [
  '',
  'TRUE',
  'True',
  'tRue',
  ' true',
  'true ',
  ' true ',
  '\ttrue',
  'true\n',
  'true1',
  '1',
  '0',
  'yes',
  'no',
  'on',
  'off',
  'false',
  'FALSE',
  'False',
];

/**
 * A value drawn from the full input space: the absent value (`undefined`), the
 * exact `'true'`, the curated near-miss variants, and arbitrary strings
 * (including unicode), per the task's `fc.oneof` mix.
 */
const valueArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant('true'),
  fc.constantFrom(...NEAR_MISS_VALUES),
  fc.string(),
  fc.string({ unit: 'binary' }),
);

// --- Property ---------------------------------------------------------------

describe('normalizeEnableManagementRole - property tests', () => {
  // Feature: billing-transfer-cli, Property 14: enable-management-role normalizes to 'true' only for an exact 'true'
  it("returns 'true' iff the input is exactly the string 'true', and 'false' for every other value (incl. undefined/garbage)", () => {
    fc.assert(
      fc.property(valueArb, (value) => {
        const result = normalizeEnableManagementRole(value);

        // Ground truth: the result is the literal 'true' exactly when the input
        // is the exact string 'true' (Req 18.6).
        const expected = value === 'true' ? 'true' : 'false';
        expect(result).toBe(expected);

        // The result is always one of the two literal strings, never anything
        // else (totality), and never echoes the input.
        expect(result === 'true' || result === 'false').toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 14: enable-management-role normalizes to 'true' only for an exact 'true'
  it("normalizes the exact string 'true' to 'true' (the only true-producing input)", () => {
    expect(normalizeEnableManagementRole('true')).toBe('true');
  });

  // Feature: billing-transfer-cli, Property 14: enable-management-role normalizes to 'true' only for an exact 'true'
  it("normalizes an absent value (undefined) to 'false'", () => {
    expect(normalizeEnableManagementRole(undefined)).toBe('false');
  });

  // Feature: billing-transfer-cli, Property 14: enable-management-role normalizes to 'true' only for an exact 'true'
  it("normalizes near-miss variants (wrong case, padded, alternative spellings) to 'false'", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NEAR_MISS_VALUES), (value) => {
        expect(normalizeEnableManagementRole(value)).toBe('false');
      }),
      { numRuns: 100 },
    );
  });
});
