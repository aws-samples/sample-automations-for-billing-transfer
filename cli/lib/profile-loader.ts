// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Profile_Loader — resolves and parses the Profile_List_File for fleet
 * (multi-account) operations of the `bt` CLI (Requirement 4).
 *
 * This module ports `scripts/lib/profiles.sh` to TypeScript, with the single
 * path-resolution delta agreed in the design: the default Profile_List_File is
 * `./payer-profiles.txt` resolved relative to the current working directory
 * (`ctx.cwd`) rather than the legacy `scripts/payer-profiles.txt`, so the CLI
 * can be run from anywhere (design "Requirements Deltas (a)").
 *
 * Three responsibilities, split so the pure logic is unit/property testable
 * without touching the filesystem:
 *
 *  - {@link parseProfiles}: pure parser mirroring the shell pipeline
 *    `grep -vE '^[[:space:]]*(#|$)' | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'`
 *    (Req 4.1, 4.5, 4.6) — drop blank and comment-only lines, strip inline
 *    `# comments`, trim surrounding whitespace, and preserve file order.
 *  - {@link resolvePath}: pure resolver applying the precedence
 *    `--profiles-file` option → `$PAYER_PROFILES_FILE` → `<cwd>/payer-profiles.txt`
 *    (Req 4.2, 4.3, 4.4).
 *  - {@link load}: reads the resolved file and parses it, throwing a
 *    {@link ProfileListError} on a missing file (Req 4.7), an unreadable file
 *    (Req 4.9), or zero profiles after parsing (Req 4.8).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
 *
 * @module profile-loader
 */

import * as fs from 'fs';
import * as path from 'path';

import type { GlobalOptions, IoContext } from './io-context.js';

/**
 * Why a Profile_List_File could not be turned into a usable profile list.
 *
 * - `not-found`: the resolved file does not exist (Req 4.7).
 * - `unreadable`: the file exists but could not be read; never conflated with
 *   `not-found` (Req 4.9).
 * - `empty`: the file was read but yielded zero profiles after parsing (Req 4.8).
 */
export type ProfileListErrorReason = 'not-found' | 'unreadable' | 'empty';

/**
 * Error thrown by {@link load} when the Profile_List_File cannot be resolved
 * into at least one AWS profile name.
 *
 * Carries the {@link ProfileListErrorReason}, the resolved file `path`, and a
 * `remediation` hint so the Error_Reporter can present an actionable message on
 * stderr and the CLI can exit with a non-zero status code (Req 4.7, 4.8, 4.9).
 * The `reason` lets callers distinguish a missing file from a read failure
 * without inspecting the message text (Req 4.9).
 */
export class ProfileListError extends Error {
  /** The category of failure (drives messaging and keeps the cases distinct). */
  readonly reason: ProfileListErrorReason;
  /** The resolved Profile_List_File path that failed. */
  readonly path: string;
  /** A user-facing next step describing how to resolve the failure. */
  readonly remediation: string;
  /** The underlying error, when the failure wraps one (e.g. a read error). */
  readonly cause?: unknown;

  constructor(args: {
    reason: ProfileListErrorReason;
    path: string;
    message: string;
    remediation: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'ProfileListError';
    this.reason = args.reason;
    this.path = args.path;
    this.remediation = args.remediation;
    this.cause = args.cause;
    // Restore the prototype chain so `instanceof ProfileListError` works after
    // transpilation to ES2020/CommonJS.
    Object.setPrototypeOf(this, ProfileListError.prototype);
  }
}

/**
 * The Profile_Loader contract: a pure parser, a pure resolver, and the
 * filesystem-backed `load` that composes them.
 */
export interface ProfileLoader {
  /**
   * Resolve the Profile_List_File, read it, and parse it into an ordered list
   * of AWS profile names.
   *
   * @throws {@link ProfileListError} when the file is missing (`not-found`),
   * unreadable (`unreadable`), or yields zero profiles (`empty`).
   */
  load(global: GlobalOptions, ctx: IoContext): string[];

  /** Pure parser exposed for property tests (no filesystem access). */
  parseProfiles(fileContents: string): string[];

  /** Pure resolver exposed for unit tests (no filesystem access). */
  resolvePath(global: GlobalOptions, ctx: IoContext): string;
}

/** Default Profile_List_File name, resolved relative to `ctx.cwd` (Req 4.4). */
const DEFAULT_PROFILE_LIST_FILENAME = 'payer-profiles.txt';

/**
 * Parse the raw contents of a Profile_List_File into an ordered list of AWS
 * profile names (Req 4.1, 4.5, 4.6).
 *
 * Mirrors the legacy shell pipeline exactly, per line:
 *  1. Left-trim the line; drop it when it is now empty (blank line) or begins
 *     with `#` (comment-only line) — equivalent to
 *     `grep -vE '^[[:space:]]*(#|$)'` (Req 4.5).
 *  2. Strip an inline comment, defined as whitespace followed by `#` through
 *     end of line, then trim the surviving text so the profile name carries no
 *     comment text and no surrounding whitespace — equivalent to
 *     `sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'`, and removing leading
 *     whitespace as well per Req 4.6.
 *
 * File order is preserved (Req 4.1). A `#` that is not preceded by whitespace
 * (for example `my#profile`) is treated as part of the name, matching the shell
 * `[[:space:]]+#` rule.
 *
 * @param fileContents - Raw UTF-8 contents of the Profile_List_File.
 * @returns Ordered AWS profile names with blanks/comments removed.
 */
export function parseProfiles(fileContents: string): string[] {
  const profiles: string[] = [];
  for (const rawLine of fileContents.split(/\r?\n/)) {
    // Step 1: drop blank and comment-only lines (after ignoring leading space).
    const leftTrimmed = rawLine.replace(/^\s+/, '');
    if (leftTrimmed === '' || leftTrimmed.startsWith('#')) {
      continue;
    }
    // Step 2: strip an inline `# comment` (whitespace + '#' to EOL), then trim.
    const profile = leftTrimmed.replace(/\s+#.*$/, '').trim();
    if (profile !== '') {
      profiles.push(profile);
    }
  }
  return profiles;
}

/**
 * Resolve the Profile_List_File path using the fixed precedence
 * `--profiles-file` → `$PAYER_PROFILES_FILE` → `<cwd>/payer-profiles.txt`
 * (Req 4.2, 4.3, 4.4).
 *
 * The `--profiles-file` option wins whenever it is provided as a non-empty
 * value (Req 4.2). Otherwise `$PAYER_PROFILES_FILE` is used when set to a
 * non-empty value (Req 4.3); when it is unset or empty, the default
 * `payer-profiles.txt` is used (Req 4.4). The chosen candidate is resolved
 * against `ctx.cwd`, so a relative option/env path or the default all anchor to
 * the current working directory while an absolute path is honored as-is.
 *
 * @returns An absolute Profile_List_File path.
 */
export function resolvePath(global: GlobalOptions, ctx: IoContext): string {
  const optionPath = global.profilesFile;
  if (typeof optionPath === 'string' && optionPath !== '') {
    // nosemgrep: path-join-resolve-traversal -- operator-supplied profile-list path from a trusted CLI flag, resolved against cwd; not external/untrusted input.
    return path.resolve(ctx.cwd, optionPath);
  }

  const envPath = ctx.env.PAYER_PROFILES_FILE;
  if (typeof envPath === 'string' && envPath !== '') {
    // nosemgrep: path-join-resolve-traversal -- operator-supplied profile-list path from a trusted env var, resolved against cwd; not external/untrusted input.
    return path.resolve(ctx.cwd, envPath);
  }

  // nosemgrep: path-join-resolve-traversal -- joins a hardcoded default filename to cwd; no external input.
  return path.resolve(ctx.cwd, DEFAULT_PROFILE_LIST_FILENAME);
}

/**
 * Resolve the Profile_List_File, read it from disk, and parse it into an
 * ordered list of AWS profile names.
 *
 * Fails fast, never operating on partially read data (Req 4.9):
 *  - A missing file raises a `not-found` {@link ProfileListError} explaining how
 *    to create the list, and the Fleet_Operation must halt before processing any
 *    account (Req 4.7).
 *  - A file that exists but cannot be read raises an `unreadable`
 *    {@link ProfileListError} — explicitly distinct from `not-found` (Req 4.9).
 *  - A file that yields zero profiles after parsing raises an `empty`
 *    {@link ProfileListError} (Req 4.8).
 *
 * @returns Ordered, non-empty AWS profile names.
 * @throws {@link ProfileListError} on any of the above conditions.
 */
export function load(global: GlobalOptions, ctx: IoContext): string[] {
  const filePath = resolvePath(global, ctx);

  let contents: string;
  try {
    // nosemgrep: detect-non-literal-fs-filename -- filePath derived from a trusted CLI flag/env/default profile-list path, not external input.
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProfileListError({
        reason: 'not-found',
        path: filePath,
        message: `Profile list not found: ${filePath}`,
        remediation:
          'Create it with one AWS profile name per line (blank lines and lines ' +
          'starting with "#" are ignored), or set PAYER_PROFILES_FILE to point at your list.',
        cause: error,
      });
    }
    throw new ProfileListError({
      reason: 'unreadable',
      path: filePath,
      message: `Profile list could not be read: ${filePath}`,
      remediation:
        'Check the file permissions and that the path refers to a readable file, then try again.',
      cause: error,
    });
  }

  const profiles = parseProfiles(contents);
  if (profiles.length === 0) {
    throw new ProfileListError({
      reason: 'empty',
      path: filePath,
      message: `No AWS profiles found in profile list: ${filePath}`,
      remediation:
        'Add at least one AWS profile name (one per line). Blank lines and lines starting ' +
        'with "#" are ignored.',
    });
  }

  return profiles;
}

/**
 * Concrete Profile_Loader implementation wiring the pure parser/resolver to the
 * filesystem-backed loader. Provided as a single injectable object so handlers
 * and tests can depend on the {@link ProfileLoader} interface.
 */
export const profileLoader: ProfileLoader = {
  load,
  parseProfiles,
  resolvePath,
};
