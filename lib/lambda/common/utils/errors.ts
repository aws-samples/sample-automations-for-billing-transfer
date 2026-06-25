// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared Error Utilities
 *
 * Provides centralized error types, constants, and utility functions for
 * consistent error handling across all Lambda functions.
 *
 * @module errors
 */

/**
 * Error codes that indicate transient/retryable failures
 *
 * These errors are temporary and the operation can be safely retried.
 * Includes throttling, timeouts, and service unavailability.
 */
export const RETRYABLE_ERROR_CODES = [
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'InternalServerError',
  'RequestTimeout',
  'NetworkError',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
] as const;

/**
 * Error codes that indicate critical failures
 *
 * These errors are not retryable and typically indicate authentication
 * or authorization problems that require human intervention.
 */
export const CRITICAL_ERROR_CODES = [
  'AccessDeniedException',
  'UnauthorizedException',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
] as const;

/**
 * AWS Service Error interface
 *
 * Represents errors returned by AWS SDK operations. Extends the standard
 * Error interface with AWS-specific properties.
 */
export interface AWSServiceError extends Error {
  /** AWS error code (e.g., 'ThrottlingException') */
  code?: string;
  /** Error name (typically same as code for AWS errors) */
  name: string;
  /** AWS SDK metadata including HTTP status code */
  $metadata?: {
    httpStatusCode?: number;
    requestId?: string;
    attempts?: number;
    totalRetryDelay?: number;
  };
}

/**
 * Type guard to check if an unknown value is an Error
 *
 * @param error - Value to check
 * @returns True if error is an Error instance
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Type guard to check if an error is an AWS Service Error
 *
 * Checks for AWS-specific properties like code and $metadata.
 *
 * @param error - Value to check
 * @returns True if error is an AWSServiceError
 */
export function isAWSServiceError(error: unknown): error is AWSServiceError {
  return (
    isError(error) &&
    (typeof (error as AWSServiceError).code === 'string' ||
      typeof (error as AWSServiceError).$metadata === 'object')
  );
}

/**
 * Extracts error code from an unknown error
 *
 * Attempts to extract the error code from various error formats.
 * Handles Error instances, AWS SDK errors, and plain objects with
 * code/name properties. Falls back to error name if code is not available.
 *
 * @param error - Error to extract code from
 * @returns Error code string or empty string if not found
 */
export function getErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const errorObj = error as Record<string, unknown>;
  // Check for AWS SDK error code first, then fall back to name
  if (typeof errorObj.code === 'string' && errorObj.code) {
    return errorObj.code;
  }
  if (typeof errorObj.name === 'string' && errorObj.name) {
    return errorObj.name;
  }
  return '';
}

/**
 * Extracts error message from an unknown error
 *
 * Handles Error instances, plain objects with message property,
 * and string errors.
 *
 * @param error - Error to extract message from
 * @returns Error message or default message if not found
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  // Handle plain objects with message property
  if (typeof error === 'object' && error !== null) {
    const errorObj = error as Record<string, unknown>;
    if (typeof errorObj.message === 'string' && errorObj.message) {
      return errorObj.message;
    }
  }
  return 'Unknown error occurred';
}

/**
 * Determines if an error is retryable
 *
 * Checks if the error code matches any known retryable error codes.
 * These are transient failures that can be safely retried.
 *
 * @param error - Error to check
 * @returns True if the error is retryable, false otherwise
 */
export function isRetryableError(error: unknown): boolean {
  const errorCode = getErrorCode(error);
  if (!errorCode) {
    return false;
  }
  return RETRYABLE_ERROR_CODES.some((retryable) => errorCode.includes(retryable));
}

/**
 * Determines if an error is critical
 *
 * Critical errors indicate authentication or authorization failures
 * that should stop processing and require human intervention.
 *
 * @param error - Error to check
 * @returns True if the error is critical, false otherwise
 */
export function isCriticalError(error: unknown): boolean {
  const errorCode = getErrorCode(error);
  if (!errorCode) {
    return false;
  }
  return CRITICAL_ERROR_CODES.some((critical) => errorCode.includes(critical));
}

/**
 * Converts an unknown error to a standard Error object
 *
 * Ensures we always have a proper Error instance for logging and handling.
 *
 * @param error - Unknown error value
 * @returns Error instance
 */
export function toError(error: unknown): Error {
  if (isError(error)) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error(getErrorMessage(error));
}
