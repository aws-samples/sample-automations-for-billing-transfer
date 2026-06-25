// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for the value-source precedence of
 * `bt partner-central seed-params` (Requirement 18.4).
 *
 * Covers the design's Correctness Property 15: for any combination of
 * present/absent values from the command option, the environment variable, and
 * the repository-root `.env` file, the pure {@link resolveValue} helper returns
 * the value from the first source — in the fixed order option → environment →
 * `.env` — that provides a non-empty value, tagging it with the matching
 * `source`; when every source is empty/absent it returns
 * `{ value: '', source: 'none' }`.
 *
 * `resolveValue` is pure, synchronous, and AWS-free (no SDK clients, nothing
 * awaited), so it is exercised directly without invoking the handler. Each of
 * the three sources is generated independently from
 * `fc.oneof(undefined, '', nonEmptyString)` so all 3^3 = 27 presence
 * combinations are covered across runs.
 */

import fc from 'fast-check';
import {
  resolveValue,
  ResolvedValue,
  ValueSource,
} from '../../../../cli/commands/partner-central/seed-params.js';

// --- Arbitraries ------------------------------------------------------------

/**
 * A non-empty value: any string with at least one character (the only kind of
 * value that "counts" as provided). Includes whitespace-bearing strings because
 * `resolveValue` performs no trimming — a non-zero-length string is provided.
 */
const nonEmptyString: fc.Arbitrary<string> = fc.string({ minLength: 1 });

/**
 * A single source slot: `undefined` (absent) or `''` (empty) — both treated as
 * "not provided" — or a non-empty string that counts as provided. Drawing each
 * of the three sources from this arbitrary independently exercises every
 * presence combination (absent / empty / present) per source.
 */
const sourceArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  nonEmptyString,
);

/** True when a source slot counts as provided (non-undefined, non-empty). */
function isProvided(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * Reference implementation of the precedence rule, written independently of the
 * production code: the first provided source in order option → env → dotenv,
 * else the `'none'` sentinel.
 */
function expectedResolution(
  option: string | undefined,
  env: string | undefined,
  dotenvValue: string | undefined,
): ResolvedValue {
  if (isProvided(option)) return { value: option, source: 'option' };
  if (isProvided(env)) return { value: env, source: 'env' };
  if (isProvided(dotenvValue)) return { value: dotenvValue, source: 'dotenv' };
  return { value: '', source: 'none' };
}

// --- Property ---------------------------------------------------------------

describe('seed-params value-source precedence - property tests', () => {
  // Feature: billing-transfer-cli, Property 15: Value resolution selects the first non-empty source in precedence order
  it('returns the first non-empty source in order option > env > .env, with the matching source tag', () => {
    fc.assert(
      fc.property(sourceArb, sourceArb, sourceArb, (option, env, dotenvValue) => {
        const result = resolveValue(option, env, dotenvValue);

        // Pure and synchronous: the resolution initiates no AWS call (Req 18.4).
        expect(result).not.toBeInstanceOf(Promise);

        // The resolved value/source equals the first-provided-source rule.
        const expected = expectedResolution(option, env, dotenvValue);
        expect(result).toEqual(expected);

        // Spell out the precedence consequences as cross-checks.
        if (isProvided(option)) {
          // Highest precedence: option always wins when provided, regardless of
          // whatever env / .env hold.
          expect(result).toEqual({ value: option, source: 'option' });
        } else if (isProvided(env)) {
          // env wins only when option is absent/empty.
          expect(result).toEqual({ value: env, source: 'env' });
        } else if (isProvided(dotenvValue)) {
          // .env is the lowest-precedence fallback.
          expect(result).toEqual({ value: dotenvValue, source: 'dotenv' });
        } else {
          // All three empty/absent => the explicit 'none' sentinel.
          expect(result).toEqual({ value: '', source: 'none' });
        }

        // The reported source is always one of the four discriminants, and a
        // non-'none' source carries a genuinely non-empty value.
        const validSources: ValueSource[] = ['option', 'env', 'dotenv', 'none'];
        expect(validSources).toContain(result.source);
        if (result.source === 'none') {
          expect(result.value).toBe('');
        } else {
          expect(result.value.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
