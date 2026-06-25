// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Validation Result Model
 *
 * Represents the results of validating consistency between billing transfers
 * and their associated resources. Includes missing resources and orphaned
 * resources with uniform categorization.
 *
 * Requirements: 2.5, 2.6
 *
 * @module validation-result
 */

import { RelationshipState } from './billing-transfer.js';
import {
  BillingTransferWithResourcesModel,
  BillingGroup,
} from './billing-transfer-resources.js';
import { BillingView } from './billing-view.js';

/**
 * Missing resources categorized by type
 * 
 * Contains transfers that are missing specific resource types.
 * All resource types are treated uniformly.
 */
export interface MissingResources {
  /** Transfers missing billing views (unexpected - AWS manages these) */
  billingViews: BillingTransferWithResourcesModel[];
  /** Transfers missing billing groups (critical - needs automation) */
  billingGroups: BillingTransferWithResourcesModel[];
  /** Transfers missing pricing plans (warning) */
  pricingPlans: BillingTransferWithResourcesModel[];
  /** Transfers missing CUR configurations (warning) */
  curConfigurations: BillingTransferWithResourcesModel[];
}

/**
 * Orphaned resources categorized by type
 * 
 * Contains resources that exist without corresponding active transfers.
 */
export interface OrphanedResources {
  /** Billing views without corresponding active transfers */
  billingViews: BillingView[];
  /** Billing groups without corresponding active transfers */
  billingGroups: BillingGroup[];
}

/**
 * Issue counts by type
 * 
 * Summary counts for each type of validation issue found.
 */
export interface IssuesByType {
  /** Missing billing views (unexpected - AWS manages these) */
  missingBillingViews: number;
  /** Missing billing groups (critical - needs automation) */
  missingBillingGroups: number;
  /** Missing pricing plans (warning) */
  missingPricingPlans: number;
  /** Missing CUR configurations (warning) */
  missingCURConfigurations: number;
  /** Orphaned billing views */
  orphanedBillingViews: number;
  /** Orphaned billing groups */
  orphanedBillingGroups: number;
}

/**
 * Validation Result Model
 * 
 * Contains the complete results of a validation operation including
 * overall status, detailed findings, and summary counts.
 * 
 * Requirements: 2.5, 2.6
 */
export interface ValidationResultModel {
  /** Overall validation status - true if no issues found */
  isValid: boolean;

  /** Timestamp when validation was performed */
  validationTimestamp: number;

  /** Relationship state that was validated */
  relationshipState: RelationshipState;

  /** Detailed findings - transfers missing resources (uniform treatment) */
  missingResources: MissingResources;

  /** Detailed findings - resources without corresponding transfers */
  orphanedResources: OrphanedResources;

  /** Total number of issues found */
  totalIssues: number;

  /** Issue counts by type */
  issuesByType: IssuesByType;
}


/**
 * Creates a ValidationResultModel from validation findings
 * 
 * @param relationshipState - The relationship state that was validated
 * @param missingResources - Transfers missing resources
 * @param orphanedResources - Resources without corresponding transfers
 * @returns ValidationResultModel instance
 */
export function createValidationResult(
  relationshipState: RelationshipState,
  missingResources: MissingResources,
  orphanedResources: OrphanedResources
): ValidationResultModel {
  const issuesByType: IssuesByType = {
    missingBillingViews: missingResources.billingViews.length,
    missingBillingGroups: missingResources.billingGroups.length,
    missingPricingPlans: missingResources.pricingPlans.length,
    missingCURConfigurations: missingResources.curConfigurations.length,
    orphanedBillingViews: orphanedResources.billingViews.length,
    orphanedBillingGroups: orphanedResources.billingGroups.length,
  };

  const totalIssues =
    issuesByType.missingBillingViews +
    issuesByType.missingBillingGroups +
    issuesByType.missingPricingPlans +
    issuesByType.missingCURConfigurations +
    issuesByType.orphanedBillingViews +
    issuesByType.orphanedBillingGroups;

  return {
    isValid: totalIssues === 0,
    validationTimestamp: Date.now(),
    relationshipState,
    missingResources,
    orphanedResources,
    totalIssues,
    issuesByType,
  };
}

/**
 * Creates an empty validation result (no issues found)
 * 
 * @param relationshipState - The relationship state that was validated
 * @returns ValidationResultModel with no issues
 */
export function createEmptyValidationResult(
  relationshipState: RelationshipState
): ValidationResultModel {
  return createValidationResult(
    relationshipState,
    {
      billingViews: [],
      billingGroups: [],
      pricingPlans: [],
      curConfigurations: [],
    },
    {
      billingViews: [],
      billingGroups: [],
    }
  );
}

/**
 * Checks if validation result has critical issues
 * 
 * Critical issues are missing billing groups, which require automation
 * to create. Missing billing views are unexpected (AWS manages these)
 * and should be logged as potential AWS service issues.
 * 
 * @param result - The validation result to check
 * @returns true if there are critical issues
 */
export function hasCriticalIssues(result: ValidationResultModel): boolean {
  return result.issuesByType.missingBillingGroups > 0;
}

/**
 * Checks if validation result has warning-level issues
 * 
 * Warning issues include missing pricing plans and CUR configurations.
 * These are less critical but should be addressed.
 * 
 * @param result - The validation result to check
 * @returns true if there are warning-level issues
 */
export function hasWarningIssues(result: ValidationResultModel): boolean {
  return (
    result.issuesByType.missingPricingPlans > 0 ||
    result.issuesByType.missingCURConfigurations > 0
  );
}

/**
 * Checks if validation result has unexpected issues
 * 
 * Unexpected issues are missing billing views, which AWS should
 * automatically create for billing transfers.
 * 
 * @param result - The validation result to check
 * @returns true if there are unexpected issues
 */
export function hasUnexpectedIssues(result: ValidationResultModel): boolean {
  return result.issuesByType.missingBillingViews > 0;
}

/**
 * Checks if validation result has orphaned resources
 * 
 * @param result - The validation result to check
 * @returns true if there are orphaned resources
 */
export function hasOrphanedResources(result: ValidationResultModel): boolean {
  return (
    result.issuesByType.orphanedBillingViews > 0 ||
    result.issuesByType.orphanedBillingGroups > 0
  );
}

/**
 * Gets a summary of validation issues for logging
 * 
 * @param result - The validation result
 * @returns Object with summary information for logging
 */
export function getValidationSummary(result: ValidationResultModel): {
  isValid: boolean;
  totalIssues: number;
  criticalIssues: number;
  warningIssues: number;
  unexpectedIssues: number;
  orphanedResources: number;
} {
  return {
    isValid: result.isValid,
    totalIssues: result.totalIssues,
    criticalIssues: result.issuesByType.missingBillingGroups,
    warningIssues:
      result.issuesByType.missingPricingPlans +
      result.issuesByType.missingCURConfigurations,
    unexpectedIssues: result.issuesByType.missingBillingViews,
    orphanedResources:
      result.issuesByType.orphanedBillingViews +
      result.issuesByType.orphanedBillingGroups,
  };
}
