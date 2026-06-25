// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * All Billing Transfer Resources Container Model
 *
 * Container for all billing transfer resources retrieved from AWS.
 * Used for caching and batch operations to avoid redundant API calls.
 *
 * Requirements: 9.7
 *
 * @module all-billing-transfer-resources
 */

import {
  BillingGroup,
  PricingPlan,
  CURConfiguration,
} from './billing-transfer-resources.js';
import { BillingView } from './billing-view.js';

/**
 * Resource counts for all resource types
 */
export interface AllResourceCounts {
  billingViews: number;
  billingGroups: number;
  pricingPlans: number;
  curConfigurations: number;
}

/**
 * Container for all billing transfer resources
 * 
 * Holds all resources retrieved from AWS APIs for caching and batch operations.
 * Includes lookup helper methods for efficient resource matching.
 * 
 * Requirements: 9.7
 */
export interface AllBillingTransferResources {
  /** All billing views */
  billingViews: BillingView[];

  /** All billing groups */
  billingGroups: BillingGroup[];

  /** All pricing plans */
  pricingPlans: PricingPlan[];

  /** All CUR configurations */
  curConfigurations: CURConfiguration[];

  /** Timestamp when resources were retrieved */
  retrievalTimestamp: number;

  /** Resource counts */
  resourceCounts: AllResourceCounts;
}

/**
 * Creates an AllBillingTransferResources container from resource arrays
 * 
 * @param billingViews - Array of billing views
 * @param billingGroups - Array of billing groups
 * @param pricingPlans - Array of pricing plans
 * @param curConfigurations - Array of CUR configurations
 * @returns AllBillingTransferResources container
 */
export function createAllBillingTransferResources(
  billingViews: BillingView[],
  billingGroups: BillingGroup[],
  pricingPlans: PricingPlan[],
  curConfigurations: CURConfiguration[]
): AllBillingTransferResources {
  return {
    billingViews,
    billingGroups,
    pricingPlans,
    curConfigurations,
    retrievalTimestamp: Date.now(),
    resourceCounts: {
      billingViews: billingViews.length,
      billingGroups: billingGroups.length,
      pricingPlans: pricingPlans.length,
      curConfigurations: curConfigurations.length,
    },
  };
}

/**
 * Creates an empty AllBillingTransferResources container
 * 
 * @returns Empty AllBillingTransferResources container
 */
export function createEmptyAllBillingTransferResources(): AllBillingTransferResources {
  return createAllBillingTransferResources([], [], [], []);
}


/**
 * Finds a billing view by source account ID
 * 
 * Searches for a billing view where the sourceAccountId matches.
 * Used for matching billing views to transfers.
 * 
 * @param resources - The AllBillingTransferResources container
 * @param accountId - Source account ID to search for
 * @returns Matching billing view or null if not found
 */
export function findBillingViewBySourceAccount(
  resources: AllBillingTransferResources,
  accountId: string
): BillingView | null {
  return (
    resources.billingViews.find((view) => view.sourceAccountId === accountId) ??
    null
  );
}

/**
 * Finds a billing view by source account ID and transfer name
 * 
 * Searches for a billing view where both sourceAccountId and name match.
 * This is more precise when multiple transfers exist for the same account.
 * 
 * @param resources - The AllBillingTransferResources container
 * @param accountId - Source account ID to search for
 * @param transferName - Transfer name to match
 * @returns Matching billing view or null if not found
 */
export function findBillingViewBySourceAccountAndName(
  resources: AllBillingTransferResources,
  accountId: string,
  transferName: string
): BillingView | null {
  // First try exact match on both account and name
  const exactMatch = resources.billingViews.find(
    (view) => view.sourceAccountId === accountId && view.name === transferName
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Fall back to account-only match
  return findBillingViewBySourceAccount(resources, accountId);
}

/**
 * Finds a billing view by source account, billing view type, and (optionally)
 * transfer name.
 *
 * This is type-aware: it only returns a view whose billingViewType matches the
 * requested type. This is required to resolve a Showback view
 * (BILLING_TRANSFER_SHOWBACK) independently from a My View (BILLING_TRANSFER),
 * since a transfer's source account can have one of each. Matching purely on
 * source account (as findBillingViewBySourceAccountAndName does) would always
 * return whichever view is first, hiding the Showback view.
 *
 * @param resources - The AllBillingTransferResources container
 * @param accountId - Source account ID to search for
 * @param viewType - The billing view type to match
 * @param transferName - Optional transfer name to disambiguate multiple views
 * @returns Matching billing view of the requested type, or null if none
 */
export function findBillingViewBySourceAccountTypeAndName(
  resources: AllBillingTransferResources,
  accountId: string,
  viewType: BillingView['billingViewType'],
  transferName?: string
): BillingView | null {
  const ofType = resources.billingViews.filter(
    (view) => view.sourceAccountId === accountId && view.billingViewType === viewType
  );
  if (ofType.length === 0) {
    return null;
  }
  if (transferName) {
    const byName = ofType.find((view) => view.name === transferName);
    if (byName) {
      return byName;
    }
  }
  return ofType[0];
}

/**
 * Finds a billing group by transfer ARN
 * 
 * Searches for a billing group where the responsibilityTransferArn matches.
 * 
 * @param resources - The AllBillingTransferResources container
 * @param transferArn - Transfer ARN to search for
 * @returns Matching billing group or null if not found
 */
export function findBillingGroupByTransferArn(
  resources: AllBillingTransferResources,
  transferArn: string
): BillingGroup | null {
  return (
    resources.billingGroups.find(
      (group) => group.responsibilityTransferArn === transferArn
    ) ?? null
  );
}

/**
 * Finds a billing group by primary account ID
 * 
 * Searches for a billing group where the primaryAccountId matches.
 * 
 * @param resources - The AllBillingTransferResources container
 * @param accountId - Primary account ID to search for
 * @returns Matching billing group or null if not found
 */
export function findBillingGroupByPrimaryAccount(
  resources: AllBillingTransferResources,
  accountId: string
): BillingGroup | null {
  return (
    resources.billingGroups.find(
      (group) => group.primaryAccountId === accountId
    ) ?? null
  );
}

/**
 * Finds a pricing plan by ARN
 * 
 * @param resources - The AllBillingTransferResources container
 * @param pricingPlanArn - Pricing plan ARN to search for
 * @returns Matching pricing plan or null if not found
 */
export function findPricingPlanByArn(
  resources: AllBillingTransferResources,
  pricingPlanArn: string
): PricingPlan | null {
  return (
    resources.pricingPlans.find((plan) => plan.arn === pricingPlanArn) ?? null
  );
}

/**
 * Finds CUR configurations by billing view ARN
 * 
 * Searches for CUR configurations associated with a billing view.
 * A billing view may have multiple CUR configurations.
 * 
 * Note: CUR reports are associated with billing views via BillingViewArn,
 * not directly with billing groups.
 * 
 * @param resources - The AllBillingTransferResources container
 * @param billingViewArn - Billing view ARN to search for
 * @returns Array of matching CUR configurations (may be empty)
 */
export function findCURConfigurationsByBillingViewArn(
  resources: AllBillingTransferResources,
  billingViewArn: string
): CURConfiguration[] {
  return resources.curConfigurations.filter(
    (config) => config.billingViewArn === billingViewArn
  );
}

/**
 * Finds the first CUR configuration by billing view ARN
 * 
 * @param resources - The AllBillingTransferResources container
 * @param billingViewArn - Billing view ARN to search for
 * @returns First matching CUR configuration or null if not found
 */
export function findCURConfigurationByBillingViewArn(
  resources: AllBillingTransferResources,
  billingViewArn: string
): CURConfiguration | null {
  return (
    resources.curConfigurations.find(
      (config) => config.billingViewArn === billingViewArn
    ) ?? null
  );
}

/**
 * Gets all billing views for a specific source account
 * 
 * @param resources - The AllBillingTransferResources container
 * @param accountId - Source account ID to search for
 * @returns Array of billing views for the account
 */
export function getBillingViewsForAccount(
  resources: AllBillingTransferResources,
  accountId: string
): BillingView[] {
  return resources.billingViews.filter(
    (view) => view.sourceAccountId === accountId
  );
}

/**
 * Gets all billing groups for a specific primary account
 * 
 * @param resources - The AllBillingTransferResources container
 * @param accountId - Primary account ID to search for
 * @returns Array of billing groups for the account
 */
export function getBillingGroupsForAccount(
  resources: AllBillingTransferResources,
  accountId: string
): BillingGroup[] {
  return resources.billingGroups.filter(
    (group) => group.primaryAccountId === accountId
  );
}
