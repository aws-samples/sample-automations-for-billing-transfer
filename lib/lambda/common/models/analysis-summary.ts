// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Analysis Summary Model
 *
 * Represents aggregated analysis results and statistics for billing transfers.
 * Includes relationship state context, unified resource counts, and filtering methods.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5, 8.4
 *
 * @module analysis-summary
 */

import { RelationshipState, TransferType } from './billing-transfer.js';
import {
  BillingTransferWithResourcesModel,
  ResourceType,
  hasResource,
} from './billing-transfer-resources.js';

/**
 * Resource availability counts
 * 
 * Tracks how many transfers have or are missing each resource type.
 * All resource types are treated uniformly.
 */
export interface ResourceCounts {
  /** Number of transfers with billing views */
  withBillingViews: number;
  /** Number of transfers with billing groups */
  withBillingGroups: number;
  /** Number of transfers with pricing plans */
  withPricingPlans: number;
  /** Number of transfers with CUR configurations */
  withCURConfigurations: number;
  /** Number of transfers missing billing views */
  missingBillingViews: number;
  /** Number of transfers missing billing groups */
  missingBillingGroups: number;
  /** Number of transfers missing pricing plans */
  missingPricingPlans: number;
  /** Number of transfers missing CUR configurations */
  missingCURConfigurations: number;
}

/**
 * Analysis Summary Model
 * 
 * Contains aggregated analysis results with relationship state context,
 * transfer counts, resource availability counts, and detailed transfer data.
 * 
 * Requirements: 4.2, 4.3, 4.4, 4.5, 8.4
 */
export interface AnalysisSummaryModel {
  /** Relationship state that was analyzed */
  relationshipState: RelationshipState;

  /** Total number of transfers analyzed */
  totalTransfers: number;

  /** Number of direct transfers */
  directTransferCount: number;

  /** Number of indirect transfers */
  indirectTransferCount: number;

  /** Resource availability counts (uniform treatment of all resource types) */
  resourceCounts: ResourceCounts;

  /** Detailed transfer data with resources */
  transfers: BillingTransferWithResourcesModel[];

  /** Timestamp when analysis was performed */
  analysisTimestamp: number;

  /** Execution time in milliseconds */
  executionTimeMs: number;
}


/**
 * Creates an AnalysisSummaryModel from transfer data
 * 
 * @param transfers - Array of transfers with resources
 * @param relationshipState - The relationship state that was analyzed
 * @param executionTimeMs - Execution time in milliseconds
 * @returns AnalysisSummaryModel instance
 */
export function createAnalysisSummary(
  transfers: BillingTransferWithResourcesModel[],
  relationshipState: RelationshipState,
  executionTimeMs: number
): AnalysisSummaryModel {
  const directTransfers = transfers.filter((t) => t.transfer.transferType === 'direct');
  const indirectTransfers = transfers.filter((t) => t.transfer.transferType === 'indirect');

  const resourceCounts = calculateResourceCounts(transfers);

  return {
    relationshipState,
    totalTransfers: transfers.length,
    directTransferCount: directTransfers.length,
    indirectTransferCount: indirectTransfers.length,
    resourceCounts,
    transfers,
    analysisTimestamp: Date.now(),
    executionTimeMs,
  };
}

/**
 * Calculates resource counts from transfer data
 * 
 * @param transfers - Array of transfers with resources
 * @returns ResourceCounts object
 */
export function calculateResourceCounts(
  transfers: BillingTransferWithResourcesModel[]
): ResourceCounts {
  let withBillingViews = 0;
  let withBillingGroups = 0;
  let withPricingPlans = 0;
  let withCURConfigurations = 0;

  for (const transfer of transfers) {
    if (hasResource(transfer, 'billingView')) withBillingViews++;
    if (hasResource(transfer, 'billingGroup')) withBillingGroups++;
    if (hasResource(transfer, 'pricingPlan')) withPricingPlans++;
    if (hasResource(transfer, 'curConfiguration')) withCURConfigurations++;
  }

  return {
    withBillingViews,
    withBillingGroups,
    withPricingPlans,
    withCURConfigurations,
    missingBillingViews: transfers.length - withBillingViews,
    missingBillingGroups: transfers.length - withBillingGroups,
    missingPricingPlans: transfers.length - withPricingPlans,
    missingCURConfigurations: transfers.length - withCURConfigurations,
  };
}

/**
 * Filters analysis summary by transfer type
 * 
 * Creates a new AnalysisSummaryModel containing only transfers of the specified type.
 * Maintains referential integrity between transfers and their associations.
 * 
 * @param summary - The analysis summary to filter
 * @param type - Transfer type to filter by (direct/indirect)
 * @returns New AnalysisSummaryModel with filtered transfers
 */
export function filterByTransferType(
  summary: AnalysisSummaryModel,
  type: TransferType
): AnalysisSummaryModel {
  const filteredTransfers = summary.transfers.filter(
    (t) => t.transfer.transferType === type
  );

  return createFilteredSummary(summary, filteredTransfers);
}

/**
 * Filters analysis summary by resource availability
 * 
 * Creates a new AnalysisSummaryModel containing only transfers that have
 * the specified resource type.
 * 
 * @param summary - The analysis summary to filter
 * @param resourceType - Resource type to filter by
 * @returns New AnalysisSummaryModel with filtered transfers
 */
export function filterByResourceAvailability(
  summary: AnalysisSummaryModel,
  resourceType: ResourceType
): AnalysisSummaryModel {
  const filteredTransfers = summary.transfers.filter((t) =>
    hasResource(t, resourceType)
  );

  return createFilteredSummary(summary, filteredTransfers);
}

/**
 * Filters analysis summary by account ID
 * 
 * Creates a new AnalysisSummaryModel containing only transfers where
 * the bill source account matches the specified account ID.
 * 
 * @param summary - The analysis summary to filter
 * @param accountId - Account ID to filter by
 * @returns New AnalysisSummaryModel with filtered transfers
 */
export function filterByAccountId(
  summary: AnalysisSummaryModel,
  accountId: string
): AnalysisSummaryModel {
  const filteredTransfers = summary.transfers.filter(
    (t) => t.transfer.billSourceAccountId === accountId
  );

  return createFilteredSummary(summary, filteredTransfers);
}

/**
 * Filters analysis summary by relationship status
 * 
 * Creates a new AnalysisSummaryModel containing only transfers with
 * the specified relationship state.
 * 
 * @param summary - The analysis summary to filter
 * @param status - Relationship state to filter by
 * @returns New AnalysisSummaryModel with filtered transfers
 */
export function filterByStatus(
  summary: AnalysisSummaryModel,
  status: RelationshipState
): AnalysisSummaryModel {
  const filteredTransfers = summary.transfers.filter(
    (t) => t.transfer.status === status
  );

  return createFilteredSummary(summary, filteredTransfers);
}

/**
 * Creates a filtered summary from existing summary and filtered transfers
 * 
 * Helper function that maintains consistent structure when filtering.
 * Recalculates all counts based on the filtered transfer set.
 * 
 * @param originalSummary - The original analysis summary
 * @param filteredTransfers - The filtered transfers array
 * @returns New AnalysisSummaryModel with recalculated counts
 */
function createFilteredSummary(
  originalSummary: AnalysisSummaryModel,
  filteredTransfers: BillingTransferWithResourcesModel[]
): AnalysisSummaryModel {
  const directTransfers = filteredTransfers.filter(
    (t) => t.transfer.transferType === 'direct'
  );
  const indirectTransfers = filteredTransfers.filter(
    (t) => t.transfer.transferType === 'indirect'
  );

  return {
    relationshipState: originalSummary.relationshipState,
    totalTransfers: filteredTransfers.length,
    directTransferCount: directTransfers.length,
    indirectTransferCount: indirectTransfers.length,
    resourceCounts: calculateResourceCounts(filteredTransfers),
    transfers: filteredTransfers,
    analysisTimestamp: originalSummary.analysisTimestamp,
    executionTimeMs: originalSummary.executionTimeMs,
  };
}

/**
 * Creates an empty analysis summary
 * 
 * Returns a summary with zero counts and empty transfers array.
 * Useful when filtering returns no results.
 * 
 * @param relationshipState - The relationship state context
 * @returns Empty AnalysisSummaryModel with consistent structure
 */
export function createEmptyAnalysisSummary(
  relationshipState: RelationshipState
): AnalysisSummaryModel {
  return {
    relationshipState,
    totalTransfers: 0,
    directTransferCount: 0,
    indirectTransferCount: 0,
    resourceCounts: {
      withBillingViews: 0,
      withBillingGroups: 0,
      withPricingPlans: 0,
      withCURConfigurations: 0,
      missingBillingViews: 0,
      missingBillingGroups: 0,
      missingPricingPlans: 0,
      missingCURConfigurations: 0,
    },
    transfers: [],
    analysisTimestamp: Date.now(),
    executionTimeMs: 0,
  };
}
