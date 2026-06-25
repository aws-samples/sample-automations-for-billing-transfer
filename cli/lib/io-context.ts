// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * IO Context and Command Handler contract for the `bt` CLI.
 *
 * This module defines the single injection seam shared by every command: the
 * resolved {@link Scope}, the parsed {@link GlobalOptions}, the {@link OutputSink}
 * abstraction for stdout/stderr, the aggregated {@link IoContext}, and the uniform
 * {@link CommandHandler} signature. The command router, the Fleet_Runner, and unit
 * tests all treat handlers through this one contract so that a handler can be invoked
 * directly with mocked AWS clients and in-memory output sinks (Req 22.3, 22.4) without
 * spawning the `bt` executable.
 *
 * The component dependencies referenced by {@link IoContext} (the AWS client factory,
 * external-tool runner, fleet runner, output formatter, and error reporter) are owned
 * by sibling modules and are pulled in here as type-only forward references so this
 * module remains the single place that wires them together.
 *
 * Requirements: 3.1, 3.2, 3.3, 22.3, 22.4
 *
 * @module io-context
 */

import type { CliExitCode } from './exit-codes.js';
import type { AwsClientFactory } from './aws-clients.js';
import type { ExternalToolRunner } from './external-tool-runner.js';
import type { FleetRunner } from './fleet-runner.js';
import type { OutputFormatter, RenderableView } from './output-formatter.js';
import type { ErrorReporter } from './error-reporter.js';

/**
 * Scope resolved from the global options, applied uniformly to every command.
 *
 * - `profile`: a single named AWS profile selected with `--profile <name>` (Req 3.2).
 * - `all-profiles`: the fleet, every profile resolved by the Profile_Loader (`--all-profiles`).
 * - `ambient`: neither option provided, so the standard AWS credential chain applies (Req 3.3).
 */
export type Scope =
  | { kind: 'profile'; profile: string } // --profile <name>
  | { kind: 'all-profiles' } //            --all-profiles (fleet)
  | { kind: 'ambient' }; //                neither (active/ambient credentials)

/**
 * Global options parsed once from the command line and threaded into every handler.
 *
 * These mirror the global flags accepted by the entrypoint and carry the resolved
 * {@link Scope} so handlers never re-parse credential selection.
 */
export interface GlobalOptions {
  /** Resolved credential/target scope (profile, all-profiles, or ambient). */
  scope: Scope;
  /** `--profiles-file <path>` override, otherwise `$PAYER_PROFILES_FILE` / default applies. */
  profilesFile?: string;
  /** `--json`: render a single machine-readable JSON document to stdout. */
  json: boolean;
  /** Colorized human output; false when `--no-color` is set or stdout is not a TTY. */
  color: boolean;
  /** `--execute`: perform mutating fleet operations; dry-run when false. */
  execute: boolean;
  /** `--parallel [N]`: bounded fleet concurrency; sequential when absent. */
  parallel?: number;
  /** `--verbose`: route diagnostic logs to stderr; silent by default. */
  verbose: boolean;
}

/**
 * Minimal text-output abstraction for a single stream (stdout or stderr).
 *
 * Real runs back this with the process streams; tests back it with an in-memory
 * buffer so they can assert exactly what reached stdout versus stderr. `write`
 * appends text verbatim (no implicit newline); `writeLine` appends a single
 * trailing newline.
 */
export interface OutputSink {
  /** Write text to the stream exactly as given, without adding a newline. */
  write(text: string): void;
  /** Write a line of text to the stream, terminated by a single newline. */
  writeLine(line: string): void;
}

/**
 * Injected IO and dependency seam handed to every command handler.
 *
 * A real invocation wires the process streams, the AWS SDK client factory, and the
 * child-process/external-tool runners; tests wire in-memory sinks, `aws-sdk-client-mock`
 * backed clients, and stub runners. This is the sole mechanism through which a handler
 * touches the outside world, which is what makes handlers unit-testable by direct call
 * (Req 22.3, 22.4).
 */
export interface IoContext {
  /** Result output (human-readable text/tables or a single JSON document). */
  stdout: OutputSink;
  /** Diagnostics, progress, and error output; never carries the result payload. */
  stderr: OutputSink;
  /** Environment, e.g. for `PAYER_PROFILES_FILE` and `.env`-derived values. */
  env: NodeJS.ProcessEnv;
  /** Current working directory, used for profile-list resolution. */
  cwd: string;
  /** Per-context AWS SDK clients, constructed per invocation and mockable in tests. */
  clients: AwsClientFactory;
  /** Typed, non-interactive spawn wrappers for `cdk` / `git` / `aws`; stubbable. */
  tools: ExternalToolRunner;
  /** Child-process pool that runs a single-account command per profile; stubbable. */
  fleet: FleetRunner;
  /** Renders results as human tables or a single JSON document. */
  formatter: OutputFormatter;
  /** Classifies failures and writes message + remediation to stderr only. */
  reporter: ErrorReporter;
  /** Injectable clock (epoch ms) for deterministic lookback/timestamp tests. */
  now: () => number;
}

/**
 * The uniform shape every command implements.
 *
 * A handler is a pure function of its parsed options (always carrying the resolved
 * {@link GlobalOptions} under `global`) and the injected {@link IoContext}; it returns
 * a typed result plus a {@link CliExitCode}. The router, the Fleet_Runner, and tests all
 * invoke handlers through this single signature.
 *
 * @typeParam TOptions - command-specific parsed options (merged with `{ global }`).
 * @typeParam TResult - the typed result payload the handler produces.
 */
export type CommandHandler<TOptions, TResult> = (
  options: TOptions & { global: GlobalOptions },
  ctx: IoContext,
) => Promise<{ result: TResult; exitCode: CliExitCode }>;

// Re-exported for handlers that build a RenderableView for the Output_Formatter; the
// concrete shape is owned by the output-formatter module.
export type { RenderableView };
