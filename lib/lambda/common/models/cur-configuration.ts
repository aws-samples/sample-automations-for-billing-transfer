// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CUR Configuration Models
 *
 * Configuration models for CUR (Cost and Usage Report) automation.
 * Defines the structure of export configuration templates that control
 * how data exports are created for billing transfer relationships.
 *
 * @module cur-configuration
 */

/**
 * View-specific report configuration
 *
 * Defines all settings for creating a CUR report for a specific billing view type
 * (either BILLING_TRANSFER or BILLING_TRANSFER_SHOWBACK)
 */
export interface ViewReportConfig {
  /** Master enable/disable flag for this view type */
  enabled: boolean;

  /** Time granularity for report line items */
  timeUnit: 'HOURLY' | 'DAILY' | 'MONTHLY';

  /** File format for the report */
  format: 'textORcsv' | 'Parquet';

  /** Compression format (must match format for Parquet) */
  compression: 'ZIP' | 'GZIP' | 'Parquet';

  /**
   * Additional schema elements to include in the report
   * MUST NOT include SPLIT_COST_ALLOCATION_DATA for BILLING_TRANSFER_SHOWBACK views
   */
  additionalSchemaElements: Array<
    'RESOURCES' | 'SPLIT_COST_ALLOCATION_DATA' | 'MANUAL_DISCOUNT_COMPATIBILITY'
  >;

  /** S3 bucket name for report delivery */
  s3Bucket: string;

  /** S3 prefix (path) for report files */
  s3Prefix: string;

  /** AWS region where S3 bucket is located */
  s3Region: string;

  /** Whether to refresh closed reports */
  refreshClosedReports: boolean;

  /** Report versioning strategy */
  reportVersioning: 'CREATE_NEW_REPORT' | 'OVERWRITE_REPORT';

  /** Optional resource tags to apply to created exports */
  tags?: Record<string, string>;

  /** Optional backfill configuration for historical data */
  backfill?: {
    /** Whether to create support cases for historical data backfill */
    enabled: boolean;

    /** Billing period range for backfill (only used if enabled is true) */
    billingPeriodRange?: {
      /** Start billing period in YYYY-MM format */
      start: string;
      /** End billing period in YYYY-MM format */
      end: string;
    };

    /** Support case severity code (only used if enabled is true) */
    severityCode?: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
  };
}

/**
 * Report configuration template
 *
 * Top-level configuration structure that defines settings for both
 * My View (BILLING_TRANSFER) and Showback View (BILLING_TRANSFER_SHOWBACK) reports.
 *
 * At least one of myViewReportConfig or showbackViewReportConfig must be present.
 */
export interface ReportConfigurationTemplate {
  /** Configuration version for future compatibility */
  version: string;

  /**
   * Optional configuration for My View (BILLING_TRANSFER) reports
   *
   * When present and enabled, the system will create CUR reports for BILLING_TRANSFER views
   * using these settings.
   */
  myViewReportConfig?: ViewReportConfig;

  /**
   * Optional configuration for Showback View (BILLING_TRANSFER_SHOWBACK) reports
   *
   * When present and enabled, the system will create CUR reports for BILLING_TRANSFER_SHOWBACK views
   * using these settings.
   */
  showbackViewReportConfig?: ViewReportConfig;
}

/**
 * Configuration validation error
 */
export class ConfigurationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationValidationError';
  }
}
