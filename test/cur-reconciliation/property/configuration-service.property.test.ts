// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Property-based tests for ConfigurationService
 *
 * Tests correctness properties for configuration validation:
 * - Property 7: Configuration template loads successfully
 * - Property 8: Configuration validation detects missing view configurations
 * - Property 9: My View configuration validation
 * - Property 10: Showback View configuration validation
 * - Property 42: Configuration is valid JSON
 * - Property 43: Configuration validates against schema
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 10.1, 10.2, 10.3
 */

import fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { sdkStreamMixin } from '@smithy/util-stream';
import { ConfigurationService } from '../../../lib/lambda/cur-reconciliation/services/configuration-service.js';
import {
  ReportConfigurationTemplate,
  ViewReportConfig,
  ConfigurationValidationError,
} from '../../../lib/lambda/common/models/cur-configuration.js';

const s3Mock = mockClient(S3Client);

// --- Arbitraries ---

const timeUnitArb = fc.constantFrom('HOURLY' as const, 'DAILY' as const, 'MONTHLY' as const);
const formatArb = fc.constantFrom('textORcsv' as const, 'Parquet' as const);
const compressionArb = fc.constantFrom('ZIP' as const, 'GZIP' as const, 'Parquet' as const);
const reportVersioningArb = fc.constantFrom('CREATE_NEW_REPORT' as const, 'OVERWRITE_REPORT' as const);
const schemaElementArb = fc.constantFrom(
  'RESOURCES' as const,
  'SPLIT_COST_ALLOCATION_DATA' as const,
  'MANUAL_DISCOUNT_COMPATIBILITY' as const,
);
const severityCodeArb = fc.constantFrom('low' as const, 'normal' as const, 'high' as const, 'urgent' as const, 'critical' as const);

/** Generates a YYYY-MM formatted date string */
const yearMonthArb = fc.tuple(
  fc.integer({ min: 2020, max: 2030 }),
  fc.integer({ min: 1, max: 12 }),
).map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`);

/** Generates a non-empty alphanumeric string suitable for S3 bucket/prefix names */
const s3NameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

/** Generates a valid backfill configuration */
const backfillConfigArb = fc.oneof(
  // Disabled backfill (minimal)
  fc.record({ enabled: fc.constant(false as const) }),
  // Enabled backfill (full)
  fc.record({
    enabled: fc.constant(true as const),
    billingPeriodRange: fc.record({
      start: yearMonthArb,
      end: yearMonthArb,
    }),
    severityCode: severityCodeArb,
  }),
);

/** Generates a valid ViewReportConfig */
const viewReportConfigArb: fc.Arbitrary<ViewReportConfig> = fc.record({
  enabled: fc.boolean(),
  timeUnit: timeUnitArb,
  format: formatArb,
  compression: compressionArb,
  additionalSchemaElements: fc.uniqueArray(schemaElementArb, { maxLength: 3 }),
  s3Bucket: s3NameArb,
  s3Prefix: s3NameArb,
  s3Region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
  refreshClosedReports: fc.boolean(),
  reportVersioning: reportVersioningArb,
  tags: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ maxLength: 20 }), { maxKeys: 3 }), { nil: undefined }),
  backfill: fc.option(backfillConfigArb, { nil: undefined }),
});

/** Generates a valid ReportConfigurationTemplate with at least one view config */
const validConfigTemplateArb: fc.Arbitrary<ReportConfigurationTemplate> = fc.oneof(
  // Both views
  fc.record({
    version: fc.string({ minLength: 1, maxLength: 10 }),
    myViewReportConfig: viewReportConfigArb,
    showbackViewReportConfig: viewReportConfigArb,
  }),
  // My View only
  fc.record({
    version: fc.string({ minLength: 1, maxLength: 10 }),
    myViewReportConfig: viewReportConfigArb,
  }).map(c => ({ ...c, showbackViewReportConfig: undefined })),
  // Showback View only
  fc.record({
    version: fc.string({ minLength: 1, maxLength: 10 }),
    showbackViewReportConfig: viewReportConfigArb,
  }).map(c => ({ ...c, myViewReportConfig: undefined })),
);

/** Helper to create S3 stream response */
const createS3StreamResponse = (content: string) => {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return { Body: sdkStreamMixin(stream) };
};

describe('ConfigurationService - Property Tests', () => {
  let service: ConfigurationService;

  beforeEach(() => {
    s3Mock.reset();
    service = new ConfigurationService();
  });

  // -----------------------------------------------------------------------
  // Property 7: Configuration template loads successfully
  // For any valid configuration template, loadConfiguration should succeed
  // Validates: Requirements 2.1, 10.4
  // -----------------------------------------------------------------------
  describe('Property 7: Configuration template loads successfully', () => {
    it('any valid config template serialized as JSON should load from S3 without error', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);

      await fc.assert(
        fc.asyncProperty(validConfigTemplateArb, async (config) => {
          s3Mock.reset();
          const json = JSON.stringify(config);
          s3Mock.on(GetObjectCommand).resolves(createS3StreamResponse(json));

          const result = await s3Service.loadConfiguration('s3://test-bucket/config.json');

          expect(result.version).toBe(config.version);
          if (config.myViewReportConfig) {
            expect(result.myViewReportConfig).toBeDefined();
            expect(result.myViewReportConfig!.timeUnit).toBe(config.myViewReportConfig.timeUnit);
            expect(result.myViewReportConfig!.format).toBe(config.myViewReportConfig.format);
          }
          if (config.showbackViewReportConfig) {
            expect(result.showbackViewReportConfig).toBeDefined();
            expect(result.showbackViewReportConfig!.timeUnit).toBe(config.showbackViewReportConfig.timeUnit);
            expect(result.showbackViewReportConfig!.format).toBe(config.showbackViewReportConfig.format);
          }
        }),
        { numRuns: 50 },
      );
    });

    it('validateConfiguration should return the config unchanged for any valid template', () => {
      fc.assert(
        fc.property(validConfigTemplateArb, (config) => {
          const result = service.validateConfiguration(config);
          expect(result.version).toBe(config.version);
          expect(result.myViewReportConfig).toEqual(config.myViewReportConfig);
          expect(result.showbackViewReportConfig).toEqual(config.showbackViewReportConfig);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Property 8: Configuration validation detects missing view configurations
  // For any config with neither myViewReportConfig nor showbackViewReportConfig,
  // validation must fail.
  // Validates: Requirements 2.2, 2.5, 10.3
  // -----------------------------------------------------------------------
  describe('Property 8: Configuration validation detects missing view configurations', () => {
    it('any config without both view configs should fail validation', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue(), { maxKeys: 5 }),
          (version, extraFields) => {
            // Build a config that explicitly has no view configs
            const config: Record<string, unknown> = {
              ...extraFields,
              version,
            };
            delete config.myViewReportConfig;
            delete config.showbackViewReportConfig;

            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('null, undefined, and non-object values should fail validation', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant([]),
          ),
          (input) => {
            expect(() => service.validateConfiguration(input)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Property 9: My View configuration validation
  // For any config with myViewReportConfig, all required fields must be present
  // and valid. Missing or invalid fields must cause validation failure.
  // Validates: Requirements 2.3
  // -----------------------------------------------------------------------
  describe('Property 9: My View configuration validation', () => {
    const requiredStringFields = ['s3Bucket', 's3Prefix', 's3Region'] as const;
    const requiredBooleanFields = ['enabled', 'refreshClosedReports'] as const;

    it('removing any required string field from myViewReportConfig should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.constantFrom(...requiredStringFields),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, fieldToRemove, version) => {
            const partial = { ...viewConfig } as Record<string, unknown>;
            delete partial[fieldToRemove];

            const config = { version, myViewReportConfig: partial };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting any required boolean field to a non-boolean should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.constantFrom(...requiredBooleanFields),
          fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, fieldToCorrupt, badValue, version) => {
            const corrupted = { ...viewConfig, [fieldToCorrupt]: badValue } as Record<string, unknown>;
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting timeUnit to an invalid value should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => !['HOURLY', 'DAILY', 'MONTHLY'].includes(s)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badTimeUnit, version) => {
            const corrupted = { ...viewConfig, timeUnit: badTimeUnit };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting format to an invalid value should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => !['textORcsv', 'Parquet'].includes(s)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badFormat, version) => {
            const corrupted = { ...viewConfig, format: badFormat };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting compression to an invalid value should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => !['ZIP', 'GZIP', 'Parquet'].includes(s)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badCompression, version) => {
            const corrupted = { ...viewConfig, compression: badCompression };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting reportVersioning to an invalid value should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !['CREATE_NEW_REPORT', 'OVERWRITE_REPORT'].includes(s)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badVersioning, version) => {
            const corrupted = { ...viewConfig, reportVersioning: badVersioning };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('including invalid schema elements should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 20 }).filter(
            s => !['RESOURCES', 'SPLIT_COST_ALLOCATION_DATA', 'MANUAL_DISCOUNT_COMPATIBILITY'].includes(s),
          ),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badElement, version) => {
            const corrupted = { ...viewConfig, additionalSchemaElements: [badElement] };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('valid myViewReportConfig with any valid field values should pass validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, version) => {
            const config = { version, myViewReportConfig: viewConfig };
            const result = service.validateConfiguration(config);
            expect(result.myViewReportConfig).toBeDefined();
            expect(result.myViewReportConfig!.enabled).toBe(viewConfig.enabled);
            expect(result.myViewReportConfig!.timeUnit).toBe(viewConfig.timeUnit);
            expect(result.myViewReportConfig!.format).toBe(viewConfig.format);
            expect(result.myViewReportConfig!.compression).toBe(viewConfig.compression);
            expect(result.myViewReportConfig!.s3Bucket).toBe(viewConfig.s3Bucket);
            expect(result.myViewReportConfig!.s3Prefix).toBe(viewConfig.s3Prefix);
            expect(result.myViewReportConfig!.s3Region).toBe(viewConfig.s3Region);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Property 10: Showback View configuration validation
  // For any config with showbackViewReportConfig, all required fields must
  // be present and valid. Mirrors Property 9 for the showback view.
  // Validates: Requirements 2.4
  // -----------------------------------------------------------------------
  describe('Property 10: Showback View configuration validation', () => {
    const requiredStringFields = ['s3Bucket', 's3Prefix', 's3Region'] as const;
    const requiredBooleanFields = ['enabled', 'refreshClosedReports'] as const;

    it('removing any required string field from showbackViewReportConfig should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.constantFrom(...requiredStringFields),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, fieldToRemove, version) => {
            const partial = { ...viewConfig } as Record<string, unknown>;
            delete partial[fieldToRemove];

            const config = { version, showbackViewReportConfig: partial };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting any required boolean field to a non-boolean should fail validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.constantFrom(...requiredBooleanFields),
          fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, fieldToCorrupt, badValue, version) => {
            const corrupted = { ...viewConfig, [fieldToCorrupt]: badValue } as Record<string, unknown>;
            const config = { version, showbackViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('setting any enum field to an invalid value should fail validation', () => {
      const enumFields = [
        { field: 'timeUnit', valid: ['HOURLY', 'DAILY', 'MONTHLY'] },
        { field: 'format', valid: ['textORcsv', 'Parquet'] },
        { field: 'compression', valid: ['ZIP', 'GZIP', 'Parquet'] },
        { field: 'reportVersioning', valid: ['CREATE_NEW_REPORT', 'OVERWRITE_REPORT'] },
      ] as const;

      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.constantFrom(...enumFields),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, enumDef, randomStr, version) => {
            fc.pre(!enumDef.valid.includes(randomStr as never));
            const corrupted = { ...viewConfig, [enumDef.field]: randomStr };
            const config = { version, showbackViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('valid showbackViewReportConfig with any valid field values should pass validation', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, version) => {
            const config = { version, showbackViewReportConfig: viewConfig };
            const result = service.validateConfiguration(config);
            expect(result.showbackViewReportConfig).toBeDefined();
            expect(result.showbackViewReportConfig!.enabled).toBe(viewConfig.enabled);
            expect(result.showbackViewReportConfig!.timeUnit).toBe(viewConfig.timeUnit);
            expect(result.showbackViewReportConfig!.format).toBe(viewConfig.format);
            expect(result.showbackViewReportConfig!.compression).toBe(viewConfig.compression);
            expect(result.showbackViewReportConfig!.s3Bucket).toBe(viewConfig.s3Bucket);
            expect(result.showbackViewReportConfig!.s3Prefix).toBe(viewConfig.s3Prefix);
            expect(result.showbackViewReportConfig!.s3Region).toBe(viewConfig.s3Region);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Property 42: Configuration is valid JSON
  // For any valid config template, serializing to JSON and parsing back
  // should produce an equivalent object that passes validation.
  // Validates: Requirements 10.1
  // -----------------------------------------------------------------------
  describe('Property 42: Configuration is valid JSON', () => {
    it('any valid config should survive JSON round-trip and still pass validation', () => {
      fc.assert(
        fc.property(validConfigTemplateArb, (config) => {
          const json = JSON.stringify(config);
          const parsed = JSON.parse(json);
          const result = service.validateConfiguration(parsed);

          expect(result.version).toBe(config.version);
          if (config.myViewReportConfig) {
            expect(result.myViewReportConfig).toBeDefined();
          }
          if (config.showbackViewReportConfig) {
            expect(result.showbackViewReportConfig).toBeDefined();
          }
        }),
        { numRuns: 100 },
      );
    });

    it('non-JSON strings should fail to load', async () => {
      const s3Service = new ConfigurationService(s3Mock as unknown as S3Client);

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
            try { JSON.parse(s); return false; } catch { return true; }
          }),
          async (invalidJson) => {
            s3Mock.reset();
            s3Mock.on(GetObjectCommand).resolves(createS3StreamResponse(invalidJson));

            await expect(
              s3Service.loadConfiguration('s3://test-bucket/config.json'),
            ).rejects.toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Property 43: Configuration validates against schema
  // For any valid config, the helper methods should be consistent with
  // the presence and enabled state of view configurations.
  // Validates: Requirements 10.2, 10.3
  // -----------------------------------------------------------------------
  describe('Property 43: Configuration validates against schema', () => {
    it('hasMyViewConfig should be true iff myViewReportConfig is present', () => {
      fc.assert(
        fc.property(validConfigTemplateArb, (config) => {
          const result = service.validateConfiguration(config);
          expect(service.hasMyViewConfig(result)).toBe(config.myViewReportConfig !== undefined);
        }),
        { numRuns: 100 },
      );
    });

    it('hasShowbackViewConfig should be true iff showbackViewReportConfig is present', () => {
      fc.assert(
        fc.property(validConfigTemplateArb, (config) => {
          const result = service.validateConfiguration(config);
          expect(service.hasShowbackViewConfig(result)).toBe(config.showbackViewReportConfig !== undefined);
        }),
        { numRuns: 100 },
      );
    });

    it('isMyViewEnabled should be true iff myViewReportConfig is present and enabled', () => {
      fc.assert(
        fc.property(validConfigTemplateArb, (config) => {
          const result = service.validateConfiguration(config);
          const expected = config.myViewReportConfig !== undefined && config.myViewReportConfig.enabled === true;
          expect(service.isMyViewEnabled(result)).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });

    it('isShowbackViewEnabled should be true iff showbackViewReportConfig is present and enabled', () => {
      fc.assert(
        fc.property(validConfigTemplateArb, (config) => {
          const result = service.validateConfiguration(config);
          const expected = config.showbackViewReportConfig !== undefined && config.showbackViewReportConfig.enabled === true;
          expect(service.isShowbackViewEnabled(result)).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });

    it('backfill config with enabled=true but invalid date format should fail', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => !/^\d{4}-\d{2}$/.test(s)),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badDate, version) => {
            const corrupted = {
              ...viewConfig,
              backfill: {
                enabled: true,
                billingPeriodRange: { start: badDate, end: '2024-12' },
                severityCode: 'normal',
              },
            };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('backfill config with enabled=true but invalid severity should fail', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 10 }).filter(
            s => !['low', 'normal', 'high', 'urgent', 'critical'].includes(s),
          ),
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, badSeverity, version) => {
            const corrupted = {
              ...viewConfig,
              backfill: {
                enabled: true,
                billingPeriodRange: { start: '2024-01', end: '2024-12' },
                severityCode: badSeverity,
              },
            };
            const config = { version, myViewReportConfig: corrupted };
            expect(() => service.validateConfiguration(config)).toThrow(ConfigurationValidationError);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('backfill config with enabled=false should pass without additional fields', () => {
      fc.assert(
        fc.property(
          viewReportConfigArb,
          fc.string({ minLength: 1, maxLength: 5 }),
          (viewConfig, version) => {
            const withDisabledBackfill = {
              ...viewConfig,
              backfill: { enabled: false },
            };
            const config = { version, myViewReportConfig: withDisabledBackfill };
            const result = service.validateConfiguration(config);
            expect(result).toBeDefined();
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
