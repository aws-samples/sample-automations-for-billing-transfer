// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * ExternalToolRunner — typed, non-interactive spawn wrappers for the external
 * tools the `bt` CLI legitimately shells out to: `cdk` (fleet deploy / test
 * termination), `git` (setup-remotes / push), and `aws` (Partner Central
 * contingency fallback only).
 *
 * The runner is a thin, typed wrapper around child-process spawning that applies
 * non-interactive defaults so a command never blocks on a prompt or a pager
 * (Req 7.5): `aws` invocations always carry `--no-cli-pager` (and `AWS_PAGER` is
 * cleared), `cdk deploy` carries `--require-approval never`, and `git` runs with
 * `GIT_TERMINAL_PROMPT=0`. The single injection seam (an overridable spawn
 * function) lets handlers be unit-tested with an in-memory fake that records
 * invocations instead of executing them (Req 22.4).
 *
 * Captured `stdout` is returned in the {@link ToolResult} rather than forwarded
 * to the process's own stdout, which keeps the child-process fleet contract
 * intact: each `bt` child must emit a single clean JSON document on stdout, so a
 * wrapped `cdk`/`git` invocation must never leak onto that stream. Diagnostic
 * output (the child tool's stderr and the rendered command line) is mirrored to
 * the optional per-account {@link SpawnOpts.logStream}.
 *
 * A dry-run {@link ExternalToolRunner.render} produces the exact planned command
 * line — with the same non-interactive flags `run` would apply — without spawning
 * anything, so mutating fleet commands can print what they *would* do in their
 * dry-run (default) mode.
 *
 * Requirements: 7.5, 22.4
 *
 * @module external-tool-runner
 */

import { spawn as nodeSpawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';

/**
 * Minimal writable-stream abstraction for a per-account log destination.
 *
 * Compatible with `process.stderr`, a `fs.WriteStream`, or an in-memory test
 * buffer; only the `write` method is required so callers can supply any of them.
 */
export interface WritableLike {
  /** Append a chunk to the stream. Return value is ignored. */
  write(chunk: string | Uint8Array): unknown;
}

/**
 * Result of running an external tool to completion.
 *
 * `run`/`cdk`/`git`/`aws` resolve with this regardless of exit status (a
 * non-zero `exitCode` is data the caller classifies, not a thrown error); the
 * promise rejects only when the process cannot be spawned at all (e.g. the tool
 * is not on `PATH`).
 */
export interface ToolResult {
  /** The rendered command line that was executed (matches {@link ExternalToolRunner.render}). */
  command: string;
  /** Process exit code; non-signal terminations report the real code, signals map to a non-zero. */
  exitCode: number;
  /** Captured standard output (not forwarded to the CLI's own stdout). */
  stdout: string;
  /** Captured standard error (also mirrored to {@link SpawnOpts.logStream} when provided). */
  stderr: string;
  /** Terminating signal when the process was killed by one, otherwise `null`. */
  signal: NodeJS.Signals | null;
}

/**
 * Options controlling a single external-tool invocation.
 */
export interface SpawnOpts {
  /** AWS profile for the invocation; exported as `AWS_PROFILE` to the child (honored by `aws` and `cdk`). */
  profile?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** `cdk --output` directory for per-account isolated synth/deploy (Req 13.10). */
  outputDir?: string;
  /** Per-account log destination; receives the command line and the tool's stderr. */
  logStream?: WritableLike;
  /**
   * Apply non-interactive defaults (no prompts, no pager). Defaults to `true`;
   * pass `false` only to run the tool exactly as given.
   */
  nonInteractive?: boolean;
}

/**
 * Typed, non-interactive wrappers around the external tools the CLI shells out to.
 */
export interface ExternalToolRunner {
  /** Run `cdk` (bootstrap/deploy/destroy/synth) with non-interactive defaults. */
  cdk(args: string[], opts?: SpawnOpts): Promise<ToolResult>;
  /** Run `git` (remote add/remove/get-url/push) with prompts disabled. */
  git(args: string[], opts?: SpawnOpts): Promise<ToolResult>;
  /** Run `aws` (Partner Central contingency fallback only) with `--no-cli-pager`. */
  aws(args: string[], opts?: SpawnOpts): Promise<ToolResult>;
  /** Run an arbitrary command; AWS profile is exported when provided. */
  run(cmd: string, args: string[], opts?: SpawnOpts): Promise<ToolResult>;
  /**
   * Dry-run: return the exact command line `run`/`cdk`/`git`/`aws` would execute
   * (including injected non-interactive flags and an `AWS_PROFILE=` prefix when a
   * profile is set) without spawning anything.
   */
  render(cmd: string, args: string[], opts?: SpawnOpts): string;
}

/**
 * Spawn function shape — the single injection seam. Defaults to
 * {@link child_process.spawn}; tests override it with a fake.
 */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Known tools that receive tailored non-interactive defaults. */
type KnownTool = 'cdk' | 'git' | 'aws';

/** Resolved invocation after non-interactive defaults are applied. */
interface Invocation {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Returns `true` when `flag` (e.g. `--output`) appears in `args`, either as a
 * standalone token or in `--flag=value` form.
 */
function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Shell-quote a single token for the rendered command line. Tokens made up of
 * safe characters are emitted as-is; anything else is wrapped in single quotes
 * with embedded single quotes escaped.
 */
function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_\-./:=@]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default {@link ExternalToolRunner} backed by `child_process.spawn`.
 *
 * The spawn function is injectable so unit tests can supply a fake that records
 * invocations and never starts a real process (Req 22.4).
 */
export class NodeExternalToolRunner implements ExternalToolRunner {
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn = nodeSpawn) {
    this.spawnFn = spawnFn;
  }

  cdk(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec('cdk', args, opts);
  }

  git(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec('git', args, opts);
  }

  aws(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec('aws', args, opts);
  }

  run(cmd: string, args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec(cmd, args, opts);
  }

  render(cmd: string, args: string[], opts: SpawnOpts = {}): string {
    const invocation = this.buildInvocation(cmd, args, opts);
    return this.formatCommandLine(invocation, opts);
  }

  /**
   * Build the resolved invocation, applying non-interactive defaults for the
   * known tools and exporting `AWS_PROFILE` when a profile is supplied. Shared by
   * {@link run} and {@link render} so a dry-run preview matches what executes.
   */
  private buildInvocation(cmd: string, args: string[], opts: SpawnOpts): Invocation {
    const nonInteractive = opts.nonInteractive !== false; // default: true
    const finalArgs = [...args];
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (opts.profile) {
      env.AWS_PROFILE = opts.profile;
    }

    const tool = cmd as KnownTool;
    switch (tool) {
      case 'aws': {
        if (nonInteractive) {
          // Never block on the AWS CLI pager (see development-guide.md).
          env.AWS_PAGER = '';
          if (!hasFlag(finalArgs, '--no-cli-pager')) {
            finalArgs.push('--no-cli-pager');
          }
        }
        break;
      }
      case 'cdk': {
        if (nonInteractive && finalArgs.includes('deploy') && !hasFlag(finalArgs, '--require-approval')) {
          finalArgs.push('--require-approval', 'never');
        }
        if (opts.outputDir && !hasFlag(finalArgs, '--output') && !hasFlag(finalArgs, '-o')) {
          finalArgs.push('--output', opts.outputDir);
        }
        break;
      }
      case 'git': {
        if (nonInteractive) {
          // Fail fast instead of prompting for credentials.
          env.GIT_TERMINAL_PROMPT = '0';
        }
        break;
      }
      default:
        break;
    }

    return { cmd, args: finalArgs, env };
  }

  /**
   * Render an invocation as a single command-line string, prefixing the
   * `AWS_PROFILE=` assignment when a profile is set so the dry-run preview is
   * unambiguous about which account it targets.
   */
  private formatCommandLine(invocation: Invocation, opts: SpawnOpts): string {
    const prefix = opts.profile ? `AWS_PROFILE=${shellQuote(opts.profile)} ` : '';
    const tokens = [invocation.cmd, ...invocation.args].map(shellQuote);
    return prefix + tokens.join(' ');
  }

  /**
   * Spawn the resolved invocation and resolve with a {@link ToolResult}. Captured
   * stdout is returned (never written to the CLI's own stdout); stderr is captured
   * and mirrored to `opts.logStream` when present. Rejects only on spawn failure.
   */
  private exec(cmd: string, args: string[], opts: SpawnOpts): Promise<ToolResult> {
    const invocation = this.buildInvocation(cmd, args, opts);
    const commandLine = this.formatCommandLine(invocation, opts);
    const logStream = opts.logStream;

    if (logStream) {
      logStream.write(`$ ${commandLine}\n`);
    }

    return new Promise<ToolResult>((resolve, reject) => {
      const child = this.spawnFn(invocation.cmd, invocation.args, {
        cwd: opts.cwd,
        env: invocation.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        if (logStream) {
          logStream.write(text);
        }
      });

      child.on('error', (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(err);
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        const exitCode = code === null ? (signal ? 1 : 0) : code;
        resolve({ command: commandLine, exitCode, stdout, stderr, signal: signal ?? null });
      });
    });
  }
}

/**
 * Construct the default {@link ExternalToolRunner}. The optional `spawnFn` lets
 * tests inject a fake spawn implementation.
 */
export function createExternalToolRunner(spawnFn?: SpawnFn): ExternalToolRunner {
  return new NodeExternalToolRunner(spawnFn);
}
