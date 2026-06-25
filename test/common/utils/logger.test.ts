// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
import { Logger, logger } from '../../../lib/lambda/common/utils/logger.js';

describe('Logger (Powertools)', () => {
  describe('module exports', () => {
    it('should export Logger class from Powertools', () => {
      expect(Logger).toBeDefined();
      expect(typeof Logger).toBe('function');
    });

    it('should export pre-configured logger instance', () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should allow creating new Logger instances', () => {
      const customLogger = new Logger({ serviceName: 'test-service' });
      expect(customLogger).toBeDefined();
      expect(typeof customLogger.info).toBe('function');
    });
  });

  describe('logger functionality', () => {
    it('should not throw when logging info messages', () => {
      expect(() => {
        logger.info('test message', { key: 'value' });
      }).not.toThrow();
    });

    it('should not throw when logging warn messages', () => {
      expect(() => {
        logger.warn('warning message', { context: 'test' });
      }).not.toThrow();
    });

    it('should not throw when logging error messages', () => {
      const testError = new Error('test error');
      expect(() => {
        logger.error('error occurred', { error: testError, requestId: '123' });
      }).not.toThrow();
    });

    it('should not throw when logging debug messages', () => {
      expect(() => {
        logger.debug('debug message', { detail: 'test' });
      }).not.toThrow();
    });

    it('should support addContext method for Lambda context injection', () => {
      expect(typeof logger.addContext).toBe('function');
    });

    it('should support appendKeys method for persistent attributes', () => {
      expect(typeof logger.appendKeys).toBe('function');
    });
  });
});
