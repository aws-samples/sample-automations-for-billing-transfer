// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { logger } from './logger.js';
import {
  RETRYABLE_ERROR_CODES,
  CRITICAL_ERROR_CODES,
  getErrorCode,
  getErrorMessage,
  toError,
  isError,
} from './errors.js';

/**
 * Error Handler Utility
 *
 * Provides centralized error handling, categorization, and recovery logic
 * for all Lambda functions. Categorizes errors into transient,
 * permanent, and critical types to determine appropriate handling.
 *
 * Error Categories:
 * - TRANSIENT: Temporary failures that can be retried (throttling, timeouts)
 * - PERMANENT: Non-retryable failures that don't stop processing (validation errors)
 * - CRITICAL: Failures that stop processing (authentication, permissions)
 *
 * @module error-handler
 */

/**
 * Error details interface
 *
 * Standardized error information structure used throughout the application.
 */
export interface ErrorDetails {
  code: string;
  message: string;
  accountId?: string;
  transferId?: string;
  stack?: string;
  timestamp: string;
  retryable: boolean;
}

/**
 * Error categories
 *
 * Defines the three types of errors and their handling strategies:
 * - TRANSIENT: Retry the operation (throttling, timeouts)
 * - PERMANENT: Log and continue (validation errors, not found)
 * - CRITICAL: Stop processing (auth failures, permissions)
 */
export enum ErrorCategory {
  /** Retryable errors (throttling, timeouts, service unavailable) */
  TRANSIENT = 'TRANSIENT',

  /** Non-retryable errors that don't stop processing (validation, not found) */
  PERMANENT = 'PERMANENT',

  /** Critical errors that stop processing (auth, permissions) */
  CRITICAL = 'CRITICAL',
}


/**
 * Categorizes an error based on its error code
 *
 * Examines the error code to determine if the error is transient (retryable),
 * permanent (non-retryable but not critical), or critical (stops processing).
 *
 * @param error - Error object to categorize
 * @returns ErrorCategory - Category of the error
 */
export function categorizeError(error: unknown): ErrorCategory {
  const errorCode = getErrorCode(error);

  // Critical errors that should stop processing
  if (CRITICAL_ERROR_CODES.some((critical) => errorCode.includes(critical))) {
    return ErrorCategory.CRITICAL;
  }

  // Transient errors that can be retried
  if (RETRYABLE_ERROR_CODES.some((transient) => errorCode.includes(transient))) {
    return ErrorCategory.TRANSIENT;
  }

  // All other errors are permanent (non-retryable but don't stop processing)
  return ErrorCategory.PERMANENT;
}

/**
 * Converts an error to ErrorDetails
 *
 * Extracts relevant information from an error object and formats it
 * into a standardized ErrorDetails structure.
 *
 * @param error - Error object to convert
 * @param accountId - Optional account ID for context
 * @param transferId - Optional transfer ID for context
 * @returns ErrorDetails - Standardized error information
 */
export function toErrorDetails(
  error: unknown,
  accountId?: string,
  transferId?: string
): ErrorDetails {
  const category = categorizeError(error);
  const errorObj = isError(error) ? error : toError(error);

  return {
    code: getErrorCode(error) || 'UnknownError',
    message: getErrorMessage(error),
    accountId,
    transferId,
    stack: process.env.LOG_LEVEL === 'DEBUG' ? errorObj.stack : undefined,
    timestamp: new Date().toISOString(),
    retryable: category === ErrorCategory.TRANSIENT,
  };
}

/**
 * Handles an error based on its category
 *
 * Central error handling function that categorizes errors, logs them,
 * and determines whether to throw (critical) or return error details.
 *
 * Behavior by Category:
 * - TRANSIENT: Log and return details (caller should retry)
 * - PERMANENT: Log and return details (caller should continue)
 * - CRITICAL: Log and throw (stops processing)
 *
 * @param error - The error to handle
 * @param context - Context for logging (accountId, transferId, etc.)
 * @returns ErrorDetails - Standardized error information
 * @throws {Error} If error is critical (authentication, permissions)
 */
export function handleError(
  error: unknown,
  context: Record<string, unknown> = {}
): ErrorDetails {
  const category = categorizeError(error);
  const errorDetails = toErrorDetails(
    error,
    context.accountId as string | undefined,
    context.transferId as string | undefined
  );

  // Log the error with category
  const errorObj = toError(error);
  logger.error('Error occurred', {
    error: errorObj,
    ...context,
    category,
    errorDetails,
  });

  // If critical, throw to stop processing
  if (category === ErrorCategory.CRITICAL) {
    throw new Error(
      `Critical error: ${errorDetails.message} (${errorDetails.code})`
    );
  }

  return errorDetails;
}

/**
 * Checks if error is a ConflictException (resource already exists)
 *
 * ConflictExceptions indicate that a resource already exists, which is
 * treated as success for idempotent operations. This allows safe retries
 * of create operations.
 *
 * @param error - Error object to check
 * @returns True if error is a conflict/already exists error, false otherwise
 *
 * This is treated as success for idempotency
 */
export function isConflictError(error: unknown): boolean {
  const errorCode = getErrorCode(error);
  return errorCode.includes('ConflictException') || errorCode.includes('AlreadyExists');
}
