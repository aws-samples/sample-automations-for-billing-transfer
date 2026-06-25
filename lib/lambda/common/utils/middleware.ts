// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Middleware Stack using AWS Lambda Powertools + Middy
 *
 * Provides a pre-configured middleware stack that combines
 * Logger, Tracer, and Metrics for consistent Lambda instrumentation.
 *
 * Features:
 * - Automatic Lambda context injection for logging
 * - X-Ray trace capture for all invocations
 * - Cold start metrics tracking
 * - State cleanup between invocations
 *
 * Usage:
 * ```typescript
 * import middy from '@middy/core';
 * import { powertools } from '../common/utils/middleware.js';
 *
 * const lambdaHandler = async (event, context) => {
 *   // Your handler logic
 * };
 *
 * export const handler = middy(lambdaHandler).use(powertools());
 * ```
 *
 * @module middleware
 */

import type { MiddlewareObj } from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { logger } from './logger.js';
import { tracer } from './tracer.js';
import { metrics } from './metrics.js';

/**
 * Returns a pre-configured Powertools middleware stack
 *
 * Includes:
 * - Logger context injection (clears state between invocations)
 * - Tracer Lambda handler capture
 * - Metrics logging with cold start tracking
 *
 * @returns Array of Middy middleware handlers
 */
export const powertools = (): MiddlewareObj[] => [
  injectLambdaContext(logger, { clearState: true }),
  captureLambdaHandler(tracer),
  logMetrics(metrics, { captureColdStartMetric: true }),
];

// Re-export utilities for convenience
export { logger, tracer, metrics };
