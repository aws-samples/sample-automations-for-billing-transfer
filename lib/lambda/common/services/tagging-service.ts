// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unified Tagging Service
 *
 * Provides consistent tagging operations across all AWS resources managed by
 * the Billing Transfer Automation project. Supports:
 * - Billing Groups (AWS Billing Conductor)
 * - Billing Views (AWS Billing)
 * - CUR Reports (Cost and Usage Report Service)
 *
 * All resources are tagged with standard project tags for:
 * - Resource identification and ownership
 * - Cost allocation
 * - Automation tracking
 * - Troubleshooting
 *
 * @module tagging-service
 */

import {
  TagResourceCommand as BillingConductorTagCommand,
  ListTagsForResourceCommand as BillingConductorListTagsCommand,
} from '@aws-sdk/client-billingconductor';
import {
  TagResourceCommand as BillingTagCommand,
  ListTagsForResourceCommand as BillingListTagsCommand,
} from '@aws-sdk/client-billing';
import {
  TagResourceCommand as CURTagCommand,
  DescribeReportDefinitionsCommand,
} from '@aws-sdk/client-cost-and-usage-report-service';
import { logger } from '../utils/logger.js';
import { billingConductorClient, billingClient, curClient } from '../utils/clients.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../utils/retry.js';
import { getErrorMessage } from '../utils/errors.js';
import { PROJECT_NAME } from '../constants.js';

/**
 * Standard tags applied to all resources
 */
export interface StandardTags {
  Project: string;
  ManagedBy: string;
  CreatedBy: string;
  Purpose: string;
}

/**
 * Result of a tagging operation
 */
export interface TaggingResult {
  success: boolean;
  resourceArn: string;
  resourceType: 'BillingGroup' | 'BillingView' | 'CURReport';
  action: 'tagged' | 'already-tagged' | 'failed';
  tagsApplied?: number;
  error?: string;
}

/**
 * Gets standard tags for all resources
 */
export function getStandardTags(): StandardTags {
  return {
    Project: PROJECT_NAME,
    ManagedBy: 'BillingTransferAutomation',
    CreatedBy: 'billing-transfer-automation',
    Purpose: 'BillingTransferManagement',
  };
}

/**
 * Gets tags for a billing group
 */
export function getBillingGroupTags(
  accountId: string,
  transferArn: string
): Record<string, string> {
  return {
    ...getStandardTags(),
    AccountId: accountId,
    TransferArn: transferArn,
    ResourceType: 'BillingGroup',
  };
}

/**
 * Gets tags for a billing view
 */
export function getBillingViewTags(
  sourceAccountId: string,
  viewType: 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK'
): Record<string, string> {
  return {
    ...getStandardTags(),
    SourceAccountId: sourceAccountId,
    ViewType: viewType,
    ResourceType: 'BillingView',
  };
}

/**
 * Gets tags for a CUR report
 */
export function getCURReportTags(
  billSourceAccountId: string,
  viewType: 'MY_VIEW' | 'SHOWBACK_VIEW',
  billingViewArn: string
): Record<string, string> {
  return {
    ...getStandardTags(),
    BillSourceAccountId: billSourceAccountId,
    ViewType: viewType,
    BillingViewArn: billingViewArn,
    ResourceType: 'CURReport',
    CreationTimestamp: new Date().toISOString(),
  };
}

/**
 * Tags a billing group
 *
 * @param billingGroupArn - ARN of the billing group to tag
 * @param tags - Tags to apply
 * @returns Tagging result
 */
export async function tagBillingGroup(
  billingGroupArn: string,
  tags: Record<string, string>
): Promise<TaggingResult> {
  logger.info('Tagging billing group', {
    billingGroupArn,
    tagCount: Object.keys(tags).length,
  });

  try {
    const command = new BillingConductorTagCommand({
      ResourceArn: billingGroupArn,
      Tags: tags,
    });

    await retryWithBackoff(
      () => billingConductorClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'TagBillingGroup', billingGroupArn }
    );

    logger.info('Billing group tagged successfully', { billingGroupArn });

    return {
      success: true,
      resourceArn: billingGroupArn,
      resourceType: 'BillingGroup',
      action: 'tagged',
      tagsApplied: Object.keys(tags).length,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.warn('Failed to tag billing group (non-fatal)', {
      billingGroupArn,
      error: errorMessage,
    });

    return {
      success: false,
      resourceArn: billingGroupArn,
      resourceType: 'BillingGroup',
      action: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Tags a billing view
 *
 * @param billingViewArn - ARN of the billing view to tag
 * @param tags - Tags to apply
 * @returns Tagging result
 */
export async function tagBillingView(
  billingViewArn: string,
  tags: Record<string, string>
): Promise<TaggingResult> {
  logger.info('Tagging billing view', {
    billingViewArn,
    tagCount: Object.keys(tags).length,
  });

  try {
    // Billing API expects tags as array of {key, value} objects
    const resourceTags = Object.entries(tags).map(([key, value]) => ({
      key,
      value,
    }));

    const command = new BillingTagCommand({
      resourceArn: billingViewArn,
      resourceTags,
    });

    await retryWithBackoff(
      () => billingClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'TagBillingView', billingViewArn }
    );

    logger.info('Billing view tagged successfully', { billingViewArn });

    return {
      success: true,
      resourceArn: billingViewArn,
      resourceType: 'BillingView',
      action: 'tagged',
      tagsApplied: Object.keys(tags).length,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.warn('Failed to tag billing view (non-fatal)', {
      billingViewArn,
      error: errorMessage,
    });

    return {
      success: false,
      resourceArn: billingViewArn,
      resourceType: 'BillingView',
      action: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Tags a CUR report
 *
 * Note: CUR reports use report name as identifier, not ARN.
 * The ARN is constructed as: arn:aws:cur:us-east-1:{accountId}:definition/{reportName}
 *
 * @param reportName - Name of the CUR report to tag
 * @param tags - Tags to apply
 * @returns Tagging result
 */
export async function tagCURReport(
  reportName: string,
  tags: Record<string, string>
): Promise<TaggingResult> {
  logger.info('Tagging CUR report', {
    reportName,
    tagCount: Object.keys(tags).length,
  });

  try {
    // First, get the report ARN by describing reports
    const describeCommand = new DescribeReportDefinitionsCommand({});
    const describeResponse = await retryWithBackoff(
      () => curClient.send(describeCommand),
      DEFAULT_RETRY_CONFIG,
      { operation: 'DescribeReportDefinitions', reportName }
    );

    const report = describeResponse.ReportDefinitions?.find(
      (r) => r.ReportName === reportName
    );

    if (!report) {
      logger.warn('CUR report not found for tagging', { reportName });
      return {
        success: false,
        resourceArn: reportName,
        resourceType: 'CURReport',
        action: 'failed',
        error: `Report ${reportName} not found`,
      };
    }

    // Construct the ARN (CUR reports don't return ARN in describe)
    // Format: arn:aws:cur:us-east-1:{accountId}:definition/{reportName}
    // We'll use the report name directly with TagResource
    const command = new CURTagCommand({
      ReportName: reportName,
      Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    });

    await retryWithBackoff(
      () => curClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'TagCURReport', reportName }
    );

    logger.info('CUR report tagged successfully', { reportName });

    return {
      success: true,
      resourceArn: reportName,
      resourceType: 'CURReport',
      action: 'tagged',
      tagsApplied: Object.keys(tags).length,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.warn('Failed to tag CUR report (non-fatal)', {
      reportName,
      error: errorMessage,
    });

    return {
      success: false,
      resourceArn: reportName,
      resourceType: 'CURReport',
      action: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Checks if a billing group has the required project tags
 */
export async function checkBillingGroupTags(
  billingGroupArn: string
): Promise<{ hasProjectTags: boolean; existingTags: Record<string, string> }> {
  try {
    const command = new BillingConductorListTagsCommand({
      ResourceArn: billingGroupArn,
    });

    const response = await retryWithBackoff(
      () => billingConductorClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'ListBillingGroupTags', billingGroupArn }
    );

    const existingTags = response.Tags || {};
    const hasProjectTags = existingTags['Project'] === PROJECT_NAME;

    return { hasProjectTags, existingTags };
  } catch (error) {
    logger.warn('Failed to check billing group tags', {
      billingGroupArn,
      error: getErrorMessage(error),
    });
    return { hasProjectTags: false, existingTags: {} };
  }
}

/**
 * Checks if a billing view has the required project tags
 */
export async function checkBillingViewTags(
  billingViewArn: string
): Promise<{ hasProjectTags: boolean; existingTags: Record<string, string> }> {
  try {
    const command = new BillingListTagsCommand({
      resourceArn: billingViewArn,
    });

    const response = await retryWithBackoff(
      () => billingClient.send(command),
      DEFAULT_RETRY_CONFIG,
      { operation: 'ListBillingViewTags', billingViewArn }
    );

    // Convert array of {key, value} to Record<string, string>
    const existingTags: Record<string, string> = {};
    if (response.resourceTags) {
      for (const tag of response.resourceTags) {
        if (tag.key && tag.value) {
          existingTags[tag.key] = tag.value;
        }
      }
    }
    const hasProjectTags = existingTags['Project'] === PROJECT_NAME;

    return { hasProjectTags, existingTags };
  } catch (error) {
    logger.warn('Failed to check billing view tags', {
      billingViewArn,
      error: getErrorMessage(error),
    });
    return { hasProjectTags: false, existingTags: {} };
  }
}

/**
 * Ensures a billing group has the required tags (idempotent)
 */
export async function ensureBillingGroupTags(
  billingGroupArn: string,
  accountId: string,
  transferArn: string
): Promise<TaggingResult> {
  const { hasProjectTags } = await checkBillingGroupTags(billingGroupArn);

  if (hasProjectTags) {
    logger.info('Billing group already has project tags', { billingGroupArn });
    return {
      success: true,
      resourceArn: billingGroupArn,
      resourceType: 'BillingGroup',
      action: 'already-tagged',
    };
  }

  const tags = getBillingGroupTags(accountId, transferArn);
  return tagBillingGroup(billingGroupArn, tags);
}

/**
 * Ensures a billing view has the required tags (idempotent)
 */
export async function ensureBillingViewTags(
  billingViewArn: string,
  sourceAccountId: string,
  viewType: 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK'
): Promise<TaggingResult> {
  const { hasProjectTags } = await checkBillingViewTags(billingViewArn);

  if (hasProjectTags) {
    logger.info('Billing view already has project tags', { billingViewArn });
    return {
      success: true,
      resourceArn: billingViewArn,
      resourceType: 'BillingView',
      action: 'already-tagged',
    };
  }

  const tags = getBillingViewTags(sourceAccountId, viewType);
  return tagBillingView(billingViewArn, tags);
}

/**
 * Ensures a CUR report has the required tags (idempotent)
 *
 * Note: CUR API doesn't have ListTagsForResource, so we always apply tags
 */
export async function ensureCURReportTags(
  reportName: string,
  billSourceAccountId: string,
  viewType: 'MY_VIEW' | 'SHOWBACK_VIEW',
  billingViewArn: string
): Promise<TaggingResult> {
  const tags = getCURReportTags(billSourceAccountId, viewType, billingViewArn);
  return tagCURReport(reportName, tags);
}
