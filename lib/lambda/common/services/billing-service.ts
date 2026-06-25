// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unified Billing Service for AWS Billing API Operations
 *
 * Provides operations for listing and retrieving billing views across all Lambda functions.
 * Billing views represent different perspectives of billing data including PRIMARY,
 * BILLING_TRANSFER, BILLING_TRANSFER_SHOWBACK, and BILLING_GROUP views.
 *
 * Features:
 * - List billing views with type and source account filtering
 * - Retrieve specific billing view details
 * - Find billing views for transfer relationships
 * - Integrated retry logic for transient failures
 * - Structured logging for all operations
 *
 * Usage:
 * ```typescript
 * import { listBillingViews, findBillingViewForTransfer } from '../common/services/billing-service.js';
 *
 * const views = await listBillingViews(['BILLING_TRANSFER'], '123456789012');
 * const view = await findBillingViewForTransfer('123456789012', 'BILLING_TRANSFER');
 * ```
 *
 * @module billing-service
 */

import {
  ListBillingViewsCommand,
  GetBillingViewCommand,
  BillingViewType,
} from '@aws-sdk/client-billing';
import { logger } from '../utils/logger.js';
import { billingClient } from '../utils/clients.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../utils/retry.js';
import { BillingView } from '../models/billing-view.js';

// Re-export client for backward compatibility
export { billingClient } from '../utils/clients.js';

/**
 * Lists billing views with optional filtering
 * 
 * Retrieves billing views filtered by type and/or source account ID.
 * Uses retry logic to handle transient API failures.
 * 
 * @param billingViewTypes - Array of billing view types to filter by
 * @param sourceAccountId - Optional source account ID to filter by
 * @returns Array of billing views matching the filter criteria
 * 
 * @example
 * ```typescript
 * // List all billing transfer views for an account
 * const views = await listBillingViews(['BILLING_TRANSFER'], '123456789012');
 * 
 * // List all billing transfer and showback views
 * const views = await listBillingViews(['BILLING_TRANSFER', 'BILLING_TRANSFER_SHOWBACK']);
 * ```
 */
export async function listBillingViews(
  billingViewTypes: BillingViewType[],
  sourceAccountId?: string
): Promise<BillingView[]> {
  logger.info('Listing billing views', {
    billingViewTypes,
    sourceAccountId,
    operation: 'listBillingViews',
  });

  try {
    const views: BillingView[] = [];
    let nextToken: string | undefined = undefined;
    let pageCount = 0;

    // Paginate through all results
    do {
      pageCount++;
      const response = await retryWithBackoff(
        async () => {
          const command = new ListBillingViewsCommand({
            billingViewTypes,
            sourceAccountId,
            nextToken,
            // Don't include activeTimeRange - let it default to current active views
          });
          return await billingClient.send(command);
        },
        DEFAULT_RETRY_CONFIG,
        {
          operation: 'listBillingViews',
          billingViewTypes,
          sourceAccountId,
          page: pageCount,
        }
      );

      if (response.billingViews && response.billingViews.length > 0) {
        for (const element of response.billingViews) {
          // Validate required fields
          if (!element.arn || !element.name || !element.billingViewType || !element.ownerAccountId) {
            logger.warn('Billing view element missing required fields', {
              hasArn: !!element.arn,
              hasName: !!element.name,
              hasBillingViewType: !!element.billingViewType,
              hasOwnerAccountId: !!element.ownerAccountId,
              operation: 'listBillingViews',
            });
            continue;
          }

          views.push({
            arn: element.arn,
            name: element.name,
            billingViewType: element.billingViewType as BillingView['billingViewType'],
            ownerAccountId: element.ownerAccountId,
            sourceAccountId: element.sourceAccountId,
          });
        }
      }

      nextToken = response.nextToken;
    } while (nextToken);

    logger.info('Successfully listed billing views', {
      viewCount: views.length,
      billingViewTypes,
      sourceAccountId,
      pages: pageCount,
      operation: 'listBillingViews',
    });

    return views;
  } catch (error) {
    logger.error('Failed to list billing views', {
      error: error as Error,
      billingViewTypes,
      sourceAccountId,
      operation: 'listBillingViews',
    });
    throw error;
  }
}

/**
 * Retrieves a specific billing view by ARN
 * 
 * Gets the complete details of a billing view including its ARN, name, type,
 * and associated accounts. Uses retry logic to handle transient API failures.
 * 
 * @param billingViewArn - The ARN of the billing view to retrieve
 * @returns The billing view details
 * @throws Error if the billing view is not found or API call fails
 * 
 * @example
 * ```typescript
 * const view = await getBillingView('arn:aws:billing::123456789012:billingview/primary');
 * console.log(view.name, view.billingViewType);
 * ```
 */
export async function getBillingView(billingViewArn: string): Promise<BillingView> {
  logger.info('Getting billing view', {
    billingViewArn,
    operation: 'getBillingView',
  });

  try {
    const response = await retryWithBackoff(
      async () => {
        const command = new GetBillingViewCommand({
          arn: billingViewArn,
        });
        return await billingClient.send(command);
      },
      DEFAULT_RETRY_CONFIG,
      {
        operation: 'getBillingView',
        billingViewArn,
      }
    );

    // Validate required fields
    if (
      !response.billingView ||
      !response.billingView.arn ||
      !response.billingView.name ||
      !response.billingView.billingViewType ||
      !response.billingView.ownerAccountId
    ) {
      throw new Error('Billing view response missing required fields');
    }

    const view: BillingView = {
      arn: response.billingView.arn,
      name: response.billingView.name,
      billingViewType: response.billingView.billingViewType as BillingView['billingViewType'],
      ownerAccountId: response.billingView.ownerAccountId,
      sourceAccountId: response.billingView.sourceAccountId,
    };

    logger.info('Successfully retrieved billing view', {
      billingViewArn,
      billingViewType: view.billingViewType,
      operation: 'getBillingView',
    });

    return view;
  } catch (error) {
    logger.error('Failed to get billing view', {
      error: error as Error,
      billingViewArn,
      operation: 'getBillingView',
    });
    throw error;
  }
}

/**
 * Finds a billing view for a billing transfer relationship
 * 
 * Searches for a specific billing view type (BILLING_TRANSFER or BILLING_TRANSFER_SHOWBACK)
 * associated with a bill-source account. Returns null if no matching view is found.
 * 
 * This is a convenience function that combines listBillingViews with filtering logic
 * to find the specific view needed for billing transfer operations.
 * 
 * IMPORTANT: When multiple billing views exist for the same source account (from
 * different transfers), the transferName parameter is used to match the correct view.
 * 
 * @param billSourceAccountId - The bill-source account ID
 * @param viewType - The type of billing view to find (BILLING_TRANSFER or BILLING_TRANSFER_SHOWBACK)
 * @param transferName - Optional transfer name to match the correct billing view when multiple exist
 * @returns The billing view if found, null otherwise
 * 
 * @example
 * ```typescript
 * // Find the "My View" billing transfer view with name matching
 * const myView = await findBillingViewForTransfer('123456789012', 'BILLING_TRANSFER', 'BSA_123456789012_4');
 * 
 * // Find the "Showback/Chargeback View"
 * const showbackView = await findBillingViewForTransfer('123456789012', 'BILLING_TRANSFER_SHOWBACK', 'BSA_123456789012_4');
 * ```
 */
export async function findBillingViewForTransfer(
  billSourceAccountId: string,
  viewType: 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK',
  transferName?: string
): Promise<BillingView | null> {
  logger.info('Finding billing view for transfer', {
    billSourceAccountId,
    viewType,
    transferName,
    operation: 'findBillingViewForTransfer',
  });

  try {
    // CRITICAL FIX: Don't use sourceAccountId filter - it doesn't work reliably
    // Instead, list all views of this type and filter client-side
    const allViews = await listBillingViews([viewType]);

    // Filter client-side by sourceAccountId
    const matchingViews = allViews.filter(v => v.sourceAccountId === billSourceAccountId);

    if (matchingViews.length === 0) {
      logger.info('No billing view found for transfer', {
        billSourceAccountId,
        viewType,
        transferName,
        totalViewsChecked: allViews.length,
        operation: 'findBillingViewForTransfer',
      });
      return null;
    }

    // If transferName is provided and there are multiple views, match by name
    // This handles the case where multiple transfers exist for the same source account
    let view: BillingView;
    if (transferName && matchingViews.length > 1) {
      const nameMatchedView = matchingViews.find(v => v.name === transferName);
      if (nameMatchedView) {
        view = nameMatchedView;
        logger.info('Matched billing view by transfer name', {
          billSourceAccountId,
          viewType,
          transferName,
          billingViewArn: view.arn,
          matchingViews: matchingViews.length,
          operation: 'findBillingViewForTransfer',
        });
      } else {
        // Fallback to first view if name doesn't match
        view = matchingViews[0];
        logger.warn('Transfer name did not match any billing view, using first match', {
          billSourceAccountId,
          viewType,
          transferName,
          billingViewArn: view.arn,
          availableNames: matchingViews.map(v => v.name),
          operation: 'findBillingViewForTransfer',
        });
      }
    } else {
      // Single view or no transfer name - use first match
      view = matchingViews[0];
    }

    logger.info('Successfully found billing view for transfer', {
      billSourceAccountId,
      viewType,
      transferName,
      billingViewArn: view.arn,
      totalViewsChecked: allViews.length,
      matchingViews: matchingViews.length,
      operation: 'findBillingViewForTransfer',
    });

    return view;
  } catch (error) {
    // Log at WARN level since this is a graceful failure that returns null
    // Callers should handle null appropriately
    logger.warn('Failed to find billing view for transfer - returning null', {
      billSourceAccountId,
      viewType,
      transferName,
      operation: 'findBillingViewForTransfer',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    // Return null instead of throwing to allow graceful handling
    return null;
  }
}
