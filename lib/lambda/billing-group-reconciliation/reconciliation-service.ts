// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ensureBillingGroup,
  tagBillingGroup,
  getBillingGroupTags,
} from '../common/services/billing-conductor-service.js';
import { analyzeTransfers } from '../common/services/transfer-analysis-service.js';
import { BillingTransferWithResourcesModel } from '../common/models/billing-transfer-resources.js';
import { AnalysisSummaryModel } from '../common/models/analysis-summary.js';
import { logger } from '../common/utils/logger.js';
import { handleError, ErrorCategory, categorizeError } from '../common/utils/error-handler.js';

/**
 * Result of reconciling a single billing transfer
 */
export interface ReconciliationResult {
  accountId: string;
  status: 'created' | 'existed' | 'failed';
  billingGroupArn?: string;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  timestamp: string;
}

/**
 * Summary of entire reconciliation run
 */
export interface ReconciliationSummary {
  directTransfersChecked: number;
  indirectTransfersChecked: number;
  billingGroupsCreated: number;
  billingGroupsExisted: number;
  errors: Array<{
    accountId: string;
    transferId?: string;
    error: string;
    timestamp: string;
  }>;
  duration: number;
}

/**
 * Reconciles a single billing transfer that is missing a billing group
 */
async function reconcileTransfer(
  transferWithResources: BillingTransferWithResourcesModel
): Promise<ReconciliationResult> {
  const { transfer, resources, resourcesFound } = transferWithResources;
  const { billSourceAccountId, id: transferId } = transfer;

  logger.info('Reconciling billing transfer', {
    transferId,
    accountId: billSourceAccountId,
    hasBillingGroup: resourcesFound.billingGroup,
  });

  try {
    // Check if billing group already exists (from analysis)
    if (resourcesFound.billingGroup && resources.billingGroup) {
      logger.info('Billing group already exists, ensuring tags', {
        transferId,
        accountId: billSourceAccountId,
        billingGroupArn: resources.billingGroup.arn,
      });

      const tags = getBillingGroupTags(billSourceAccountId, transfer.arn);
      await tagBillingGroup(resources.billingGroup.arn, tags);

      return {
        accountId: billSourceAccountId,
        status: 'existed',
        billingGroupArn: resources.billingGroup.arn,
        timestamp: new Date().toISOString(),
      };
    }

    // Billing group doesn't exist, create it
    logger.info('Billing group does not exist, creating', {
      transferId,
      accountId: billSourceAccountId,
      transferArn: transfer.arn,
    });

    const result = await ensureBillingGroup(billSourceAccountId, transfer.arn);

    if (result.success && result.action === 'created') {
      logger.info('Billing group created successfully', {
        transferId,
        accountId: billSourceAccountId,
        billingGroupArn: result.billingGroupArn,
      });

      return {
        accountId: billSourceAccountId,
        status: 'created',
        billingGroupArn: result.billingGroupArn,
        timestamp: new Date().toISOString(),
      };
    } else if (result.success && result.action === 'exists') {
      // Race condition: group was created between analysis and create
      logger.info('Billing group exists (race condition)', {
        transferId,
        accountId: billSourceAccountId,
        billingGroupArn: result.billingGroupArn,
      });

      return {
        accountId: billSourceAccountId,
        status: 'existed',
        billingGroupArn: result.billingGroupArn,
        timestamp: new Date().toISOString(),
      };
    } else {
      throw new Error(result.error?.message || 'Failed to create billing group');
    }
  } catch (error) {
    logger.error('Failed to reconcile transfer', {
      error: error as Error,
      transferId,
      accountId: billSourceAccountId,
      resourceState: resourcesFound,
    });

    const errorDetails = handleError(error, {
      transferId,
      accountId: billSourceAccountId,
    });

    return {
      accountId: billSourceAccountId,
      status: 'failed',
      error: {
        code: errorDetails.code,
        message: errorDetails.message,
        stack: errorDetails.stack,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Builds a ReconciliationSummary from analysis results and reconciliation results
 */
function buildReconciliationSummary(
  analysisSummary: AnalysisSummaryModel,
  results: ReconciliationResult[],
  errors: Array<{ accountId: string; transferId?: string; error: string; timestamp: string }>,
  duration: number
): ReconciliationSummary {
  return {
    directTransfersChecked: analysisSummary.directTransferCount,
    indirectTransfersChecked: analysisSummary.indirectTransferCount,
    billingGroupsCreated: results.filter((r) => r.status === 'created').length,
    billingGroupsExisted: results.filter((r) => r.status === 'existed').length,
    errors,
    duration,
  };
}

/**
 * Reconciles all billing transfers
 * 
 * Main entry point for the reconciliation process. Uses TransferAnalysisService
 * to discover all active transfers with their resources, then creates billing
 * groups for transfers that are missing them.
 */
export async function reconcileAllTransfers(): Promise<ReconciliationSummary> {
  const startTime = Date.now();

  logger.info('Starting reconciliation of all billing transfers');

  try {
    const { summary: analysisSummary } = await analyzeTransfers({ 
      relationshipState: 'ACCEPTED' 
    });

    logger.info('Transfer analysis completed', {
      totalTransfers: analysisSummary.totalTransfers,
      directTransferCount: analysisSummary.directTransferCount,
      indirectTransferCount: analysisSummary.indirectTransferCount,
      missingBillingGroups: analysisSummary.resourceCounts.missingBillingGroups,
    });

    if (analysisSummary.totalTransfers === 0) {
      logger.info('No billing transfers to reconcile');

      return {
        directTransfersChecked: 0,
        indirectTransfersChecked: 0,
        billingGroupsCreated: 0,
        billingGroupsExisted: 0,
        errors: [],
        duration: Date.now() - startTime,
      };
    }

    const transfersNeedingBillingGroups = analysisSummary.transfers.filter(
      (t) => !t.resourcesFound.billingGroup
    );

    const transfersWithBillingGroups = analysisSummary.transfers.filter(
      (t) => t.resourcesFound.billingGroup
    );

    logger.info('Filtered transfers for reconciliation', {
      needingBillingGroups: transfersNeedingBillingGroups.length,
      alreadyHaveBillingGroups: transfersWithBillingGroups.length,
    });

    const results: ReconciliationResult[] = [];
    const errors: Array<{ accountId: string; transferId?: string; error: string; timestamp: string }> = [];

    for (const transferWithResources of transfersNeedingBillingGroups) {
      try {
        const result = await reconcileTransfer(transferWithResources);
        results.push(result);

        if (result.status === 'failed' && result.error) {
          errors.push({
            accountId: result.accountId,
            transferId: transferWithResources.transfer.id,
            error: `${result.error.code}: ${result.error.message}`,
            timestamp: result.timestamp,
          });
        }
      } catch (error) {
        logger.error('Unexpected error during transfer reconciliation', {
          error: error as Error,
          transferId: transferWithResources.transfer.id,
          accountId: transferWithResources.transfer.billSourceAccountId,
          resourceState: transferWithResources.resourcesFound,
        });

        errors.push({
          accountId: transferWithResources.transfer.billSourceAccountId,
          transferId: transferWithResources.transfer.id,
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    for (const transferWithResources of transfersWithBillingGroups) {
      if (transferWithResources.resources.billingGroup) {
        results.push({
          accountId: transferWithResources.transfer.billSourceAccountId,
          status: 'existed',
          billingGroupArn: transferWithResources.resources.billingGroup.arn,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const summary = buildReconciliationSummary(
      analysisSummary,
      results,
      errors,
      Date.now() - startTime
    );

    logger.info('Reconciliation completed', {
      directTransfersChecked: summary.directTransfersChecked,
      indirectTransfersChecked: summary.indirectTransfersChecked,
      billingGroupsCreated: summary.billingGroupsCreated,
      billingGroupsExisted: summary.billingGroupsExisted,
      errorCount: summary.errors.length,
      duration: summary.duration,
    });

    return summary;
  } catch (error) {
    logger.error('Critical error during reconciliation', {
      error: error as Error,
      duration: Date.now() - startTime,
    });

    const category = categorizeError(error);
    if (category === ErrorCategory.CRITICAL) {
      throw error;
    }

    return {
      directTransfersChecked: 0,
      indirectTransfersChecked: 0,
      billingGroupsCreated: 0,
      billingGroupsExisted: 0,
      errors: [
        {
          accountId: 'N/A',
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        },
      ],
      duration: Date.now() - startTime,
    };
  }
}
