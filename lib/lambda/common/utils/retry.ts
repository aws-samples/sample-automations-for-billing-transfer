// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unified Retry Utility with Exponential Backoff
 *
 * Provides automatic retry logic for transient failures with exponential
 * backoff and jitter. Helps handle temporary service issues like throttling,
 * timeouts, and network errors.
 *
 * Features:
 * - Exponential backoff with configurable parameters
 * - Jitter to prevent thundering herd
 * - Configurable max retries
 * - Automatic error categorization
 * - Structured logging of retry attempts
 *
 * @module retry
 */

import {
  RETRYABLE_ERROR_CODES,
  getErrorCode,
  getErrorMessage,
} from './errors.js';
import { logger } from './logger.js';

/**
 * Retry configuration for API calls
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number; // milliseconds
  maxDelay: number; // milliseconds
  backoffMultiplier: number;
  retryableErrors: string[];
}

/**
 * Default retry configuration
 *
 * - maxAttempts: 3 retry attempts
 * - baseDelay: 1000ms (1 second) initial delay
 * - maxDelay: 30000ms (30 seconds) maximum delay
 * - backoffMultiplier: 2 (exponential backoff)
 * - retryableErrors: Common transient AWS errors (from shared errors module)
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryableErrors: [...RETRYABLE_ERROR_CODES],
};

/**
 * Determines if an error is retryable
 *
 * Checks if the error is a transient failure that can be retried.
 * Retryable errors include throttling, timeouts, service unavailability,
 * and network errors.
 *
 * @param error - Error object to check
 * @param config - Optional retry configuration (uses DEFAULT_RETRY_CONFIG if not provided)
 * @returns True if error is retryable, false otherwise
 */
export function isRetryableError(error: unknown, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  const errorCode = getErrorCode(error);
  if (!errorCode) {
    return false;
  }
  return config.retryableErrors.some((retryable) => errorCode.includes(retryable));
}

/**
 * Calculate exponential backoff delay
 * 
 * Formula: min(baseDelay * (backoffMultiplier ^ attemptNumber), maxDelay)
 * 
 * Note: This function returns the base delay without jitter. Jitter is added
 * separately in retryWithBackoff to prevent thundering herd problem.
 * 
 * @param attemptNumber - Current attempt number (0-indexed)
 * @param config - Optional retry configuration (uses DEFAULT_RETRY_CONFIG if not provided)
 * @returns Delay in milliseconds (without jitter)
 */
export function calculateBackoffDelay(
  attemptNumber: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  const exponentialDelay = config.baseDelay * Math.pow(config.backoffMultiplier, attemptNumber);
  return Math.min(exponentialDelay, config.maxDelay);
}

/**
 * Sleep utility for retry delays
 * 
 * Pauses execution for the specified number of milliseconds.
 * 
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an operation with exponential backoff and jitter
 * 
 * Automatically retries failed operations using exponential backoff with jitter.
 * Only retries transient errors (throttling, timeouts, etc.). Non-retryable
 * errors are thrown immediately.
 * 
 * Backoff Strategy (with default config):
 * - Attempt 0: 1s + jitter (0-1s) = 1-2s
 * - Attempt 1: 2s + jitter (0-1s) = 2-3s
 * - Attempt 2: 4s + jitter (0-1s) = 4-5s
 * - Maximum delay: 30s + jitter
 * 
 * @param fn - Async function to retry
 * @param config - Optional retry configuration (uses DEFAULT_RETRY_CONFIG if not provided)
 * @param context - Optional context for logging (operation name, IDs, etc.)
 * @returns Promise<T> - Result of the operation
 * @throws {Error} If max retries exceeded or non-retryable error
 * 
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => billingConductorClient.send(command),
 *   DEFAULT_RETRY_CONFIG,
 *   { operation: 'CreateBillingGroup', accountId: '123456789012' }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: Record<string, unknown> = {}
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const isLastAttempt = attempt === config.maxAttempts - 1;
      const canRetry = isRetryableError(error, config);
      const errorCode = getErrorCode(error);
      const errorMessage = getErrorMessage(error);

      // If error is not retryable, throw immediately
      if (!canRetry) {
        logger.error('Non-retryable error encountered', {
          context: {
            ...context,
            errorName: errorCode,
            errorMessage,
            attempt: attempt + 1,
          },
        });
        // Preserve original error for proper error handling downstream
        throw error;
      }

      // If this was the last attempt, throw the error
      if (isLastAttempt) {
        logger.error('Operation failed after retries', {
          context: {
            ...context,
            errorName: errorCode,
            errorMessage,
            attempt: attempt + 1,
            maxAttempts: config.maxAttempts,
            retryable: canRetry,
          },
        });
        // Preserve original error for proper error handling downstream
        throw error;
      }

      // Calculate delay with exponential backoff and add jitter
      const baseDelay = calculateBackoffDelay(attempt, config);
      const jitter = Math.random() * 1000; // Add up to 1 second of jitter
      const delay = baseDelay + jitter;

      logger.warn('Operation failed, retrying', {
        context: {
          ...context,
          attempt: attempt + 1,
          maxAttempts: config.maxAttempts,
          delayMs: Math.round(delay),
          errorName: errorCode,
          errorMessage,
        },
      });

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
