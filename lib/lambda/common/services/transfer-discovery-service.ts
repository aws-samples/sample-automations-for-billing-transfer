// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Transfer Discovery Service
 *
 * Provides a unified interface for discovering billing transfers (both direct
 * and indirect) from AWS Organizations API. This service orchestrates the
 * underlying organizations-service to provide comprehensive transfer discovery
 * with configurable relationship state filtering.
 *
 * Key Features:
 * - Discovers direct transfers (first-level billing transfers)
 * - Discovers indirect transfers (nested transfers through direct transfers)
 * - Supports relationship state filtering (default: ACCEPTED)
 * - Returns standardized BillingTransferModel objects with relationship metadata
 * - Uses retryWithBackoff for resilient API calls
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 *
 * @module transfer-discovery-service
 */

import { logger } from '../utils/logger.js';
import {
  listDirectBillingTransfers,
  listIndirectBillingTransfers,
} from './organizations-service.js';
import {
  BillingTransferModel,
  TransferDiscoveryOptions,
  DEFAULT_TRANSFER_DISCOVERY_OPTIONS,
  toBillingTransferModel,
} from '../models/billing-transfer.js';

/**
 * Result of a transfer discovery operation
 */
export interface TransferDiscoveryResult {
  /** All discovered transfers (direct and indirect) */
  transfers: BillingTransferModel[];
  /** Count of direct transfers */
  directCount: number;
  /** Count of indirect transfers */
  indirectCount: number;
  /** Relationship state used for filtering */
  relationshipState: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

/**
 * Finds all direct billing transfers
 *
 * Retrieves first-level billing transfers where this account is the target
 * (bill-transfer account). Returns standardized BillingTransferModel objects
 * with transferType set to 'direct'.
 *
 * @param options - Optional discovery options including relationship state filter
 * @returns Promise<BillingTransferModel[]> - Array of direct billing transfer models
 * @throws {Error} If API call fails after retries
 *
 * Requirements: 1.1, 1.3, 1.4, 1.5, 1.6
 */
export async function findDirectTransfers(
  options?: TransferDiscoveryOptions
): Promise<BillingTransferModel[]> {
  const { relationshipState } = { ...DEFAULT_TRANSFER_DISCOVERY_OPTIONS, ...options };
  const startTime = Date.now();

  logger.info('Finding direct transfers', { relationshipState });

  try {
    const transfers = await listDirectBillingTransfers({ relationshipState });

    // Convert to BillingTransferModel with direct transfer type
    const transferModels = transfers.map((transfer) =>
      toBillingTransferModel(transfer, 'direct')
    );

    const executionTimeMs = Date.now() - startTime;
    logger.info('Successfully found direct transfers', {
      count: transferModels.length,
      relationshipState,
      executionTimeMs,
    });

    return transferModels;
  } catch (error) {
    logger.error('Failed to find direct transfers', {
      error: error as Error,
      operation: 'findDirectTransfers',
      relationshipState,
    });
    throw error;
  }
}


/**
 * Finds all indirect billing transfers for a specific direct transfer
 *
 * Retrieves nested billing transfers where this account acts as an intermediary.
 * Returns standardized BillingTransferModel objects with transferType set to
 * 'indirect' and parentTransferId set to the direct transfer ID.
 *
 * @param transferId - The ID of the direct transfer to get indirect transfers for
 * @param options - Optional discovery options including relationship state filter
 * @returns Promise<BillingTransferModel[]> - Array of indirect billing transfer models
 * @throws {Error} If API call fails after retries
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6
 */
export async function findIndirectTransfers(
  transferId: string,
  options?: TransferDiscoveryOptions
): Promise<BillingTransferModel[]> {
  const { relationshipState } = { ...DEFAULT_TRANSFER_DISCOVERY_OPTIONS, ...options };
  const startTime = Date.now();

  logger.info('Finding indirect transfers', { transferId, relationshipState });

  try {
    const transfers = await listIndirectBillingTransfers(transferId, { relationshipState });

    // Convert to BillingTransferModel with indirect transfer type and parent reference
    const transferModels = transfers.map((transfer) =>
      toBillingTransferModel(transfer, 'indirect', transferId)
    );

    const executionTimeMs = Date.now() - startTime;
    logger.info('Successfully found indirect transfers', {
      transferId,
      count: transferModels.length,
      relationshipState,
      executionTimeMs,
    });

    return transferModels;
  } catch (error) {
    logger.error('Failed to find indirect transfers', {
      error: error as Error,
      operation: 'findIndirectTransfers',
      transferId,
      relationshipState,
    });
    // Log warning but don't fail completely - continue processing other transfers
    logger.warn('Continuing despite error finding indirect transfers', {
      transferId,
      errorMessage: (error as Error).message,
    });
    return [];
  }
}

/**
 * Finds all billing transfers (both direct and indirect)
 *
 * Discovers all billing transfers by:
 * 1. Finding all direct transfers
 * 2. For each direct transfer, finding all indirect transfers
 * 3. Combining results into a single array with proper relationship metadata
 *
 * This method handles errors gracefully - if indirect transfer discovery fails
 * for a specific direct transfer, it logs a warning and continues processing
 * other transfers.
 *
 * @param options - Optional discovery options including relationship state filter
 * @returns Promise<TransferDiscoveryResult> - Result containing all transfers and metadata
 * @throws {Error} If direct transfer discovery fails
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
export async function findAllTransfers(
  options?: TransferDiscoveryOptions
): Promise<TransferDiscoveryResult> {
  const { relationshipState } = { ...DEFAULT_TRANSFER_DISCOVERY_OPTIONS, ...options };
  const startTime = Date.now();

  logger.info('Finding all transfers (direct and indirect)', { relationshipState });

  try {
    // Step 1: Find all direct transfers
    const directTransfers = await findDirectTransfers({ relationshipState });

    // Step 2: Find indirect transfers for each direct transfer
    const indirectTransfersPromises = directTransfers.map((directTransfer) =>
      findIndirectTransfers(directTransfer.id, { relationshipState })
    );

    const indirectTransfersArrays = await Promise.all(indirectTransfersPromises);
    const indirectTransfers = indirectTransfersArrays.flat();

    // Step 3: Combine all transfers
    const allTransfers = [...directTransfers, ...indirectTransfers];

    const executionTimeMs = Date.now() - startTime;
    const result: TransferDiscoveryResult = {
      transfers: allTransfers,
      directCount: directTransfers.length,
      indirectCount: indirectTransfers.length,
      relationshipState,
      executionTimeMs,
    };

    logger.info('Successfully found all transfers', {
      totalCount: allTransfers.length,
      directCount: directTransfers.length,
      indirectCount: indirectTransfers.length,
      relationshipState,
      executionTimeMs,
    });

    return result;
  } catch (error) {
    logger.error('Failed to find all transfers', {
      error: error as Error,
      operation: 'findAllTransfers',
      relationshipState,
    });
    throw error;
  }
}
