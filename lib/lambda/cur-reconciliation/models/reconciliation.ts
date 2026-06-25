// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CUR Reconciliation Models
 * 
 * Models specific to CUR (Cost and Usage Report) reconciliation operations.
 * These are distinct from billing group reconciliation models.
 */

/**
 * Summary of tagging operations
 * 
 * Note: Billing view tagging is not supported by AWS - managed billing views
 * (billing-transfer views) cannot be tagged. Only CUR report tagging is tracked.
 */
export interface CURTaggingSummary {
  curReportsTagged: number;
  curReportsTaggingFailed: number;
}

/**
 * Summary of CUR reconciliation execution
 * 
 * Requirements: 5.2, 5.3
 */
export interface CURReconciliationSummary {
  totalTransfersProcessed: number;
  myViewReportsCreated: number;
  myViewReportsAlreadyExisted: number;
  myViewReportsFailed: number;
  /** Transfers skipped because no My View billing view applies (not a failure) */
  myViewReportsSkipped: number;
  showbackViewReportsCreated: number;
  showbackViewReportsAlreadyExisted: number;
  showbackViewReportsFailed: number;
  /** Transfers skipped because no Showback billing view applies (not a failure) */
  showbackViewReportsSkipped: number;
  /** 
   * Array of failed transfer errors
   * Requirements: 5.3 - Error objects include accountId, error message, and timestamp
   */
  failedTransfers: Array<{
    transferId: string;
    /** Account ID where error occurred (billSourceAccountId) */
    billSourceAccountId: string;
    viewType: 'MY_VIEW' | 'SHOWBACK_VIEW';
    errorMessage: string;
    /** Timestamp when error occurred (ISO 8601 format) */
    timestamp?: string;
  }>;
  supportCasesCreated: number;
  supportCasesFailed: number;
  tagging: CURTaggingSummary;
}
