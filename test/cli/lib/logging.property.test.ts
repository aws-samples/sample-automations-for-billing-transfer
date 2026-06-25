// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Feature: billing-transfer-cli, Property 19: Diagnostic logs never reach stdout

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
/**
 * Property-based test for the CLI diagnostic-logging discipline wired by
 * {@link configureCliLogging} in `cli/lib/logging.ts`.
 *
 * Property 19: Diagnostic logs never reach stdout.
 * Validates: Requirements 24.3, 24.4, 24.5, 24.6
 *
 * For any value of the `--verbose` flag and any sequence of diagnostic log calls
 * at arbitrary levels (info/debug/warn/error/critical/trace) carrying arbitrary
 * messages, no Diagnostic_Log line is ever written to standard output. Concretely:
 *
 *   - The CLI takes ownership of the single shared Powertools `logger` singleton
 *     and repoints its internal Console so that *both* of its streams write to
 *     standard error (here, an injected in-memory writable). We additionally spy
 *     on `process.stdout.write` and assert the logger NEVER writes to it — even
 *     for `info`/`debug`/`trace`, which Powertools would otherwise route to
 *     stdout (Req 24.5, 24.6).
 *   - When `--verbose` is absent the logger level is `SILENT`, so nothing is
 *     emitted anywhere — not to stdout and not to the injected stderr (Req 24.3).
 *   - When `--verbose` is present the level is `DEBUG`, so every level at or above
 *     the DEBUG threshold is emitted on the injected stderr only, never on stdout
 *     (Req 24.4).
 *
 * The test drives the *real* shared Powertools logger through
 * `configureCliLogging` (its default `options.logger` is that singleton), passing
 * an in-memory writable as `options.stderr` so it can assert exactly what reached
 * the diagnostic stream while the stdout spy proves stdout stayed pristine.
 */

import { Writable } from 'node:stream';
import fc from 'fast-check';
import { configureCliLogging } from '../../../cli/lib/logging.js';
import { logger as sharedLogger } from '../../../lib/lambda/common/utils/logger.js';

// ---------------------------------------------------------------------------
// In-memory writable used as the injected stderr stream
// ---------------------------------------------------------------------------

/**
 * A real Node {@link Writable} that records every chunk written to it. The
 * Powertools logger builds a `new Console({ stdout, stderr })` around the stream
 * we pass as `options.stderr`, so this captures the complete diagnostic output of
 * every level (Powertools routes info/debug/trace to the console's "stdout" and
 * warn/error/critical to its "stderr" — but `configureCliLogging` points *both*
 * at this single stream).
 */
function createMemoryStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

// ---------------------------------------------------------------------------
// Log-level model
//
// Powertools numeric thresholds (see @aws-lambda-powertools/logger constants):
// a log item prints only when its threshold is >= the logger's active level.
// configureCliLogging sets the active level to DEBUG (8) under --verbose and
// SILENT (28) otherwise.
// ---------------------------------------------------------------------------

type LogMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical';

const LEVEL_THRESHOLD: Record<LogMethod, number> = {
  trace: 6,
  debug: 8,
  info: 12,
  warn: 16,
  error: 20,
  critical: 24,
};

const DEBUG_THRESHOLD = 8;
const SILENT_THRESHOLD = 28;

/** True when a call at `level` is expected to be emitted for the given verbosity. */
function isVisible(level: LogMethod, verbose: boolean): boolean {
  const activeThreshold = verbose ? DEBUG_THRESHOLD : SILENT_THRESHOLD;
  return LEVEL_THRESHOLD[level] >= activeThreshold;
}

// A logger exposing the concrete level methods (the singleton returned by the
// shared module). configureCliLogging narrows its return type, so we drive the
// imported singleton directly after configuring it.
const driveable = sharedLogger as unknown as Record<LogMethod, (message: string) => void>;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const levelArb = fc.constantFrom<LogMethod>(
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'critical',
);

// Arbitrary message bodies, including the characters most likely to break a
// naive emitter or to look like JSON/control sequences.
const messageBodyArb = fc.oneof(
  fc.string(),
  fc.constantFrom(
    '',
    '"quoted"',
    'back\\slash',
    'tab\tnewline\nreturn\r',
    'unicode \u2028\u2029 \u0000 \u001b[31m',
    '}{][,:',
    '😀 multi-byte',
    'null',
    '{"already":"json"}',
  ),
);

/**
 * One diagnostic call: a level plus an arbitrary message. Each message is tagged
 * at emit time with a unique alphanumeric marker (see the property body) so its
 * presence/absence on the stderr stream can be asserted unambiguously regardless
 * of how Powertools JSON-escapes the arbitrary body.
 */
const callArb = fc.record({ level: levelArb, body: messageBodyArb });

const callsArb = fc.array(callArb, { minLength: 0, maxLength: 12 });

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe('CLI logging — diagnostic logs never reach stdout (Property 19)', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    // Spy on the real stdout sink and swallow writes so the logger cannot leak a
    // single byte to standard output; the spy records any attempt for assertion.
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Always restore the real stdout write so later tests/output are unaffected.
    stdoutSpy.mockRestore();
  });

  // Feature: billing-transfer-cli, Property 19: Diagnostic logs never reach stdout
  it('never writes to stdout for any --verbose value or sequence of log calls, and routes to stderr only under --verbose', () => {
    fc.assert(
      fc.property(fc.boolean(), callsArb, (verbose, calls) => {
        const mem = createMemoryStream();
        stdoutSpy.mockClear();

        // Configure the real shared Powertools logger: silent by default,
        // stderr-only (our in-memory stream) under --verbose, never stdout.
        configureCliLogging({ verbose }, { stderr: mem.stream });

        // Drive the singleton through arbitrary levels with arbitrary messages.
        // Each message is prefixed with a unique marker that survives JSON
        // serialization so we can assert routing precisely.
        const markers = calls.map((call, index) => {
          const marker = `MARK_${index}_zZ`;
          driveable[call.level](`${marker} ${call.body}`);
          return { marker, level: call.level };
        });

        // --- Core invariant (Req 24.5, 24.6): nothing ever reached stdout,
        // regardless of verbosity or level — not even info/debug/trace. ---
        expect(stdoutSpy).not.toHaveBeenCalled();

        const stderrText = mem.text();

        if (!verbose) {
          // --- Silent by default (Req 24.3): no diagnostics anywhere. ---
          expect(stderrText).toBe('');
        } else {
          // --- stderr-only under --verbose (Req 24.4): every level at or above
          // the DEBUG threshold appears on the injected stderr; sub-DEBUG levels
          // (trace) are suppressed. In all cases nothing reached stdout. ---
          for (const { marker, level } of markers) {
            if (isVisible(level, true)) {
              expect(stderrText).toContain(marker);
            } else {
              expect(stderrText).not.toContain(marker);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
