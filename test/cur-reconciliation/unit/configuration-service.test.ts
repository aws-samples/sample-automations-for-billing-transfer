// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Unit tests for ConfigurationService
 */

import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { sdkStreamMixin } from '@smithy/util-stream';
import { ConfigurationService } from '../../../lib/lambda/cur-reconciliation/services/configuration-service.js';
import { ReportConfigurationTemplate, ViewReportConfig, ConfigurationValidationError } from '../../../lib/lambda/common/models/cur-configuration.js';

const s3Mock = mockClient(S3Client);

describe('ConfigurationService', () => {
  let service: ConfigurationService;

  beforeEach(() => {
    s3Mock.reset();
    service = new ConfigurationService();
  });

  const validMyViewConfig: ViewReportConfig = {
    enabled: true,
    timeUnit: 'DAILY',
    format: 'Parquet',
    compression: 'Parquet',
    additionalSchemaElements: ['RESOURCES'],
    s3Bucket: 'test-bucket',
    s3Prefix: 'my-view-reports',
    s3Region: 'us-east-1',
    refreshClosedReports: true,
    reportVersioning: 'OVERWRITE_REPORT',
  };

  const validShowbackViewConfig: ViewReportConfig = {
    enabled: true,
    timeUnit: 'DAILY',
    format: 'Parquet',
    compression: 'Parquet',
    additionalSchemaElements: [],
    s3Bucket: 'test-bucket',
    s3Prefix: 'showback-view-reports',
    s3Region: 'us-east-1',
    refreshClosedReports: true,
    reportVersioning: 'OVERWRITE_REPORT',
  };

  const validConfigTemplate: ReportConfigurationTemplate = {
    version: '1.0',
    myViewReportConfig: validMyViewConfig,
    showbackViewReportConfig: validShowbackViewConfig,
  };

  // Helper to create S3 stream response
  const createS3StreamResponse = (content: string) => {
    const stream = new Readable();
    stream.push(content);
    stream.push(null);
    return { Body: sdkStreamMixin(stream) };
  };

  describe('loadConfiguration', () => {
    it('should load configuration from S3', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);
      s3Mock.on(GetObjectCommand).resolves(createS3StreamResponse(JSON.stringify(validConfigTemplate)));

      const result = await s3Service.loadConfiguration('s3://test-bucket/config.json');

      expect(result.version).toBe('1.0');
      expect(result.myViewReportConfig).toBeDefined();
    });

    it('should throw error for invalid S3 URI format', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);

      await expect(s3Service.loadConfiguration('s3://invalid')).rejects.toThrow(ConfigurationValidationError);
    });

    it('should throw error when S3 object has no body', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);
      s3Mock.on(GetObjectCommand).resolves({ Body: undefined });

      await expect(s3Service.loadConfiguration('s3://bucket/key')).rejects.toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid JSON', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);
      s3Mock.on(GetObjectCommand).resolves(createS3StreamResponse('not valid json'));

      await expect(s3Service.loadConfiguration('s3://bucket/key')).rejects.toThrow(ConfigurationValidationError);
    });

    it('should throw error when S3 request fails', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);
      s3Mock.on(GetObjectCommand).rejects(new Error('Access Denied'));

      await expect(s3Service.loadConfiguration('s3://bucket/key')).rejects.toThrow(ConfigurationValidationError);
    });
  });

  describe('validateConfiguration', () => {
    it('should accept valid configuration with both view configs', () => {
      const result = service.validateConfiguration(validConfigTemplate);
      expect(result).toBeDefined();
      expect(result.version).toBe('1.0');
    });

    it('should accept configuration with only myViewReportConfig', () => {
      const validConfig: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: validMyViewConfig,
      };

      const result = service.validateConfiguration(validConfig);
      expect(result).toBeDefined();
      expect(result.myViewReportConfig).toBeDefined();
    });

    it('should accept configuration with only showbackViewReportConfig', () => {
      const validConfig: ReportConfigurationTemplate = {
        version: '1.0',
        showbackViewReportConfig: validShowbackViewConfig,
      };

      const result = service.validateConfiguration(validConfig);
      expect(result).toBeDefined();
    });

    it('should accept configuration with disabled views', () => {
      const validConfig: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          enabled: false,
        },
      };

      const result = service.validateConfiguration(validConfig);
      expect(result).toBeDefined();
    });

    it('should throw error for null config', () => {
      expect(() => service.validateConfiguration(null)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-object config', () => {
      expect(() => service.validateConfiguration('string')).toThrow(ConfigurationValidationError);
    });

    it('should throw error for missing version', () => {
      expect(() => service.validateConfiguration({ myViewReportConfig: validMyViewConfig })).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-string version', () => {
      expect(() => service.validateConfiguration({ version: 123, myViewReportConfig: validMyViewConfig })).toThrow(ConfigurationValidationError);
    });

    it('should throw error when no view configs present', () => {
      expect(() => service.validateConfiguration({ version: '1.0' })).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid timeUnit', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, timeUnit: 'INVALID' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid format', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, format: 'INVALID' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid compression', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, compression: 'INVALID' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid additionalSchemaElements', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, additionalSchemaElements: ['INVALID_ELEMENT'] },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-array additionalSchemaElements', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, additionalSchemaElements: 'RESOURCES' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for missing s3Bucket', () => {
      const { s3Bucket, ...configWithoutBucket } = validMyViewConfig;
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: configWithoutBucket,
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for missing s3Prefix', () => {
      const { s3Prefix, ...configWithoutPrefix } = validMyViewConfig;
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: configWithoutPrefix,
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for missing s3Region', () => {
      const { s3Region, ...configWithoutRegion } = validMyViewConfig;
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: configWithoutRegion,
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-boolean refreshClosedReports', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, refreshClosedReports: 'true' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid reportVersioning', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, reportVersioning: 'INVALID' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-boolean enabled', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, enabled: 'true' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-object view config', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: 'invalid',
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });
  });

  describe('validateBackfillConfig', () => {
    it('should accept valid backfill configuration', () => {
      const configWithBackfill = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: {
            enabled: true,
            billingPeriodRange: { start: '2024-01', end: '2024-12' },
            severityCode: 'normal',
          },
        },
      };
      const result = service.validateConfiguration(configWithBackfill);
      expect(result).toBeDefined();
    });

    it('should accept disabled backfill without additional fields', () => {
      const configWithBackfill = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: { enabled: false },
        },
      };
      const result = service.validateConfiguration(configWithBackfill);
      expect(result).toBeDefined();
    });

    it('should throw error for non-object backfill', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, backfill: 'invalid' },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for non-boolean backfill.enabled', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: { ...validMyViewConfig, backfill: { enabled: 'true' } },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for missing billingPeriodRange when backfill enabled', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: { enabled: true, severityCode: 'normal' },
        },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid billingPeriodRange.start format', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: {
            enabled: true,
            billingPeriodRange: { start: '2024/01', end: '2024-12' },
            severityCode: 'normal',
          },
        },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid billingPeriodRange.end format', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: {
            enabled: true,
            billingPeriodRange: { start: '2024-01', end: 'invalid' },
            severityCode: 'normal',
          },
        },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for missing severityCode when backfill enabled', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: {
            enabled: true,
            billingPeriodRange: { start: '2024-01', end: '2024-12' },
          },
        },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });

    it('should throw error for invalid severityCode', () => {
      const invalidConfig = {
        version: '1.0',
        myViewReportConfig: {
          ...validMyViewConfig,
          backfill: {
            enabled: true,
            billingPeriodRange: { start: '2024-01', end: '2024-12' },
            severityCode: 'invalid',
          },
        },
      };
      expect(() => service.validateConfiguration(invalidConfig)).toThrow(ConfigurationValidationError);
    });
  });

  describe('helper methods', () => {
    it('should correctly identify My View config presence', () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: validMyViewConfig,
      };

      expect(service.hasMyViewConfig(config)).toBe(true);
      expect(service.hasShowbackViewConfig(config)).toBe(false);
    });

    it('should correctly identify Showback View config presence', () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        showbackViewReportConfig: validShowbackViewConfig,
      };

      expect(service.hasMyViewConfig(config)).toBe(false);
      expect(service.hasShowbackViewConfig(config)).toBe(true);
    });

    it('should correctly identify enabled views', () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: validMyViewConfig,
        showbackViewReportConfig: {
          ...validShowbackViewConfig,
          enabled: false,
        },
      };

      expect(service.isMyViewEnabled(config)).toBe(true);
      expect(service.isShowbackViewEnabled(config)).toBe(false);
    });

    it('should return false for isMyViewEnabled when config missing', () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        showbackViewReportConfig: validShowbackViewConfig,
      };

      expect(service.isMyViewEnabled(config)).toBe(false);
    });

    it('should return false for isShowbackViewEnabled when config missing', () => {
      const config: ReportConfigurationTemplate = {
        version: '1.0',
        myViewReportConfig: validMyViewConfig,
      };

      expect(service.isShowbackViewEnabled(config)).toBe(false);
    });
  });
});
