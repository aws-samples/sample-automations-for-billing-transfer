// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Billing Transfer Resources Service
 *
 * Retrieves and matches complete billing conductor resources for transfers.
 * All resource types (billing views, billing groups, pricing plans, CUR configurations)
 * are treated uniformly as billing transfer resources.
 *
 * Features:
 * - List all resource types with pagination handling
 * - Match resources to transfers using transfer ARN and account ID
 * - Cache resources during batch operations to avoid redundant API calls
 * - Uniform treatment of all resource types
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
 *
 * @module billing-transfer-resources-service
 */

import {
  ListBillingGroupsCommand,
  ListPricingPlansCommand,
  BillingGroupListElement,
  PricingPlanListElement,
} from '@aws-sdk/client-billingconductor';
import {
  DescribeReportDefinitionsCommand,
  ReportDefinition,
} from '@aws-sdk/client-cost-and-usage-report-service';
import { logger } from '../utils/logger.js';
import { billingConductorClient, curClient } from '../utils/clients.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../utils/retry.js';
import { BillingTransferModel } from '../models/billing-transfer.js';
import {
  BillingGroup,
  PricingPlan,
  CURConfiguration,
  BillingTransferWithResourcesModel,
  createBillingTransferWithResources,
} from '../models/billing-transfer-resources.js';
import {
  AllBillingTransferResources,
  createAllBillingTransferResources,
  findBillingViewBySourceAccountTypeAndName,
  findBillingGroupByTransferArn,
  findPricingPlanByArn,
  findCURConfigurationByBillingViewArn,
  getBillingViewsForAccount,
  getBillingGroupsForAccount,
} from '../models/all-billing-transfer-resources.js';
import { listBillingViews as listBillingViewsFromService } from './billing-service.js';
import { BillingView } from '../models/billing-view.js';

// Re-export clients for backward compatibility
export { billingConductorClient, curClient } from '../utils/clients.js';


/**
 * Resource cache for batch operations
 * 
 * Stores all resources during batch operations to avoid redundant API calls.
 * Cache is cleared when a new batch operation starts.
 */
let resourceCache: AllBillingTransferResources | null = null;

/**
 * Clears the resource cache
 * 
 * Call this before starting a new batch operation to ensure fresh data.
 */
export function clearResourceCache(): void {
  resourceCache = null;
  logger.debug('Resource cache cleared');
}

/**
 * Lists all billing views
 * 
 * Retrieves all BILLING_TRANSFER type billing views using the billing service.
 * Handles pagination automatically.
 * 
 * Requirements: 9.1
 * 
 * @returns Array of billing views
 */
export async function listBillingViews(): Promise<BillingView[]> {
  logger.info('Listing all billing views', { operation: 'listBillingViews' });

  const startTime = Date.now();

  try {
    // Fetch BOTH transfer view types. The Showback view type
    // (BILLING_TRANSFER_SHOWBACK) must be included so transfers can be matched
    // to their Showback billing view; previously only BILLING_TRANSFER was
    // loaded, so Showback views were never in the cache and Showback CUR
    // reconciliation always skipped.
    const views = await listBillingViewsFromService([
      'BILLING_TRANSFER',
      'BILLING_TRANSFER_SHOWBACK',
    ]);

    const executionTime = Date.now() - startTime;
    logger.info('Successfully listed billing views', {
      viewCount: views.length,
      executionTimeMs: executionTime,
      operation: 'listBillingViews',
    });

    return views;
  } catch (error) {
    logger.error('Failed to list billing views', {
      error: error as Error,
      operation: 'listBillingViews',
    });
    throw error;
  }
}

/**
 * Lists all billing groups
 * 
 * Retrieves all billing groups from Billing Conductor.
 * Handles pagination automatically.
 * 
 * Requirements: 9.2
 * 
 * @returns Array of billing groups
 */
export async function listBillingGroups(): Promise<BillingGroup[]> {
  logger.info('Listing all billing groups', { operation: 'listBillingGroups' });

  const startTime = Date.now();
  const billingGroups: BillingGroup[] = [];
  let nextToken: string | undefined = undefined;
  let pageCount = 0;

  try {
    do {
      pageCount++;
      const response = await retryWithBackoff(
        async () => {
          const command = new ListBillingGroupsCommand({
            NextToken: nextToken,
          });
          return await billingConductorClient.send(command);
        },
        DEFAULT_RETRY_CONFIG,
        { operation: 'ListBillingGroups', page: pageCount }
      );

      if (response.BillingGroups) {
        for (const group of response.BillingGroups) {
          const billingGroup = mapBillingGroupFromApi(group);
          if (billingGroup) {
            billingGroups.push(billingGroup);
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    const executionTime = Date.now() - startTime;
    logger.info('Successfully listed billing groups', {
      groupCount: billingGroups.length,
      pages: pageCount,
      executionTimeMs: executionTime,
      operation: 'listBillingGroups',
    });

    return billingGroups;
  } catch (error) {
    logger.error('Failed to list billing groups', {
      error: error as Error,
      operation: 'listBillingGroups',
    });
    throw error;
  }
}

/**
 * Maps a billing group from API response to our model
 */
function mapBillingGroupFromApi(group: BillingGroupListElement): BillingGroup | null {
  if (!group.Arn || !group.Name || !group.PrimaryAccountId || !group.ComputationPreference?.PricingPlanArn) {
    logger.warn('Billing group missing required fields', {
      hasArn: !!group.Arn,
      hasName: !!group.Name,
      hasPrimaryAccountId: !!group.PrimaryAccountId,
      hasPricingPlanArn: !!group.ComputationPreference?.PricingPlanArn,
    });
    return null;
  }

  return {
    arn: group.Arn,
    name: group.Name,
    description: group.Description,
    primaryAccountId: group.PrimaryAccountId,
    pricingPlanArn: group.ComputationPreference.PricingPlanArn,
    responsibilityTransferArn: group.AccountGrouping?.ResponsibilityTransferArn,
    creationTime: group.CreationTime,
    lastModifiedTime: group.LastModifiedTime,
    status: group.Status as BillingGroup['status'],
  };
}

/**
 * Lists all pricing plans
 * 
 * Retrieves all pricing plans from Billing Conductor.
 * Handles pagination automatically.
 * 
 * Requirements: 9.3
 * 
 * @returns Array of pricing plans
 */
export async function listPricingPlans(): Promise<PricingPlan[]> {
  logger.info('Listing all pricing plans', { operation: 'listPricingPlans' });

  const startTime = Date.now();
  const pricingPlans: PricingPlan[] = [];
  let nextToken: string | undefined = undefined;
  let pageCount = 0;

  try {
    do {
      pageCount++;
      const response = await retryWithBackoff(
        async () => {
          const command = new ListPricingPlansCommand({
            NextToken: nextToken,
          });
          return await billingConductorClient.send(command);
        },
        DEFAULT_RETRY_CONFIG,
        { operation: 'ListPricingPlans', page: pageCount }
      );

      if (response.PricingPlans) {
        for (const plan of response.PricingPlans) {
          const pricingPlan = mapPricingPlanFromApi(plan);
          if (pricingPlan) {
            pricingPlans.push(pricingPlan);
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    const executionTime = Date.now() - startTime;
    logger.info('Successfully listed pricing plans', {
      planCount: pricingPlans.length,
      pages: pageCount,
      executionTimeMs: executionTime,
      operation: 'listPricingPlans',
    });

    return pricingPlans;
  } catch (error) {
    logger.error('Failed to list pricing plans', {
      error: error as Error,
      operation: 'listPricingPlans',
    });
    throw error;
  }
}

/**
 * Maps a pricing plan from API response to our model
 */
function mapPricingPlanFromApi(plan: PricingPlanListElement): PricingPlan | null {
  if (!plan.Arn || !plan.Name) {
    logger.warn('Pricing plan missing required fields', {
      hasArn: !!plan.Arn,
      hasName: !!plan.Name,
    });
    return null;
  }

  return {
    arn: plan.Arn,
    name: plan.Name,
    description: plan.Description,
    creationTime: plan.CreationTime,
    lastModifiedTime: plan.LastModifiedTime,
  };
}

/**
 * Lists all CUR configurations
 * 
 * Retrieves all Cost and Usage Report configurations.
 * Handles pagination automatically.
 * 
 * Note: CUR API uses DescribeReportDefinitions which returns all reports.
 * We filter for reports that have billing group associations.
 * 
 * Requirements: 9.4
 * 
 * @returns Array of CUR configurations
 */
export async function listCURConfigurations(): Promise<CURConfiguration[]> {
  logger.info('Listing all CUR configurations', { operation: 'listCURConfigurations' });

  const startTime = Date.now();
  const curConfigurations: CURConfiguration[] = [];
  let nextToken: string | undefined = undefined;
  let pageCount = 0;

  try {
    do {
      pageCount++;
      const response = await retryWithBackoff(
        async () => {
          const command = new DescribeReportDefinitionsCommand({
            NextToken: nextToken,
          });
          return await curClient.send(command);
        },
        DEFAULT_RETRY_CONFIG,
        { operation: 'DescribeReportDefinitions', page: pageCount }
      );

      if (response.ReportDefinitions) {
        for (const report of response.ReportDefinitions) {
          const curConfig = mapCURConfigurationFromApi(report);
          if (curConfig) {
            curConfigurations.push(curConfig);
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    const executionTime = Date.now() - startTime;
    logger.info('Successfully listed CUR configurations', {
      configCount: curConfigurations.length,
      pages: pageCount,
      executionTimeMs: executionTime,
      operation: 'listCURConfigurations',
    });

    return curConfigurations;
  } catch (error) {
    logger.error('Failed to list CUR configurations', {
      error: error as Error,
      operation: 'listCURConfigurations',
    });
    throw error;
  }
}

/**
 * Maps a CUR report definition from API response to our model
 */
function mapCURConfigurationFromApi(report: ReportDefinition): CURConfiguration | null {
  if (!report.ReportName || !report.S3Bucket || !report.S3Region) {
    logger.warn('CUR configuration missing required fields', {
      hasReportName: !!report.ReportName,
      hasS3Bucket: !!report.S3Bucket,
      hasS3Region: !!report.S3Region,
    });
    return null;
  }

  return {
    reportName: report.ReportName,
    s3Bucket: report.S3Bucket,
    s3Prefix: report.S3Prefix,
    s3Region: report.S3Region,
    timeUnit: (report.TimeUnit as CURConfiguration['timeUnit']) || 'DAILY',
    format: (report.Format as CURConfiguration['format']) || 'textORcsv',
    compression: (report.Compression as CURConfiguration['compression']) || 'GZIP',
    additionalSchemaElements: report.AdditionalSchemaElements || [],
    additionalArtifacts: report.AdditionalArtifacts || [],
    refreshClosedReports: report.RefreshClosedReports ?? false,
    reportVersioning: (report.ReportVersioning as CURConfiguration['reportVersioning']) || 'CREATE_NEW_REPORT',
    billingViewArn: report.BillingViewArn, // CUR reports are associated with billing views
    status: 'ACTIVE',
  };
}


/**
 * Lists all billing transfer resources
 * 
 * Retrieves all resource types (billing views, billing groups, pricing plans,
 * CUR configurations) and caches them for subsequent operations.
 * 
 * Requirements: 9.7
 * 
 * @param useCache - Whether to use cached resources if available (default: true)
 * @returns AllBillingTransferResources container with all resources
 */
export async function listAllResources(useCache: boolean = true): Promise<AllBillingTransferResources> {
  // Return cached resources if available and caching is enabled
  if (useCache && resourceCache) {
    logger.debug('Using cached resources', {
      resourceCounts: resourceCache.resourceCounts,
      cacheAge: Date.now() - resourceCache.retrievalTimestamp,
    });
    return resourceCache;
  }

  logger.info('Listing all billing transfer resources', { operation: 'listAllResources' });

  const startTime = Date.now();

  try {
    // Fetch all resource types in parallel for better performance
    const [billingViews, billingGroups, pricingPlans, curConfigurations] = await Promise.all([
      listBillingViews(),
      listBillingGroups(),
      listPricingPlans(),
      listCURConfigurations(),
    ]);

    // Create and cache the resources container
    resourceCache = createAllBillingTransferResources(
      billingViews,
      billingGroups,
      pricingPlans,
      curConfigurations
    );

    const executionTime = Date.now() - startTime;
    logger.info('Successfully listed all billing transfer resources', {
      resourceCounts: resourceCache.resourceCounts,
      executionTimeMs: executionTime,
      operation: 'listAllResources',
    });

    return resourceCache;
  } catch (error) {
    logger.error('Failed to list all billing transfer resources', {
      error: error as Error,
      operation: 'listAllResources',
    });
    throw error;
  }
}

/**
 * Gets resources for a single transfer
 * 
 * Retrieves all associated resources for a billing transfer:
 * - Billing view (matched by source account ID and transfer name)
 * - Billing group (matched by transfer ARN)
 * - Pricing plan (from billing group's pricing plan ARN)
 * - CUR configuration (matched by billing group ARN)
 * 
 * Uses null values for missing resources rather than omitting fields.
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.8
 * 
 * @param transfer - The billing transfer to get resources for
 * @returns BillingTransferWithResourcesModel with all found resources
 */
export async function getResourcesForTransfer(
  transfer: BillingTransferModel
): Promise<BillingTransferWithResourcesModel> {
  logger.debug('Getting resources for transfer', {
    transferId: transfer.id,
    transferArn: transfer.arn,
    billSourceAccountId: transfer.billSourceAccountId,
    operation: 'getResourcesForTransfer',
  });

  // Ensure resources are cached
  const allResources = await listAllResources();

  // Find My View billing view (BILLING_TRANSFER) by source account + transfer name.
  // Requirements: 9.1
  const billingView = findBillingViewBySourceAccountTypeAndName(
    allResources,
    transfer.billSourceAccountId,
    'BILLING_TRANSFER',
    transfer.name
  );

  // Find Showback billing view (BILLING_TRANSFER_SHOWBACK) independently.
  // A transfer's source account can have both a My View and a Showback view;
  // matching on source account alone would only ever return one of them.
  const showbackBillingView = findBillingViewBySourceAccountTypeAndName(
    allResources,
    transfer.billSourceAccountId,
    'BILLING_TRANSFER_SHOWBACK',
    transfer.name
  );

  // Find billing group by transfer ARN
  // Requirements: 9.2
  const billingGroup = findBillingGroupByTransferArn(allResources, transfer.arn);

  // Find pricing plan from billing group's pricing plan ARN
  // Requirements: 9.3
  let pricingPlan: PricingPlan | null = null;
  if (billingGroup) {
    pricingPlan = findPricingPlanByArn(allResources, billingGroup.pricingPlanArn);
  }

  // Find CUR configurations by billing view ARN (per view type).
  // Note: CUR reports are associated with billing views, not billing groups.
  // Requirements: 9.4
  let curConfiguration: CURConfiguration | null = null;
  if (billingView) {
    curConfiguration = findCURConfigurationByBillingViewArn(allResources, billingView.arn);
  }
  let showbackCurConfiguration: CURConfiguration | null = null;
  if (showbackBillingView) {
    showbackCurConfiguration = findCURConfigurationByBillingViewArn(
      allResources,
      showbackBillingView.arn
    );
  }

  // Create the model with all found resources (null for missing)
  // Requirements: 9.5, 9.8
  const result = createBillingTransferWithResources(transfer, {
    billingView,
    showbackBillingView,
    billingGroup,
    pricingPlan,
    curConfiguration,
    showbackCurConfiguration,
  });

  logger.debug('Resources found for transfer', {
    transferId: transfer.id,
    resourcesFound: result.resourcesFound,
    operation: 'getResourcesForTransfer',
  });

  return result;
}

/**
 * Gets resources for multiple transfers with caching
 * 
 * Retrieves all associated resources for multiple billing transfers.
 * Caches all resource types to avoid redundant API calls within the operation.
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
 * 
 * @param transfers - Array of billing transfers to get resources for
 * @returns Array of BillingTransferWithResourcesModel with all found resources
 */
export async function getResourcesForTransfers(
  transfers: BillingTransferModel[]
): Promise<BillingTransferWithResourcesModel[]> {
  logger.info('Getting resources for multiple transfers', {
    transferCount: transfers.length,
    operation: 'getResourcesForTransfers',
  });

  const startTime = Date.now();

  // Clear cache and fetch fresh resources for batch operation
  // This ensures we have the latest data for all transfers
  clearResourceCache();

  // Pre-fetch all resources (this will cache them)
  // Requirements: 9.7
  await listAllResources(false);

  // Get resources for each transfer (uses cached resources)
  const results: BillingTransferWithResourcesModel[] = [];
  for (const transfer of transfers) {
    const result = await getResourcesForTransfer(transfer);
    results.push(result);
  }

  const executionTime = Date.now() - startTime;

  // Calculate summary statistics
  const withBillingViews = results.filter(r => r.resourcesFound.billingView).length;
  const withBillingGroups = results.filter(r => r.resourcesFound.billingGroup).length;
  const withPricingPlans = results.filter(r => r.resourcesFound.pricingPlan).length;
  const withCURConfigurations = results.filter(r => r.resourcesFound.curConfiguration).length;

  logger.info('Successfully retrieved resources for transfers', {
    transferCount: transfers.length,
    withBillingViews,
    withBillingGroups,
    withPricingPlans,
    withCURConfigurations,
    executionTimeMs: executionTime,
    operation: 'getResourcesForTransfers',
  });

  return results;
}

/**
 * Gets resources by account ID
 * 
 * Finds all billing transfer resources associated with a specific account ID.
 * This includes resources where the account is the source account (for billing views)
 * or the primary account (for billing groups).
 * 
 * Requirements: 9.6
 * 
 * @param accountId - The account ID to search for
 * @returns Array of BillingTransferWithResourcesModel for the account
 */
export async function getResourcesByAccountId(
  accountId: string
): Promise<{
  billingViews: BillingView[];
  billingGroups: BillingGroup[];
  pricingPlans: PricingPlan[];
  curConfigurations: CURConfiguration[];
}> {
  logger.info('Getting resources by account ID', {
    accountId,
    operation: 'getResourcesByAccountId',
  });

  const startTime = Date.now();

  // Ensure resources are cached
  const allResources = await listAllResources();

  // Find billing views for the account (as source account)
  const billingViews = getBillingViewsForAccount(allResources, accountId);

  // Find billing groups for the account (as primary account)
  const billingGroups = getBillingGroupsForAccount(allResources, accountId);

  // Find pricing plans associated with the billing groups
  const pricingPlanArns = new Set(billingGroups.map(bg => bg.pricingPlanArn));
  const pricingPlans = allResources.pricingPlans.filter(pp => pricingPlanArns.has(pp.arn));

  // Find CUR configurations associated with the billing views
  // Note: CUR reports are associated with billing views, not billing groups
  const billingViewArns = new Set(billingViews.map(bv => bv.arn));
  const curConfigurations = allResources.curConfigurations.filter(
    cur => cur.billingViewArn && billingViewArns.has(cur.billingViewArn)
  );

  const executionTime = Date.now() - startTime;

  logger.info('Successfully retrieved resources for account', {
    accountId,
    billingViewCount: billingViews.length,
    billingGroupCount: billingGroups.length,
    pricingPlanCount: pricingPlans.length,
    curConfigurationCount: curConfigurations.length,
    executionTimeMs: executionTime,
    operation: 'getResourcesByAccountId',
  });

  return {
    billingViews,
    billingGroups,
    pricingPlans,
    curConfigurations,
  };
}

/**
 * Gets the current resource cache
 * 
 * Returns the cached resources if available, or null if cache is empty.
 * Useful for checking cache state without triggering a fetch.
 * 
 * @returns Cached AllBillingTransferResources or null
 */
export function getResourceCache(): AllBillingTransferResources | null {
  return resourceCache;
}

/**
 * Checks if resources are currently cached
 * 
 * @returns true if resources are cached, false otherwise
 */
export function hasResourceCache(): boolean {
  return resourceCache !== null;
}
