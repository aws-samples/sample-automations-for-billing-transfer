// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for the Output_Formatter's JSON output-channel discipline.
 *
 * Covers the design's Correctness Property 6 (Output-channel discipline in JSON
 * mode): for any command result emitted with `--json`, standard output contains
 * exactly one syntactically valid JSON document — a result payload on success or
 * a structured error object on failure — and nothing else, while all progress,
 * diagnostic, and human-readable text is reserved for standard error.
 *
 * The implementation under test is `createOutputFormatter` /
 * `DefaultOutputFormatter` from `cli/lib/output-formatter.ts`. The formatter is
 * driven through an in-memory IoContext whose stdout/stderr are capturing
 * OutputSinks, so the test can assert exactly what reached each stream.
 *
 * Validates: Requirements 6.5, 7.2, 7.3, 7.4
 */

import fc from 'fast-check';
import { createOutputFormatter, RenderableView } from '../../../cli/lib/output-formatter.js';
import type { GlobalOptions, IoContext, OutputSink } from '../../../cli/lib/io-context.js';

// ---------------------------------------------------------------------------
// In-memory capturing output sink
// ---------------------------------------------------------------------------

/**
 * An {@link OutputSink} that records everything written to it so a test can
 * reconstruct the exact stream contents and count how many distinct writes
 * occurred. `writeLine` mirrors the production contract by appending exactly one
 * trailing newline; `write` appends text verbatim.
 */
interface CapturingSink extends OutputSink {
  /** The exact bytes that would have reached the stream, in order. */
  text(): string;
  /** Number of `write(...)` (no-newline) calls. */
  writeCount(): number;
  /** Number of `writeLine(...)` calls. */
  writeLineCount(): number;
}

function createCapturingSink(): CapturingSink {
  const chunks: string[] = [];
  let writes = 0;
  let writeLines = 0;
  return {
    write(text: string): void {
      writes += 1;
      chunks.push(text);
    },
    writeLine(line: string): void {
      writeLines += 1;
      chunks.push(`${line}\n`);
    },
    text: () => chunks.join(''),
    writeCount: () => writes,
    writeLineCount: () => writeLines,
  };
}

/**
 * Build a minimal IoContext carrying only the two capturing sinks (plus the
 * trivially-required scalar fields). The Output_Formatter touches nothing else,
 * so the AWS clients / runners / reporter are intentionally left unset; the cast
 * keeps the test focused on the rendering seam.
 */
function createTestContext(): {
  ctx: IoContext;
  stdout: CapturingSink;
  stderr: CapturingSink;
} {
  const stdout = createCapturingSink();
  const stderr = createCapturingSink();
  const ctx = {
    stdout,
    stderr,
    env: {},
    cwd: '/tmp',
    now: () => 0,
  } as unknown as IoContext;
  return { ctx, stdout, stderr };
}

// A non-empty human view, present on every emit. In JSON mode it must be ignored
// entirely (nothing from it may reach stdout), which is part of the discipline.
const HUMAN_VIEW: RenderableView = {
  blocks: [
    { kind: 'heading', text: 'Diagnostic heading that must never reach stdout in JSON mode' },
    { kind: 'text', lines: ['progress line 1', 'progress line 2'] },
  ],
};

// Always-JSON global options for this property.
const jsonGlobal = (): GlobalOptions => ({
  scope: { kind: 'ambient' },
  json: true,
  color: false,
  execute: false,
  verbose: false,
});

/** Normalize any value to the canonical JSON round-trip form the formatter targets. */
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

// ---------------------------------------------------------------------------
// Arbitraries: arbitrary JSON-serializable result payloads + structured errors
// ---------------------------------------------------------------------------

/** Strings packed with the characters that most often break naive JSON emitters. */
const nastyStringArb = fc.constantFrom(
  '',
  '"quoted"',
  'back\\slash',
  'tab\tnewline\nreturn\r',
  'unicode \u2028\u2029 \u0000 \u001b[31m',
  '}{][,:',
  '😀 \uD83D\uDE00 multi-byte',
  'null',
  'true',
  '12345',
);

/**
 * A structured error object of the shape the formatter emits on the failure path
 * (Req 7.4): a single JSON document describing the error.
 */
const structuredErrorArb = fc.record({
  error: fc.record({
    code: fc.constantFrom('CredentialsError', 'AccessDenied', 'Throttling', 'UnknownError'),
    message: nastyStringArb,
    remediation: nastyStringArb,
  }),
  exitCode: fc.constantFrom(1, 2, 64),
});

/**
 * The full payload space: arbitrary JSON-compliant values (objects, arrays,
 * nested structures, special-character strings, numbers, booleans, null) from
 * `fc.jsonValue()`, plus explicit nasty strings, structured error objects, and
 * the `undefined` case that exercises the formatter's `payload ?? null` guard.
 */
const payloadArb = fc.oneof(
  fc.jsonValue(),
  nastyStringArb,
  structuredErrorArb,
  fc.constant(undefined),
  fc.constant(null),
);

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

describe('Output_Formatter — JSON output-channel discipline (Property 6)', () => {
  // Feature: billing-transfer-cli, Property 6: Output-channel discipline in JSON mode
  it('emits exactly one valid JSON document that round-trips the payload to stdout, and nothing to stderr, for any payload', () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        const { ctx, stdout, stderr } = createTestContext();
        const formatter = createOutputFormatter(jsonGlobal());

        // emit() chooses the JSON path from global.json === true.
        formatter.emit(payload, HUMAN_VIEW, jsonGlobal(), ctx);

        const out = stdout.text();

        // --- Exactly one document was written to stdout ---
        // renderJson writes the whole document via a single writeLine and never
        // uses the no-newline write(), so the human view cannot have leaked in.
        expect(stdout.writeLineCount()).toBe(1);
        expect(stdout.writeCount()).toBe(0);

        // --- stdout is syntactically valid JSON parseable without modification.
        // Two concatenated documents (or any trailing human text) would make the
        // whole-buffer parse throw, so a successful parse proves "exactly one". ---
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(out);
        }).not.toThrow();

        // --- The single document round-trips the payload ---
        expect(parsed).toEqual(canonical(payload));

        // --- Output-channel discipline: nothing reached stderr from the
        // formatter in JSON mode, and the human/diagnostic view was suppressed. ---
        expect(stderr.text()).toBe('');
        expect(stderr.writeCount()).toBe(0);
        expect(stderr.writeLineCount()).toBe(0);

        // The diagnostic heading/progress lines from HUMAN_VIEW must not appear
        // anywhere on stdout (Req 7.3): stdout carries only the JSON document.
        expect(out).not.toContain('Diagnostic heading that must never reach stdout');
        expect(out).not.toContain('progress line 1');

        // stdout is exactly the document plus the single trailing newline from
        // writeLine — i.e. no extra bytes beyond the one JSON document.
        expect(out.endsWith('\n')).toBe(true);
        expect(out.slice(0, -1)).toBe(JSON.stringify(canonical(payload), null, 2));
      }),
      { numRuns: 200 },
    );
  });

  // Feature: billing-transfer-cli, Property 6: Output-channel discipline in JSON mode
  it('renderJson alone (the failure-path writer) also emits exactly one JSON document for structured error objects', () => {
    fc.assert(
      fc.property(structuredErrorArb, (errorPayload) => {
        const { ctx, stdout, stderr } = createTestContext();
        const formatter = createOutputFormatter(jsonGlobal());

        // The failure path (Req 7.4) calls renderJson directly with a structured
        // error object; it must still produce exactly one valid JSON document.
        formatter.renderJson(errorPayload, ctx);

        const out = stdout.text();
        expect(stdout.writeLineCount()).toBe(1);
        expect(stdout.writeCount()).toBe(0);
        expect(() => JSON.parse(out)).not.toThrow();
        expect(JSON.parse(out)).toEqual(canonical(errorPayload));
        expect(stderr.text()).toBe('');
      }),
      { numRuns: 100 },
    );
  });
});
