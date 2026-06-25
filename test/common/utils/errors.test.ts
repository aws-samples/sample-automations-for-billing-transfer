// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
import {
  RETRYABLE_ERROR_CODES,
  CRITICAL_ERROR_CODES,
  isError,
  isAWSServiceError,
  getErrorCode,
  getErrorMessage,
  isRetryableError,
  isCriticalError,
  toError,
} from '../../../lib/lambda/common/utils/errors.js';

describe('errors utility', () => {
  describe('isError', () => {
    it('should return true for Error instances', () => {
      expect(isError(new Error('test'))).toBe(true);
      expect(isError(new TypeError('test'))).toBe(true);
    });

    it('should return false for non-Error values', () => {
      expect(isError('string')).toBe(false);
      expect(isError(123)).toBe(false);
      expect(isError(null)).toBe(false);
      expect(isError(undefined)).toBe(false);
      expect(isError({ message: 'test' })).toBe(false);
    });
  });

  describe('isAWSServiceError', () => {
    it('should return true for errors with code property', () => {
      const error = new Error('test');
      (error as any).code = 'ThrottlingException';
      expect(isAWSServiceError(error)).toBe(true);
    });

    it('should return true for errors with $metadata property', () => {
      const error = new Error('test');
      (error as any).$metadata = { httpStatusCode: 500 };
      expect(isAWSServiceError(error)).toBe(true);
    });

    it('should return false for plain errors', () => {
      expect(isAWSServiceError(new Error('test'))).toBe(false);
    });
  });

  describe('getErrorCode', () => {
    it('should extract code from AWS SDK error', () => {
      const error = new Error('test');
      (error as any).code = 'ThrottlingException';
      expect(getErrorCode(error)).toBe('ThrottlingException');
    });

    it('should fall back to name property', () => {
      const error = new TypeError('test');
      expect(getErrorCode(error)).toBe('TypeError');
    });

    it('should return empty string for non-object', () => {
      expect(getErrorCode('string')).toBe('');
      expect(getErrorCode(null)).toBe('');
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error', () => {
      expect(getErrorMessage(new Error('test message'))).toBe('test message');
    });

    it('should return string directly', () => {
      expect(getErrorMessage('string error')).toBe('string error');
    });

    it('should extract message from plain object', () => {
      expect(getErrorMessage({ message: 'object message' })).toBe('object message');
    });

    it('should return default message for unknown types', () => {
      expect(getErrorMessage(123)).toBe('Unknown error occurred');
      expect(getErrorMessage(null)).toBe('Unknown error occurred');
    });
  });

  describe('isRetryableError', () => {
    it('should return true for throttling errors', () => {
      const error = new Error('test');
      (error as any).code = 'ThrottlingException';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for service unavailable errors', () => {
      const error = new Error('test');
      (error as any).code = 'ServiceUnavailableException';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      const error = new Error('test');
      (error as any).code = 'ValidationException';
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for errors without code', () => {
      expect(isRetryableError(new Error('test'))).toBe(false);
    });
  });

  describe('isCriticalError', () => {
    it('should return true for access denied errors', () => {
      const error = new Error('test');
      (error as any).code = 'AccessDeniedException';
      expect(isCriticalError(error)).toBe(true);
    });

    it('should return true for unauthorized errors', () => {
      const error = new Error('test');
      (error as any).code = 'UnauthorizedException';
      expect(isCriticalError(error)).toBe(true);
    });

    it('should return false for non-critical errors', () => {
      const error = new Error('test');
      (error as any).code = 'ThrottlingException';
      expect(isCriticalError(error)).toBe(false);
    });
  });

  describe('toError', () => {
    it('should return Error instances unchanged', () => {
      const error = new Error('test');
      expect(toError(error)).toBe(error);
    });

    it('should convert string to Error', () => {
      const result = toError('string error');
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('string error');
    });

    it('should convert unknown types to Error', () => {
      const result = toError({ message: 'object error' });
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('object error');
    });
  });

  describe('error code constants', () => {
    it('should have retryable error codes', () => {
      expect(RETRYABLE_ERROR_CODES).toContain('ThrottlingException');
      expect(RETRYABLE_ERROR_CODES).toContain('ServiceUnavailableException');
      expect(RETRYABLE_ERROR_CODES).toContain('ECONNRESET');
    });

    it('should have critical error codes', () => {
      expect(CRITICAL_ERROR_CODES).toContain('AccessDeniedException');
      expect(CRITICAL_ERROR_CODES).toContain('UnauthorizedException');
    });
  });
});
