// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda event and result models
 */

import { CURReconciliationSummary } from './reconciliation.js';

/**
 * Lambda function event payload
 */
export interface CURReconciliationEvent {
  source: 'scheduler';
  action: 'reconcile-all';
}

/**
 * Lambda function result
 */
export interface CURReconciliationResult {
  summary: CURReconciliationSummary;
  timestamp: string;
}
