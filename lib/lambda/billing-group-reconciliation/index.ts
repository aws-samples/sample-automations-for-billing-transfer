// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Context } from 'aws-lambda';
import middy from '@middy/core';
import { reconcileAllTransfers, ReconciliationSummary } from './reconciliation-service.js';
import { logger } from '../common/utils/logger.js';
import { metrics, MetricUnit } from '../common/utils/metrics.js';
import { powertools } from '../common/utils/middleware.js';
import { toError, getErrorMessage } from '../common/utils/errors.js';
import { RECON_MARKERS } from '../common/log-markers.js';

/**
 * Billing Group Reconciliation Lambda Function
 *
 * Performs periodic reconciliation ensuring every active billing transfer
 * has a corresponding billing group in AWS Billing Conductor.
 * Handles both direct and indirect (nested) billing transfers.
 *
 * Triggered by EventBridge Scheduler (default: daily at midnight UTC).
 *
 * @module billing-group-reconciliation
 */

export interface SchedulerEvent {
  source: 'scheduler';
  action: 'reconcile-all';
  time?: string; // ISO 8601 timestamp
}

export interface ReconciliationResponse {
  statusCode: 200 | 500;
  body: {
    summary: ReconciliationSummary;
    timestamp: string;
  };
}

function isSchedulerEvent(event: unknown): event is SchedulerEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const eventObj = event as Record<string, unknown>;
  return (
    eventObj.source === 'scheduler' &&
    eventObj.action === 'reconcile-all'
  );
}

/**
 * Main Lambda handler - validates scheduler event and orchestrates reconciliation.
 * Returns 500 on errors (EventBridge Scheduler will retry based on retry policy).
 */
const lambdaHandler = async (
  event: unknown,
  context: Context
): Promise<ReconciliationResponse> => {
  const startTime = Date.now();

  logger.info('Reconciliation Lambda invoked', {
    requestId: context.awsRequestId,
    functionName: context.functionName,
    event,
    remainingTimeMs: context.getRemainingTimeInMillis(),
  });

  // Track reconciliation invocation
  metrics.addMetric('ReconciliationInvoked', MetricUnit.Count, 1);

  try {
    // Validate event
    if (!isSchedulerEvent(event)) {
      const eventObj = (typeof event === 'object' && event !== null)
        ? (event as Record<string, unknown>)
        : {};
      logger.error('Invalid event received', {
        error: new Error('Not a scheduler event'),
        eventSource: eventObj.source,
        eventAction: eventObj.action,
      });

      metrics.addMetric('ReconciliationInvalidEvent', MetricUnit.Count, 1);

      return {
        statusCode: 500,
        body: {
          summary: {
            directTransfersChecked: 0,
            indirectTransfersChecked: 0,
            billingGroupsCreated: 0,
            billingGroupsExisted: 0,
            errors: [
              {
                accountId: 'N/A',
                error: 'Invalid event: expected scheduler event with action reconcile-all',
                timestamp: new Date().toISOString(),
              },
            ],
            duration: Date.now() - startTime,
          },
          timestamp: new Date().toISOString(),
        },
      };
    }

    logger.info('Processing scheduler event', {
      action: event.action,
      source: event.source,
    });

    // Execute reconciliation
    const summary = await reconcileAllTransfers();

    // Track reconciliation metrics
    metrics.addMetric('DirectTransfersChecked', MetricUnit.Count, summary.directTransfersChecked);
    metrics.addMetric('IndirectTransfersChecked', MetricUnit.Count, summary.indirectTransfersChecked);
    metrics.addMetric('BillingGroupsCreated', MetricUnit.Count, summary.billingGroupsCreated);
    metrics.addMetric('BillingGroupsExisted', MetricUnit.Count, summary.billingGroupsExisted);
    metrics.addMetric('ReconciliationErrors', MetricUnit.Count, summary.errors.length);
    metrics.addMetric('ReconciliationDuration', MetricUnit.Milliseconds, summary.duration);

    // Log summary
    logger.info(RECON_MARKERS.bg.ok, {
      summary,
      executionDuration: Date.now() - startTime,
    });

    // Return success response
    const response: ReconciliationResponse = {
      statusCode: 200,
      body: {
        summary,
        timestamp: new Date().toISOString(),
      },
    };

    return response;
  } catch (error) {
    // Log critical error
    const err = toError(error);
    logger.error(RECON_MARKERS.bg.fail, {
      error: err,
      executionDuration: Date.now() - startTime,
    });

    metrics.addMetric('ReconciliationFailed', MetricUnit.Count, 1);

    // Return error response
    // Note: EventBridge Scheduler will retry based on retry policy
    return {
      statusCode: 500,
      body: {
        summary: {
          directTransfersChecked: 0,
          indirectTransfersChecked: 0,
          billingGroupsCreated: 0,
          billingGroupsExisted: 0,
          errors: [
            {
              accountId: 'N/A',
              error: getErrorMessage(error),
              timestamp: new Date().toISOString(),
            },
          ],
          duration: Date.now() - startTime,
        },
        timestamp: new Date().toISOString(),
      },
    };
  }
};

// Wrap handler with Powertools middleware
export const handler = middy(lambdaHandler).use(powertools());
