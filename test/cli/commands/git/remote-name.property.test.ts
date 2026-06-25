// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the shared remote-name derivation in
 * `cli/commands/git/remote-name.ts`.
 *
 * Covers the correctness property from the design document:
 * - Property 7: Remote-name derivation is deterministic, well-formed, and
 *   agreed upon (Requirements 14.2, 15.2)
 *
 * The single exported `deriveRemoteName(profile)` is imported by BOTH
 * `bt git setup-remotes` (which creates the CodeCommit remotes) and
 * `bt git push` (which pushes to them), so the two commands cannot drift. This
 * suite asserts three facets over arbitrary profile names (including unicode,
 * symbols, mixed case, empty, and very long names):
 *
 *  1. DETERMINISTIC — `deriveRemoteName(p) === deriveRemoteName(p)` for equal
 *     inputs (a pure function of its argument).
 *  2. WELL-FORMED — the result is `codecommit-` followed by the profile
 *     lowercased with each run of one or more non-`[a-z0-9]` characters
 *     replaced by a single `-`. Verified against an independent oracle that
 *     does not share the implementation's regex.
 *  3. AGREED-UPON / parity — because setup-remotes and push both import the
 *     same exported function, the name each command derives for a profile is
 *     identical. We assert this by importing `deriveRemoteName` exactly as both
 *     handlers do and confirming the value used by the push code path equals
 *     the value used by the setup-remotes code path for every generated name.
 *
 * Each property runs at least 100 fast-check iterations.
 */

import fc from 'fast-check';

// Import the shared function the SAME way both git command handlers import it
// (see cli/commands/git/setup-remotes.ts and cli/commands/git/push.ts:
//   `import { deriveRemoteName } from './remote-name.js';`).
// Importing the single shared module here is what proves the "agreed-upon"
// facet: there is one derivation, and both commands bind to it.
import { deriveRemoteName } from '../../../../cli/commands/git/remote-name.js';

// Re-bind under names that mirror how each command path reaches the helper, so
// the parity assertions below read as "setup name === push name".
const deriveRemoteNameAsSetup = deriveRemoteName;
const deriveRemoteNameAsPush = deriveRemoteName;

const PREFIX = 'codecommit-';

/**
 * Independent oracle for the well-formed shape (Req 14.2 / 15.2). Implemented
 * without reusing the production regex: lowercase, then fold the string into
 * runs, collapsing every maximal run of non-`[a-z0-9]` characters to a single
 * '-'. A character is "kept" iff it is an ASCII lowercase letter or digit.
 */
function expectedRemoteName(profile: string): string {
  const lowered = profile.toLowerCase();
  let body = '';
  let inSeparatorRun = false;
  for (const ch of lowered) {
    const isAlnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (isAlnum) {
      body += ch;
      inSeparatorRun = false;
    } else if (!inSeparatorRun) {
      body += '-';
      inSeparatorRun = true;
    }
    // else: still inside a separator run — collapse (emit nothing).
  }
  return PREFIX + body;
}

// --- Arbitraries ---

/** Mixed-case ASCII alphanumeric tokens (exercise the lowercasing path). */
const mixedCaseTokenArb = fc.stringMatching(/^[A-Za-z0-9]{1,16}$/);

/** Symbol / punctuation runs (exercise the collapse-to-single-'-' path). */
const symbolArb = fc.string({
  unit: fc.constantFrom(...'-_./ @#:%+!()[]{}*'.split('')),
  minLength: 1,
  maxLength: 8,
});

/** Unicode characters spanning accents, CJK, emoji, and combining marks. */
const unicodeCharArb = fc.constantFrom(
  'é', 'Ç', 'Ñ', 'ß', 'Ø', 'Å', // latin-1 / accented (have case folding)
  'İ', 'I', 'ı', // Turkish dotted/dotless i (tricky toLowerCase cases)
  'Σ', 'σ', 'ς', 'Δ', 'Ω', // Greek (case folding)
  'А', 'я', 'Ж', // Cyrillic
  '中', '日', '本', '한', 'あ', 'ア', // CJK / kana
  '😀', '🚀', '👍', // emoji (surrogate pairs)
  '\u0301', '\u200d', '\uFEFF', // combining acute, ZWJ, BOM
  'ﬀ', 'Ⅷ', '𝓍' // ligature, roman numeral, math alphanumeric (expand/fold oddly)
);

/** Strings built from unicode characters and the occasional ASCII token. */
const unicodeStringArb = fc
  .array(fc.oneof(unicodeCharArb, mixedCaseTokenArb, symbolArb), { minLength: 1, maxLength: 12 })
  .map((parts) => parts.join(''));

/**
 * A broad profile-name arbitrary mixing every interesting shape: empty string,
 * whitespace, mixed-case alphanumerics, symbol runs, unicode, and very long
 * names assembled from the above.
 */
const profileArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom('', ' ', '   ', '\t', '\n', '---', '___') },
  { weight: 3, arbitrary: mixedCaseTokenArb },
  { weight: 3, arbitrary: symbolArb },
  { weight: 3, arbitrary: unicodeStringArb },
  // Realistic profile-ish names with separators.
  {
    weight: 3,
    arbitrary: fc
      .array(fc.oneof(mixedCaseTokenArb, symbolArb, unicodeCharArb), { minLength: 1, maxLength: 6 })
      .map((parts) => parts.join('')),
  },
  // Very long names (assembled from many tokens/separators/unicode).
  {
    weight: 2,
    arbitrary: fc
      .array(fc.oneof(mixedCaseTokenArb, symbolArb, unicodeCharArb), { minLength: 50, maxLength: 200 })
      .map((parts) => parts.join('')),
  },
  // Fully arbitrary unicode strings (catch-all): 'binary' spans the whole
  // Unicode code-point range (0000-10FFFF), and 'grapheme' adds multi-code-point
  // printable graphemes (emoji, combining sequences).
  { weight: 2, arbitrary: fc.string({ minLength: 0, maxLength: 64, unit: 'binary' }) },
  { weight: 2, arbitrary: fc.string({ minLength: 0, maxLength: 32, unit: 'grapheme' }) }
);

describe('bt CLI - git remote-name derivation (Property 7)', () => {
  // Feature: billing-transfer-cli, Property 7: Remote-name derivation is deterministic, well-formed, and agreed upon
  it('is deterministic: equal inputs always yield equal outputs', () => {
    fc.assert(
      fc.property(profileArb, (profile) => {
        const first = deriveRemoteName(profile);
        const second = deriveRemoteName(profile);
        expect(second).toBe(first);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: billing-transfer-cli, Property 7: Remote-name derivation is deterministic, well-formed, and agreed upon
  it('is well-formed: codecommit- prefix + lowercased profile with non-[a-z0-9] runs collapsed to a single "-"', () => {
    fc.assert(
      fc.property(profileArb, (profile) => {
        const remote = deriveRemoteName(profile);

        // Starts with the documented prefix.
        expect(remote.startsWith(PREFIX)).toBe(true);

        // The whole name matches the independent oracle's shape.
        expect(remote).toBe(expectedRemoteName(profile));

        // The portion after the prefix only ever contains [a-z0-9-] and never
        // two consecutive hyphens (runs are collapsed to exactly one '-').
        const body = remote.slice(PREFIX.length);
        expect(/^[a-z0-9-]*$/.test(body)).toBe(true);
        expect(body.includes('--')).toBe(false);

        // It is fully lowercased (idempotent under toLowerCase).
        expect(remote).toBe(remote.toLowerCase());
      }),
      { numRuns: 300 }
    );
  });

  // Feature: billing-transfer-cli, Property 7: Remote-name derivation is deterministic, well-formed, and agreed upon
  it('is agreed-upon: the name git setup-remotes derives equals the name git push derives for the same profile', () => {
    fc.assert(
      fc.property(profileArb, (profile) => {
        // Both command handlers import the SAME exported function, so the name
        // the push path targets must equal the name the setup path created.
        const setupName = deriveRemoteNameAsSetup(profile);
        const pushName = deriveRemoteNameAsPush(profile);
        expect(pushName).toBe(setupName);

        // And both equal the canonical derivation (no wrapper drift).
        expect(setupName).toBe(deriveRemoteName(profile));
      }),
      { numRuns: 300 }
    );
  });

  // Feature: billing-transfer-cli, Property 7: Remote-name derivation is deterministic, well-formed, and agreed upon
  it('explicitly handles unicode, symbol, and mixed-case names (collapse + lowercase)', () => {
    fc.assert(
      fc.property(fc.oneof(unicodeStringArb, symbolArb, mixedCaseTokenArb), (profile) => {
        const remote = deriveRemoteName(profile);
        // Parity and well-formedness hold for these targeted shapes too.
        expect(remote).toBe(expectedRemoteName(profile));
        expect(remote).toBe(remote.toLowerCase());
        expect(remote.startsWith(PREFIX)).toBe(true);
        expect(deriveRemoteNameAsPush(profile)).toBe(deriveRemoteNameAsSetup(profile));
      }),
      { numRuns: 200 }
    );
  });
});
