// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
import {
  createOutputFormatter,
  type RenderableView,
} from '../../../cli/lib/output-formatter.js';
import type { GlobalOptions, IoContext, OutputSink } from '../../../cli/lib/io-context.js';

/**
 * Unit tests for the Output_Formatter stdout/stderr split (Requirements 7.1, 7.4).
 *
 * These are concrete, example-based assertions (the companion to the optional
 * JSON-discipline property test) that pin down three contracts:
 *
 *  1. Human mode (`global.json === false`) renders a {@link RenderableView}
 *     (headings, text, key/value, tables) to the stdout sink as human-readable
 *     text, honoring the color flag (Req 7.1).
 *  2. JSON mode (`global.json === true`) writes exactly one JSON document to
 *     stdout and nothing else (Req 7.2 supporting 7.1's "JSON when --json").
 *  3. The failure path in JSON mode emits exactly one syntactically valid JSON
 *     document describing a structured error object on stdout (Req 7.4).
 *
 * All assertions use an in-memory IoContext with capturing OutputSinks so the
 * stdout/stderr split is observed directly.
 */

/**
 * In-memory {@link OutputSink} that records every write so a test can assert
 * exactly what reached a stream and how many discrete writes occurred.
 */
class CapturingSink implements OutputSink {
  /** Every `writeLine` argument, in order (newline stripped by the sink). */
  readonly lines: string[] = [];
  /** Every `write` argument, in order (no implicit newline). */
  readonly fragments: string[] = [];

  write(text: string): void {
    this.fragments.push(text);
  }

  writeLine(line: string): void {
    this.lines.push(line);
  }

  /** The full stream contents reconstructed exactly as bytes would appear. */
  get text(): string {
    return this.fragments.join('') + this.lines.map((line) => `${line}\n`).join('');
  }

  /** Count of discrete output operations (write + writeLine). */
  get writeCount(): number {
    return this.fragments.length + this.lines.length;
  }
}

/** Build a GlobalOptions with sensible defaults, overridable per test. */
function makeGlobal(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    scope: { kind: 'ambient' },
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

/**
 * Build a minimal IoContext carrying only the capturing sinks the formatter
 * touches. The remaining dependency slots are unused by the Output_Formatter,
 * so they are left undefined and the object is presented as an IoContext.
 */
function makeCtx(): { ctx: IoContext; stdout: CapturingSink; stderr: CapturingSink } {
  const stdout = new CapturingSink();
  const stderr = new CapturingSink();
  const ctx = { stdout, stderr } as unknown as IoContext;
  return { ctx, stdout, stderr };
}

/** A representative view exercising every RenderableBlock kind. */
function sampleView(): RenderableView {
  return {
    blocks: [
      { kind: 'heading', text: 'Transfer Analysis' },
      { kind: 'text', lines: ['Account 123456789012', 'State: ACCEPTED'] },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Total transfers', value: 3 },
          { label: 'Missing billing group', value: { value: 1, tone: 'warning' } },
        ],
      },
      {
        kind: 'table',
        title: 'Transfers',
        columns: [
          { header: 'Source', key: 'source' },
          { header: 'Type', key: 'type' },
          { header: 'Billing Group', key: 'bg', align: 'right' },
        ],
        rows: [
          { source: '111111111111', type: 'direct', bg: { value: 'present', tone: 'success' } },
          { source: '222222222222', type: 'indirect', bg: { value: 'absent', tone: 'failure' } },
        ],
      },
    ],
  };
}

describe('Output_Formatter stdout/stderr split (Req 7.1, 7.4)', () => {
  describe('human mode (global.json === false) — Req 7.1', () => {
    it('renders all block kinds to stdout as human-readable text and writes nothing to stderr', () => {
      const { ctx, stdout, stderr } = makeCtx();
      const formatter = createOutputFormatter(makeGlobal({ json: false, color: false }));

      formatter.emit({ ignored: 'payload' }, sampleView(), makeGlobal({ json: false, color: false }), ctx);

      const out = stdout.text;
      // Heading + both text lines.
      expect(out).toContain('Transfer Analysis');
      expect(out).toContain('Account 123456789012');
      expect(out).toContain('State: ACCEPTED');
      // Key/value rows (labels and values present).
      expect(out).toContain('Total transfers');
      expect(out).toContain('Missing billing group');
      // Table title, headers, and cell values.
      expect(out).toContain('Transfers');
      expect(out).toContain('Source');
      expect(out).toContain('Billing Group');
      expect(out).toContain('111111111111');
      expect(out).toContain('present');
      expect(out).toContain('absent');

      // Human mode is the result channel; stderr stays empty.
      expect(stderr.writeCount).toBe(0);
      // It is NOT a single JSON document.
      expect(() => JSON.parse(out)).toThrow();
    });

    it('emits no ANSI escape codes when color is off', () => {
      const { ctx, stdout } = makeCtx();
      const formatter = createOutputFormatter(makeGlobal({ json: false, color: false }));

      formatter.emit({}, sampleView(), makeGlobal({ json: false, color: false }), ctx);

      // eslint-disable-next-line no-control-regex
      expect(stdout.text).not.toMatch(/\u001b\[/);
    });

    it('emits ANSI escape codes when the color flag is on (honors the color flag)', () => {
      const { ctx, stdout } = makeCtx();
      const formatter = createOutputFormatter(makeGlobal({ json: false, color: true }));

      formatter.emit({}, sampleView(), makeGlobal({ json: false, color: true }), ctx);

      // eslint-disable-next-line no-control-regex
      expect(stdout.text).toMatch(/\u001b\[/);
    });

    it('re-syncs the color flag from the global passed to emit (constructed off, emitted on)', () => {
      const { ctx, stdout } = makeCtx();
      // Constructed with color OFF, but emit is given color ON.
      const formatter = createOutputFormatter(makeGlobal({ json: false, color: false }));

      formatter.emit({}, sampleView(), makeGlobal({ json: false, color: true }), ctx);

      // eslint-disable-next-line no-control-regex
      expect(stdout.text).toMatch(/\u001b\[/);
    });
  });

  describe('JSON mode (global.json === true) — single document on stdout', () => {
    it('writes exactly one JSON document to stdout and nothing to stderr', () => {
      const { ctx, stdout, stderr } = makeCtx();
      const payload = {
        account: '123456789012',
        totalTransfers: 3,
        missingBillingGroup: 1,
        transfers: [{ source: '111111111111', type: 'direct' }],
      };
      const formatter = createOutputFormatter(makeGlobal({ json: true }));

      formatter.emit(payload, sampleView(), makeGlobal({ json: true }), ctx);

      // Exactly one discrete write to stdout (the single JSON document).
      expect(stdout.writeCount).toBe(1);
      // The whole of stdout parses as one JSON document equal to the payload.
      expect(JSON.parse(stdout.text)).toEqual(payload);
      // The human view's heading text must not leak into JSON output.
      expect(stdout.text).not.toContain('Transfer Analysis');
      // Diagnostics channel stays clean.
      expect(stderr.writeCount).toBe(0);
    });

    it('renders a syntactically valid JSON document via renderJson directly', () => {
      const { ctx, stdout } = makeCtx();
      const payload = { ok: true, items: [1, 2, 3], nested: { a: null } };
      const formatter = createOutputFormatter(makeGlobal({ json: true }));

      formatter.renderJson(payload, ctx);

      expect(stdout.writeCount).toBe(1);
      expect(JSON.parse(stdout.text)).toEqual(payload);
    });
  });

  describe('failure path in JSON mode — Req 7.4', () => {
    it('emits exactly one valid JSON document describing a structured error object on stdout', () => {
      const { ctx, stdout, stderr } = makeCtx();
      // The structured error object a failing command would hand the formatter.
      const errorPayload = {
        error: {
          code: 'AccessDenied',
          message: 'User is not authorized to perform organizations:ListAccounts',
          remediation: 'Grant the organizations:ListAccounts permission to the profile.',
        },
      };
      const formatter = createOutputFormatter(makeGlobal({ json: true }));

      // Failure path renders the structured error object through the JSON channel.
      formatter.emit(errorPayload, { blocks: [] }, makeGlobal({ json: true }), ctx);

      // Exactly one JSON document on stdout.
      expect(stdout.writeCount).toBe(1);
      const parsed = JSON.parse(stdout.text);
      expect(parsed).toEqual(errorPayload);
      expect(parsed.error.code).toBe('AccessDenied');
      expect(parsed.error.remediation).toContain('organizations:ListAccounts');
      // Human-readable diagnostics belong on stderr, not stdout; the formatter
      // itself writes only the JSON document to stdout here.
      expect(stderr.writeCount).toBe(0);
    });

    it('still produces a single valid JSON document for an undefined payload (no bare undefined)', () => {
      const { ctx, stdout } = makeCtx();
      const formatter = createOutputFormatter(makeGlobal({ json: true }));

      formatter.renderJson(undefined, ctx);

      expect(stdout.writeCount).toBe(1);
      // Must be parseable rather than the literal text "undefined".
      expect(stdout.text.trim()).toBe('null');
      expect(JSON.parse(stdout.text)).toBeNull();
    });
  });
});
