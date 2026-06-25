// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for reconciliation status derivation (Property 12).
 *
 * Covers the design's Correctness Property 12 (Reconciliation status derivation
 * follows the marker/error/DLQ truth table): for any combination of
 * (completion-marker-present, failure-marker-present, item-error-count,
 * dead-letter-queue depth) within the lookback window, the derived function
 * status is `FAILED` when a failure marker is present (regardless of the
 * completion marker or DLQ depth); otherwise `PENDING` when no completion marker
 * is present; otherwise `ATTENTION` when item errors are greater than zero or the
 * DLQ depth is greater than zero; otherwise `DONE`.
 *
 * The implementation under test is the pure, exported
 * `deriveFunctionStatus(signals: ReconStatusSignals): ReconStatus` from
 * `cli/commands/reconciliation/status.ts`. The test asserts its output equals the
 * status prescribed by an INDEPENDENT oracle (`oracleStatus` below) — a separate
 * encoding of the Req 12.1–12.3 truth table — over arbitrary signals, and also
 * pins the precedence cases explicitly (failure dominates completion + DLQ;
 * pending only when neither marker is present; attention vs done split on item
 * errors / DLQ depth).
 *
 * Validates: Requirements 12.1, 12.2, 12.3
 */

import fc from 'fast-check';

import {
  deriveFunctionStatus,
  type ReconStatus,
  type ReconStatusSignals,
} from '../../../../cli/commands/reconciliation/status.js';

// ---------------------------------------------------------------------------
// Independent oracle (a separate encoding of the Req 12.1–12.3 truth table)
//
// Written deliberately as a flat, order-independent case analysis rather than
// the implementation's early-return cascade, so the two cannot share a bug. The
// four cases are mutually exclusive and exhaustive over the signal space, so the
// oracle is total by construction.
// ---------------------------------------------------------------------------

function oracleStatus(signals: ReconStatusSignals): ReconStatus {
  const { completionPresent, failurePresent, itemErrors, dlqDepth } = signals;

  // Req 12.2: a failure marker forces FAILED regardless of completion / DLQ.
  if (failurePresent) {
    return 'FAILED';
  }
  // Req 12.1 (PENDING half): no completion *and* no failure marker in the window.
  if (!completionPresent) {
    return 'PENDING';
  }
  // Here a completion marker is present and no failure marker is present.
  // Req 12.3: item errors > 0 or DLQ depth > 0 ⇒ ATTENTION.
  if (itemErrors > 0 || dlqDepth > 0) {
    return 'ATTENTION';
  }
  // Req 12.1 (DONE half): completion, no failure, zero item errors, DLQ depth 0.
  return 'DONE';
}

// ---------------------------------------------------------------------------
// Arbitraries — the full signal space
//
// Counts are arbitrary non-negative integers (a real DLQ depth / item-error
// count is never negative); the booleans range over all four marker
// combinations, so the four-way truth table is exercised end to end.
// ---------------------------------------------------------------------------

const nonNegativeInt = fc.nat();

const signalsArb: fc.Arbitrary<ReconStatusSignals> = fc.record({
  completionPresent: fc.boolean(),
  failurePresent: fc.boolean(),
  itemErrors: nonNegativeInt,
  dlqDepth: nonNegativeInt,
});

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

describe('Reconciliation status derivation — truth table (Property 12)', () => {
  // Feature: billing-transfer-cli, Property 12: Reconciliation status derivation follows the marker/error/DLQ truth table
  it('derives exactly the status the marker/error/DLQ truth table prescribes', () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        expect(deriveFunctionStatus(signals)).toBe(oracleStatus(signals));
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: billing-transfer-cli, Property 12: Reconciliation status derivation follows the marker/error/DLQ truth table
  it('FAILED dominates: a failure marker forces FAILED regardless of completion / item errors / DLQ (Req 12.2)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        nonNegativeInt,
        nonNegativeInt,
        (completionPresent, itemErrors, dlqDepth) => {
          const status = deriveFunctionStatus({
            completionPresent,
            failurePresent: true,
            itemErrors,
            dlqDepth,
          });
          expect(status).toBe('FAILED');
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 12: Reconciliation status derivation follows the marker/error/DLQ truth table
  it('PENDING only when neither a completion nor a failure marker is present (Req 12.1)', () => {
    fc.assert(
      fc.property(nonNegativeInt, nonNegativeInt, (itemErrors, dlqDepth) => {
        const status = deriveFunctionStatus({
          completionPresent: false,
          failurePresent: false,
          itemErrors,
          dlqDepth,
        });
        // No completion marker, no failure marker ⇒ PENDING, irrespective of counts.
        expect(status).toBe('PENDING');
      }),
      { numRuns: 300 },
    );
  });

  // Feature: billing-transfer-cli, Property 12: Reconciliation status derivation follows the marker/error/DLQ truth table
  it('with a completion marker and no failure marker, splits ATTENTION vs DONE on item errors / DLQ depth (Req 12.1, 12.3)', () => {
    fc.assert(
      fc.property(nonNegativeInt, nonNegativeInt, (itemErrors, dlqDepth) => {
        const status = deriveFunctionStatus({
          completionPresent: true,
          failurePresent: false,
          itemErrors,
          dlqDepth,
        });
        if (itemErrors > 0 || dlqDepth > 0) {
          // Req 12.3: any item error or any DLQ message ⇒ ATTENTION.
          expect(status).toBe('ATTENTION');
        } else {
          // Req 12.1: clean completion (zero errors, empty DLQ) ⇒ DONE.
          expect(status).toBe('DONE');
        }
      }),
      { numRuns: 300 },
    );
  });
});
