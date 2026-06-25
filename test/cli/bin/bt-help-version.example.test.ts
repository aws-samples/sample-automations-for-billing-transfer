// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, jest } from '@jest/globals';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));
/**
 * Entrypoint example tests for help, version, and the command-group listing
 * (Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 2.7, 2.8).
 *
 * The `bt` entrypoint (`cli/bin/bt.ts`) parses `process.argv` and owns the single
 * `process.exit` site, so the cleanest way to pin down its real stdout/stderr/
 * exit-code contract is to spawn it exactly as a user would and assert on the
 * observed streams. Each case spawns `tsx cli/bin/bt.ts <args>` as a child
 * process (no stubbing of commander), captures stdout/stderr/status, and asserts
 * the discoverability behavior the requirements promise:
 *
 *  - `--version` prints the `package.json` version to stdout, exit 0 (Req 1.6).
 *  - `--help` and the no-Command invocation both print the Command_Group listing
 *    to stdout, exit 0, and the listing contains EXACTLY the six groups
 *    `transfers`, `reconciliation`, `fleet`, `git`, `partner-central`, `test`,
 *    each exactly once and nothing else (Req 1.2, 1.3, 2.7, 2.8).
 *  - A Command_Group `--help` (e.g. `transfers --help`) lists that group's
 *    Commands on stdout, exit 0 (Req 1.4).
 *  - A Command `--help` (e.g. `transfers analyze --help`) prints the Command's
 *    usage and at least one usage example on stdout, exit 0 (Req 1.5).
 *  - `bt help profiles` prints the profiles help topic to stdout, exit 0 (Req 2).
 *
 * Spawning `tsx` is comparatively slow, so the case count is kept tight and the
 * suite is given an extended timeout.
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 2.7, 2.8
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Repo root is three levels up from test/cli/bin/.
const REPO_ROOT = path.resolve(__dirname, '../../../');
const BT_ENTRY = path.join(REPO_ROOT, 'cli', 'bin', 'bt.ts');
const TSX_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

// The six Command_Groups the CLI must expose (Req 2.1-2.6); the listing rule
// (Req 2.7/2.8) requires exactly these, each once, and nothing else.
const EXPECTED_GROUPS = ['transfers', 'reconciliation', 'fleet', 'git', 'partner-central', 'test'];

/** Spawning a fresh `tsx` process per case is slow; allow generous headroom. */
const SPAWN_TIMEOUT_MS = 60_000;
jest.setTimeout(120_000);

interface BtResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Spawn `tsx cli/bin/bt.ts <args>` from the repo root and capture the result. */
function runBt(args: string[]): BtResult {
  const result = spawnSync(TSX_BIN, [BT_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    // No stdin; help/version/listing paths never read it.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/**
 * Extract the Command_Group tokens from a root/no-Command help listing. Commander
 * renders one entry per group under the `Commands:` heading as `  <name> ...`;
 * long descriptions wrap onto continuation lines that are indented far deeper, so
 * a leading exactly-two-space + lowercase-name match isolates the group tokens
 * without being fooled by wrapping. The hidden `help` topic is intentionally not
 * listed, so it must not appear here.
 */
function extractGroupListing(stdout: string): string[] {
  const commandsIndex = stdout.indexOf('Commands:');
  expect(commandsIndex).toBeGreaterThanOrEqual(0);
  const section = stdout.slice(commandsIndex);
  const tokens: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^ {2}([a-z][a-z-]*)\b/.exec(line);
    if (match) {
      tokens.push(match[1]);
    }
  }
  return tokens;
}

/** The version string the CLI must print (Req 1.6), read from package.json. */
function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  expect(typeof pkg.version).toBe('string');
  return pkg.version as string;
}

describe('bt entrypoint: help, version, and group listing', () => {
  describe('--version (Req 1.6)', () => {
    it('prints the package.json version to stdout and exits 0', () => {
      const { stdout, stderr, status } = runBt(['--version']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(packageVersion());
      // Version is a clean stdout-only success path.
      expect(stderr).toBe('');
    });
  });

  describe('root group listing (Req 1.2, 1.3, 2.7, 2.8)', () => {
    it('--help lists exactly the six groups on stdout and exits 0', () => {
      const { stdout, stderr, status } = runBt(['--help']);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      // Usage summary includes the `bt` invocation syntax (Req 1.2/1.3).
      expect(stdout).toContain('Usage: bt');

      const groups = extractGroupListing(stdout);
      // Exactly the six groups, each exactly once, nothing else (Req 2.7).
      expect([...groups].sort()).toEqual([...EXPECTED_GROUPS].sort());
      expect(groups).toHaveLength(EXPECTED_GROUPS.length);
      // The hidden `help` topic is not a seventh entry (Req 2.7/2.8).
      expect(groups).not.toContain('help');
    });

    it('no Command invocation lists exactly the six groups on stdout and exits 0', () => {
      const { stdout, status } = runBt([]);

      expect(status).toBe(0);
      expect(stdout).toContain('Usage: bt');

      const groups = extractGroupListing(stdout);
      expect([...groups].sort()).toEqual([...EXPECTED_GROUPS].sort());
      expect(groups).toHaveLength(EXPECTED_GROUPS.length);
    });
  });

  describe('group --help (Req 1.4)', () => {
    it('lists the group\u2019s Commands on stdout and exits 0', () => {
      const { stdout, stderr, status } = runBt(['transfers', '--help']);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Usage: bt transfers');
      // The transfers group exposes the `analyze` Command.
      expect(stdout).toMatch(/^ {2}analyze\b/m);
    });
  });

  describe('command --help (Req 1.5)', () => {
    it('prints the Command usage and at least one example on stdout, exit 0', () => {
      const { stdout, stderr, status } = runBt(['transfers', 'analyze', '--help']);

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Usage: bt transfers analyze');
      // At least one usage example (Req 1.5).
      expect(stdout).toContain('Example:');
      expect(stdout).toContain('bt transfers analyze');
    });
  });

  describe('bt help profiles (Req 2)', () => {
    it('prints the profiles help topic on stdout and exits 0', () => {
      const { stdout, status } = runBt(['help', 'profiles']);

      expect(status).toBe(0);
      expect(stdout).toContain('Profile list file (fleet operations)');
      // The topic documents the three-step resolution precedence.
      expect(stdout).toContain('PAYER_PROFILES_FILE');
      expect(stdout).toContain('payer-profiles.txt');
    });
  });
});
