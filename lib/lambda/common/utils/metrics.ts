// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Metrics Utility using AWS Lambda Powertools
 *
 * Provides CloudWatch Metrics integration with automatic
 * dimension management and EMF (Embedded Metric Format) output.
 *
 * Features:
 * - Automatic cold start metrics
 * - Custom metric dimensions
 * - High-resolution metrics support
 * - Metadata attachment for debugging
 *
 * Usage:
 * ```typescript
 * import { metrics, MetricUnit } from '../common/utils/metrics.js';
 *
 * // Add metrics
 * metrics.addMetric('BillingGroupCreated', MetricUnit.Count, 1);
 *
 * // Add dimensions for filtering
 * metrics.addDimension('Environment', 'production');
 *
 * // Add metadata (not published as metric, but visible in logs)
 * metrics.addMetadata('accountId', '123456789012');
 * ```
 *
 * @module metrics
 */

import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

const SERVICE_NAME = 'sample-bt-automation';
const METRICS_NAMESPACE = 'SampleBTAutomation';

/**
 * Pre-configured Powertools Metrics instance
 *
 * Configuration is read from environment variables:
 * - POWERTOOLS_SERVICE_NAME: Service name dimension (default: sample-bt-automation)
 * - POWERTOOLS_METRICS_NAMESPACE: CloudWatch namespace (default: SampleBTAutomation)
 */
export const metrics = new Metrics({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME || SERVICE_NAME,
  namespace: process.env.POWERTOOLS_METRICS_NAMESPACE || METRICS_NAMESPACE,
});

export { Metrics, MetricUnit };
