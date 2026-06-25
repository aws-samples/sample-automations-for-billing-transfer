// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Validation Service
 *
 * Validates consistency between billing transfers and their associated
 * billing transfer resources. All resource types are validated uniformly.
 *
 * Features:
 * - Detect missing billing views (unexpected - AWS manages these)
 * - Detect missing billing groups (critical - needs automation)
 * - Detect missing CUR configurations (warning)
 * - Detect orphaned billing views and billing groups
 * - Provide detailed validation results with categorization
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 *
 * @module validation-service
 */

import { logger } from '../utils/logger.js';
import { RelationshipState } from '../models/billing-transfer.js';
import {
  BillingTransferWithResourcesModel,
  BillingGroup,
  filterMissingResource,
  filterHasResource,
} from '../models/billing-transfer-resources.js';
import { BillingView } from '../models/billing-view.js';
import {
  ValidationResultModel,
  MissingResources,
  OrphanedResources,
  createValidationResult,
  createEmptyValidationResult,
  getValidationSummary,
} from '../models/validation-result.js';
import { AllBillingTransferResources } from '../models/all-billing-transfer-resources.js';

/**
 * Options for validation operations
 */
export interface ValidationOptions {
  /** Relationship state being validated. Default: 'ACCEPTED' */
  relationshipState?: RelationshipState;
}

/**
 * Default validation options
 */
export const DEFAULT_VALIDATION_OPTIONS: Required<ValidationOptions> = {
  relationshipState: 'ACCEPTED',
};

/**
 * Summary of missing resources
 */
export interface MissingResourcesSummary {
  /** Total transfers analyzed */
  totalTransfers: number;
  /** Transfers missing billing views */
  missingBillingViews: number;
  /** Transfers missing billing groups */
  missingBillingGroups: number;
  /** Transfers missing pricing plans */
  missingPricingPlans: number;
  /** Transfers missing CUR configurations */
  missingCURConfigurations: number;
}


/**
 * Validates transfer consistency by checking for missing and orphaned resources
 *
 * This method performs comprehensive validation of billing transfers and their
 * associated resources:
 * - Identifies transfers missing billing views (unexpected - AWS manages these)
 * - Identifies transfers missing billing groups (critical - needs automation)
 * - Identifies transfers missing CUR configurations (warning)
 * - Identifies orphaned billing views and billing groups
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 *
 * @param transfers - Array of BillingTransferWithResourcesModel to validate
 * @param allResources - All billing transfer resources for orphan detection
 * @param options - Validation options
 * @returns ValidationResultModel with detailed findings
 */
export async function validateTransferConsistency(
  transfers: BillingTransferWithResourcesModel[],
  allResources?: AllBillingTransferResources,
  options?: ValidationOptions
): Promise<ValidationResultModel> {
  const opts = { ...DEFAULT_VALIDATION_OPTIONS, ...options };

  logger.info('Starting transfer consistency validation', {
    transferCount: transfers.length,
    relationshipState: opts.relationshipState,
    hasAllResources: !!allResources,
    operation: 'validateTransferConsistency',
  });

  const startTime = Date.now();

  // If no transfers to validate, return empty result
  if (transfers.length === 0) {
    logger.info('No transfers to validate', {
      relationshipState: opts.relationshipState,
      operation: 'validateTransferConsistency',
    });
    return createEmptyValidationResult(opts.relationshipState);
  }

  // Identify missing resources
  // Requirements: 2.1, 2.2, 2.3
  const missingResources = identifyMissingResourcesSync(transfers);

  // Log missing billing views as potential AWS service issues
  // Requirements: 2.1
  if (missingResources.billingViews.length > 0) {
    logger.warn('Transfers missing billing views detected - potential AWS service issue', {
      count: missingResources.billingViews.length,
      transferIds: missingResources.billingViews.map((t) => t.transfer.id),
      operation: 'validateTransferConsistency',
    });
  }

  // Log missing billing groups as critical issues
  // Requirements: 2.2
  if (missingResources.billingGroups.length > 0) {
    logger.warn('Transfers missing billing groups detected - critical issue requiring automation', {
      count: missingResources.billingGroups.length,
      transferIds: missingResources.billingGroups.map((t) => t.transfer.id),
      operation: 'validateTransferConsistency',
    });
  }

  // Log missing CUR configurations as warnings
  // Requirements: 2.3
  if (missingResources.curConfigurations.length > 0) {
    logger.info('Transfers missing CUR configurations detected - warning', {
      count: missingResources.curConfigurations.length,
      transferIds: missingResources.curConfigurations.map((t) => t.transfer.id),
      operation: 'validateTransferConsistency',
    });
  }

  // Identify orphaned resources if allResources is provided
  // Requirements: 2.4
  let orphanedResources: OrphanedResources = {
    billingViews: [],
    billingGroups: [],
  };

  if (allResources) {
    orphanedResources = identifyOrphanedResources(transfers, allResources);

    if (orphanedResources.billingViews.length > 0) {
      logger.warn('Orphaned billing views detected', {
        count: orphanedResources.billingViews.length,
        viewArns: orphanedResources.billingViews.map((v) => v.arn),
        operation: 'validateTransferConsistency',
      });
    }

    if (orphanedResources.billingGroups.length > 0) {
      logger.warn('Orphaned billing groups detected', {
        count: orphanedResources.billingGroups.length,
        groupArns: orphanedResources.billingGroups.map((g) => g.arn),
        operation: 'validateTransferConsistency',
      });
    }
  }

  // Create validation result
  // Requirements: 2.5, 2.6
  const result = createValidationResult(
    opts.relationshipState,
    missingResources,
    orphanedResources
  );

  const executionTime = Date.now() - startTime;
  const summary = getValidationSummary(result);

  logger.info('Transfer consistency validation completed', {
    ...summary,
    executionTimeMs: executionTime,
    relationshipState: opts.relationshipState,
    operation: 'validateTransferConsistency',
  });

  return result;
}


/**
 * Identifies missing resources from transfers
 *
 * Analyzes transfers to find those missing specific resource types.
 * All resource types are treated uniformly.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 2.6
 *
 * @param transfers - Array of BillingTransferWithResourcesModel to analyze
 * @returns Promise<MissingResourcesSummary> with counts of missing resources
 */
export async function identifyMissingResources(
  transfers: BillingTransferWithResourcesModel[]
): Promise<MissingResourcesSummary> {
  logger.info('Identifying missing resources', {
    transferCount: transfers.length,
    operation: 'identifyMissingResources',
  });

  const missingResources = identifyMissingResourcesSync(transfers);

  const summary: MissingResourcesSummary = {
    totalTransfers: transfers.length,
    missingBillingViews: missingResources.billingViews.length,
    missingBillingGroups: missingResources.billingGroups.length,
    missingPricingPlans: missingResources.pricingPlans.length,
    missingCURConfigurations: missingResources.curConfigurations.length,
  };

  logger.info('Missing resources identified', {
    ...summary,
    operation: 'identifyMissingResources',
  });

  return summary;
}

/**
 * Synchronously identifies missing resources from transfers
 *
 * Internal helper that categorizes transfers by missing resource type.
 *
 * Requirements: 2.1, 2.2, 2.3
 *
 * @param transfers - Array of BillingTransferWithResourcesModel to analyze
 * @returns MissingResources with categorized transfers
 */
function identifyMissingResourcesSync(
  transfers: BillingTransferWithResourcesModel[]
): MissingResources {
  // Transfers missing billing views (unexpected - AWS manages these)
  // Requirements: 2.1
  const missingBillingViews = filterMissingResource(transfers, 'billingView');

  // Transfers with billing views but missing billing groups (critical)
  // Requirements: 2.2
  const transfersWithViews = filterHasResource(transfers, 'billingView');
  const missingBillingGroups = filterMissingResource(transfersWithViews, 'billingGroup');

  // Transfers with billing groups but missing pricing plans (warning)
  const transfersWithGroups = filterHasResource(transfers, 'billingGroup');
  const missingPricingPlans = filterMissingResource(transfersWithGroups, 'pricingPlan');

  // Transfers with billing groups but missing CUR configurations (warning)
  // Requirements: 2.3
  const missingCURConfigurations = filterMissingResource(transfersWithGroups, 'curConfiguration');

  return {
    billingViews: missingBillingViews,
    billingGroups: missingBillingGroups,
    pricingPlans: missingPricingPlans,
    curConfigurations: missingCURConfigurations,
  };
}


/**
 * Identifies orphaned resources
 *
 * Finds billing views and billing groups that exist without corresponding
 * active transfers. These are resources that may have been left behind
 * when transfers were terminated.
 *
 * Requirements: 2.4
 *
 * @param transfers - Array of BillingTransferWithResourcesModel (active transfers)
 * @param allResources - All billing transfer resources from AWS
 * @returns OrphanedResources with orphaned billing views and billing groups
 */
export function identifyOrphanedResources(
  transfers: BillingTransferWithResourcesModel[],
  allResources: AllBillingTransferResources
): OrphanedResources {
  logger.debug('Identifying orphaned resources', {
    transferCount: transfers.length,
    totalBillingViews: allResources.billingViews.length,
    totalBillingGroups: allResources.billingGroups.length,
    operation: 'identifyOrphanedResources',
  });

  // Build sets of transfer ARNs and source account IDs for quick lookup
  const transferArns = new Set(transfers.map((t) => t.transfer.arn));
  const sourceAccountIds = new Set(transfers.map((t) => t.transfer.billSourceAccountId));

  // Find orphaned billing views
  // A billing view is orphaned if its source account doesn't have an active transfer
  const orphanedBillingViews = allResources.billingViews.filter((view) => {
    // Only consider BILLING_TRANSFER type views
    if (view.billingViewType !== 'BILLING_TRANSFER') {
      return false;
    }
    // Check if there's no active transfer for this source account
    return view.sourceAccountId && !sourceAccountIds.has(view.sourceAccountId);
  });

  // Find orphaned billing groups
  // A billing group is orphaned if it has a responsibilityTransferArn that doesn't
  // match any active transfer
  const orphanedBillingGroups = allResources.billingGroups.filter((group) => {
    // Only consider billing groups with responsibility transfer ARN
    if (!group.responsibilityTransferArn) {
      return false;
    }
    // Check if there's no active transfer with this ARN
    return !transferArns.has(group.responsibilityTransferArn);
  });

  logger.debug('Orphaned resources identified', {
    orphanedBillingViews: orphanedBillingViews.length,
    orphanedBillingGroups: orphanedBillingGroups.length,
    operation: 'identifyOrphanedResources',
  });

  return {
    billingViews: orphanedBillingViews,
    billingGroups: orphanedBillingGroups,
  };
}

/**
 * Detects missing billing views
 *
 * Identifies transfers that are missing billing views. This is unexpected
 * because AWS automatically creates billing views for billing transfers.
 * Missing billing views should be logged as potential AWS service issues.
 *
 * Requirements: 2.1
 *
 * @param transfers - Array of BillingTransferWithResourcesModel to check
 * @returns Array of transfers missing billing views
 */
export function detectMissingBillingViews(
  transfers: BillingTransferWithResourcesModel[]
): BillingTransferWithResourcesModel[] {
  const missing = filterMissingResource(transfers, 'billingView');

  if (missing.length > 0) {
    logger.warn('Missing billing views detected - potential AWS service issue', {
      count: missing.length,
      transferIds: missing.map((t) => t.transfer.id),
      sourceAccountIds: missing.map((t) => t.transfer.billSourceAccountId),
      operation: 'detectMissingBillingViews',
    });
  }

  return missing;
}

/**
 * Detects missing billing groups
 *
 * Identifies transfers that have billing views but are missing billing groups.
 * This is a critical issue that requires automation to create the billing groups.
 *
 * Requirements: 2.2
 *
 * @param transfers - Array of BillingTransferWithResourcesModel to check
 * @returns Array of transfers missing billing groups
 */
export function detectMissingBillingGroups(
  transfers: BillingTransferWithResourcesModel[]
): BillingTransferWithResourcesModel[] {
  // Only check transfers that have billing views
  const transfersWithViews = filterHasResource(transfers, 'billingView');
  const missing = filterMissingResource(transfersWithViews, 'billingGroup');

  if (missing.length > 0) {
    logger.warn('Missing billing groups detected - critical issue requiring automation', {
      count: missing.length,
      transferIds: missing.map((t) => t.transfer.id),
      transferArns: missing.map((t) => t.transfer.arn),
      operation: 'detectMissingBillingGroups',
    });
  }

  return missing;
}

/**
 * Detects missing CUR configurations
 *
 * Identifies transfers that have billing groups but are missing CUR configurations.
 * This is a warning-level issue as CUR configurations are optional but recommended.
 *
 * Requirements: 2.3
 *
 * @param transfers - Array of BillingTransferWithResourcesModel to check
 * @returns Array of transfers missing CUR configurations
 */
export function detectMissingCURConfigurations(
  transfers: BillingTransferWithResourcesModel[]
): BillingTransferWithResourcesModel[] {
  // Only check transfers that have billing groups
  const transfersWithGroups = filterHasResource(transfers, 'billingGroup');
  const missing = filterMissingResource(transfersWithGroups, 'curConfiguration');

  if (missing.length > 0) {
    logger.info('Missing CUR configurations detected - warning', {
      count: missing.length,
      transferIds: missing.map((t) => t.transfer.id),
      billingGroupArns: missing.map((t) => t.resources.billingGroup?.arn),
      operation: 'detectMissingCURConfigurations',
    });
  }

  return missing;
}

/**
 * Detects orphaned billing views
 *
 * Identifies billing views that exist without corresponding active transfers.
 * These may be left over from terminated transfers.
 *
 * Requirements: 2.4
 *
 * @param transfers - Array of active transfers
 * @param allBillingViews - All billing views from AWS
 * @returns Array of orphaned billing views
 */
export function detectOrphanedBillingViews(
  transfers: BillingTransferWithResourcesModel[],
  allBillingViews: BillingView[]
): BillingView[] {
  const sourceAccountIds = new Set(transfers.map((t) => t.transfer.billSourceAccountId));

  const orphaned = allBillingViews.filter((view) => {
    // Only consider BILLING_TRANSFER type views
    if (view.billingViewType !== 'BILLING_TRANSFER') {
      return false;
    }
    return view.sourceAccountId && !sourceAccountIds.has(view.sourceAccountId);
  });

  if (orphaned.length > 0) {
    logger.warn('Orphaned billing views detected', {
      count: orphaned.length,
      viewArns: orphaned.map((v) => v.arn),
      sourceAccountIds: orphaned.map((v) => v.sourceAccountId),
      operation: 'detectOrphanedBillingViews',
    });
  }

  return orphaned;
}

/**
 * Detects orphaned billing groups
 *
 * Identifies billing groups that exist without corresponding active transfers.
 * These may be left over from terminated transfers.
 *
 * Requirements: 2.4
 *
 * @param transfers - Array of active transfers
 * @param allBillingGroups - All billing groups from AWS
 * @returns Array of orphaned billing groups
 */
export function detectOrphanedBillingGroups(
  transfers: BillingTransferWithResourcesModel[],
  allBillingGroups: BillingGroup[]
): BillingGroup[] {
  const transferArns = new Set(transfers.map((t) => t.transfer.arn));

  const orphaned = allBillingGroups.filter((group) => {
    // Only consider billing groups with responsibility transfer ARN
    if (!group.responsibilityTransferArn) {
      return false;
    }
    return !transferArns.has(group.responsibilityTransferArn);
  });

  if (orphaned.length > 0) {
    logger.warn('Orphaned billing groups detected', {
      count: orphaned.length,
      groupArns: orphaned.map((g) => g.arn),
      transferArns: orphaned.map((g) => g.responsibilityTransferArn),
      operation: 'detectOrphanedBillingGroups',
    });
  }

  return orphaned;
}

