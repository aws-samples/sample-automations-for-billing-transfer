// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Context } from 'aws-lambda';
import middy from '@middy/core';
import {
  OrganizationsClient,
  DescribeResponsibilityTransferCommand,
} from '@aws-sdk/client-organizations';
import { IdempotencyConfig, makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { logger } from '../common/utils/logger.js';
import { tracer } from '../common/utils/tracer.js';
import { metrics, MetricUnit } from '../common/utils/metrics.js';
import { powertools } from '../common/utils/middleware.js';
import { ensureBillingGroup, BillingGroupOperationResult } from '../common/services/billing-conductor-service.js';
import { toError } from '../common/utils/errors.js';

/**
 * Billing Group Event Handler Lambda Function
 *
 * Creates billing groups in AWS Billing Conductor when billing transfer events occur.
 * Triggered by EventBridge CloudTrail events for ResponsibilityTransferAccepted.
 *
 * Note: Scheduled reconciliation is handled separately by BillingGroupReconciliationStack.
 *
 * @module billing-group-handler
 */

import { GLOBAL_SERVICES_REGION } from '../common/constants.js';

/**
 * Initialize Organizations client for transfer ARN lookups
 * Wrapped with Tracer for automatic X-Ray instrumentation
 *
 * Note: Client is created at module level intentionally for Lambda warm start
 * optimization. The client is reused across invocations for better performance.
 */
const organizationsClient = tracer.captureAWSv3Client(
  new OrganizationsClient({
    region: GLOBAL_SERVICES_REGION,
    maxAttempts: 3,
    retryMode: 'adaptive',
  })
);

// Configure idempotency persistence layer
const persistenceStore = new DynamoDBPersistenceLayer({
  tableName: process.env.IDEMPOTENCY_TABLE_NAME || 'billing-group-idempotency',
});

const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: 'detail.serviceEventDetails.id', // Use transfer ID as idempotency key
  expiresAfterSeconds: 86400, // 24 hours - aligns with billing period
  throwOnNoIdempotencyKey: true,
});

// TypeScript interfaces for event types

/**
 * CloudTrail Event for Billing Transfer
 * 
 * This event is delivered by AWS Organizations via CloudTrail to EventBridge
 * when billing transfer responsibility events occur.
 */
export interface BillingTransferEvent {
  version: string;
  id: string;
  'detail-type': 'AWS Service Event via CloudTrail';
  source: 'aws.organizations';
  account: string;
  time: string;
  region: string;
  resources?: string[];
  detail: {
    eventVersion: string;
    eventTime: string;
    eventName: 'ResponsibilityTransferAccepted' | 'ResponsibilityTransferTerminated';
    eventSource: 'organizations.amazonaws.com';
    eventType: 'AwsServiceEvent';
    serviceEventDetails: {
      id: string;
      arn?: string;  // Transfer ARN - may not be present in all events
      transferChain: string[];
      type: 'BILLING';
      status: 'ACCEPTED' | 'WITHDRAWN' | 'DECLINED' | 'EXPIRED' | 'CANCELED' | 'COMPLETED';
      source: {
        managementAccountId: string;
      };
      target: {
        managementAccountId: string;
      };
      requester: string;
      startTimestamp: number;
      endTimestamp?: number;
    };
  };
}

export type HandlerEvent = BillingTransferEvent;

export interface HandlerResponse {
  statusCode: number;
  body: {
    message: string;
    billingGroupArn?: string;
    accountId: string;
    action: 'created' | 'exists' | 'skipped';
  };
}

/**
 * Determines if the event is from AWS Organizations CloudTrail
 *
 * @param event - The incoming Lambda event
 * @returns true if event is from aws.organizations, false otherwise
 */
function isOrganizationsEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  return (event as Record<string, unknown>).source === 'aws.organizations';
}

/**
 * Main Lambda handler - processes CloudTrail billing transfer events.
 * Throws errors to trigger EventBridge retry mechanism.
 */
const lambdaHandler = async (event: unknown, context: Context): Promise<HandlerResponse> => {
  // Log the incoming event
  logger.info('Lambda function started', { event });

  const eventObj = (event as Record<string, unknown>) || {};

  logger.info('Processing event', {
    eventId: eventObj.id || 'unknown',
    requestId: context.awsRequestId,
  });

  // Track event processing metric
  metrics.addMetric('BillingTransferEventReceived', MetricUnit.Count, 1);

  try {
    if (isOrganizationsEvent(event)) {
      // Use idempotent wrapper to prevent duplicate processing
      return await processTransferEventIdempotent(event as BillingTransferEvent);
    } else {
      return await handleUnknownEvent(event);
    }
  } catch (error) {
    const err = toError(error);
    logger.error('Lambda function failed', {
      error: err,
      eventId: eventObj.id || 'unknown',
    });
    metrics.addMetric('BillingTransferEventFailed', MetricUnit.Count, 1);
    throw err;
  }
};

// Wrap billing transfer processing with idempotency
const processTransferEventIdempotent = makeIdempotent(
  async (event: BillingTransferEvent): Promise<HandlerResponse> => {
    return await handleBillingTransferEvent(event);
  },
  {
    persistenceStore,
    config: idempotencyConfig,
  }
);

// Wrap handler with Powertools middleware
export const handler = middy(lambdaHandler).use(powertools());

/**
 * Handles billing transfer events from CloudTrail.
 * Extracts transfer ARN (from event or via DescribeResponsibilityTransfer API)
 * and creates billing group using ResponsibilityTransferArn parameter.
 */
async function handleBillingTransferEvent(event: BillingTransferEvent): Promise<HandlerResponse> {
  const { eventName, serviceEventDetails } = event.detail;
  const { id: transferId, status, source, target } = serviceEventDetails;
  const accountId = source.managementAccountId;

  // Log event details with structured context
  logger.info('Processing billing transfer event', {
    transferId,
    eventName,
    accountId,
    status,
    sourceAccountId: source.managementAccountId,
    targetAccountId: target.managementAccountId,
  });

  try {
    // Extract or look up the transfer ARN
    // Some events include the ARN, others don't - we need to handle both cases
    let transferArn = serviceEventDetails.arn;
    
    if (!transferArn) {
      // ARN not in event - need to look it up via Organizations API
      // Format: arn:aws:organizations::<target-account>:transfer/o-<org-id>/billing/inbound/rt-<id>
      logger.info('Transfer ARN not in event, looking up via DescribeResponsibilityTransfer', {
        transferId,
        accountId,
      });

      let describeResult;
      try {
        describeResult = await organizationsClient.send(
          new DescribeResponsibilityTransferCommand({ Id: transferId })
        );
      } catch (describeError) {
        const errMsg = describeError instanceof Error ? describeError.message : String(describeError);
        throw new Error(
          `Failed to lookup transfer ARN via DescribeResponsibilityTransfer for ${transferId}: ${errMsg}`
        );
      }

      transferArn = describeResult.ResponsibilityTransfer?.Arn;

      if (!transferArn) {
        // nosemgrep: missing-template-string-indicator - false positive, template strings are correct
        throw new Error(
          `DescribeResponsibilityTransfer returned no ARN for transfer ${transferId}. ` +
          `Response: ${JSON.stringify(describeResult.ResponsibilityTransfer || {})}`
        );
      }

      logger.info('Retrieved transfer ARN from Organizations API', {
        transferId,
        transferArn,
        accountId,
      });
    } else {
      logger.info('Using transfer ARN from event', {
        transferId,
        transferArn,
        accountId,
      });
    }
    
    // Call ensureBillingGroup with the account ID and transfer ARN
    const operationResult: BillingGroupOperationResult = await ensureBillingGroup(accountId, transferArn);

    // Log operation result (created, exists, or failed)
    logger.info('Billing group operation completed', {
      transferId,
      accountId,
      success: operationResult.success,
      action: operationResult.action,
      billingGroupArn: operationResult.billingGroupArn,
      billingGroupName: operationResult.billingGroupName,
    });

    // Track metrics based on operation result
    if (operationResult.success) {
      metrics.addMetric('BillingGroupOperationSuccess', MetricUnit.Count, 1);
      if (operationResult.action === 'created') {
        metrics.addMetric('BillingGroupCreated', MetricUnit.Count, 1);
      }
    } else {
      metrics.addMetric('BillingGroupOperationFailed', MetricUnit.Count, 1);
    }

    // Update response to include billing group ARN and action taken
    const response: HandlerResponse = {
      statusCode: operationResult.success ? 200 : 500,
      body: {
        message: operationResult.success
          ? `Successfully ${operationResult.action} billing group for account ${accountId}`
          : `Failed to ensure billing group for account ${accountId}`,
        billingGroupArn: operationResult.billingGroupArn,
        accountId,
        action: operationResult.action as 'created' | 'exists' | 'skipped',
      },
    };

    logger.info('Lambda function completed', {
      statusCode: response.statusCode,
      transferId,
      success: operationResult.success,
      action: operationResult.action,
    });

    // Handle errors and allow EventBridge retry mechanism
    if (!operationResult.success) {
      // Throw error to trigger EventBridge retry
      throw new Error(
        `Failed to ensure billing group: ${operationResult.error?.message || 'Unknown error'}`
      );
    }

    return response;
  } catch (error) {
    // Log error and re-throw to allow EventBridge retry mechanism
    logger.error('Error processing billing transfer event', {
      error: error as Error,
      transferId,
      accountId,
    });

    // Re-throw to trigger EventBridge retry
    throw error;
  }
}

/** Handles unknown event sources - returns 500 error response */
async function handleUnknownEvent(event: unknown): Promise<HandlerResponse> {
  const eventObj = (typeof event === 'object' && event !== null)
    ? (event as Record<string, unknown>)
    : {};
  logger.error('Unknown event source received', {
    error: new Error('Unknown event source'),
    eventSource: eventObj.source,
  });

  const response: HandlerResponse = {
    statusCode: 500,
    body: {
      message: 'Failed to process event: unknown event source',
      accountId: 'N/A',
      action: 'skipped',
    },
  };

  return response;
}
