// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Configuration Service
 * 
 * Loads and validates report configuration templates for CUR automation.
 * Supports loading from S3 or local file system.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { 
  ReportConfigurationTemplate, 
  ViewReportConfig,
  ConfigurationValidationError 
} from '../../common/models/cur-configuration.js';

export class ConfigurationService {
  private s3Client: S3Client;

  constructor(s3Client?: S3Client) {
    this.s3Client = s3Client || new S3Client({});
  }

  /**
   * Load configuration from S3 or local source
   * 
   * @param source - S3 URI (s3://bucket/key) or local file path
   * @returns Validated configuration template
   * @throws ConfigurationValidationError if configuration is invalid
   */
  async loadConfiguration(source: string): Promise<ReportConfigurationTemplate> {
    let configContent: string;

    try {
      if (source.startsWith('s3://')) {
        configContent = await this.loadFromS3(source);
      } else {
        configContent = await this.loadFromLocal(source);
      }
    } catch (error) {
      throw new ConfigurationValidationError(
        `Failed to load configuration from ${source}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Parse JSON
    let config: unknown;
    try {
      config = JSON.parse(configContent);
    } catch (error) {
      throw new ConfigurationValidationError(
        `Configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validate and return
    const validatedConfig = this.validateConfiguration(config);
    return validatedConfig;
  }

  /**
   * Load configuration from S3
   * 
   * @param s3Uri - S3 URI in format s3://bucket/key
   * @returns Configuration content as string
   */
  private async loadFromS3(s3Uri: string): Promise<string> {
    // Parse S3 URI
    const match = s3Uri.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid S3 URI format: ${s3Uri}. Expected format: s3://bucket/key`);
    }

    const [, bucket, key] = match;

    // Get object from S3
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);
    
    if (!response.Body) {
      throw new Error('S3 object has no body');
    }

    // Convert stream to string
    const bodyString = await response.Body.transformToString();
    return bodyString;
  }

  /**
   * Load configuration from local file system
   * 
   * @param filePath - Local file path
   * @returns Configuration content as string
   */
  private async loadFromLocal(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    return await fs.readFile(filePath, 'utf-8');
  }

  /**
   * Validate configuration template structure and content
   * 
   * @param config - Parsed configuration object
   * @returns Validated configuration template
   * @throws ConfigurationValidationError if validation fails
   */
  validateConfiguration(config: unknown): ReportConfigurationTemplate {
    // Check if config is an object
    if (!config || typeof config !== 'object') {
      throw new ConfigurationValidationError(
        'Configuration must be a JSON object'
      );
    }

    const cfg = config as Record<string, unknown>;

    // Validate version field
    if (!cfg.version || typeof cfg.version !== 'string') {
      throw new ConfigurationValidationError(
        'Configuration must have a "version" field of type string'
      );
    }

    // Check that at least one view configuration is present
    const hasMyView = cfg.myViewReportConfig !== undefined;
    const hasShowbackView = cfg.showbackViewReportConfig !== undefined;

    if (!hasMyView && !hasShowbackView) {
      throw new ConfigurationValidationError(
        'Configuration must have at least one of "myViewReportConfig" or "showbackViewReportConfig"'
      );
    }

    // Validate My View configuration if present
    if (hasMyView) {
      this.validateViewConfig(cfg.myViewReportConfig, 'myViewReportConfig');
    }

    // Validate Showback View configuration if present
    if (hasShowbackView) {
      this.validateViewConfig(cfg.showbackViewReportConfig, 'showbackViewReportConfig');
    }

    return cfg as unknown as ReportConfigurationTemplate;
  }

  /**
   * Validate a view-specific configuration
   * 
   * @param viewConfig - View configuration to validate
   * @param configName - Name of the configuration (for error messages)
   * @throws ConfigurationValidationError if validation fails
   */
  private validateViewConfig(viewConfig: unknown, configName: string): void {
    if (!viewConfig || typeof viewConfig !== 'object') {
      throw new ConfigurationValidationError(
        `${configName} must be an object`
      );
    }

    const cfg = viewConfig as Record<string, unknown>;

    // Validate enabled field
    if (typeof cfg.enabled !== 'boolean') {
      throw new ConfigurationValidationError(
        `${configName}.enabled is required and must be a boolean`
      );
    }

    // Validate timeUnit
    const validTimeUnits = ['HOURLY', 'DAILY', 'MONTHLY'];
    if (!cfg.timeUnit || !validTimeUnits.includes(cfg.timeUnit as string)) {
      throw new ConfigurationValidationError(
        `${configName}.timeUnit is required and must be one of: ${validTimeUnits.join(', ')}`
      );
    }

    // Validate format
    const validFormats = ['textORcsv', 'Parquet'];
    if (!cfg.format || !validFormats.includes(cfg.format as string)) {
      throw new ConfigurationValidationError(
        `${configName}.format is required and must be one of: ${validFormats.join(', ')}`
      );
    }

    // Validate compression
    const validCompression = ['ZIP', 'GZIP', 'Parquet'];
    if (!cfg.compression || !validCompression.includes(cfg.compression as string)) {
      throw new ConfigurationValidationError(
        `${configName}.compression is required and must be one of: ${validCompression.join(', ')}`
      );
    }

    // Validate additionalSchemaElements
    if (!Array.isArray(cfg.additionalSchemaElements)) {
      throw new ConfigurationValidationError(
        `${configName}.additionalSchemaElements is required and must be an array`
      );
    }

    const validSchemaElements = ['RESOURCES', 'SPLIT_COST_ALLOCATION_DATA', 'MANUAL_DISCOUNT_COMPATIBILITY'];
    for (const element of cfg.additionalSchemaElements as unknown[]) {
      if (!validSchemaElements.includes(element as string)) {
        throw new ConfigurationValidationError(
          `${configName}.additionalSchemaElements contains invalid element: ${element}. Must be one of: ${validSchemaElements.join(', ')}`
        );
      }
    }

    // Validate S3 fields
    if (!cfg.s3Bucket || typeof cfg.s3Bucket !== 'string') {
      throw new ConfigurationValidationError(
        `${configName}.s3Bucket is required and must be a string`
      );
    }

    if (!cfg.s3Prefix || typeof cfg.s3Prefix !== 'string') {
      throw new ConfigurationValidationError(
        `${configName}.s3Prefix is required and must be a string`
      );
    }

    if (!cfg.s3Region || typeof cfg.s3Region !== 'string') {
      throw new ConfigurationValidationError(
        `${configName}.s3Region is required and must be a string`
      );
    }

    // Validate refreshClosedReports
    if (typeof cfg.refreshClosedReports !== 'boolean') {
      throw new ConfigurationValidationError(
        `${configName}.refreshClosedReports is required and must be a boolean`
      );
    }

    // Validate reportVersioning
    const validVersioning = ['CREATE_NEW_REPORT', 'OVERWRITE_REPORT'];
    if (!cfg.reportVersioning || !validVersioning.includes(cfg.reportVersioning as string)) {
      throw new ConfigurationValidationError(
        `${configName}.reportVersioning is required and must be one of: ${validVersioning.join(', ')}`
      );
    }

    // Validate backfill configuration if present
    if (cfg.backfill !== undefined) {
      this.validateBackfillConfig(cfg.backfill, configName);
    }
  }

  /**
   * Validate backfill configuration
   * 
   * @param backfill - Backfill configuration to validate
   * @param configName - Name of the parent configuration (for error messages)
   * @throws ConfigurationValidationError if validation fails
   */
  private validateBackfillConfig(backfill: unknown, configName: string): void {
    if (!backfill || typeof backfill !== 'object') {
      throw new ConfigurationValidationError(
        `${configName}.backfill must be an object`
      );
    }

    const cfg = backfill as Record<string, unknown>;

    // Validate enabled field
    if (typeof cfg.enabled !== 'boolean') {
      throw new ConfigurationValidationError(
        `${configName}.backfill.enabled is required and must be a boolean`
      );
    }

    // If backfill is enabled, validate additional fields
    if (cfg.enabled === true) {
      // Validate billingPeriodRange
      if (!cfg.billingPeriodRange || typeof cfg.billingPeriodRange !== 'object') {
        throw new ConfigurationValidationError(
          `${configName}.backfill.billingPeriodRange is required when backfill is enabled`
        );
      }

      const periodRange = cfg.billingPeriodRange as Record<string, unknown>;

      if (!periodRange.start || typeof periodRange.start !== 'string') {
        throw new ConfigurationValidationError(
          `${configName}.backfill.billingPeriodRange.start is required and must be a string in YYYY-MM format`
        );
      }

      if (!periodRange.end || typeof periodRange.end !== 'string') {
        throw new ConfigurationValidationError(
          `${configName}.backfill.billingPeriodRange.end is required and must be a string in YYYY-MM format`
        );
      }

      // Validate date format (YYYY-MM)
      const datePattern = /^\d{4}-\d{2}$/;
      if (!datePattern.test(periodRange.start as string)) {
        throw new ConfigurationValidationError(
          `${configName}.backfill.billingPeriodRange.start must be in YYYY-MM format`
        );
      }

      if (!datePattern.test(periodRange.end as string)) {
        throw new ConfigurationValidationError(
          `${configName}.backfill.billingPeriodRange.end must be in YYYY-MM format`
        );
      }

      // Validate severityCode
      if (!cfg.severityCode || typeof cfg.severityCode !== 'string') {
        throw new ConfigurationValidationError(
          `${configName}.backfill.severityCode is required when backfill is enabled`
        );
      }

      const validSeverities = ['low', 'normal', 'high', 'urgent', 'critical'];
      if (!validSeverities.includes(cfg.severityCode as string)) {
        throw new ConfigurationValidationError(
          `${configName}.backfill.severityCode must be one of: ${validSeverities.join(', ')}`
        );
      }
    }
  }

  /**
   * Check if configuration has My View report configuration
   * 
   * @param config - Configuration template
   * @returns True if My View configuration is present
   */
  hasMyViewConfig(config: ReportConfigurationTemplate): boolean {
    return config.myViewReportConfig !== undefined;
  }

  /**
   * Check if configuration has Showback View report configuration
   * 
   * @param config - Configuration template
   * @returns True if Showback View configuration is present
   */
  hasShowbackViewConfig(config: ReportConfigurationTemplate): boolean {
    return config.showbackViewReportConfig !== undefined;
  }

  /**
   * Check if My View reports are enabled
   * 
   * @param config - Configuration template
   * @returns True if My View configuration is present and enabled
   */
  isMyViewEnabled(config: ReportConfigurationTemplate): boolean {
    return config.myViewReportConfig !== undefined && config.myViewReportConfig.enabled === true;
  }

  /**
   * Check if Showback View reports are enabled
   * 
   * @param config - Configuration template
   * @returns True if Showback View configuration is present and enabled
   */
  isShowbackViewEnabled(config: ReportConfigurationTemplate): boolean {
    return config.showbackViewReportConfig !== undefined && config.showbackViewReportConfig.enabled === true;
  }
}
