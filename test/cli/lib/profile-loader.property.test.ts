// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Feature: billing-transfer-cli, Property 1: Profile parsing produces clean, ordered, idempotent output

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the Profile_Loader pure parser (`parseProfiles`).
 *
 * Property 1: Profile parsing produces clean, ordered, idempotent output
 *   - clean: every parsed profile is non-empty, carries no surrounding
 *     whitespace, does not start with `#`, and retains no inline-comment marker
 *     (whitespace followed by `#`) — i.e. blank/comment-only lines are dropped
 *     and inline `# comment` suffixes are stripped (Req 4.1, 4.5, 4.6).
 *   - ordered: the parsed profiles appear in the same order as their source
 *     lines in the file (Req 4.1).
 *   - idempotent: joining the parsed profiles back into file contents and
 *     re-parsing yields the identical list (Req 4.4 — the resolved profile name
 *     contains no comment text and no surrounding whitespace, so a second pass
 *     is a no-op).
 *
 * Validates: Requirements 4.1, 4.4, 4.5
 */

import fc from 'fast-check';

import { parseProfiles } from '../../../cli/lib/profile-loader.js';

// ---------------------------------------------------------------------------
// Cleanliness predicate — the observable contract for a single parsed profile.
// ---------------------------------------------------------------------------

/**
 * A parsed profile is "clean" when it is:
 *  - non-empty,
 *  - free of leading/trailing whitespace (equal to its own trim),
 *  - not a comment line (does not start with `#`), and
 *  - free of any residual inline-comment marker (no whitespace directly
 *    followed by `#`, which is what the parser strips).
 *
 * A bare `#` not preceded by whitespace (e.g. `my#profile`) is intentionally
 * allowed: the shell pipeline only treats `\s+#` as an inline comment.
 */
const isClean = (profile: string): boolean =>
  profile.length > 0 &&
  profile === profile.trim() &&
  !profile.startsWith('#') &&
  !/\s#/.test(profile);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Inline whitespace (spaces/tabs only; never a line separator). */
const wsArb = fc.stringMatching(/^[ \t]{1,4}$/);

/** Optional inline whitespace (may be empty). */
const optWsArb = fc.stringMatching(/^[ \t]{0,4}$/);

/**
 * A canonical AWS profile name: non-empty, no whitespace, no `#`. Because it
 * contains neither whitespace nor a comment marker, parsing a line built around
 * it must return exactly this token.
 */
const cleanNameArb = fc.stringMatching(/^[A-Za-z0-9._:/+=-]{1,24}$/);

/** Free text for comments, with line separators removed so it stays one line. */
const commentTextArb = fc.string({ maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, ' '));

/**
 * A line that parses to exactly one known profile. Wraps a clean name with
 * optional leading whitespace and either an inline `# comment` (always preceded
 * by whitespace so it is recognized as a comment) or optional trailing
 * whitespace. The `name` is the value the parser must yield.
 */
const profileLineArb: fc.Arbitrary<{ line: string; name: string }> = fc
  .tuple(
    optWsArb,
    cleanNameArb,
    fc.option(fc.tuple(wsArb, commentTextArb), { nil: undefined }),
    optWsArb,
  )
  .map(([leadWs, name, inlineComment, trailWs]) => {
    const suffix =
      inlineComment !== undefined
        ? `${inlineComment[0]}#${inlineComment[1]}`
        : trailWs;
    return { line: `${leadWs}${name}${suffix}`, name };
  });

/** A line that parses to nothing: blank/whitespace-only or comment-only. */
const noiseLineArb: fc.Arbitrary<string> = fc.oneof(
  // Blank or whitespace-only line.
  fc.stringMatching(/^[ \t]*$/),
  // Comment-only line: optional leading whitespace then `#` then free text.
  fc.tuple(optWsArb, commentTextArb).map(([leadWs, text]) => `${leadWs}#${text}`),
);

/**
 * A document built from an ordered mix of profile lines and noise lines,
 * carrying the expected ordered list of profile names alongside the raw text.
 */
const documentArb: fc.Arbitrary<{ contents: string; expected: string[] }> = fc
  .array(
    fc.oneof(
      profileLineArb.map((p) => ({ kind: 'profile' as const, ...p })),
      noiseLineArb.map((line) => ({ kind: 'noise' as const, line })),
    ),
    { maxLength: 25 },
  )
  .map((items) => ({
    contents: items.map((item) => item.line).join('\n'),
    expected: items.filter((i) => i.kind === 'profile').map((i) => i.name),
  }));

/**
 * Unstructured fuzz content drawn from a small alphabet rich in the characters
 * that matter to the parser (`#`, spaces, tabs, and newlines), to exercise
 * cleanliness and idempotency across the whole input space.
 */
const fuzzCharArb = fc.constantFrom(
  'a', 'B', 'z', '0', '9', '#', ' ', '\t', '.', '-', '_', '/', ':', '+',
);
const fuzzLineArb = fc.array(fuzzCharArb, { maxLength: 14 }).map((cs) => cs.join(''));
const fuzzContentArb = fc.array(fuzzLineArb, { maxLength: 14 }).map((lines) => lines.join('\n'));

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe('Property 1: Profile parsing produces clean, ordered, idempotent output', () => {
  it('drops blanks/comments, strips inline comments, preserves order, and is idempotent', () => {
    fc.assert(
      fc.property(documentArb, ({ contents, expected }) => {
        const parsed = parseProfiles(contents);

        // ordered + complete: exactly the intended names, in file order.
        expect(parsed).toEqual(expected);

        // clean: each parsed profile satisfies the observable contract.
        for (const profile of parsed) {
          expect(isClean(profile)).toBe(true);
        }

        // idempotent: re-parsing the joined output is a no-op.
        expect(parseProfiles(parsed.join('\n'))).toEqual(parsed);
      }),
      { numRuns: 200 },
    );
  });

  it('yields only clean profiles and is idempotent for arbitrary file contents', () => {
    fc.assert(
      fc.property(fuzzContentArb, (contents) => {
        const parsed = parseProfiles(contents);

        // clean: holds for every parsed element regardless of input shape.
        for (const profile of parsed) {
          expect(isClean(profile)).toBe(true);
        }

        // idempotent: a second parse over the joined output changes nothing.
        expect(parseProfiles(parsed.join('\n'))).toEqual(parsed);
      }),
      { numRuns: 200 },
    );
  });
});
