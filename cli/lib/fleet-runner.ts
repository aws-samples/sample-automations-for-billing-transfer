// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Fleet_Runner — a bounded-concurrency child-process pool that runs the *same*
 * single-account `bt` command once per AWS profile and aggregates a typed,
 * CI-friendly fleet result.
 *
 * Fleet commands deliberately do **not** run multiple profiles in one Node
 * process: the shared services use module-level singleton SDK clients and a
 * module-level resource cache, which makes in-process multi-profile concurrency
 * unsafe. Instead the parent process spawns the single-account command as a
 * child per profile (a wave model with a concurrency cap, default 5), exporting
 * exactly one ambient profile via `AWS_PROFILE`. Each child prints its typed
 * result as a single JSON document on stdout while its diagnostics go to stderr;
 * the parent reads the stdout JSON, mirrors each child's stderr to a per-account
 * log file, continues on failure, and computes a fleet exit code where any
 * failure yields {@link CliExitCode.FleetPartialFailure}
 * (Req 9.1, 9.6, 11.4, 11.5, 13.4, 13.5, 13.8, 13.9, 16.5, 16.6, 20.2–20.6).
 *
 * The injection seams keep the runner fully unit-/property-testable without
 * spawning real processes:
 *  - `spawn` (default {@link child_process.spawn}) lets tests supply a fake that
 *    returns canned stdout JSON / stderr / exit code per profile, so aggregation,
 *    continue-on-failure, the exit-code contract, and bounded concurrency can be
 *    asserted deterministically.
 *  - `entryResolver` (default {@link defaultEntryResolver}) lets tests force the
 *    compiled-vs-dev branch so {@link FleetRunner.selfInvocation} argv can be
 *    verified for both `node dist/cli/bin/bt.js` and `tsx cli/bin/bt.ts`.
 *  - `createLogStream` (default backed by `fs.createWriteStream`) lets tests
 *    observe per-account logging via an in-memory sink instead of touching disk.
 *
 * Requirements: 9.1, 9.6, 11.4, 11.5, 13.4, 13.5, 13.8, 13.9, 16.5, 16.6,
 * 20.2, 20.3, 20.4, 20.5, 20.6
 *
 * @module fleet-runner
 */

import { spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { CliExitCode } from './exit-codes.js';
import type { IoContext } from './io-context.js';
import type { SpawnFn, WritableLike } from './external-tool-runner.js';

/** Default fleet concurrency cap when a non-positive value is supplied (Req 13.8, 20.6). */
const DEFAULT_PARALLEL = 5;

/**
 * Inputs to a single fleet run.
 *
 * `command` plus `passthroughArgs` describe the single-account invocation the
 * parent re-invokes per profile; `profiles` is the ordered list from the
 * Profile_Loader; `parallel` caps concurrency; `execute` is forwarded so
 * mutating children stay a no-op unless set; `logDir` is where per-account
 * stderr logs are written.
 */
export interface FleetRunnerOptions {
  /** Single-account command path, e.g. `['transfers', 'analyze']`. */
  command: string[];
  /** Command-specific flags forwarded verbatim to each child (e.g. `['--validate']`). */
  passthroughArgs: string[];
  /** Ordered AWS profile names resolved by the Profile_Loader. */
  profiles: string[];
  /** Concurrency cap; values < 1 fall back to {@link DEFAULT_PARALLEL}. */
  parallel: number;
  /** Forwarded as `--execute`; mutating children no-op unless `true`. */
  execute: boolean;
  /** Directory that receives each account's `<profile>.log` stderr capture. */
  logDir: string;
}

/**
 * Outcome of running the single-account command for one profile.
 *
 * `data` is the parsed child stdout JSON when `status === 'ok'`; `failureDetail`
 * carries the cause or a pointer to the per-account log when `status === 'failed'`
 * (Req 20.4).
 */
export interface AccountResult<TData = unknown> {
  /** AWS profile this child targeted. */
  profile: string;
  /** Whether the child completed successfully or failed. */
  status: 'ok' | 'failed';
  /** The child's process exit code (1 when the child could not be spawned). */
  exitCode: number;
  /** Parsed typed payload from the child's stdout JSON (present when `ok`). */
  data?: TData;
  /** Cause of failure or a pointer to `logDir/<profile>.log` (present when `failed`). */
  failureDetail?: string;
}

/**
 * Aggregated outcome of a whole fleet run.
 *
 * `exitCode` is {@link CliExitCode.FleetPartialFailure} when any account failed
 * and {@link CliExitCode.Success} otherwise (Req 20.4, 20.5).
 */
export interface FleetResult<TData = unknown> {
  /** Per-account results in the same order as the input profile list. */
  accounts: AccountResult<TData>[];
  /** Count of accounts whose child completed successfully. */
  succeeded: number;
  /** Count of accounts whose child failed. */
  failed: number;
  /** Fleet exit code: non-zero iff at least one account failed. */
  exitCode: CliExitCode;
}

/**
 * The Fleet_Runner contract referenced by {@link IoContext}.
 *
 * `run` orchestrates the child-process pool and aggregates a {@link FleetResult};
 * `selfInvocation` resolves the argv the parent uses to re-invoke itself per
 * profile.
 */
export interface FleetRunner {
  /** Run `opts.command` once per profile with bounded concurrency and aggregate the results. */
  run<TData>(opts: FleetRunnerOptions, ctx: IoContext): Promise<FleetResult<TData>>;
  /** Resolve the self-invocation argv: `[runner, entry, ...command, '--profile', p, '--json']`. */
  selfInvocation(command: string[], profile: string, ctx: IoContext): string[];
}

/**
 * Resolved self-invocation target: the executable that runs the CLI plus the CLI
 * entry script. Compiled builds run `dist/cli/bin/bt.js` with `node`
 * (`process.execPath`); dev runs `cli/bin/bt.ts` with `tsx`.
 */
export interface SelfInvocationTarget {
  /** Executable to spawn: `process.execPath` (node) compiled, or the `tsx` runner in dev. */
  runner: string;
  /** Resolved CLI entry: `dist/cli/bin/bt.js` (compiled) or `cli/bin/bt.ts` (dev). */
  entry: string;
}

/** Resolves how this process should re-invoke the `bt` CLI. Injectable for tests. */
export type EntryResolver = () => SelfInvocationTarget;

/**
 * Creates the per-account log destination. Injectable so tests can capture log
 * output in memory instead of writing to disk.
 */
export type LogStreamFactory = (profile: string, logDir: string) => WritableLike;

/** Optional dependencies; each defaults to a real implementation. */
export interface FleetRunnerDeps {
  /** Spawn function; defaults to {@link child_process.spawn}. */
  spawn?: SpawnFn;
  /** Self-invocation resolver; defaults to {@link defaultEntryResolver}. */
  entryResolver?: EntryResolver;
  /** Per-account log-stream factory; defaults to an `fs.createWriteStream`-backed sink. */
  createLogStream?: LogStreamFactory;
}

/**
 * Detect whether this module is running from a compiled `.js` build and resolve
 * the matching CLI entry. In a compiled build this file lives at
 * `dist/cli/lib/fleet-runner.js`, so the sibling entry is `../bin/bt.js` run by
 * `node`; in dev it is `cli/lib/fleet-runner.ts`, so the entry is `../bin/bt.ts`
 * run by `tsx` (resolved from the workspace `node_modules/.bin`, falling back to
 * `tsx` on `PATH`).
 */
export function defaultEntryResolver(): SelfInvocationTarget {
  const here = fileURLToPath(import.meta.url);
  const hereDir = path.dirname(here);
  const isCompiled = here.endsWith('.js');
  if (isCompiled) {
    return {
      runner: process.execPath,
      entry: path.resolve(hereDir, '../bin/bt.js'),
    };
  }
  const tsxBin = path.resolve(hereDir, '../../node_modules/.bin/tsx');
  return {
    runner: fs.existsSync(tsxBin) ? tsxBin : 'tsx',
    entry: path.resolve(hereDir, '../bin/bt.ts'),
  };
}

/**
 * Turn a profile name into a filesystem-safe log file stem. Profile names may
 * contain unicode and symbols, so any run of characters outside `[A-Za-z0-9._-]`
 * collapses to a single `_`.
 */
function logFileName(profile: string): string {
  const stem = profile.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${stem.length > 0 ? stem : 'profile'}.log`;
}

/** Default {@link LogStreamFactory}: append each child's stderr to `logDir/<profile>.log`. */
function defaultCreateLogStream(profile: string, logDir: string): WritableLike {
  // nosemgrep: detect-non-literal-fs-filename -- logDir is a CLI/env-derived local log directory (os.tmpdir or .bt-logs), not external input.
  fs.mkdirSync(logDir, { recursive: true });
  return fs.createWriteStream(path.join(logDir, logFileName(profile)), { flags: 'a' }); // nosemgrep: detect-non-literal-fs-filename, path-join-resolve-traversal -- local log file under a CLI/env-derived dir; profile is sanitized; not external input.
}

/** Close a log sink if it exposes an `end`/`close` method (e.g. an `fs.WriteStream`). */
function closeLogStream(stream: WritableLike): void {
  const closable = stream as { end?: () => void; close?: () => void };
  if (typeof closable.end === 'function') {
    closable.end();
  } else if (typeof closable.close === 'function') {
    closable.close();
  }
}

/**
 * Default {@link FleetRunner} backed by `child_process.spawn`.
 *
 * Uses a wave model: profiles are processed in successive batches of at most
 * `parallel`, so at no instant are more than `parallel` children alive and each
 * profile is processed exactly once (Req 20.6). Children run concurrently within
 * a wave and the next wave starts only after the current one settles.
 */
export class ChildProcessFleetRunner implements FleetRunner {
  private readonly spawnFn: SpawnFn;
  private readonly entryResolver: EntryResolver;
  private readonly createLogStream: LogStreamFactory;

  constructor(deps: FleetRunnerDeps = {}) {
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.entryResolver = deps.entryResolver ?? defaultEntryResolver;
    this.createLogStream = deps.createLogStream ?? defaultCreateLogStream;
  }

  selfInvocation(command: string[], profile: string, _ctx: IoContext): string[] {
    const { runner, entry } = this.entryResolver();
    return [runner, entry, ...command, '--profile', profile, '--json'];
  }

  async run<TData>(opts: FleetRunnerOptions, ctx: IoContext): Promise<FleetResult<TData>> {
    const concurrency = opts.parallel >= 1 ? Math.floor(opts.parallel) : DEFAULT_PARALLEL;
    const accounts: AccountResult<TData>[] = [];

    // Wave model: bound concurrency to `concurrency` and keep profile order.
    for (let i = 0; i < opts.profiles.length; i += concurrency) {
      const wave = opts.profiles.slice(i, i + concurrency);
      const waveResults = await Promise.all(
        wave.map((profile) => this.runOne<TData>(opts, profile, ctx)),
      );
      accounts.push(...waveResults);
    }

    const failed = accounts.reduce((n, a) => (a.status === 'failed' ? n + 1 : n), 0);
    const succeeded = accounts.length - failed;
    return {
      accounts,
      succeeded,
      failed,
      exitCode: failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success,
    };
  }

  /**
   * Spawn the single-account command for one profile and resolve a typed
   * {@link AccountResult}. Never rejects: a spawn failure, a non-zero exit, or an
   * unparseable stdout document is recorded as a failed account so the caller can
   * continue with the remaining profiles (Req 20.2).
   */
  private runOne<TData>(
    opts: FleetRunnerOptions,
    profile: string,
    ctx: IoContext,
  ): Promise<AccountResult<TData>> {
    const argv = this.selfInvocation(opts.command, profile, ctx);
    const runner = argv[0];
    const args = [...argv.slice(1), ...opts.passthroughArgs];
    if (opts.execute) {
      args.push('--execute');
    }

    // nosemgrep: path-join-resolve-traversal -- joins a sanitized profile-derived filename under a local log dir; not external input.
    const logPath = path.join(opts.logDir, logFileName(profile));
    const logStream = this.createLogStream(profile, opts.logDir);
    logStream.write(`$ AWS_PROFILE=${profile} ${[runner, ...args].join(' ')}\n`);

    return new Promise<AccountResult<TData>>((resolve) => {
      const child = this.spawnFn(runner, args, {
        env: { ...ctx.env, AWS_PROFILE: profile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let settled = false;

      const finish = (result: AccountResult<TData>): void => {
        if (settled) {
          return;
        }
        settled = true;
        closeLogStream(logStream);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        logStream.write(chunk.toString());
      });

      child.on('error', (err: Error) => {
        const detail = `failed to spawn child process: ${err.message}; see ${logPath}`;
        logStream.write(`${detail}\n`);
        finish({ profile, status: 'failed', exitCode: 1, failureDetail: detail });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const exitCode = code === null ? (signal ? 1 : 0) : code;

        if (exitCode !== 0) {
          finish({
            profile,
            status: 'failed',
            exitCode,
            failureDetail: `child exited with code ${exitCode}; see ${logPath}`,
          });
          return;
        }

        // Exit 0: the child's stdout must be a single clean JSON document.
        const trimmed = stdout.trim();
        if (trimmed.length === 0) {
          finish({ profile, status: 'ok', exitCode, data: undefined });
          return;
        }

        try {
          const data = JSON.parse(trimmed) as TData;
          finish({ profile, status: 'ok', exitCode, data });
        } catch (err) {
          const detail = `failed to parse child JSON output: ${
            (err as Error).message
          }; see ${logPath}`;
          logStream.write(`${detail}\n`);
          finish({ profile, status: 'failed', exitCode, failureDetail: detail });
        }
      });
    });
  }
}

/**
 * Construct the default {@link FleetRunner}. Pass `deps` to inject a fake spawn
 * function (and optionally a self-invocation resolver or log-stream factory) so
 * tests exercise aggregation, concurrency, and argv construction without
 * spawning real processes.
 */
export function createFleetRunner(deps?: FleetRunnerDeps): FleetRunner {
  return new ChildProcessFleetRunner(deps);
}
