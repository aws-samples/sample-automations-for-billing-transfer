// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
/**
 * Unit tests for CLI logging discipline with REUSED shared code (Task 6.3,
 * Requirements 24.2, 24.5, 24.6).
 *
 * Where the companion property test (`logging.property.test.ts`, Property 19)
 * proves the diagnostic-log discipline abstractly, this example-based test pins
 * the discipline against the actual reused Shared_Utility that emits the most
 * diagnostics on the hot path: `retryWithBackoff` in
 * `lib/lambda/common/utils/retry.ts`. It drives that helper through all three of
 * its logging branches and asserts the CLI logging wiring keeps the result
 * stream (stdout) clean:
 *
 *  1. After {@link configureCliLogging} is applied for a non-verbose run (the
 *     `--json` / default case), driving `retryWithBackoff` through its
 *     retry-pending (`logger.warn`), non-retryable (`logger.error`), and
 *     exhausted (`logger.warn` + `logger.error`) paths writes NOTHING to
 *     `process.stdout` (Req 24.5, 24.6). The diagnostics still flow through the
 *     shared Powertools `logger`; they are merely silenced.
 *  2. Under `--verbose`, the same retry diagnostics are emitted to the configured
 *     stderr stream (the shared logger routed to stderr) and STILL nothing
 *     reaches `process.stdout` (Req 24.4, 24.5, 24.6).
 *  3. The reused retry diagnostics flow through the shared Powertools `logger`
 *     (`warn`/`error`) and never through `console.log` (Req 24.2 — the refactor
 *     that replaced `console.log(JSON.stringify(...))` with the shared logger).
 *
 * The shared `logger` singleton imported here is the very same instance that
 * `retry.ts` logs through and that {@link configureCliLogging} configures by
 * default, so configuring it centrally is what silences/redirects the reused
 * code's diagnostics. All spies and the mutated singleton state are restored in
 * `afterEach`.
 */

import { Writable } from 'node:stream';

import { configureCliLogging } from '../../../cli/lib/logging.js';
import { logger as sharedLogger } from '../../../lib/lambda/common/utils/logger.js';
import {
  DEFAULT_RETRY_CONFIG,
  retryWithBackoff,
  type RetryConfig,
} from '../../../lib/lambda/common/utils/retry.js';

/**
 * A retryable AWS-shaped error: its `name` is a known transient code, so
 * `isRetryableError` returns true and `retryWithBackoff` logs a retry-pending
 * `warn` before sleeping.
 */
const THROTTLING_ERROR = { name: 'ThrottlingException', message: 'Rate exceeded' };

/**
 * A non-retryable AWS-shaped error: its `name` is not a transient code, so
 * `retryWithBackoff` logs a single `error` and rethrows immediately.
 */
const ACCESS_DENIED_ERROR = { name: 'AccessDeniedException', message: 'not authorized' };

/**
 * A fast retry config: only one extra attempt, and zero base/max delay so the
 * only wait is jitter (which the tests neutralize by stubbing `Math.random`).
 */
const FAST_CONFIG: RetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxAttempts: 2,
  baseDelay: 0,
  maxDelay: 0,
};

/** An in-memory writable that records everything written to it, for stderr assertions. */
function makeBuffer(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/**
 * Drive the retry-pending branch: fail once with a retryable error, then succeed.
 * Triggers exactly one `logger.warn('Operation failed, retrying')`.
 */
async function driveRetryPending(): Promise<string> {
  let calls = 0;
  return retryWithBackoff(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw THROTTLING_ERROR;
      }
      return 'recovered';
    },
    FAST_CONFIG,
    { operation: 'RetryPendingOp' },
  );
}

/**
 * Drive the non-retryable branch: fail with a non-retryable error.
 * Triggers exactly one `logger.error('Non-retryable error encountered')` and rethrows.
 */
async function driveNonRetryable(): Promise<void> {
  await expect(
    retryWithBackoff(
      async () => {
        throw ACCESS_DENIED_ERROR;
      },
      FAST_CONFIG,
      { operation: 'NonRetryableOp' },
    ),
  ).rejects.toBeDefined();
}

/**
 * Drive the exhausted branch: always fail with a retryable error.
 * Triggers a `logger.warn` (retry-pending) then a `logger.error('Operation failed after retries')`.
 */
async function driveExhausted(): Promise<void> {
  await expect(
    retryWithBackoff(
      async () => {
        throw THROTTLING_ERROR;
      },
      FAST_CONFIG,
      { operation: 'ExhaustedOp' },
    ),
  ).rejects.toBeDefined();
}

/** Drive all three retry branches in sequence. */
async function driveAllRetryPaths(): Promise<void> {
  await driveRetryPending();
  await driveNonRetryable();
  await driveExhausted();
}

describe('CLI logging discipline with reused retry.ts (Req 24.2, 24.5, 24.6)', () => {
  let originalConsole: unknown;
  let originalLevelName: string;

  beforeEach(() => {
    // Capture the singleton state mutated by configureCliLogging so it can be
    // restored, keeping these tests hermetic w.r.t. the shared logger.
    originalConsole = (sharedLogger as unknown as { console: unknown }).console;
    originalLevelName = sharedLogger.getLevelName();
    // Neutralize the jitter wait inside retryWithBackoff so the retry-pending and
    // exhausted paths resolve immediately (delay = 0 base + 0 jitter).
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    (sharedLogger as unknown as { console: unknown }).console = originalConsole;
    sharedLogger.setLogLevel(originalLevelName as 'INFO');
    jest.restoreAllMocks();
  });

  describe('non-verbose run (--json / default): nothing reaches stdout', () => {
    it('writes no retry diagnostic to process.stdout while still routing through the shared logger', async () => {
      const stdoutSpy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      // Spy on the shared logger emit methods to prove the reused retry code's
      // diagnostics flow THROUGH the silenced logger (not that they vanish).
      const warnSpy = jest.spyOn(sharedLogger, 'warn');
      const errorSpy = jest.spyOn(sharedLogger, 'error');

      // Simulate a non-verbose CLI run (the --json case logs identically: silent).
      configureCliLogging({ verbose: false });

      await driveAllRetryPaths();

      // The result stream stays clean regardless of how much retry.ts logs (Req 24.5, 24.6).
      expect(stdoutSpy).not.toHaveBeenCalled();
      // But the diagnostics did flow through the shared Powertools logger.
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('keeps stdout clean even when --json is combined with a silent (non-verbose) logger', async () => {
      const stdoutSpy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      // Route the silenced logger's stderr at an in-memory buffer so we can also
      // confirm SILENT suppresses output entirely (nothing on stdout OR stderr).
      const { stream: stderr, text } = makeBuffer();

      configureCliLogging({ verbose: false }, { stderr });

      await driveAllRetryPaths();

      expect(stdoutSpy).not.toHaveBeenCalled();
      // Silent-by-default: no diagnostic line is emitted to the stderr stream either.
      expect(text()).toBe('');
    });
  });

  describe('--verbose run: retry diagnostics go to stderr, never stdout', () => {
    it('emits the retry warn/error diagnostics to the configured stderr stream only', async () => {
      const stdoutSpy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const { stream: stderr, text } = makeBuffer();

      // Verbose run with the shared logger routed to an in-memory stderr stream.
      configureCliLogging({ verbose: true }, { stderr });

      await driveAllRetryPaths();

      // Nothing on the result stream.
      expect(stdoutSpy).not.toHaveBeenCalled();

      const emitted = text();
      // All three retry branches surfaced their diagnostics on stderr.
      expect(emitted).toContain('Operation failed, retrying');
      expect(emitted).toContain('Non-retryable error encountered');
      expect(emitted).toContain('Operation failed after retries');
      // Structured context fields are preserved (operation names from each call).
      expect(emitted).toContain('RetryPendingOp');
      expect(emitted).toContain('NonRetryableOp');
      expect(emitted).toContain('ExhaustedOp');
    });

    it('keeps stdout clean under --verbose even though diagnostics are now emitted', async () => {
      const stdoutSpy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const { stream: stderr, text } = makeBuffer();

      configureCliLogging({ verbose: true }, { stderr });

      await driveExhausted();

      expect(stdoutSpy).not.toHaveBeenCalled();
      // Sanity: the verbose stderr stream did receive output (so the prior
      // assertion is meaningful, not vacuously true).
      expect(text().length).toBeGreaterThan(0);
    });
  });

  describe('reuse routing: retry diagnostics use the shared Powertools logger, not console.log', () => {
    it('drives all retry paths through logger.warn/logger.error and never console.log', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(sharedLogger, 'warn');
      const errorSpy = jest.spyOn(sharedLogger, 'error');
      const { stream: stderr } = makeBuffer();

      configureCliLogging({ verbose: true }, { stderr });

      await driveAllRetryPaths();

      // Req 24.2: the refactor moved retry diagnostics onto the shared logger.
      // warn: retry-pending (x2, from pending + exhausted paths).
      expect(warnSpy).toHaveBeenCalledTimes(2);
      // error: non-retryable (x1) + exhausted (x1).
      expect(errorSpy).toHaveBeenCalledTimes(2);
      // The legacy console.log path is gone.
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('passes structured fields (not stringified blobs) to the shared logger', async () => {
      const warnSpy = jest.spyOn(sharedLogger, 'warn');
      const { stream: stderr } = makeBuffer();

      configureCliLogging({ verbose: true }, { stderr });

      await driveRetryPending();

      // The warn call carries a message plus a structured context object, proving
      // the diagnostics are real logger calls rather than console.log(JSON.stringify()).
      expect(warnSpy).toHaveBeenCalledWith(
        'Operation failed, retrying',
        expect.objectContaining({
          context: expect.objectContaining({
            operation: 'RetryPendingOp',
            attempt: 1,
            maxAttempts: FAST_CONFIG.maxAttempts,
          }),
        }),
      );
    });
  });
});
