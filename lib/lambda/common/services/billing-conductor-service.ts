// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ListPricingPlansCommand,
  ListBillingGroupsCommand,
  CreateBillingGroupCommand,
  ConflictException,
  ValidationException,
} from '@aws-sdk/client-billingconductor';
import { logger } from '../utils/logger.js';
import { billingConductorClient } from '../utils/clients.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../utils/retry.js';
import { getErrorCode, getErrorMessage, toError } from '../utils/errors.js';
import {
  DEFAULT_PRICING_PLAN_NAME,
  BILLING_GROUP_PREFIX,
} from '../constants.js';
import { getBillingGroupTags, tagBillingGroup } from './tagging-service.js';

/**
 * AWS Billing Conductor Service
 *
 * This service provides operations for managing billing groups and pricing plans
 * in AWS Billing Conductor. It handles the creation and management of billing groups
 * for billing transfer relationships.
 *
 * Key Features:
 * - Idempotent billing group creation
 * - Automatic pricing plan retrieval
 * - Conflict resolution for existing resources
 * - Structured logging for all operations
 * - Automatic retry with exponential backoff
 *
 * @module billing-conductor-service
 */

// Re-export client for backward compatibility
export { billingConductorClient } from '../utils/clients.js';

/**
 * Gets the ARN of the AWS managed BasicPricingPlan
 *
 * The BasicPricingPlan is an AWS-managed pricing plan that calculates pro forma costs
 * pre-discounts, excluding credits, taxes, and support charges. This is the recommended
 * default pricing plan for billing transfer relationships.
 *
 * @returns Promise<string> - ARN of the BasicPricingPlan
 * @throws {Error} If BasicPricingPlan is not found in the list of pricing plans
 *
 * @example
 * ```typescript
 * const pricingPlanArn = await getBasicPricingPlanArn();
 * console.log(pricingPlanArn); // arn:aws:billingconductor::123456789012:pricing-plan/...
 * ```
 */
export async function getBasicPricingPlanArn(): Promise<string> {
  logger.info('Retrieving BasicPricingPlan ARN');

  try {
    const command = new ListPricingPlansCommand({});
    const response = await retryWithBackoff(
      () => billingConductorClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'ListPricingPlans' }
    );

    // Search for pricing plan with configured name
    const basicPlan = response.PricingPlans?.find(
      (plan) => plan.Name === DEFAULT_PRICING_PLAN_NAME
    );

    if (!basicPlan || !basicPlan.Arn) {
      const error = new Error(`${DEFAULT_PRICING_PLAN_NAME} not found in the list of pricing plans`);
      logger.error(`${DEFAULT_PRICING_PLAN_NAME} not found`, { error });
      throw error;
    }

    logger.info(`${DEFAULT_PRICING_PLAN_NAME} found`, { arn: basicPlan.Arn });
    return basicPlan.Arn;
  } catch (error) {
    logger.error(`Failed to retrieve ${DEFAULT_PRICING_PLAN_NAME}`, { error: error as Error });
    throw error;
  }
}

/**
 * Result of a billing group operation
 * 
 * This interface represents the outcome of attempting to create or verify
 * a billing group. It provides detailed information about the operation
 * including success status, resource identifiers, and error details.
 */
export interface BillingGroupOperationResult {
  /** Whether the operation completed successfully */
  success: boolean;
  
  /** ARN of the billing group (present if success is true) */
  billingGroupArn?: string;
  
  /** Name of the billing group */
  billingGroupName?: string;
  
  /** Account ID for which the billing group was created */
  accountId: string;
  
  /** Action taken: 'created' (new), 'exists' (already present), or 'failed' (error) */
  action: 'created' | 'exists' | 'failed';
  
  /** Error details if the operation failed */
  error?: {
    /** Error code from AWS SDK or custom error identifier */
    code: string;
    /** Human-readable error message */
    message: string;
  };
}

/**
 * Checks if a billing group exists for the given account
 * 
 * Searches through all billing groups to find one where the PrimaryAccountId
 * matches the specified account ID. This is used to implement idempotent
 * billing group creation.
 * 
 * @param accountId - Bill-Source Account ID (customer management account)
 * @returns Promise<string | null> - Billing group ARN if exists, null otherwise
 * @throws {Error} If the API call fails
 * 
 * @example
 * ```typescript
 * const existingArn = await findBillingGroupByAccount('123456789012');
 * if (existingArn) {
 *   console.log('Billing group already exists:', existingArn);
 * }
 * ```
 */
export async function findBillingGroupByAccount(accountId: string): Promise<string | null> {
  logger.info('Checking for existing billing group', { accountId });

  try {
    const command = new ListBillingGroupsCommand({});
    const response = await retryWithBackoff(
      () => billingConductorClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'ListBillingGroups', accountId }
    );

    // Search for billing group where PrimaryAccountId matches the given account ID
    const billingGroup = response.BillingGroups?.find(
      (group) => group.PrimaryAccountId === accountId
    );

    if (billingGroup && billingGroup.Arn) {
      logger.info('Existing billing group found', {
        accountId,
        billingGroupArn: billingGroup.Arn,
        billingGroupName: billingGroup.Name,
      });
      return billingGroup.Arn;
    }

    logger.info('No existing billing group found', { accountId });
    return null;
  } catch (error) {
    logger.error('Failed to check for existing billing group', { error: error as Error, accountId });
    throw error;
  }
}

// Re-export tagging functions for backward compatibility
export { getBillingGroupTags, tagBillingGroup } from './tagging-service.js';

/**
 * Creates a new billing group for a billing transfer relationship
 *
 * IMPORTANT: For billing transfer relationships, you MUST use ResponsibilityTransferArn
 * in the AccountGrouping parameter. Using LinkedAccountIds will fail with error:
 * "Accounts are not in the payer account's CB family"
 *
 * The billing group name follows the format: bg-{accountId}
 * 
 * Note: For billing groups with historical records (from previous billing relationships),
 * AWS requires creating without tags first, then adding tags separately. This function
 * handles that case automatically.
 *
 * @param accountId - Bill-Source Account ID (customer management account)
 * @param pricingPlanArn - ARN of pricing plan to use (typically BasicPricingPlan)
 * @param transferArn - ARN of the responsibility transfer from Organizations API
 * @returns Promise<string> - ARN of the created billing group
 * @throws {ConflictException} If billing group already exists (handled as success)
 * @throws {Error} If creation fails for other reasons
 *
 * @example
 * ```typescript
 * const billingGroupArn = await createBillingGroup(
 *   '123456789012',
 *   'arn:aws:billingconductor::...:pricing-plan/...',
 *   'arn:aws:organizations::...:responsibility-transfer/...'
 * );
 * ```
 */
export async function createBillingGroup(
  accountId: string,
  pricingPlanArn: string,
  transferArn: string
): Promise<string> {
  // Generate billing group name using format "bg-{accountId}"
  const billingGroupName = `${BILLING_GROUP_PREFIX}${accountId}`;
  const tags = getBillingGroupTags(accountId, transferArn);

  logger.info('Creating billing group for billing transfer', {
    accountId,
    billingGroupName,
    pricingPlanArn,
    transferArn,
  });

  try {
    // First attempt: create with tags
    const command = new CreateBillingGroupCommand({
      Name: billingGroupName,
      Description: `Billing group for billing transfer ${transferArn}`,
      AccountGrouping: {
        ResponsibilityTransferArn: transferArn,
      },
      ComputationPreference: {
        PricingPlanArn: pricingPlanArn,
      },
      Tags: tags,
    });

    const response = await retryWithBackoff(
      () => billingConductorClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'CreateBillingGroup', accountId, billingGroupName, transferArn }
    );

    if (!response.Arn) {
      throw new Error('CreateBillingGroup did not return an ARN');
    }

    logger.info('Billing group created successfully', {
      accountId,
      billingGroupArn: response.Arn,
      billingGroupName,
      transferArn,
    });

    return response.Arn;
  } catch (error) {
    // Handle ConflictException as success (resource already exists)
    if (error instanceof ConflictException) {
      logger.info('Billing group already exists (ConflictException)', {
        accountId,
        billingGroupName,
      });

      // Find and return the existing billing group ARN
      const existingArn = await findBillingGroupByAccount(accountId);
      if (existingArn) {
        return existingArn;
      }

      // If we can't find it, throw the original error
      throw error;
    }

    // Handle ValidationException for historical records - retry without tags
    if (error instanceof ValidationException) {
      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes('historical records') && errorMessage.includes('without tag')) {
        logger.info('Billing group has historical records, retrying without tags', {
          accountId,
          billingGroupName,
        });

        return createBillingGroupWithoutTags(accountId, billingGroupName, pricingPlanArn, transferArn, tags);
      }
    }

    logger.error('Failed to create billing group', {
      error: error as Error,
      accountId,
      billingGroupName,
      transferArn,
    });
    throw error;
  }
}

/**
 * Creates a billing group without tags, then adds tags separately
 * 
 * This is required for billing groups with historical records from previous
 * billing relationships. AWS Billing Conductor requires these to be created
 * without tags first.
 */
async function createBillingGroupWithoutTags(
  accountId: string,
  billingGroupName: string,
  pricingPlanArn: string,
  transferArn: string,
  tags: Record<string, string>
): Promise<string> {
  logger.info('Creating billing group without tags (historical records)', {
    accountId,
    billingGroupName,
  });

  const command = new CreateBillingGroupCommand({
    Name: billingGroupName,
    Description: `Billing group for billing transfer ${transferArn}`,
    AccountGrouping: {
      ResponsibilityTransferArn: transferArn,
    },
    ComputationPreference: {
      PricingPlanArn: pricingPlanArn,
    },
    // No tags - will add separately
  });

  const response = await retryWithBackoff(
    () => billingConductorClient.send(command),
    DEFAULT_RETRY_CONFIG,
    { operation: 'CreateBillingGroup (no tags)', accountId, billingGroupName, transferArn }
  );

  if (!response.Arn) {
    throw new Error('CreateBillingGroup did not return an ARN');
  }

  logger.info('Billing group created without tags', {
    accountId,
    billingGroupArn: response.Arn,
    billingGroupName,
  });

  // Add tags separately (non-fatal if this fails)
  await tagBillingGroup(response.Arn, tags);

  return response.Arn;
}

/**
 * Ensures a billing group exists for the billing transfer (idempotent)
 * 
 * This is the main entry point for billing group management. It implements
 * idempotent creation by checking if a billing group already exists before
 * attempting to create one.
 * 
 * Operation Flow:
 * 1. Check if billing group exists for the account
 * 2. If exists, return success with 'exists' action
 * 3. If not exists, get BasicPricingPlan ARN
 * 4. Create billing group with transfer ARN
 * 5. Return success with 'created' action
 * 
 * This function never throws errors - all failures are captured in the result.
 * 
 * @param accountId - Bill-Source Account ID (customer management account)
 * @param transferArn - ARN of the responsibility transfer from Organizations API
 * @returns Promise<BillingGroupOperationResult> - Detailed operation result
 * 
 * @example
 * ```typescript
 * const result = await ensureBillingGroup(
 *   '123456789012',
 *   'arn:aws:organizations::...:responsibility-transfer/rt-abc123'
 * );
 * 
 * if (result.success) {
 *   console.log(`Billing group ${result.action}:`, result.billingGroupArn);
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * ```
 */
export async function ensureBillingGroup(
  accountId: string,
  transferArn: string
): Promise<BillingGroupOperationResult> {
  logger.info('Ensuring billing group exists', { accountId, transferArn });

  try {
    // Check if group exists
    const existingArn = await findBillingGroupByAccount(accountId);

    if (existingArn) {
      logger.info('Billing group already exists', {
        accountId,
        billingGroupArn: existingArn,
        action: 'exists',
      });

      return {
        success: true,
        billingGroupArn: existingArn,
        billingGroupName: `${BILLING_GROUP_PREFIX}${accountId}`,
        accountId,
        action: 'exists',
      };
    }

    // Get pricing plan ARN
    const pricingPlanArn = await getBasicPricingPlanArn();

    // Create billing group with transfer ARN
    const billingGroupArn = await createBillingGroup(accountId, pricingPlanArn, transferArn);

    logger.info('Billing group created', {
      accountId,
      billingGroupArn,
      transferArn,
      action: 'created',
    });

    return {
      success: true,
      billingGroupArn,
      billingGroupName: `${BILLING_GROUP_PREFIX}${accountId}`,
      accountId,
      action: 'created',
    };
  } catch (error) {
    const err = toError(error);
    logger.error('Failed to ensure billing group', { error: err, accountId, transferArn });

    return {
      success: false,
      accountId,
      action: 'failed',
      error: {
        code: getErrorCode(error) || 'UnknownError',
        message: getErrorMessage(error),
      },
    };
  }
}
