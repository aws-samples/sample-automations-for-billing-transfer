// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Logger Utility using AWS Lambda Powertools
 *
 * Provides structured JSON logging with Lambda context injection,
 * correlation IDs, and CloudWatch Logs integration.
 *
 * Features:
 * - Automatic Lambda context injection (request ID, cold start)
 * - Structured JSON output for easy parsing
 * - Configurable log levels via LOG_LEVEL env var
 * - X-Ray trace ID correlation
 * - Log sampling support
 *
 * Usage:
 * ```typescript
 * import { logger } from '../common/utils/logger.js';
 *
 * export const handler = async (event, context) => {
 *   logger.addContext(context);
 *   logger.info('Operation started', { accountId: '123456789012' });
 *   logger.error('Operation failed', { error });
 * };
 * ```
 *
 * @module logger
 */

import { Logger as PowertoolsLogger } from '@aws-lambda-powertools/logger';

const SERVICE_NAME = 'sample-bt-automation';

/**
 * Pre-configured Powertools Logger instance
 *
 * Configuration is read from environment variables:
 * - LOG_LEVEL: DEBUG, INFO, WARN, ERROR (default: INFO)
 * - POWERTOOLS_SERVICE_NAME: Service name for logs (default: sample-bt-automation)
 * - POWERTOOLS_LOG_LEVEL: Alternative to LOG_LEVEL
 */
export const logger = new PowertoolsLogger({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME || SERVICE_NAME,
});

/**
 * Re-export Logger class for cases where a new instance is needed
 *
 * @example
 * ```typescript
 * import { Logger } from '../common/utils/logger.js';
 * const customLogger = new Logger({ serviceName: 'my-service' });
 * ```
 */
export { PowertoolsLogger as Logger };

/**
 * Log level type for compatibility
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Context type for log entries
 */
export interface LogContext {
  [key: string]: unknown;
}
