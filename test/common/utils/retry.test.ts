// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  calculateBackoffDelay,
  sleep,
  retryWithBackoff,
} from '../../../lib/lambda/common/utils/retry.js';

describe('retry utility', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('DEFAULT_RETRY_CONFIG', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.baseDelay).toBe(1000);
      expect(DEFAULT_RETRY_CONFIG.maxDelay).toBe(30000);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ThrottlingException');
    });
  });

  describe('isRetryableError', () => {
    it('should return true for throttling errors', () => {
      const error = new Error('test');
      (error as any).code = 'ThrottlingException';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for network errors', () => {
      const error = new Error('test');
      (error as any).code = 'ECONNRESET';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      const error = new Error('test');
      (error as any).code = 'ValidationException';
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('should calculate exponential delay', () => {
      expect(calculateBackoffDelay(0)).toBe(1000); // 1000 * 2^0
      expect(calculateBackoffDelay(1)).toBe(2000); // 1000 * 2^1
      expect(calculateBackoffDelay(2)).toBe(4000); // 1000 * 2^2
      expect(calculateBackoffDelay(3)).toBe(8000); // 1000 * 2^3
    });

    it('should cap at maxDelay', () => {
      expect(calculateBackoffDelay(10)).toBe(30000); // Capped at maxDelay
    });

    it('should use custom config', () => {
      const config = { ...DEFAULT_RETRY_CONFIG, baseDelay: 500, backoffMultiplier: 3 };
      expect(calculateBackoffDelay(0, config)).toBe(500);
      expect(calculateBackoffDelay(1, config)).toBe(1500);
      expect(calculateBackoffDelay(2, config)).toBe(4500);
    });
  });

  describe('sleep', () => {
    it('should delay execution', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });
  });

  describe('retryWithBackoff', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const result = await retryWithBackoff(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error', async () => {
      const error = new Error('throttled');
      (error as any).code = 'ThrottlingException';

      const fn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('success');

      const result = await retryWithBackoff(fn, { ...DEFAULT_RETRY_CONFIG, baseDelay: 10 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw immediately on non-retryable error', async () => {
      const error = new Error('validation failed');
      (error as any).code = 'ValidationException';

      const fn = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(fn)).rejects.toThrow('validation failed');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retries', async () => {
      const error = new Error('throttled');
      (error as any).code = 'ThrottlingException';

      const fn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(fn, { ...DEFAULT_RETRY_CONFIG, maxAttempts: 2, baseDelay: 10 })
      ).rejects.toThrow('throttled');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
