// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared Reconciliation Log Markers
 *
 * Single source of truth for the completion and failure marker strings that the
 * reconciliation Lambda handlers emit via the Powertools logger. The `bt`
 * reconciliation-status command reads these same markers from CloudWatch Logs to
 * derive per-function status, so centralizing them here keeps the emitters and the
 * reader from silently drifting apart.
 *
 * The string values MUST match the markers historically inlined in the handlers so
 * existing CloudWatch Logs queries and Lambda behavior are unchanged.
 *
 * @module log-markers
 */

/**
 * Reconciliation completion/failure markers, grouped by reconciliation function.
 *
 * - `bg`: Billing Group reconciliation (`billing-group-reconciliation/index.ts`)
 * - `cur`: CUR reconciliation (`cur-reconciliation/index.ts`)
 */
export const RECON_MARKERS = {
  bg: {
    ok: 'Reconciliation completed successfully',
    fail: 'Reconciliation failed with critical error',
  },
  cur: {
    ok: 'CUR reconciliation completed successfully',
    fail: 'CUR reconciliation failed',
    execCompleted: 'CUR reconciliation execution completed',
  },
} as const;
