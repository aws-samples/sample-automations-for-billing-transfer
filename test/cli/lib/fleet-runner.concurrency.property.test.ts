// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Feature: billing-transfer-cli, Property 10: Bounded concurrency is never exceeded and every account runs once

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for the Fleet_Runner's bounded-concurrency wave model.
 *
 * Property 10: Bounded concurrency is never exceeded and every account runs once
 *   For any concurrency limit N (integer >= 1) and any profile list, the
 *   Fleet_Runner has at most N children running at any instant and processes
 *   each profile exactly once.
 *
 * The implementation under test is `ChildProcessFleetRunner` / `createFleetRunner`
 * from `cli/lib/fleet-runner.ts`, which uses a bounded-concurrency wave model
 * (`Promise.all` over successive batches of at most N profiles).
 *
 * Strategy: inject a STUB SPAWNER whose fake child processes are genuinely
 * in-flight. The runner spawns every child in a wave synchronously inside
 * `wave.map(...)`, then `await`s the wave; our stub defers each child's `close`
 * event to a later macrotask (via `setImmediate`), so every child in a wave is
 * alive simultaneously before any of them closes. An instrumented live counter
 * is incremented on spawn and decremented on close, and we assert:
 *   - the live count NEVER exceeds N at any moment (the bound, Req 20.6/13.4),
 *   - the observed peak equals `min(N, profiles.length)` (concurrency is
 *     genuinely used, not silently serialized),
 *   - every profile is spawned exactly once, and the aggregated FleetResult
 *     reports each account exactly once.
 *
 * No fake timers are required: because the runner spawns synchronously and our
 * stub closes on a deferred macrotask, real `setImmediate` is sufficient (and
 * deterministic) to keep an entire wave in-flight at once.
 *
 * Validates: Requirements 11.5, 13.4, 13.8, 16.6, 20.6
 */

import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';

import fc from 'fast-check';

import { createFleetRunner } from '../../../cli/lib/fleet-runner.js';
import { CliExitCode } from '../../../cli/lib/exit-codes.js';
import type { SpawnFn, WritableLike } from '../../../cli/lib/external-tool-runner.js';
import type { IoContext, OutputSink } from '../../../cli/lib/io-context.js';

// ---------------------------------------------------------------------------
// Instrumented stub spawner with a shared live-concurrency tracker
// ---------------------------------------------------------------------------

/** Tracks live concurrency and the per-profile spawn/close lifecycle. */
interface ConcurrencyTracker {
  /** Number of children currently alive (spawned but not yet closed). */
  live: number;
  /** Maximum value `live` ever reached during the run. */
  maxLive: number;
  /** Profiles in the order their child was spawned. */
  spawned: string[];
  /** Profiles in the order their child closed. */
  closed: string[];
}

/**
 * Build a stub {@link SpawnFn} whose fake children increment the live counter on
 * spawn and decrement it when they close. The `close` event is deferred to a
 * later macrotask so the whole wave is in-flight simultaneously before any child
 * settles. `hops` controls how many `setImmediate` hops precede the close, which
 * interleaves close timings within a wave without ever letting a close precede a
 * spawn in the same synchronous batch.
 */
function makeStubSpawn(tracker: ConcurrencyTracker, hops: (profile: string) => number): SpawnFn {
  return (_command: string, _args: string[], options: SpawnOptions): ChildProcess => {
    const profile = (options.env?.AWS_PROFILE as string | undefined) ?? '';

    // --- spawn: a child becomes live the instant it is spawned ---
    tracker.live += 1;
    tracker.maxLive = Math.max(tracker.maxLive, tracker.live);
    tracker.spawned.push(profile);

    const child = new EventEmitter() as unknown as ChildProcess & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    // --- close: deferred to a later macrotask so peers stay in-flight ---
    const remaining = Math.max(1, hops(profile));
    const scheduleClose = (left: number): void => {
      if (left > 1) {
        setImmediate(() => scheduleClose(left - 1));
        return;
      }
      setImmediate(() => {
        tracker.live -= 1;
        tracker.closed.push(profile);
        // Exit 0 with no stdout => the runner records the account as `ok`.
        child.emit('close', 0, null);
      });
    };
    scheduleClose(remaining);

    return child;
  };
}

// ---------------------------------------------------------------------------
// In-memory IoContext (the runner only reads `ctx.env`)
// ---------------------------------------------------------------------------

/** A capturing {@link OutputSink} so nothing touches the real process streams. */
function createCapturingSink(): OutputSink & { text(): string } {
  const chunks: string[] = [];
  return {
    write: (text: string) => void chunks.push(text),
    writeLine: (line: string) => void chunks.push(`${line}\n`),
    text: () => chunks.join(''),
  };
}

/** Build a minimal in-memory IoContext sufficient for the Fleet_Runner. */
function createTestContext(): IoContext {
  return {
    stdout: createCapturingSink(),
    stderr: createCapturingSink(),
    env: {},
    cwd: '/tmp',
    now: () => 0,
  } as unknown as IoContext;
}

/**
 * In-memory {@link WritableLike} log-stream factory: per-account stderr is
 * captured to memory instead of disk, satisfying the "injected createLogStream
 * capturing to memory" requirement.
 */
function createMemoryLogStreams(): {
  factory: (profile: string, logDir: string) => WritableLike;
  byProfile: Map<string, string[]>;
} {
  const byProfile = new Map<string, string[]>();
  const factory = (profile: string): WritableLike => {
    const buffer: string[] = [];
    byProfile.set(profile, buffer);
    return { write: (chunk: string | Uint8Array) => void buffer.push(String(chunk)) };
  };
  return { factory, byProfile };
}

// A fixed, hermetic self-invocation target so the runner never touches the
// filesystem (the default resolver calls `fs.existsSync`).
const stubEntryResolver = () => ({ runner: 'node', entry: '/cli/bin/bt.js' });

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * A list of unique profile names (0..25). The `${i}-` index prefix guarantees
 * uniqueness regardless of the random suffix, so "runs exactly once" can be
 * asserted unambiguously per profile.
 */
const profilesArb: fc.Arbitrary<string[]> = fc
  .array(fc.stringMatching(/^[A-Za-z0-9._-]{0,10}$/), { maxLength: 25 })
  .map((suffixes) => suffixes.map((s, i) => `${i}-${s}`));

/** Concurrency cap N: an integer >= 1, per the property statement. */
const parallelArb = fc.integer({ min: 1, max: 12 });

/** Per-profile close-hop count (1..3) to interleave close timings within a wave. */
const hopsArb = fc.integer({ min: 1, max: 3 });

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe('Property 10: Bounded concurrency is never exceeded and every account runs once', () => {
  it('never runs more than N children at once and processes each profile exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        profilesArb,
        parallelArb,
        fc.integer({ min: 1, max: 3 }),
        async (profiles, parallel, hopBase) => {
          const tracker: ConcurrencyTracker = { live: 0, maxLive: 0, spawned: [], closed: [] };
          // Vary close timing per profile (deterministically) to interleave closes.
          const hops = (profile: string): number => ((profile.length + hopBase) % 3) + 1;
          const { factory, byProfile } = createMemoryLogStreams();

          const runner = createFleetRunner({
            spawn: makeStubSpawn(tracker, hops),
            entryResolver: stubEntryResolver,
            createLogStream: factory,
          });

          const result = await runner.run(
            {
              command: ['fleet', 'status'],
              passthroughArgs: [],
              profiles,
              parallel,
              execute: false,
              logDir: '/tmp/logs',
            },
            createTestContext(),
          );

          const expectedPeak = Math.min(parallel, profiles.length);

          // --- Bound: the live count never exceeded N at any instant. ---
          expect(tracker.maxLive).toBeLessThanOrEqual(parallel);

          // --- Genuine concurrency: the peak equals min(N, count), proving the
          //     wave actually ran multiple children in-flight (not serialized). ---
          expect(tracker.maxLive).toBe(expectedPeak);

          // --- Every account runs exactly once (spawn side). ---
          expect(tracker.spawned).toHaveLength(profiles.length);
          expect(new Set(tracker.spawned).size).toBe(profiles.length);
          expect([...tracker.spawned].sort()).toEqual([...profiles].sort());
          // Spawn order preserves the resolved profile-list order.
          expect(tracker.spawned).toEqual(profiles);

          // --- All children settled: no leaked live children. ---
          expect(tracker.live).toBe(0);
          expect(tracker.closed).toHaveLength(profiles.length);

          // --- Aggregated FleetResult reports each account exactly once. ---
          expect(result.accounts).toHaveLength(profiles.length);
          expect(result.accounts.map((a) => a.profile)).toEqual(profiles);
          expect(result.succeeded).toBe(profiles.length);
          expect(result.failed).toBe(0);
          expect(result.exitCode).toBe(CliExitCode.Success);

          // A per-account log stream was created for each profile.
          expect(byProfile.size).toBe(profiles.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('respects the bound for a sequential cap (N = 1): at most one child is ever live', async () => {
    await fc.assert(
      fc.asyncProperty(profilesArb, async (profiles) => {
        const tracker: ConcurrencyTracker = { live: 0, maxLive: 0, spawned: [], closed: [] };
        const { factory } = createMemoryLogStreams();

        const runner = createFleetRunner({
          spawn: makeStubSpawn(tracker, () => 2),
          entryResolver: stubEntryResolver,
          createLogStream: factory,
        });

        const result = await runner.run(
          {
            command: ['reconciliation', 'trigger'],
            passthroughArgs: [],
            profiles,
            parallel: 1,
            execute: false,
            logDir: '/tmp/logs',
          },
          createTestContext(),
        );

        // With N = 1 the runner is fully serialized: never more than one in-flight.
        expect(tracker.maxLive).toBeLessThanOrEqual(1);
        expect(tracker.maxLive).toBe(Math.min(1, profiles.length));

        // Still processes every account exactly once, in order.
        expect(tracker.spawned).toEqual(profiles);
        expect(tracker.live).toBe(0);
        expect(result.accounts.map((a) => a.profile)).toEqual(profiles);
        expect(result.exitCode).toBe(CliExitCode.Success);
      }),
      { numRuns: 100 },
    );
  });
});
