// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Support case models for backfill requests
 */

/**
 * Request to create a support case for historical data backfill
 */
export interface BackfillRequest {
  exportName: string;
  billingViewArn: string;
  billingPeriodRange: {
    start: string; // YYYY-MM format
    end: string; // YYYY-MM format
  };
  severityCode: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
}

/**
 * Result of support case creation
 */
export interface SupportCaseResult {
  caseId?: string;
  created: boolean;
  errorMessage?: string;
}
