// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Billing Transfer Model
 *
 * Represents an AWS Organizations billing transfer relationship where one
 * management account (bill-transfer account) manages and pays for another
 * management account's (bill-source account) consolidated bill.
 *
 * Transfer Types:
 * - Direct: First-level transfer directly to this account
 * - Indirect: Nested transfer through another account
 *
 * Relationship States (from AWS Organizations API):
 * - ACCEPTED: Active transfer relationship
 * - PENDING: Transfer invitation sent but not yet accepted
 * - TERMINATED: Transfer ended
 * - WITHDRAWN: Transfer withdrawn by source
 * - DECLINED: Transfer declined by target
 * - CANCELED: Transfer canceled
 * - EXPIRED: Transfer invitation expired
 *
 * @module billing-transfer
 */

/**
 * Supported relationship states from AWS Organizations API
 * 
 * These states represent the lifecycle of a billing transfer relationship.
 */
export type RelationshipState = 
  | 'ACCEPTED' 
  | 'PENDING' 
  | 'TERMINATED' 
  | 'WITHDRAWN' 
  | 'DECLINED' 
  | 'CANCELED' 
  | 'EXPIRED';

/**
 * Transfer type classification
 * 
 * - direct: First-level transfer directly to this account
 * - indirect: Nested transfer through another account (depends on a direct transfer)
 */
export type TransferType = 'direct' | 'indirect';

/**
 * Canonical, ordered list of every defined {@link RelationshipState}.
 *
 * This is the single source of truth for the *runtime* list of valid
 * relationship-state values (the type alias above is the compile-time source of
 * truth). The `satisfies` clause keeps the two in lock-step: adding or removing
 * a member of the `RelationshipState` union without updating this array — or
 * vice versa — is a compile error. Consumers that need to validate or enumerate
 * states (for example the CLI Input_Validator) import this constant instead of
 * re-declaring the literal list.
 */
export const VALID_STATES = [
  'ACCEPTED',
  'PENDING',
  'TERMINATED',
  'WITHDRAWN',
  'DECLINED',
  'CANCELED',
  'EXPIRED',
] as const satisfies readonly RelationshipState[];

/**
 * Canonical, ordered list of every defined {@link TransferType}.
 *
 * Single runtime source of truth for the transfer-type values, kept aligned
 * with the `TransferType` union by the `satisfies` clause. Imported by
 * consumers (for example the CLI Input_Validator) rather than re-declared.
 */
export const VALID_TYPES = ['direct', 'indirect'] as const satisfies readonly TransferType[];

/**
 * Billing Transfer interface (legacy - for backward compatibility)
 *
 * Core model representing a billing transfer relationship between
 * two AWS management accounts.
 */
export interface BillingTransfer {
  /** Transfer ID (e.g., rt-abc123) */
  id: string;

  /** Transfer ARN - REQUIRED for creating billing groups */
  arn: string;

  /** Transfer name - used to match billing views */
  name: string;

  /** Customer management account (bill-source) */
  billSourceAccountId: string;

  /** Our management account (bill-transfer) */
  billTransferAccountId: string;

  /** Transfer status */
  status: 'ACCEPTED' | 'PENDING' | 'TERMINATED';

  /** Transfer type (always BILLING for billing transfers) */
  type: 'BILLING';

  /** Transfer start time (Unix timestamp in milliseconds) */
  startTimestamp: number;

  /** Transfer end time (Unix timestamp in milliseconds, present if terminated) */
  endTimestamp?: number;
}

/**
 * Enhanced Billing Transfer Model with relationship state support
 * 
 * This model extends the basic BillingTransfer with:
 * - Full relationship state support (all 7 states)
 * - Transfer type classification (direct/indirect)
 * - Parent transfer ID for indirect transfers
 * - Filtering methods for querying
 * 
 * Requirements: 1.3, 8.1, 8.2
 */
export interface BillingTransferModel {
  /** Transfer ID (e.g., rt-abc123) */
  id: string;

  /** Transfer ARN - REQUIRED for creating billing groups */
  arn: string;

  /** Transfer name - used to match billing views */
  name: string;

  /** Customer management account (bill-source) */
  billSourceAccountId: string;

  /** Our management account (bill-transfer) */
  billTransferAccountId: string;

  /** Relationship state from AWS Organizations API */
  status: RelationshipState;

  /** Transfer type (always BILLING for billing transfers) */
  type: 'BILLING';

  /** Transfer start time (Unix timestamp in milliseconds) */
  startTimestamp: number;

  /** Transfer end time (Unix timestamp in milliseconds, present if not active) */
  endTimestamp?: number;

  /** Transfer type classification: direct or indirect */
  transferType: TransferType;

  /** Parent transfer ID for indirect transfers (undefined for direct transfers) */
  parentTransferId?: string;
}

/**
 * Creates a BillingTransferModel from raw transfer data
 * 
 * @param data - Raw transfer data from API or other sources
 * @param transferType - Classification as direct or indirect
 * @param parentTransferId - Parent transfer ID for indirect transfers
 * @returns BillingTransferModel instance
 */
export function createBillingTransferModel(
  data: {
    id: string;
    arn: string;
    name: string;
    billSourceAccountId: string;
    billTransferAccountId: string;
    status: RelationshipState;
    startTimestamp: number;
    endTimestamp?: number;
  },
  transferType: TransferType,
  parentTransferId?: string
): BillingTransferModel {
  return {
    id: data.id,
    arn: data.arn,
    name: data.name,
    billSourceAccountId: data.billSourceAccountId,
    billTransferAccountId: data.billTransferAccountId,
    status: data.status,
    type: 'BILLING',
    startTimestamp: data.startTimestamp,
    endTimestamp: data.endTimestamp,
    transferType,
    parentTransferId,
  };
}

/**
 * Filters transfers by source account ID
 * 
 * @param transfers - Array of billing transfer models
 * @param accountId - Source account ID to filter by
 * @returns Filtered array of transfers matching the source account
 */
export function filterBySourceAccount(
  transfers: BillingTransferModel[],
  accountId: string
): BillingTransferModel[] {
  return transfers.filter((transfer) => transfer.billSourceAccountId === accountId);
}

/**
 * Filters transfers by transfer type (direct/indirect)
 * 
 * @param transfers - Array of billing transfer models
 * @param type - Transfer type to filter by
 * @returns Filtered array of transfers matching the type
 */
export function filterByTransferType(
  transfers: BillingTransferModel[],
  type: TransferType
): BillingTransferModel[] {
  return transfers.filter((transfer) => transfer.transferType === type);
}

/**
 * Filters transfers by relationship state
 * 
 * @param transfers - Array of billing transfer models
 * @param state - Relationship state to filter by
 * @returns Filtered array of transfers matching the state
 */
export function filterByStatus(
  transfers: BillingTransferModel[],
  state: RelationshipState
): BillingTransferModel[] {
  return transfers.filter((transfer) => transfer.status === state);
}

/**
 * Filters billing transfers to only include active ones (legacy function)
 *
 * Active transfers are those with ACCEPTED status and BILLING type.
 * These are the transfers that require billing group management.
 *
 * @param transfers - Array of billing transfers to filter
 * @returns Array of active billing transfers
 */
export function filterActiveTransfers(transfers: BillingTransfer[]): BillingTransfer[] {
  return transfers.filter(
    (transfer) => transfer.status === 'ACCEPTED' && transfer.type === 'BILLING'
  );
}

/**
 * Filters BillingTransferModel array to only include active ones
 *
 * Active transfers are those with ACCEPTED status and BILLING type.
 *
 * @param transfers - Array of billing transfer models to filter
 * @returns Array of active billing transfer models
 */
export function filterActiveTransferModels(transfers: BillingTransferModel[]): BillingTransferModel[] {
  return transfers.filter(
    (transfer) => transfer.status === 'ACCEPTED' && transfer.type === 'BILLING'
  );
}

/**
 * Converts a legacy BillingTransfer to BillingTransferModel
 * 
 * @param transfer - Legacy BillingTransfer object
 * @param transferType - Classification as direct or indirect
 * @param parentTransferId - Parent transfer ID for indirect transfers
 * @returns BillingTransferModel instance
 */
export function toBillingTransferModel(
  transfer: BillingTransfer,
  transferType: TransferType,
  parentTransferId?: string
): BillingTransferModel {
  return {
    ...transfer,
    transferType,
    parentTransferId,
  };
}

/**
 * Checks if a relationship state represents an active transfer
 * 
 * @param state - Relationship state to check
 * @returns true if the state represents an active transfer
 */
export function isActiveState(state: RelationshipState): boolean {
  return state === 'ACCEPTED';
}

/**
 * Checks if a relationship state represents a terminal state
 * 
 * Terminal states are those where the transfer relationship has ended
 * and cannot be reactivated.
 * 
 * @param state - Relationship state to check
 * @returns true if the state is terminal
 */
export function isTerminalState(state: RelationshipState): boolean {
  return ['TERMINATED', 'WITHDRAWN', 'DECLINED', 'CANCELED', 'EXPIRED'].includes(state);
}

/**
 * Options for Transfer Discovery Service operations
 * 
 * Configures how transfers are discovered and filtered.
 * 
 * Requirements: 1.3
 */
export interface TransferDiscoveryOptions {
  /** 
   * Relationship state to filter by. 
   * Default: 'ACCEPTED' (active transfers only)
   */
  relationshipState?: RelationshipState;
}

/**
 * Default transfer discovery options
 * 
 * Uses ACCEPTED as the default relationship state to return only active transfers.
 */
export const DEFAULT_TRANSFER_DISCOVERY_OPTIONS: Required<TransferDiscoveryOptions> = {
  relationshipState: 'ACCEPTED',
};
