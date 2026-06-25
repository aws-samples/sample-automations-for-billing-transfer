// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Billing Transfer Resources Model
 *
 * Represents a billing transfer and all its associated billing conductor resources.
 * All resource types (billing view, billing group, pricing plan, CUR configuration)
 * are treated uniformly as billing transfer resources.
 *
 * Requirements: 8.3, 9.5, 9.8
 *
 * @module billing-transfer-resources
 */

import { BillingTransferModel } from './billing-transfer.js';
import { BillingView } from './billing-view.js';

/**
 * Billing Group representation
 * 
 * Represents a Billing Conductor billing group that groups accounts
 * for billing management and associates with pricing plans.
 */
export interface BillingGroup {
  /** Billing group ARN */
  arn: string;
  /** Billing group name */
  name: string;
  /** Description of the billing group */
  description?: string;
  /** Primary account ID for the billing group */
  primaryAccountId: string;
  /** ARN of the associated pricing plan */
  pricingPlanArn: string;
  /** Responsibility transfer ARN (for billing transfer billing groups) */
  responsibilityTransferArn?: string;
  /** Creation timestamp */
  creationTime?: number;
  /** Last modified timestamp */
  lastModifiedTime?: number;
  /** Billing group status */
  status?: 'ACTIVE' | 'PRIMARY_ACCOUNT_MISSING';
}

/**
 * Pricing Plan representation
 * 
 * Represents a Billing Conductor pricing plan that defines
 * pricing rules and rates for billing groups.
 */
export interface PricingPlan {
  /** Pricing plan ARN */
  arn: string;
  /** Pricing plan name */
  name: string;
  /** Description of the pricing plan */
  description?: string;
  /** Creation timestamp */
  creationTime?: number;
  /** Last modified timestamp */
  lastModifiedTime?: number;
}

/**
 * CUR Configuration representation
 * 
 * Represents a Cost and Usage Report configuration that provides
 * detailed billing data exports for billing views.
 * 
 * Note: CUR reports are associated with billing views via BillingViewArn,
 * not directly with billing groups.
 */
export interface CURConfiguration {
  /** Report name */
  reportName: string;
  /** S3 bucket for report delivery */
  s3Bucket: string;
  /** S3 prefix for report files */
  s3Prefix?: string;
  /** S3 region */
  s3Region: string;
  /** Time granularity */
  timeUnit: 'HOURLY' | 'DAILY' | 'MONTHLY';
  /** Report format */
  format: 'textORcsv' | 'Parquet';
  /** Compression type */
  compression: 'ZIP' | 'GZIP' | 'Parquet';
  /** Additional schema elements */
  additionalSchemaElements: string[];
  /** Additional artifacts */
  additionalArtifacts: string[];
  /** Whether to refresh closed reports */
  refreshClosedReports: boolean;
  /** Report versioning strategy */
  reportVersioning: 'CREATE_NEW_REPORT' | 'OVERWRITE_REPORT';
  /** Associated billing view ARN (CUR reports are linked to billing views) */
  billingViewArn?: string;
  /** Creation timestamp */
  creationTimestamp?: number;
  /** Last modified timestamp */
  lastModifiedTimestamp?: number;
  /** Configuration status */
  status?: 'ACTIVE' | 'INACTIVE';
}

/**
 * Resource types that can be associated with a billing transfer
 */
export type ResourceType = 'billingView' | 'billingGroup' | 'pricingPlan' | 'curConfiguration';

/**
 * All resource types as an array for iteration
 */
export const ALL_RESOURCE_TYPES: ResourceType[] = [
  'billingView',
  'billingGroup',
  'pricingPlan',
  'curConfiguration',
];

/**
 * Resources associated with a billing transfer
 * 
 * All resource types are treated uniformly. Missing resources
 * are represented as null rather than being omitted.
 */
export interface BillingTransferResources {
  /**
   * Associated My View billing view (BILLING_TRANSFER type), null if not found.
   * Kept as `billingView` for backward compatibility with the billing-group
   * reconciliation path, which only cares that a transfer billing view exists.
   */
  billingView: BillingView | null;
  /**
   * Associated Showback billing view (BILLING_TRANSFER_SHOWBACK type), null if
   * not found. A transfer may legitimately have a My View but no Showback view.
   */
  showbackBillingView: BillingView | null;
  /** Associated billing group (null if not found) */
  billingGroup: BillingGroup | null;
  /** Associated pricing plan (null if not found) */
  pricingPlan: PricingPlan | null;
  /** Associated My View CUR configuration (null if not found) */
  curConfiguration: CURConfiguration | null;
  /** Associated Showback CUR configuration (null if not found) */
  showbackCurConfiguration: CURConfiguration | null;
}

/**
 * Flags indicating which resources were found
 */
export interface ResourcesFoundFlags {
  billingView: boolean;
  showbackBillingView: boolean;
  billingGroup: boolean;
  pricingPlan: boolean;
  curConfiguration: boolean;
  showbackCurConfiguration: boolean;
}


/**
 * Unified model representing a billing transfer and all its associated resources
 * 
 * This model combines a BillingTransferModel with all its associated billing
 * conductor resources (billing view, billing group, pricing plan, CUR configuration).
 * All resource types are treated uniformly.
 * 
 * Requirements: 8.3, 9.5, 9.8
 */
export interface BillingTransferWithResourcesModel {
  /** The billing transfer */
  transfer: BillingTransferModel;

  /** Associated billing transfer resources (all treated uniformly) */
  resources: BillingTransferResources;

  /** Timestamp when resources were retrieved */
  retrievalTimestamp: number;

  /** Flags indicating which resources were found */
  resourcesFound: ResourcesFoundFlags;
}

/**
 * Creates a BillingTransferWithResourcesModel from transfer and resources
 * 
 * @param transfer - The billing transfer model
 * @param resources - The associated resources (partial, missing will be null)
 * @returns BillingTransferWithResourcesModel instance
 */
export function createBillingTransferWithResources(
  transfer: BillingTransferModel,
  resources: Partial<BillingTransferResources>
): BillingTransferWithResourcesModel {
  const fullResources: BillingTransferResources = {
    billingView: resources.billingView ?? null,
    showbackBillingView: resources.showbackBillingView ?? null,
    billingGroup: resources.billingGroup ?? null,
    pricingPlan: resources.pricingPlan ?? null,
    curConfiguration: resources.curConfiguration ?? null,
    showbackCurConfiguration: resources.showbackCurConfiguration ?? null,
  };

  return {
    transfer,
    resources: fullResources,
    retrievalTimestamp: Date.now(),
    resourcesFound: {
      billingView: fullResources.billingView !== null,
      showbackBillingView: fullResources.showbackBillingView !== null,
      billingGroup: fullResources.billingGroup !== null,
      pricingPlan: fullResources.pricingPlan !== null,
      curConfiguration: fullResources.curConfiguration !== null,
      showbackCurConfiguration: fullResources.showbackCurConfiguration !== null,
    },
  };
}

/**
 * Checks if all resources are present for a transfer
 * 
 * @param model - The BillingTransferWithResourcesModel to check
 * @returns true if all resources are present
 */
export function hasAllResources(model: BillingTransferWithResourcesModel): boolean {
  return (
    model.resourcesFound.billingView &&
    model.resourcesFound.billingGroup &&
    model.resourcesFound.pricingPlan &&
    model.resourcesFound.curConfiguration
  );
}

/**
 * Gets the list of missing resource types for a transfer
 * 
 * @param model - The BillingTransferWithResourcesModel to check
 * @returns Array of missing resource type names
 */
export function getMissingResources(model: BillingTransferWithResourcesModel): ResourceType[] {
  const missing: ResourceType[] = [];

  if (!model.resourcesFound.billingView) {
    missing.push('billingView');
  }
  if (!model.resourcesFound.billingGroup) {
    missing.push('billingGroup');
  }
  if (!model.resourcesFound.pricingPlan) {
    missing.push('pricingPlan');
  }
  if (!model.resourcesFound.curConfiguration) {
    missing.push('curConfiguration');
  }

  return missing;
}

/**
 * Checks if a specific resource type is present
 * 
 * @param model - The BillingTransferWithResourcesModel to check
 * @param resourceType - The resource type to check for
 * @returns true if the resource is present
 */
export function hasResource(
  model: BillingTransferWithResourcesModel,
  resourceType: ResourceType
): boolean {
  return model.resourcesFound[resourceType];
}

/**
 * Filters transfers that have all resources
 * 
 * @param models - Array of BillingTransferWithResourcesModel
 * @returns Filtered array with only complete transfers
 */
export function filterCompleteTransfers(
  models: BillingTransferWithResourcesModel[]
): BillingTransferWithResourcesModel[] {
  return models.filter(hasAllResources);
}

/**
 * Filters transfers that are missing a specific resource type
 * 
 * @param models - Array of BillingTransferWithResourcesModel
 * @param resourceType - The resource type to check for
 * @returns Filtered array with transfers missing the specified resource
 */
export function filterMissingResource(
  models: BillingTransferWithResourcesModel[],
  resourceType: ResourceType
): BillingTransferWithResourcesModel[] {
  return models.filter((model) => !hasResource(model, resourceType));
}

/**
 * Filters transfers that have a specific resource type
 * 
 * @param models - Array of BillingTransferWithResourcesModel
 * @param resourceType - The resource type to check for
 * @returns Filtered array with transfers having the specified resource
 */
export function filterHasResource(
  models: BillingTransferWithResourcesModel[],
  resourceType: ResourceType
): BillingTransferWithResourcesModel[] {
  return models.filter((model) => hasResource(model, resourceType));
}
