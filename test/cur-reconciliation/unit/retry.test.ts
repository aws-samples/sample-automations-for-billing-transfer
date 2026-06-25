// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
  calculateBackoffDelay,
  isRetryableError,
  sleep,
  retryWithBackoff
} from '../../../lib/lambda/common/utils/retry.js';
import { logger } from '../../../lib/lambda/common/utils/logger.js';

describe('Retry Utility', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    // Guard the result/stdout stream: retryWithBackoff must emit diagnostics
    // through the shared Powertools logger, never via console.log (Req 24.2, 24.5).
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('calculateBackoffDelay', () => {
    it('should calculate exponential backoff correctly', () => {
      const config = DEFAULT_RETRY_CONFIG;
      
      // Attempt 0: 1000 * 2^0 = 1000ms
      expect(calculateBackoffDelay(0, config)).toBe(1000);
      
      // Attempt 1: 1000 * 2^1 = 2000ms
      expect(calculateBackoffDelay(1, config)).toBe(2000);
      
      // Attempt 2: 1000 * 2^2 = 4000ms
      expect(calculateBackoffDelay(2, config)).toBe(4000);
    });

    it('should respect max delay', () => {
      const config: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        maxDelay: 5000
      };
      
      // Attempt 10 would be 1000 * 2^10 = 1,024,000ms, but should cap at 5000ms
      expect(calculateBackoffDelay(10, config)).toBe(5000);
    });

    it('should use default config when not provided', () => {
      expect(calculateBackoffDelay(0)).toBe(1000);
      expect(calculateBackoffDelay(1)).toBe(2000);
    });
  });

  describe('isRetryableError', () => {
    it('should identify throttling errors as retryable', () => {
      const error = { name: 'ThrottlingException', message: 'Rate exceeded' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should identify TooManyRequestsException as retryable', () => {
      const error = { name: 'TooManyRequestsException', message: 'Too many requests' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should identify ServiceUnavailableException as retryable', () => {
      const error = { name: 'ServiceUnavailableException', message: 'Service unavailable' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should identify InternalServerError as retryable', () => {
      const error = { name: 'InternalServerError', message: 'Internal error' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('should not identify validation errors as retryable', () => {
      const error = { name: 'ValidationException', message: 'Invalid input' };
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not identify resource not found as retryable', () => {
      const error = { name: 'ResourceNotFoundException', message: 'Not found' };
      expect(isRetryableError(error)).toBe(false);
    });

    it('should handle errors without name property', () => {
      const error = { message: 'Some error' };
      expect(isRetryableError(error)).toBe(false);
    });

    it('should handle null/undefined errors', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });
  });

  describe('sleep', () => {
    it('should return a promise that resolves', async () => {
      // Test with a very short delay to avoid slowing down tests
      const start = Date.now();
      await sleep(10);
      const elapsed = Date.now() - start;
      
      // Should have waited at least 8ms (allowing for timing variance in CI environments)
      // The sleep function uses setTimeout which is not perfectly precise
      expect(elapsed).toBeGreaterThanOrEqual(8);
    });
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      
      const result = await retryWithBackoff(fn);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on throttling error and eventually succeed', async () => {
      // Use a very short delay for testing
      const testConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1,
        maxDelay: 10
      };
      
      const fn = jest.fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException', message: 'Rate exceeded' })
        .mockResolvedValueOnce('success');
      
      const result = await retryWithBackoff(fn, testConfig);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry up to max attempts for retryable errors', async () => {
      // Use a very short delay for testing
      const testConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1,
        maxDelay: 10
      };
      
      const fn = jest.fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException', message: 'Rate exceeded' })
        .mockRejectedValueOnce({ name: 'ThrottlingException', message: 'Rate exceeded' })
        .mockResolvedValueOnce('success');
      
      const result = await retryWithBackoff(fn, testConfig);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw error after exhausting all retries', async () => {
      // Use a very short delay for testing
      const testConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1,
        maxDelay: 10
      };
      
      const error = { name: 'ThrottlingException', message: 'Rate exceeded' };
      const fn = jest.fn().mockRejectedValue(error);
      
      await expect(retryWithBackoff(fn, testConfig)).rejects.toEqual(error);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-retryable errors', async () => {
      const error = { name: 'ValidationException', message: 'Invalid input' };
      const fn = jest.fn().mockRejectedValue(error);
      
      await expect(retryWithBackoff(fn)).rejects.toEqual(error);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use exponential backoff delays', () => {
      // Test the backoff calculation logic directly
      const config = DEFAULT_RETRY_CONFIG;
      
      // Verify exponential growth
      const delay0 = calculateBackoffDelay(0, config);
      const delay1 = calculateBackoffDelay(1, config);
      const delay2 = calculateBackoffDelay(2, config);
      
      expect(delay1).toBe(delay0 * 2);
      expect(delay2).toBe(delay0 * 4);
    });

    it('should log retry attempts with context', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      
      // Use a very short delay for testing
      const testConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1,
        maxDelay: 10
      };
      
      const fn = jest.fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException', message: 'Rate exceeded' })
        .mockResolvedValueOnce('success');
      
      const context = {
        operation: 'createExport',
        transferId: 'rt-123',
        billSourceAccountId: '123456789012'
      };
      
      await retryWithBackoff(fn, testConfig, context);
      
      // Should log the retry attempt via the shared Powertools logger (warn level)
      expect(warnSpy).toHaveBeenCalledWith(
        'Operation failed, retrying',
        expect.objectContaining({
          context: expect.objectContaining({
            operation: 'createExport',
            transferId: 'rt-123',
            attempt: 1,
          }),
        })
      );

      // Diagnostics must never go to stdout via console.log (Req 24.2, 24.5)
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should log final error after exhausting retries', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      
      // Use a very short delay for testing
      const testConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1,
        maxDelay: 10
      };
      
      const error = { name: 'ThrottlingException', message: 'Rate exceeded' };
      const fn = jest.fn().mockRejectedValue(error);
      
      const context = {
        operation: 'createExport',
        exportName: 'test-export'
      };
      
      await expect(retryWithBackoff(fn, testConfig, context)).rejects.toEqual(error);
      
      // Should log exhausted retries via the shared Powertools logger (error level)
      expect(errorSpy).toHaveBeenCalledWith(
        'Operation failed after retries',
        expect.objectContaining({
          context: expect.objectContaining({
            operation: 'createExport',
            maxAttempts: 3,
          }),
        })
      );

      // Diagnostics must never go to stdout via console.log (Req 24.2, 24.5)
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should log non-retryable errors', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      
      const error = { name: 'ValidationException', message: 'Invalid input' };
      const fn = jest.fn().mockRejectedValue(error);
      
      const context = {
        operation: 'validateConfig'
      };
      
      await expect(retryWithBackoff(fn, DEFAULT_RETRY_CONFIG, context)).rejects.toEqual(error);
      
      // Should log non-retryable error via the shared Powertools logger (error level)
      expect(errorSpy).toHaveBeenCalledWith(
        'Non-retryable error encountered',
        expect.objectContaining({
          context: expect.objectContaining({
            operation: 'validateConfig',
            errorName: 'ValidationException',
          }),
        })
      );

      // Diagnostics must never go to stdout via console.log (Req 24.2, 24.5)
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should route all retry diagnostics through the shared logger and never console.log', async () => {
      // Spy on every shared-logger level plus console.log to prove the channel.
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

      const testConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1,
        maxDelay: 10,
      };

      // Retry-pending path -> logger.warn
      const retryThenSucceed = jest.fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException', message: 'Rate exceeded' })
        .mockResolvedValueOnce('success');
      await retryWithBackoff(retryThenSucceed, testConfig, { operation: 'retryPending' });

      // Exhausted-retries path -> logger.error
      const alwaysThrottled = jest.fn().mockRejectedValue({
        name: 'ThrottlingException',
        message: 'Rate exceeded',
      });
      await expect(
        retryWithBackoff(alwaysThrottled, testConfig, { operation: 'exhausted' })
      ).rejects.toBeDefined();

      // Non-retryable path -> logger.error
      const nonRetryable = jest.fn().mockRejectedValue({
        name: 'ValidationException',
        message: 'Invalid input',
      });
      await expect(
        retryWithBackoff(nonRetryable, testConfig, { operation: 'nonRetryable' })
      ).rejects.toBeDefined();

      // Diagnostics flow through the shared logger at the correct levels...
      expect(warnSpy).toHaveBeenCalledWith('Operation failed, retrying', expect.any(Object));
      expect(errorSpy).toHaveBeenCalledWith('Operation failed after retries', expect.any(Object));
      expect(errorSpy).toHaveBeenCalledWith('Non-retryable error encountered', expect.any(Object));

      // ...and never via console.log, which would corrupt the CLI's --json/stdout
      // result contract and fleet aggregation (Req 24.2, 24.5).
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should handle custom retry config', async () => {
      const customConfig: RetryConfig = {
        maxAttempts: 3,
        baseDelay: 1,
        maxDelay: 10,
        backoffMultiplier: 3,
        retryableErrors: ['ThrottlingException', 'TooManyRequestsException', 'ServiceUnavailableException', 'InternalServerError']
      };
      
      const fn = jest.fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException', message: 'Rate exceeded' })
        .mockResolvedValueOnce('success');
      
      const result = await retryWithBackoff(fn, customConfig);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
