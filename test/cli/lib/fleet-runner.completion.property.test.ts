// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for the Fleet_Runner's completion and exit-code contract.
 *
 * Covers the design's Correctness Property 9 (Fleet runs process every account
 * and exit non-zero exactly when any account fails): for any fleet operation over
 * a profile list with any pattern of per-account success/failure, every account in
 * the resolved list is attempted (one account's failure never halts the run), each
 * failed account is recorded with a failure detail / per-account log pointer, and
 * the aggregate exit code is non-zero (FleetPartialFailure) if and only if at least
 * one account failed.
 *
 * The implementation under test is `createFleetRunner` / `ChildProcessFleetRunner`
 * from `cli/lib/fleet-runner.ts`. The runner exposes an injectable `spawn`
 * (SpawnFn), `entryResolver`, and `createLogStream`, so the test drives it with a
 * STUB SPAWNER that returns a fake ChildProcess emitting canned stdout/stderr plus
 * a `close`/`error` event per profile — never spawning a real process — and an
 * in-memory log sink so nothing touches disk.
 *
 * Validates: Requirements 9.6, 9.7, 9.8, 11.6, 11.7, 16.5, 18.7, 18.8, 20.2, 20.4, 20.5
 */

import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';

import fc from 'fast-check';

import { createFleetRunner } from '../../../cli/lib/fleet-runner.js';
import type {
  FleetRunnerOptions,
  SelfInvocationTarget,
  LogStreamFactory,
} from '../../../cli/lib/fleet-runner.js';
import { CliExitCode } from '../../../cli/lib/exit-codes.js';
import type { IoContext } from '../../../cli/lib/io-context.js';
import type { SpawnFn, WritableLike } from '../../../cli/lib/external-tool-runner.js';

// ---------------------------------------------------------------------------
// Per-profile outcomes
//
// Each profile's child is modeled by exactly one of these outcomes. Only `ok`
// represents a successful account; every other shape exercises one of the
// runner's failure paths (non-zero exit, exit-0 with an unparseable stdout
// document, or a spawn-level error). This lets the property assert the
// success/failure -> exit-code contract across the whole input space.
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: 'ok'; code: 0; stdout: string } //              success: exit 0 + clean JSON
  | { kind: 'ok-empty'; code: 0 } //                        success: exit 0 + empty stdout
  | { kind: 'fail-exit'; code: number } //                  failure: non-zero exit
  | { kind: 'fail-badjson'; code: 0; stdout: string } //    failure: exit 0 but junk stdout
  | { kind: 'fail-spawn' }; //                              failure: child cannot be spawned

/** True iff the modeled outcome should aggregate as a successful account. */
function isOk(outcome: Outcome): boolean {
  return outcome.kind === 'ok' || outcome.kind === 'ok-empty';
}

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  // Success: a clean JSON document on stdout (the typical child contract).
  fc
    .record({ profile: fc.string(), n: fc.integer() })
    .map((payload) => ({ kind: 'ok' as const, code: 0 as const, stdout: JSON.stringify(payload) })),
  // Success: a silent child that exits 0 with no stdout (data === undefined).
  fc.constant({ kind: 'ok-empty' as const, code: 0 as const }),
  // Failure: a non-zero exit code.
  fc.integer({ min: 1, max: 255 }).map((code) => ({ kind: 'fail-exit' as const, code })),
  // Failure: exit 0 but stdout is not parseable as a single JSON document.
  fc
    .constantFrom('this is { not json', '<<< oops >>>', '}{', 'NaN trailing }')
    .map((stdout) => ({ kind: 'fail-badjson' as const, code: 0 as const, stdout })),
  // Failure: the child process could not be spawned at all.
  fc.constant({ kind: 'fail-spawn' as const }),
);

// ---------------------------------------------------------------------------
// Stub spawner + hermetic injection seams
// ---------------------------------------------------------------------------

/**
 * Minimal fake ChildProcess: an EventEmitter exposing `stdout`/`stderr`
 * EventEmitters, matching the surface the Fleet_Runner consumes
 * (`stdout.on('data')`, `stderr.on('data')`, `on('close')`, `on('error')`).
 */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

/**
 * Build a stub SpawnFn that resolves the target profile from the child's
 * `AWS_PROFILE` env and replays that profile's canned outcome asynchronously
 * (after the runner has attached its listeners). Never starts a real process.
 */
function makeStubSpawn(outcomeByProfile: ReadonlyMap<string, Outcome>): SpawnFn {
  return (_command: string, _args: string[], options: SpawnOptions): ChildProcess => {
    const profile = String(options.env?.AWS_PROFILE ?? '');
    const outcome = outcomeByProfile.get(profile);
    const child = new FakeChildProcess();

    setImmediate(() => {
      if (!outcome || outcome.kind === 'fail-spawn') {
        child.emit('error', new Error('spawn ENOENT (stub)'));
        return;
      }

      // Emit some stderr to exercise the per-account log mirroring path.
      child.stderr.emit('data', Buffer.from(`[${profile}] diagnostic line\n`));

      if (outcome.kind === 'ok' || outcome.kind === 'fail-badjson') {
        child.stdout.emit('data', Buffer.from(outcome.stdout));
      }

      child.emit('close', outcome.code, null);
    });

    return child as unknown as ChildProcess;
  };
}

/** Deterministic, hermetic self-invocation target (no filesystem probing). */
function stubEntryResolver(): SelfInvocationTarget {
  return { runner: 'node', entry: 'dist/cli/bin/bt.js' };
}

/** In-memory log sink so per-account logging never touches disk. */
function makeMemoryLogStreamFactory(): { factory: LogStreamFactory; chunks: string[] } {
  const chunks: string[] = [];
  const factory: LogStreamFactory = (): WritableLike & { end(): void } => ({
    write(chunk: string | Uint8Array): boolean {
      chunks.push(chunk.toString());
      return true;
    },
    end(): void {
      /* no-op */
    },
  });
  return { factory, chunks };
}

/**
 * Minimal IoContext: the Fleet_Runner only reads `ctx.env` (forwarded to the
 * child spawn) for this property, so the remaining seams are intentionally
 * absent and the cast keeps the test focused on orchestration.
 */
function makeContext(): IoContext {
  return {
    env: { SOME_AMBIENT: 'value' },
    cwd: '/tmp',
  } as unknown as IoContext;
}

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

describe('Fleet_Runner — completion and exit code (Property 9)', () => {
  // Feature: billing-transfer-cli, Property 9: Fleet runs process every account and exit non-zero exactly when any account fails
  it('processes every account exactly once in order and exits non-zero iff any account failed', async () => {
    await fc.assert(
      fc.asyncProperty(
        // An arbitrary-length list of arbitrary per-profile outcomes...
        fc.array(outcomeArb, { maxLength: 14 }),
        // ...run with an arbitrary concurrency cap (incl. < 1, which falls back to the default).
        fc.integer({ min: 0, max: 8 }),
        async (outcomes, parallel) => {
          // Unique, varied profile names: prefixing the position guarantees
          // uniqueness so the stub can map each spawn back to one outcome.
          const profiles = outcomes.map((_, i) => `acct-${i}-x`);
          const outcomeByProfile = new Map<string, Outcome>(
            profiles.map((p, i) => [p, outcomes[i]]),
          );

          const { factory: createLogStream } = makeMemoryLogStreamFactory();
          const runner = createFleetRunner({
            spawn: makeStubSpawn(outcomeByProfile),
            entryResolver: stubEntryResolver,
            createLogStream,
          });

          const opts: FleetRunnerOptions = {
            command: ['transfers', 'analyze'],
            passthroughArgs: ['--validate'],
            profiles,
            parallel,
            execute: false,
            logDir: '/tmp/fleet-logs',
          };

          const result = await runner.run(opts, makeContext());

          // (1) Every account is attempted exactly once, in input order
          //     (a failure never halts the run) — Req 9.6, 9.7, 16.5, 20.2.
          expect(result.accounts).toHaveLength(profiles.length);
          expect(result.accounts.map((a) => a.profile)).toEqual(profiles);

          // (2) Per-account status mirrors the modeled outcome, and each failed
          //     account carries a failure detail / log pointer — Req 20.4.
          const expectedFailures = outcomes.filter((o) => !isOk(o)).length;
          result.accounts.forEach((account, i) => {
            if (isOk(outcomes[i])) {
              expect(account.status).toBe('ok');
              expect(account.exitCode).toBe(0);
            } else {
              expect(account.status).toBe('failed');
              expect(typeof account.failureDetail).toBe('string');
              expect((account.failureDetail ?? '').length).toBeGreaterThan(0);
            }
          });

          // (3) succeeded + failed === profiles.length, and the counts match.
          expect(result.failed).toBe(expectedFailures);
          expect(result.succeeded).toBe(profiles.length - expectedFailures);
          expect(result.succeeded + result.failed).toBe(profiles.length);

          // (4) The aggregate exit code is non-zero (FleetPartialFailure) iff at
          //     least one account failed, and Success when all succeeded
          //     (incl. the empty-fleet case) — Req 9.8, 11.6, 11.7, 18.7, 18.8, 20.4, 20.5.
          if (expectedFailures > 0) {
            expect(result.exitCode).toBe(CliExitCode.FleetPartialFailure);
            expect(result.exitCode).not.toBe(CliExitCode.Success);
          } else {
            expect(result.exitCode).toBe(CliExitCode.Success);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
