// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CLI diagnostic-logging wiring for the `bt` CLI.
 *
 * The reused Shared_Services and Shared_Utilities all log through the shared
 * Powertools `logger` singleton in `lib/lambda/common/utils/logger.ts`, which by
 * default writes structured JSON to **stdout** for the `info`/`debug`/`trace`
 * levels and to **stderr** for `warn`/`error`/`critical`. Left unmanaged that
 * stdout traffic would corrupt the `--json`/stdout result contract (Req 7) and
 * break the child-process fleet model, where the parent parses each child's
 * stdout as JSON.
 *
 * {@link configureCliLogging} takes ownership of that single logging stream at
 * CLI startup so that:
 *
 * - **No diagnostic line ever reaches stdout** — regardless of `--verbose` or
 *   `--json` (Req 24.5, 24.6). This is enforced structurally by repointing the
 *   logger's internal `Console` so that *both* of its streams write to standard
 *   error; even an `info`/`debug` line (which Powertools would otherwise send to
 *   `console.info`/`console.debug` → stdout) is redirected to stderr.
 * - **Silent by default** — when `--verbose` is absent the logger level is set to
 *   `SILENT`, suppressing all Diagnostic_Log output from the CLI and from the
 *   reused Shared_Services/Shared_Utilities (Req 24.3).
 * - **stderr-only under `--verbose`** — when `--verbose` is present the level is
 *   lowered to `DEBUG` and the redirected console emits every level on standard
 *   error only (Req 24.4).
 *
 * Because every reused module logs through this one singleton, configuring it
 * centrally here also silences/redirects their diagnostics; no per-service wiring
 * is needed. This is what keeps the fleet model correct: each child's stdout stays
 * a pure JSON document no matter how much the reused services log.
 *
 * This module deliberately touches **only** the shared logger. It instantiates no
 * CloudWatch Embedded Metric Format metrics, no AWS X-Ray tracer, and no Middy
 * middleware, because those Lambda-only utilities are out of scope for the CLI
 * (Req 24.7).
 *
 * Requirements: 24.3, 24.4, 24.5, 24.6, 24.7
 *
 * @module logging
 */

import { Console } from 'node:console';
import { logger as sharedLogger } from '../../lib/lambda/common/utils/logger.js';
import type { GlobalOptions } from './io-context.js';

/**
 * Structural view of the parts of the shared Powertools logger this module needs
 * to control. `console` is a private field on the Powertools `Logger` at compile
 * time but is a real instance property at runtime (initialized in `setConsole()`);
 * we narrow to this shape so we can repoint it to a stderr-only console without
 * depending on Powertools internals beyond this single field.
 */
interface ConfigurableLogger {
  /** Internal Node `Console` the logger prints through; repointed to stderr-only. */
  console: Console;
  /** Public Powertools method to set the active log level (accepts `'SILENT'`). */
  setLogLevel(logLevel: 'SILENT' | 'DEBUG'): void;
}

/** Options for {@link configureCliLogging}, primarily to inject seams in tests. */
export interface ConfigureCliLoggingOptions {
  /**
   * The shared Powertools logger to configure. Defaults to the application
   * singleton; tests may pass a child/stub logger to assert behavior in isolation.
   */
  logger?: ConfigurableLogger;
  /**
   * The stream every diagnostic level is routed to. Defaults to `process.stderr`;
   * tests may pass an in-memory writable to assert nothing reaches stdout.
   */
  stderr?: NodeJS.WritableStream;
}

/**
 * Configure the shared Powertools logger for CLI use: silent by default, and
 * stderr-only (never stdout) under `--verbose`.
 *
 * Call this once at CLI startup (from `cli/bin/bt.ts`) before any command handler
 * runs, so the result stream stays clean for every subsequent invocation.
 *
 * @param global - The parsed global options; only `verbose` is consulted.
 * @param options - Optional injection seams (logger instance, stderr stream).
 * @returns The configured logger instance (the shared singleton by default).
 */
export function configureCliLogging(
  global: Pick<GlobalOptions, 'verbose'>,
  options: ConfigureCliLoggingOptions = {},
): ConfigurableLogger {
  const target = options.logger ?? (sharedLogger as unknown as ConfigurableLogger);
  const stderr = options.stderr ?? process.stderr;

  // Route ALL diagnostic output to standard error. Powertools selects the console
  // method from the log level (info/debug/trace -> stdout, warn/error/critical ->
  // stderr); by pointing BOTH of this console's streams at stderr we guarantee no
  // diagnostic line can ever reach stdout, including under `--json` (Req 24.5, 24.6).
  const stderrConsole = new Console({ stdout: stderr, stderr });

  // Align with Powertools' own console handling: `trace` must not print a stack
  // trace, it should behave like a plain log line (see Powertools setConsole()).
  stderrConsole.trace = (message?: unknown, ...optionalParams: unknown[]): void => {
    stderrConsole.log(message as string, ...optionalParams);
  };

  target.console = stderrConsole;

  // Silent by default; emit diagnostics (now stderr-only) only under `--verbose`
  // (Req 24.3, 24.4).
  target.setLogLevel(global.verbose ? 'DEBUG' : 'SILENT');

  return target;
}
