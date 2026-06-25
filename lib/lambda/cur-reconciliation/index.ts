// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CUR Automation Lambda Handler
 * 
 * Main entry point for the CUR (Cost and Usage Report) automation Lambda function.
 * This handler orchestrates the creation and management of AWS Cost and Usage Reports
 * for billing transfer relationships using the Legacy CUR API.
 * 
 * Workflow:
 * 1. Load configuration from S3 or environment
 * 2. Invoke ReconciliationService to process all billing transfers
 * 3. Return comprehensive reconciliation summary
 * 
 * Triggered by:
 * - EventBridge Scheduler (daily scheduled execution)
 * 
 * Environment Variables:
 * - CONFIG_BUCKET: S3 bucket containing configuration template
 * - CONFIG_KEY: S3 key for configuration template
 * - CONFIG_PATH: (Optional) Local file path for configuration (for testing)
 */

import { Context } from 'aws-lambda';
import middy from '@middy/core';
import { CURReconciliationEvent, CURReconciliationResult } from './models/lambda-event.js';
import { ConfigurationService } from './services/configuration-service.js';
import { ReconciliationService } from './services/reconciliation-service.js';
import { logger } from '../common/utils/logger.js';
import { metrics, MetricUnit } from '../common/utils/metrics.js';
import { powertools } from '../common/utils/middleware.js';
import { RECON_MARKERS } from '../common/log-markers.js';

/**
 * Lambda handler function
 * 
 * @param event - Lambda event payload (scheduled event)
 * @param context - Lambda context
 * @returns Reconciliation result with summary
 */
const lambdaHandler = async (
  event: CURReconciliationEvent,
  context: Context
): Promise<CURReconciliationResult> => {
  const startTime = Date.now();

  // Track CUR reconciliation invocation
  metrics.addMetric('CURReconciliationInvoked', MetricUnit.Count, 1);

  try {
    // Validate event source
    if (event.source !== 'scheduler') {
      throw new Error(`Unknown event source: ${event.source}. Expected 'scheduler'`);
    }

    // Validate event action
    if (event.action !== 'reconcile-all') {
      throw new Error(`Unknown event action: ${event.action}. Expected 'reconcile-all'`);
    }

    // Determine configuration source
    const configSource = getConfigurationSource();
    logger.info('CUR reconciliation execution started', {
      configurationSource: configSource,
    });

    // Load configuration
    const configService = new ConfigurationService();
    const config = await configService.loadConfiguration(configSource);

    logger.info('Configuration loaded successfully', {
      hasMyViewConfig: configService.hasMyViewConfig(config),
      hasShowbackViewConfig: configService.hasShowbackViewConfig(config),
      myViewEnabled: configService.isMyViewEnabled(config),
      showbackViewEnabled: configService.isShowbackViewEnabled(config),
    });

    // Execute reconciliation workflow
    const reconciliationService = new ReconciliationService();
    const summary = await reconciliationService.reconcileAllTransfers(config);

    // Track CUR reconciliation metrics
    metrics.addMetric('CURTransfersProcessed', MetricUnit.Count, summary.totalTransfersProcessed);
    metrics.addMetric('CURMyViewReportsCreated', MetricUnit.Count, summary.myViewReportsCreated);
    metrics.addMetric('CURMyViewReportsExisted', MetricUnit.Count, summary.myViewReportsAlreadyExisted);
    metrics.addMetric('CURMyViewReportsFailed', MetricUnit.Count, summary.myViewReportsFailed);
    metrics.addMetric('CURShowbackReportsCreated', MetricUnit.Count, summary.showbackViewReportsCreated);
    metrics.addMetric('CURShowbackReportsExisted', MetricUnit.Count, summary.showbackViewReportsAlreadyExisted);
    metrics.addMetric('CURShowbackReportsFailed', MetricUnit.Count, summary.showbackViewReportsFailed);
    metrics.addMetric('CURSupportCasesCreated', MetricUnit.Count, summary.supportCasesCreated);
    metrics.addMetric('CURSupportCasesFailed', MetricUnit.Count, summary.supportCasesFailed);

    // Log execution summary
    logger.info(RECON_MARKERS.cur.execCompleted, {
      totalTransfersProcessed: summary.totalTransfersProcessed,
      myViewReportsCreated: summary.myViewReportsCreated,
      myViewReportsAlreadyExisted: summary.myViewReportsAlreadyExisted,
      myViewReportsFailed: summary.myViewReportsFailed,
      showbackViewReportsCreated: summary.showbackViewReportsCreated,
      showbackViewReportsAlreadyExisted: summary.showbackViewReportsAlreadyExisted,
      showbackViewReportsFailed: summary.showbackViewReportsFailed,
      supportCasesCreated: summary.supportCasesCreated,
      supportCasesFailed: summary.supportCasesFailed,
      failedTransfersCount: summary.failedTransfers.length,
    });

    const duration = Date.now() - startTime;
    metrics.addMetric('CURReconciliationDuration', MetricUnit.Milliseconds, duration);

    logger.info(RECON_MARKERS.cur.ok, {
      durationMs: duration,
      requestId: context.awsRequestId,
    });

    // Return result
    return {
      summary,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error(RECON_MARKERS.cur.fail, {
      error: error instanceof Error ? error : new Error(String(error)),
      durationMs: duration,
      requestId: context.awsRequestId,
    });

    metrics.addMetric('CURReconciliationFailed', MetricUnit.Count, 1);

    // Re-throw error to mark Lambda execution as failed
    throw error;
  }
};

// Wrap handler with Powertools middleware
export const handler = middy(lambdaHandler).use(powertools());

/**
 * Determine configuration source from environment variables
 * 
 * Priority:
 * 1. CONFIG_PATH (local file path, for testing)
 * 2. CONFIG_BUCKET + CONFIG_KEY (S3, for production)
 * 
 * @returns Configuration source (S3 URI or local file path)
 * @throws Error if configuration source is not properly configured
 */
function getConfigurationSource(): string {
  // Check for local file path (testing)
  const configPath = process.env.CONFIG_PATH;
  if (configPath) {
    return configPath;
  }

  // Check for S3 configuration (production)
  const configBucket = process.env.CONFIG_BUCKET;
  const configKey = process.env.CONFIG_KEY;

  if (!configBucket || !configKey) {
    throw new Error(
      'Configuration source not specified. Set either CONFIG_PATH or both CONFIG_BUCKET and CONFIG_KEY environment variables'
    );
  }

  return `s3://${configBucket}/${configKey}`;
}
