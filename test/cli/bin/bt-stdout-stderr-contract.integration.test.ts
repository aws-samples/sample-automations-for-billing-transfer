// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));
/**
 * Integration smoke test of the `bt` stdout/stderr contract (Task 16.4).
 *
 * Unlike every other CLI test (which invokes the pure handlers directly per
 * Req 22.3), this test deliberately spawns ONE real child process of the `bt`
 * entrypoint and asserts the end-to-end output contract a `--json` consumer
 * relies on:
 *
 *  - stdout carries EXACTLY ONE syntactically valid JSON document and nothing
 *    else — no extra text, no second document, no diagnostics (Req 7.2, 7.3).
 *  - all human/progress/diagnostic output goes to stderr (Req 7.3).
 *  - the run completes WITHOUT invoking `python3` or `jq`: the CLI parses every
 *    response in TypeScript and has no `jq`/`python3` runtime dependency
 *    (Req 17.2, 22.5).
 *
 * Hermetic command choice — `bt reconciliation trigger --all-profiles --json`:
 * fleet reconciliation is a Mutating_Operation and is therefore dry-run by
 * default (no `--execute`). The dry-run path validates input, loads the
 * Profile_List_File, then prints the per-account plan as a single JSON document
 * on stdout and the `DRY-RUN` notice on stderr — submitting nothing, spawning
 * no per-profile child, and making no AWS call. So the contract is exercised
 * end-to-end without any AWS credentials.
 *
 * The "no python3 / no jq" guarantee is asserted structurally with a PATH-shim:
 * a temp directory holding executable `python3` and `jq` shims is PREPENDED to
 * PATH, so if anything in the process tree shelled out to either tool it would
 * hit our shim first and drop a sentinel file. After the run we assert neither
 * sentinel was created — i.e. the CLI completed using only node/tsx.
 *
 * Requirements: 7.2, 7.3, 17.2, 22.5
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// test/cli/bin -> repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../');
const BT_ENTRYPOINT = path.join(REPO_ROOT, 'cli', 'bin', 'bt.ts');

// tsx cold-start + on-the-fly compilation of the whole CLI tree is slow; give
// the single spawned child a generous budget.
jest.setTimeout(180_000);

interface SpawnSetup {
  tmpRoot: string;
  shimDir: string;
  python3Sentinel: string;
  jqSentinel: string;
  profilesFile: string;
  profiles: string[];
}

/**
 * Build the hermetic sandbox: a temp profile list with two fake profiles and a
 * shim bin dir holding `python3`/`jq` stubs that each touch a sentinel file when
 * invoked.
 */
function setupSandbox(): SpawnSetup {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-stdout-contract-'));
  const shimDir = path.join(tmpRoot, 'shim-bin');
  fs.mkdirSync(shimDir, { recursive: true });

  const python3Sentinel = path.join(tmpRoot, 'python3.invoked');
  const jqSentinel = path.join(tmpRoot, 'jq.invoked');

  // POSIX sh shims: record that the tool was invoked, then exit cleanly so we
  // never mask a different failure mode.
  writeShim(path.join(shimDir, 'python3'), python3Sentinel);
  writeShim(path.join(shimDir, 'jq'), jqSentinel);

  const profiles = ['payer-111111111111', 'payer-222222222222'];
  const profilesFile = path.join(tmpRoot, 'payer-profiles.txt');
  fs.writeFileSync(
    profilesFile,
    ['# fake payer profiles for the dry-run smoke test', ...profiles, ''].join('\n'),
    'utf8',
  );

  return { tmpRoot, shimDir, python3Sentinel, jqSentinel, profilesFile, profiles };
}

/** Write an executable shell shim that touches `sentinelPath` when run. */
function writeShim(shimPath: string, sentinelPath: string): void {
  const body = `#!/bin/sh\nprintf 'invoked\\n' > "${sentinelPath}"\nexit 0\n`;
  fs.writeFileSync(shimPath, body, { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);
}

describe('bt stdout/stderr contract (real child process)', () => {
  let sandbox: SpawnSetup;

  beforeAll(() => {
    sandbox = setupSandbox();
  });

  afterAll(() => {
    if (sandbox?.tmpRoot) {
      fs.rmSync(sandbox.tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits exactly one clean JSON document on stdout, diagnostics on stderr, and invokes no python3/jq', () => {
    // Prepend the shim dir so python3/jq resolve to our sentinels first, while
    // keeping the rest of PATH intact so node/npx/tsx still resolve.
    const env = {
      ...process.env,
      PATH: `${sandbox.shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      PAYER_PROFILES_FILE: sandbox.profilesFile,
      // Force a deterministic, non-interactive run.
      NO_COLOR: '1',
    };

    const result = spawnSync(
      'npx',
      ['tsx', BT_ENTRYPOINT, 'reconciliation', 'trigger', '--all-profiles', '--json'],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );

    // The process must have actually run (not failed to spawn).
    expect(result.error).toBeUndefined();

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    // On an unexpected non-zero exit, surface both streams to make the failure
    // diagnosable rather than letting a bare `0 !== status` hide the cause.
    if (result.status !== 0) {
      throw new Error(
        `bt exited ${result.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    // Dry-run fleet trigger submits nothing and exits zero (Success).
    expect(result.status).toBe(0);

    // --- stdout: exactly one syntactically valid JSON document (Req 7.2, 7.3) -
    // JSON.parse over the WHOLE stdout succeeds only when stdout is a single
    // JSON value plus optional surrounding whitespace; trailing text or a second
    // document would make it throw. That alone proves "one clean document, no
    // extra text".
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(stdout);
    }).not.toThrow();

    const trimmed = stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);

    // It is the expected fleet dry-run plan covering every profile in the list.
    const doc = parsed as { kind?: unknown; accounts?: unknown };
    expect(doc.kind).toBe('fleet-dry-run');
    expect(Array.isArray(doc.accounts)).toBe(true);
    expect((doc.accounts as unknown[]).length).toBe(sandbox.profiles.length);

    // --- stderr: human diagnostics live here, never on stdout (Req 7.3) -------
    expect(stderr).toContain('DRY-RUN');
    // The diagnostic notice must NOT leak into the machine-readable stream.
    expect(stdout).not.toContain('DRY-RUN');

    // --- no python3 / jq invoked anywhere in the process tree (Req 17.2, 22.5) -
    expect(fs.existsSync(sandbox.python3Sentinel)).toBe(false);
    expect(fs.existsSync(sandbox.jqSentinel)).toBe(false);
  });
});
