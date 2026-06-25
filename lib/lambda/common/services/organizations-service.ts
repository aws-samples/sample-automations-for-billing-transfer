// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unified AWS Organizations Service
 *
 * This service provides operations for listing and managing billing transfer
 * relationships using the AWS Organizations API. It consolidates functionality
 * from multiple Lambda functions into a single, consistent implementation.
 *
 * Key Concepts:
 * - Direct Transfers: First-level billing transfers to this account
 * - Indirect Transfers: Nested transfers where this account acts as intermediary
 * - Active Transfers: Transfers with ACCEPTED status and BILLING type
 *
 * API Behavior:
 * - ListInboundResponsibilityTransfers without Id: Returns direct transfers
 * - ListInboundResponsibilityTransfers with Id: Returns indirect/nested transfers
 * - Pagination uses NextToken parameter (not Id parameter for NextToken)
 *
 * @module organizations-service
 */

import {
  ListInboundResponsibilityTransfersCommand,
  ResponsibilityTransferType,
} from '@aws-sdk/client-organizations';
import { logger } from '../utils/logger.js';
import { organizationsClient } from '../utils/clients.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../utils/retry.js';
import {
  BillingTransfer,
  RelationshipState,
  TransferDiscoveryOptions,
  DEFAULT_TRANSFER_DISCOVERY_OPTIONS,
} from '../models/billing-transfer.js';

// Re-export types for backward compatibility and convenience
export type { BillingTransfer, RelationshipState, TransferDiscoveryOptions } from '../models/billing-transfer.js';
export { DEFAULT_TRANSFER_DISCOVERY_OPTIONS } from '../models/billing-transfer.js';

// Re-export client for backward compatibility
export { organizationsClient } from '../utils/clients.js';

interface FetchTransfersOptions {
  transferId?: string;
  operationName: string;
  relationshipState?: RelationshipState;
}

/** Fetches billing transfers with pagination support */
async function fetchBillingTransfers(options: FetchTransfersOptions): Promise<BillingTransfer[]> {
  const { transferId, operationName, relationshipState = 'ACCEPTED' } = options;
  const transfers: BillingTransfer[] = [];
  let nextToken: string | undefined;

  do {
    const command = new ListInboundResponsibilityTransfersCommand({
      Type: 'BILLING' as ResponsibilityTransferType,
      Id: transferId,
      NextToken: nextToken,
    });

    const response = await retryWithBackoff(
      () => organizationsClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: operationName, transferId, relationshipState }
    );

    // Process responsibility transfers
    if (response.ResponsibilityTransfers) {
      for (const transfer of response.ResponsibilityTransfers) {
        // Skip transfers without required fields
        if (
          !transfer.Id ||
          !transfer.Arn ||
          !transfer.Source?.ManagementAccountId ||
          !transfer.Target?.ManagementAccountId
        ) {
          continue;
        }

        // Only include BILLING type transfers
        if (transfer.Type !== 'BILLING') {
          continue;
        }

        // Filter by relationship state
        if (transfer.Status !== relationshipState) {
          continue;
        }

        // Map AWS SDK transfer to our BillingTransfer model
        // Convert Date to timestamp if needed
        const startTimestamp =
          transfer.StartTimestamp instanceof Date
            ? transfer.StartTimestamp.getTime()
            : transfer.StartTimestamp || Date.now();

        const endTimestamp =
          transfer.EndTimestamp instanceof Date
            ? transfer.EndTimestamp.getTime()
            : transfer.EndTimestamp;

        transfers.push({
          id: transfer.Id,
          arn: transfer.Arn,
          name: transfer.Name || transfer.Id, // Use name for billing view matching, fallback to ID
          billSourceAccountId: transfer.Source.ManagementAccountId,
          billTransferAccountId: transfer.Target.ManagementAccountId,
          status: transfer.Status as 'ACCEPTED' | 'PENDING' | 'TERMINATED',
          type: 'BILLING',
          startTimestamp,
          endTimestamp,
        });
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return transfers;
}

/**
 * Lists all direct inbound billing transfer relationships
 *
 * Retrieves first-level billing transfers where this account is the target
 * (bill-transfer account). These are transfers directly to this account,
 * not nested through other accounts.
 *
 * API Behavior:
 * - Calls ListInboundResponsibilityTransfers without Id parameter
 * - Returns only direct transfers (not nested/indirect)
 * - Supports pagination using NextToken parameter
 *
 * Filtering:
 * - Only BILLING type transfers (not ACCOUNT or ORGANIZATION)
 * - Filters by specified relationship state (default: ACCEPTED)
 *
 * @param options - Optional discovery options including relationship state filter
 * @returns Promise<BillingTransfer[]> - Array of direct billing transfers matching the filter
 * @throws {Error} If API call fails after retries
 * 
 * Requirements: 1.1, 1.3
 */
export async function listDirectBillingTransfers(
  options?: TransferDiscoveryOptions
): Promise<BillingTransfer[]> {
  const { relationshipState } = { ...DEFAULT_TRANSFER_DISCOVERY_OPTIONS, ...options };
  
  logger.info('Listing direct inbound responsibility transfers', { relationshipState });

  try {
    const transfers = await fetchBillingTransfers({
      operationName: 'ListInboundResponsibilityTransfers (direct)',
      relationshipState,
    });

    logger.info('Successfully listed direct responsibility transfers', {
      totalTransfers: transfers.length,
      relationshipState,
    });

    return transfers;
  } catch (error) {
    logger.error('Failed to list direct inbound responsibility transfers', {
      error: error as Error,
      operation: 'listDirectBillingTransfers',
      relationshipState,
    });
    throw error;
  }
}

/**
 * Lists indirect billing transfers for a specific direct transfer
 * 
 * Retrieves nested billing transfers where this account acts as an intermediary.
 * These are transfers that flow through a direct transfer to reach end customers.
 * 
 * Example Scenario:
 * - Direct Transfer: Customer A → This Account
 * - Indirect Transfer: Customer B → Customer A → This Account
 * 
 * API Behavior:
 * - Calls ListInboundResponsibilityTransfers with Id parameter
 * - Returns nested transfers for the specified direct transfer
 * - Supports pagination using NextToken parameter
 * 
 * Filtering:
 * - Only BILLING type transfers (not ACCOUNT or ORGANIZATION)
 * - Filters by specified relationship state (default: ACCEPTED)
 * 
 * Use Case:
 * - Billing groups must be created for indirect transfers
 * - Each indirect transfer represents a customer that needs billing management
 * 
 * @param transferId - The ID of the direct transfer to get indirect transfers for
 * @param options - Optional discovery options including relationship state filter
 * @returns Promise<BillingTransfer[]> - Array of indirect billing transfers matching the filter
 * @throws {Error} If API call fails after retries
 * 
 * Requirements: 1.2, 1.3
 */
export async function listIndirectBillingTransfers(
  transferId: string,
  options?: TransferDiscoveryOptions
): Promise<BillingTransfer[]> {
  const { relationshipState } = { ...DEFAULT_TRANSFER_DISCOVERY_OPTIONS, ...options };
  
  logger.info('Listing indirect inbound responsibility transfers', { transferId, relationshipState });

  try {
    const transfers = await fetchBillingTransfers({
      transferId,
      operationName: 'ListInboundResponsibilityTransfers (indirect)',
      relationshipState,
    });

    logger.info('Successfully listed indirect responsibility transfers', {
      transferId,
      totalTransfers: transfers.length,
      relationshipState,
    });

    return transfers;
  } catch (error) {
    logger.error('Failed to list indirect inbound responsibility transfers', {
      error: error as Error,
      operation: 'listIndirectBillingTransfers',
      transferId,
      relationshipState,
    });
    throw error;
  }
}

/**
 * Gets billing transfer details for a specific account
 * 
 * Searches through all direct billing transfers to find one where the
 * bill-source account matches the specified account ID.
 * 
 * Use Case:
 * - Lookup transfer details when processing events
 * - Verify transfer exists before creating billing group
 * 
 * @param accountId - Account ID to get transfer details for (bill-source account)
 * @returns Promise<BillingTransfer | null> - Transfer details or null if not found
 * @throws {Error} If API call fails
 */
export async function getBillingTransferForAccount(
  accountId: string
): Promise<BillingTransfer | null> {
  logger.info('Getting billing transfer for account', { accountId });

  try {
    const transfers = await listDirectBillingTransfers();
    const transfer = transfers.find((t) => t.billSourceAccountId === accountId);

    if (transfer) {
      logger.info('Found billing transfer for account', {
        accountId,
        transferId: transfer.id,
      });
    } else {
      logger.info('No billing transfer found for account', { accountId });
    }

    return transfer || null;
  } catch (error) {
    logger.error('Failed to get billing transfer for account', {
      error: error as Error,
      accountId,
    });
    throw error;
  }
}
