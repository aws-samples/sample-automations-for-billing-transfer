// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import * as path from 'path';
import type { ChildProcess } from 'child_process';

import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
import {
  ChildProcessFleetRunner,
  createFleetRunner,
  defaultEntryResolver,
  type EntryResolver,
  type FleetRunnerOptions,
  type LogStreamFactory,
} from '../../../cli/lib/fleet-runner.js';
import { CliExitCode } from '../../../cli/lib/exit-codes.js';

const __dirname = __pathDirname(__fileURLToPath(import.meta.url));
import type { SpawnFn, WritableLike } from '../../../cli/lib/external-tool-runner.js';
import type { IoContext } from '../../../cli/lib/io-context.js';

/**
 * Unit tests for the Fleet_Runner child-process orchestration
 * ({@link ChildProcessFleetRunner} / {@link createFleetRunner} /
 * {@link defaultEntryResolver}) — Requirements 20.3, 20.4.
 *
 * These are concrete, example-based assertions (the companion to the optional
 * fleet-completion / bounded-concurrency property tests) that pin down the three
 * orchestration contracts the runner owns, all without spawning a real process:
 *
 *  1. **stdout-JSON aggregation.** A stub spawner that emits a single JSON
 *     document on a child's stdout yields `AccountResult.data` equal to the
 *     parsed object; an empty stdout yields `ok` with `data === undefined`;
 *     malformed JSON or a non-zero exit yields `status === 'failed'` with a
 *     `failureDetail` (the cause or a pointer to the per-account log) — and the
 *     aggregated {@link FleetResult} counts and exit code follow Req 20.3/20.4
 *     (non-zero exactly when an account failed).
 *  2. **Per-account log writing.** Each child's stderr is written to the
 *     injected per-account log sink (captured in memory), alongside the rendered
 *     command header and any failure detail.
 *  3. **`selfInvocation` argv.** With an injected {@link EntryResolver} forcing
 *     each branch, the argv is `[runner, entry, ...command, '--profile', p,
 *     '--json']` for both the compiled (`node dist/cli/bin/bt.js`) and the dev
 *     (`tsx cli/bin/bt.ts`) targets.
 *
 * The seams are exercised with a fake {@link ChildProcess} (an `EventEmitter`
 * with `stdout`/`stderr` emitters), a stub {@link SpawnFn}, and an in-memory
 * {@link LogStreamFactory}, so aggregation, continue-on-failure, the exit-code
 * contract, per-account logging, and argv construction are all deterministic.
 */

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A fake {@link ChildProcess}: an EventEmitter with `stdout`/`stderr` emitters. */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

/** Scripted behavior for a single child, keyed by AWS profile. */
interface ChildScript {
  /** Text emitted on the child's stdout (string or Buffer to cover both code paths). */
  stdout?: string | Buffer;
  /** Text emitted on the child's stderr (mirrored to the per-account log). */
  stderr?: string;
  /** Process exit code reported via the `close` event (defaults to 0). */
  exitCode?: number | null;
  /** Terminating signal reported via the `close` event. */
  signal?: NodeJS.Signals | null;
  /** When set, the child emits `error` (a spawn failure) instead of `close`. */
  spawnError?: Error;
}

/** A recorded spawn invocation, for asserting the composed argv. */
interface SpawnRecord {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Extract the `--profile <name>` value the runner appended to the child argv. */
function profileFromArgs(args: string[]): string {
  const idx = args.indexOf('--profile');
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
}

/**
 * Build a stub {@link SpawnFn} that returns a {@link FakeChildProcess} per call,
 * replaying the scripted behavior for the invoked profile on the next tick (so
 * the runner's listeners are attached before any event fires). Every invocation
 * is recorded in `records`.
 */
function makeSpawn(
  scripts: Record<string, ChildScript>,
  records: SpawnRecord[] = [],
): SpawnFn {
  return ((command: string, args: string[], options): ChildProcess => {
    records.push({ command, args, env: (options?.env ?? {}) as NodeJS.ProcessEnv });
    const child = new FakeChildProcess();
    const script = scripts[profileFromArgs(args)] ?? {};

    process.nextTick(() => {
      if (script.spawnError) {
        child.emit('error', script.spawnError);
        return;
      }
      if (script.stderr !== undefined) {
        child.stderr.emit('data', script.stderr);
      }
      if (script.stdout !== undefined) {
        child.stdout.emit('data', script.stdout);
      }
      const code = script.exitCode === undefined ? 0 : script.exitCode;
      child.emit('close', code, script.signal ?? null);
    });

    return child as unknown as ChildProcess;
  }) as SpawnFn;
}

/** In-memory per-account log sink that records every chunk written to it. */
class MemoryLogStream implements WritableLike {
  readonly chunks: string[] = [];
  ended = false;

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }

  end(): void {
    this.ended = true;
  }

  /** Full captured log contents. */
  get text(): string {
    return this.chunks.join('');
  }
}

/**
 * Build a {@link LogStreamFactory} that hands out one {@link MemoryLogStream}
 * per profile and keeps them in a map so a test can inspect each account's log.
 */
function makeLogStreams(): { streams: Map<string, MemoryLogStream>; factory: LogStreamFactory } {
  const streams = new Map<string, MemoryLogStream>();
  const factory: LogStreamFactory = (profile) => {
    const stream = new MemoryLogStream();
    streams.set(profile, stream);
    return stream;
  };
  return { streams, factory };
}

/** Minimal IoContext: the runner only reads `ctx.env` when spawning children. */
function makeCtx(env: NodeJS.ProcessEnv = {}): IoContext {
  return { env } as unknown as IoContext;
}

/** Build FleetRunnerOptions with sensible defaults, overridable per test. */
function makeOptions(overrides: Partial<FleetRunnerOptions> = {}): FleetRunnerOptions {
  return {
    command: ['transfers', 'analyze'],
    passthroughArgs: [],
    profiles: [],
    parallel: 5,
    execute: false,
    logDir: '/tmp/fleet-logs',
    ...overrides,
  };
}

/** An entry resolver that mimics a compiled build (`node dist/cli/bin/bt.js`). */
const COMPILED_RESOLVER: EntryResolver = () => ({
  runner: '/usr/local/bin/node',
  entry: '/repo/dist/cli/bin/bt.js',
});

/** An entry resolver that mimics the dev path (`tsx cli/bin/bt.ts`). */
const DEV_RESOLVER: EntryResolver = () => ({
  runner: '/repo/node_modules/.bin/tsx',
  entry: '/repo/cli/bin/bt.ts',
});

// ---------------------------------------------------------------------------
// 3. selfInvocation argv — compiled vs tsx
// ---------------------------------------------------------------------------

describe('Fleet_Runner selfInvocation argv (compiled vs tsx)', () => {
  it('builds [runner, entry, ...command, --profile, p, --json] for a compiled build', () => {
    const runner = createFleetRunner({ entryResolver: COMPILED_RESOLVER });

    const argv = runner.selfInvocation(['transfers', 'analyze'], 'payer-a', makeCtx());

    expect(argv).toEqual([
      '/usr/local/bin/node',
      '/repo/dist/cli/bin/bt.js',
      'transfers',
      'analyze',
      '--profile',
      'payer-a',
      '--json',
    ]);
  });

  it('builds [runner, entry, ...command, --profile, p, --json] for the tsx dev path', () => {
    const runner = createFleetRunner({ entryResolver: DEV_RESOLVER });

    const argv = runner.selfInvocation(['reconciliation', 'trigger'], 'payer-b', makeCtx());

    expect(argv).toEqual([
      '/repo/node_modules/.bin/tsx',
      '/repo/cli/bin/bt.ts',
      'reconciliation',
      'trigger',
      '--profile',
      'payer-b',
      '--json',
    ]);
  });

  it('always appends --profile/--json after the command, regardless of command length', () => {
    const runner = createFleetRunner({ entryResolver: COMPILED_RESOLVER });

    const single = runner.selfInvocation(['status'], 'p', makeCtx());
    expect(single.slice(2)).toEqual(['status', '--profile', 'p', '--json']);

    const nested = runner.selfInvocation(['fleet', 'status', 'extra'], 'p', makeCtx());
    expect(nested.slice(2)).toEqual(['fleet', 'status', 'extra', '--profile', 'p', '--json']);
  });

  it('defaultEntryResolver resolves the tsx dev target when running from .ts sources', () => {
    // Under ts-jest the module file is `cli/lib/fleet-runner.ts`, so the default
    // resolver takes the dev branch: a `tsx` runner and the `bt.ts` entry.
    const target = defaultEntryResolver();

    expect(target.runner.endsWith('tsx')).toBe(true);
    expect(target.entry).toBe(path.resolve(__dirname, '../../../cli/bin/bt.ts'));
  });
});

// ---------------------------------------------------------------------------
// 1. stdout-JSON aggregation + FleetResult exit-code contract (Req 20.3, 20.4)
// ---------------------------------------------------------------------------

describe('Fleet_Runner stdout-JSON aggregation (Req 20.3, 20.4)', () => {
  interface Analysis {
    total: number;
    missingBillingGroup: number;
  }

  it('parses a child stdout JSON document into AccountResult.data', async () => {
    const payload: Analysis = { total: 3, missingBillingGroup: 1 };
    const spawn = makeSpawn({
      'payer-a': { stdout: JSON.stringify(payload), exitCode: 0 },
    });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    const result = await runner.run<Analysis>(
      makeOptions({ profiles: ['payer-a'] }),
      makeCtx(),
    );

    expect(result.accounts).toHaveLength(1);
    const account = result.accounts[0];
    expect(account.profile).toBe('payer-a');
    expect(account.status).toBe('ok');
    expect(account.exitCode).toBe(0);
    expect(account.data).toEqual(payload);
    expect(account.failureDetail).toBeUndefined();
  });

  it('treats an empty stdout on a clean exit as ok with undefined data', async () => {
    const spawn = makeSpawn({ 'payer-a': { stdout: '', exitCode: 0 } });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    const result = await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    expect(result.accounts[0].status).toBe('ok');
    expect(result.accounts[0].data).toBeUndefined();
  });

  it('marks an account failed with a failureDetail when stdout is malformed JSON', async () => {
    const spawn = makeSpawn({ 'payer-a': { stdout: '{ not: valid json', exitCode: 0 } });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    const result = await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    const account = result.accounts[0];
    expect(account.status).toBe('failed');
    expect(account.exitCode).toBe(0);
    expect(account.data).toBeUndefined();
    expect(account.failureDetail).toContain('failed to parse child JSON output');
    // Points at the per-account log (Req 20.4).
    expect(account.failureDetail).toContain('payer-a.log');
  });

  it('marks an account failed with the exit code when the child exits non-zero', async () => {
    const spawn = makeSpawn({ 'payer-a': { stdout: '{}', exitCode: 3 } });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    const result = await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    const account = result.accounts[0];
    expect(account.status).toBe('failed');
    expect(account.exitCode).toBe(3);
    expect(account.failureDetail).toContain('child exited with code 3');
    expect(account.failureDetail).toContain('payer-a.log');
  });

  it('records a spawn failure as a failed account (exit code 1) and continues', async () => {
    const spawn = makeSpawn({ 'payer-a': { spawnError: new Error('ENOENT: tsx not found') } });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: DEV_RESOLVER, createLogStream: factory });

    const result = await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    const account = result.accounts[0];
    expect(account.status).toBe('failed');
    expect(account.exitCode).toBe(1);
    expect(account.failureDetail).toContain('failed to spawn child process');
    expect(account.failureDetail).toContain('ENOENT: tsx not found');
  });

  it('aggregates a mixed fleet: preserves order, counts, and exits FleetPartialFailure (Req 20.3, 20.4)', async () => {
    const okPayload = { ok: true };
    const spawn = makeSpawn({
      // stdout as a Buffer to exercise the Buffer -> toString path.
      alpha: { stdout: Buffer.from(JSON.stringify(okPayload)), exitCode: 0 },
      bravo: { stdout: 'not-json', exitCode: 0 },
      charlie: { stdout: '{}', exitCode: 7 },
      delta: { stdout: JSON.stringify({ ok: true }), exitCode: 0 },
    });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    const result = await runner.run(
      makeOptions({ profiles: ['alpha', 'bravo', 'charlie', 'delta'], parallel: 2 }),
      makeCtx(),
    );

    // Order preserved (Req 20.3 aggregation over the resolved profile list).
    expect(result.accounts.map((a) => a.profile)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    expect(result.accounts.map((a) => a.status)).toEqual(['ok', 'failed', 'failed', 'ok']);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(2);
    // Any failure => non-zero fleet exit code (Req 20.4).
    expect(result.exitCode).toBe(CliExitCode.FleetPartialFailure);
    // Every failed account carries a failure detail / log pointer (Req 20.4).
    for (const failed of result.accounts.filter((a) => a.status === 'failed')) {
      expect(failed.failureDetail).toBeTruthy();
    }
  });

  it('exits Success when every account succeeds (Req 20.4 contrapositive)', async () => {
    const spawn = makeSpawn({
      alpha: { stdout: JSON.stringify({ n: 1 }), exitCode: 0 },
      bravo: { stdout: JSON.stringify({ n: 2 }), exitCode: 0 },
    });
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    const result = await runner.run(makeOptions({ profiles: ['alpha', 'bravo'] }), makeCtx());

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(CliExitCode.Success);
  });

  it('composes the child argv from selfInvocation + passthrough + --execute', async () => {
    const records: SpawnRecord[] = [];
    const spawn = makeSpawn({ 'payer-a': { stdout: '{}', exitCode: 0 } }, records);
    const { factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    await runner.run(
      makeOptions({
        command: ['transfers', 'analyze'],
        passthroughArgs: ['--validate'],
        profiles: ['payer-a'],
        execute: true,
      }),
      makeCtx({ HOME: '/home/op' }),
    );

    expect(records).toHaveLength(1);
    const { command, args, env } = records[0];
    // argv[0] is the runner; the spawn args are everything after it.
    expect(command).toBe('/usr/local/bin/node');
    expect(args).toEqual([
      '/repo/dist/cli/bin/bt.js',
      'transfers',
      'analyze',
      '--profile',
      'payer-a',
      '--json',
      '--validate',
      '--execute',
    ]);
    // Child runs under the single ambient profile, inheriting ctx.env.
    expect(env.AWS_PROFILE).toBe('payer-a');
    expect(env.HOME).toBe('/home/op');
  });
});

// ---------------------------------------------------------------------------
// 2. Per-account log writing
// ---------------------------------------------------------------------------

describe('Fleet_Runner per-account log writing', () => {
  it("writes each child's stderr to that profile's injected log sink", async () => {
    const spawn = makeSpawn({
      alpha: { stderr: 'alpha diagnostic line\n', stdout: '{}', exitCode: 0 },
      bravo: { stderr: 'bravo diagnostic line\n', stdout: '{}', exitCode: 0 },
    });
    const { streams, factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    await runner.run(makeOptions({ profiles: ['alpha', 'bravo'] }), makeCtx());

    expect(streams.get('alpha')!.text).toContain('alpha diagnostic line');
    expect(streams.get('bravo')!.text).toContain('bravo diagnostic line');
    // Per-account isolation: alpha's log does not contain bravo's stderr.
    expect(streams.get('alpha')!.text).not.toContain('bravo diagnostic line');
  });

  it('writes the rendered command header to the per-account log before running', async () => {
    const spawn = makeSpawn({ 'payer-a': { stdout: '{}', exitCode: 0 } });
    const { streams, factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    await runner.run(
      makeOptions({ command: ['transfers', 'analyze'], profiles: ['payer-a'] }),
      makeCtx(),
    );

    const log = streams.get('payer-a')!.text;
    expect(log).toContain('AWS_PROFILE=payer-a');
    expect(log).toContain('/repo/dist/cli/bin/bt.js');
    expect(log).toContain('--profile payer-a --json');
  });

  it('appends the parse-failure detail to the per-account log', async () => {
    const spawn = makeSpawn({ 'payer-a': { stderr: 'some progress\n', stdout: 'oops-not-json', exitCode: 0 } });
    const { streams, factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    const log = streams.get('payer-a')!.text;
    expect(log).toContain('some progress');
    expect(log).toContain('failed to parse child JSON output');
  });

  it('appends the spawn-failure detail to the per-account log', async () => {
    const spawn = makeSpawn({ 'payer-a': { spawnError: new Error('boom') } });
    const { streams, factory } = makeLogStreams();
    const runner = createFleetRunner({ spawn, entryResolver: DEV_RESOLVER, createLogStream: factory });

    await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    expect(streams.get('payer-a')!.text).toContain('failed to spawn child process: boom');
  });

  it('closes each per-account log sink when the child settles', async () => {
    const spawn = makeSpawn({ 'payer-a': { stdout: '{}', exitCode: 0 } });
    const { streams, factory } = makeLogStreams();
    const runner = new ChildProcessFleetRunner({ spawn, entryResolver: COMPILED_RESOLVER, createLogStream: factory });

    await runner.run(makeOptions({ profiles: ['payer-a'] }), makeCtx());

    expect(streams.get('payer-a')!.ended).toBe(true);
  });
});
