// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Output_Formatter — the single rendering seam for the `bt` CLI (Requirement 7).
 *
 * Every command produces a result and hands it to the Output_Formatter, which
 * renders it one of two ways:
 *
 *  - **Human mode** (default): a {@link RenderableView} of ordered blocks
 *    (headings, text, key/value pairs, tables) written to `ctx.stdout`,
 *    optionally colorized with ANSI escapes when the color flag is set
 *    (Req 7.1).
 *  - **JSON mode** (`--json`): exactly one syntactically valid JSON document
 *    written to `ctx.stdout` — a result payload on success or a structured
 *    error object on failure — and nothing else (Req 7.2, 7.3, 7.4).
 *
 * stdout is reserved for the command result. All progress and diagnostic text
 * goes to `ctx.stderr`, so a `--json` consumer can parse stdout without
 * stripping anything (Req 7.3). `emit` is the single entry point handlers call;
 * it chooses the path from `global.json`. The implementation deliberately
 * carries no table/color third-party dependency — alignment and ANSI coloring
 * are done in-module.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 *
 * @module output-formatter
 */

// Type-only imports keep this module free of a runtime dependency on
// io-context.ts (which itself type-imports OutputFormatter/RenderableView from
// here), avoiding a circular runtime import.
import type { GlobalOptions, IoContext, OutputSink } from './io-context.js';

/**
 * Semantic tone applied to a piece of human-readable output. Tones map to ANSI
 * colors only when the color flag is on; in JSON mode and when color is off
 * they are ignored, so tone never changes machine-readable output.
 */
export type Tone = 'default' | 'success' | 'failure' | 'warning' | 'info' | 'muted';

/** A primitive value that can appear in a table cell or key/value entry. */
export type CellValue = string | number | boolean | null | undefined;

/**
 * A renderable cell: either a bare primitive, or a primitive paired with a
 * {@link Tone} so individual cells (e.g. a per-account status) can be colorized
 * in human mode without affecting JSON output.
 */
export type RenderableCell = CellValue | { value: CellValue; tone?: Tone };

/** A single column definition for a {@link TableBlock}. */
export interface TableColumn {
  /** Header label printed at the top of the column. */
  header: string;
  /** Key looked up in each row record to obtain the cell value. */
  key: string;
  /** Cell alignment within the column; defaults to `'left'`. */
  align?: 'left' | 'right';
}

/** A bold heading line. */
export interface HeadingBlock {
  kind: 'heading';
  text: string;
  /** Optional tone for the heading; defaults to a bold `'default'`. */
  tone?: Tone;
}

/** One or more free-text lines, rendered verbatim. */
export interface TextBlock {
  kind: 'text';
  lines: string[];
  /** Optional tone applied to every line in the block. */
  tone?: Tone;
}

/** A left-aligned list of `label : value` rows. */
export interface KeyValueBlock {
  kind: 'keyValue';
  entries: Array<{ label: string; value: RenderableCell }>;
}

/** A column-aligned table with an optional title. */
export interface TableBlock {
  kind: 'table';
  /** Optional title rendered as a heading above the table. */
  title?: string;
  columns: TableColumn[];
  /** Each row maps a column `key` to a {@link RenderableCell}. */
  rows: Array<Record<string, RenderableCell>>;
  /** Optional message shown instead of the grid when there are no rows. */
  emptyText?: string;
}

/** One renderable unit in a {@link RenderableView}. */
export type RenderableBlock = HeadingBlock | TextBlock | KeyValueBlock | TableBlock;

/**
 * The human-readable shape a handler builds for the Output_Formatter. It is an
 * ordered list of blocks rendered top-to-bottom to stdout, separated by blank
 * lines. The same handler also passes a structured payload (the `--json` shape)
 * to {@link OutputFormatter.emit}; the two are independent representations of
 * the same result.
 */
export interface RenderableView {
  blocks: RenderableBlock[];
}

/**
 * Renders command results as human tables/colorized text by default, or a
 * single valid JSON document with `--json`. JSON goes only to stdout; all
 * diagnostics go to stderr (Req 7).
 */
export interface OutputFormatter {
  /** Human path: tables/sections to stdout; honors the color flag. */
  renderHuman(view: RenderableView, ctx: IoContext): void;
  /** JSON path: writes exactly one JSON document to stdout (result or structured error), nothing else. */
  renderJson(payload: unknown, ctx: IoContext): void;
  /** Chooses the path based on `global.json`; the single entry handlers call. */
  emit(payload: unknown, view: RenderableView, global: GlobalOptions, ctx: IoContext): void;
}

// ---------------------------------------------------------------------------
// ANSI coloring (dependency-free)
// ---------------------------------------------------------------------------

const RESET = '\u001b[0m';

/** ANSI SGR foreground codes per tone (bold is layered on for headings). */
const TONE_CODES: Record<Tone, string> = {
  default: '',
  success: '\u001b[32m', // green
  failure: '\u001b[31m', // red
  warning: '\u001b[33m', // yellow
  info: '\u001b[36m', // cyan
  muted: '\u001b[90m', // bright black / gray
};

const BOLD = '\u001b[1m';

/** Wrap `text` in the ANSI codes for `tone` when `color` is enabled. */
function colorize(text: string, tone: Tone, color: boolean, bold = false): string {
  if (!color) {
    return text;
  }
  const prefix = `${bold ? BOLD : ''}${TONE_CODES[tone] ?? ''}`;
  return prefix ? `${prefix}${text}${RESET}` : text;
}

// ---------------------------------------------------------------------------
// Cell / value normalization
// ---------------------------------------------------------------------------

/** Convert a primitive cell value to its display string (nullish → empty). */
function stringifyValue(value: CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/** Normalize any {@link RenderableCell} to a `{ text, tone }` pair. */
function normalizeCell(cell: RenderableCell): { text: string; tone: Tone } {
  if (cell !== null && typeof cell === 'object') {
    return { text: stringifyValue(cell.value), tone: cell.tone ?? 'default' };
  }
  return { text: stringifyValue(cell), tone: 'default' };
}

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

/** Replacer that makes BigInt values JSON-serializable rather than throwing. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Serialize `payload` to a single JSON document string. Guards the edge cases
 * where `JSON.stringify` would otherwise yield `undefined` (a bare `undefined`
 * payload or a value that serializes to nothing) so the output is always a
 * syntactically valid JSON document (Req 7.2, 7.4).
 */
function toJsonDocument(payload: unknown): string {
  const json = JSON.stringify(payload ?? null, jsonReplacer, 2);
  return json ?? 'null';
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderHeading(block: HeadingBlock, color: boolean): string[] {
  return [colorize(block.text, block.tone ?? 'default', color, true)];
}

function renderText(block: TextBlock, color: boolean): string[] {
  const tone = block.tone ?? 'default';
  return block.lines.map((line) => colorize(line, tone, color));
}

function renderKeyValue(block: KeyValueBlock, color: boolean): string[] {
  const labelWidth = block.entries.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  return block.entries.map((entry) => {
    const { text, tone } = normalizeCell(entry.value);
    const label = colorize(entry.label.padEnd(labelWidth), 'muted', color);
    return `${label}  ${colorize(text, tone, color)}`;
  });
}

function renderTable(block: TableBlock, color: boolean): string[] {
  if (block.rows.length === 0) {
    const lines = block.title ? [colorize(block.title, 'default', color, true)] : [];
    lines.push(colorize(block.emptyText ?? '(no rows)', 'muted', color));
    return lines;
  }

  // Pre-compute each cell's display text/tone and the width of every column.
  const widths = block.columns.map((column) => column.header.length);
  const renderedRows = block.rows.map((row) =>
    block.columns.map((column, columnIndex) => {
      const cell = normalizeCell(row[column.key]);
      widths[columnIndex] = Math.max(widths[columnIndex], cell.text.length);
      return cell;
    }),
  );

  const pad = (text: string, width: number, align: TableColumn['align']): string =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const lines: string[] = [];
  if (block.title) {
    lines.push(colorize(block.title, 'default', color, true));
  }

  // Header row + underline, then the data rows. Padding is computed on the raw
  // (uncolored) text so alignment stays correct regardless of ANSI codes.
  const header = block.columns
    .map((column, index) => colorize(pad(column.header, widths[index], column.align), 'default', color, true))
    .join('  ');
  lines.push(header);
  lines.push(colorize(widths.map((width) => '-'.repeat(width)).join('  '), 'muted', color));

  for (const cells of renderedRows) {
    const line = cells
      .map((cell, index) => colorize(pad(cell.text, widths[index], block.columns[index].align), cell.tone, color))
      .join('  ');
    lines.push(line);
  }

  return lines;
}

function renderBlock(block: RenderableBlock, color: boolean): string[] {
  switch (block.kind) {
    case 'heading':
      return renderHeading(block, color);
    case 'text':
      return renderText(block, color);
    case 'keyValue':
      return renderKeyValue(block, color);
    case 'table':
      return renderTable(block, color);
  }
}

// ---------------------------------------------------------------------------
// OutputFormatter implementation
// ---------------------------------------------------------------------------

class DefaultOutputFormatter implements OutputFormatter {
  /**
   * Active color preference. Captured at construction from the threaded
   * GlobalOptions and re-synced from the `global` passed to {@link emit}, so
   * the human path always honors the color flag the caller resolved (Req 7.1).
   */
  private color: boolean;

  constructor(global: GlobalOptions) {
    this.color = global.color;
  }

  renderHuman(view: RenderableView, ctx: IoContext): void {
    const out: OutputSink = ctx.stdout;
    view.blocks.forEach((block, index) => {
      if (index > 0) {
        out.writeLine(''); // blank line between blocks
      }
      for (const line of renderBlock(block, this.color)) {
        out.writeLine(line);
      }
    });
  }

  renderJson(payload: unknown, ctx: IoContext): void {
    // Exactly one JSON document to stdout — the single writer in JSON mode, on
    // both the success and failure paths (Req 7.2, 7.3, 7.4).
    ctx.stdout.writeLine(toJsonDocument(payload));
  }

  emit(payload: unknown, view: RenderableView, global: GlobalOptions, ctx: IoContext): void {
    if (global.json) {
      this.renderJson(payload, ctx);
      return;
    }
    this.color = global.color;
    this.renderHuman(view, ctx);
  }
}

/**
 * Construct an {@link OutputFormatter} bound to the resolved global options.
 * The entrypoint builds one per invocation and places it on the IoContext so
 * handlers render through a single, mockable seam.
 */
export function createOutputFormatter(global: GlobalOptions): OutputFormatter {
  return new DefaultOutputFormatter(global);
}
