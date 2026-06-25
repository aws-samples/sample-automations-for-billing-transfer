// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CUR Report Service
 * 
 * Manages creation and validation of AWS Cost and Usage Reports using the Legacy CUR API.
 * This service handles:
 * - Checking if reports already exist (idempotency)
 * - Creating new CUR reports with billing view ARNs
 * - Applying view-specific configuration settings
 * - Validating report configurations
 * - Generating report names with account ID and view type
 * 
 * Note: Uses the Legacy CUR API (@aws-sdk/client-cost-and-usage-report-service)
 * with the BillingViewArn parameter. AWS Data Exports (CUR 2.0) also supports
 * billing transfer views; this sample uses the Legacy CUR API.
 */

import {
  CostAndUsageReportServiceClient,
  PutReportDefinitionCommand,
  DescribeReportDefinitionsCommand,
  ModifyReportDefinitionCommand,
  ReportDefinition,
  TagResourceCommand,
} from '@aws-sdk/client-cost-and-usage-report-service';
import { CURReportCreationRequest, CURReportCreationResult } from '../../common/models/cur-report.js';
import { logger } from '../../common/utils/logger.js';
import { retryWithBackoff } from '../../common/utils/retry.js';

export class CURReportService {
  private client: CostAndUsageReportServiceClient;

  constructor(region: string = 'us-east-1') {
    this.client = new CostAndUsageReportServiceClient({ region });
  }

  /**
   * Check if a CUR report with the given name already exists
   * 
   * @param reportName - Name of the report to check
   * @returns True if report exists, false otherwise
   */
  async checkReportExists(reportName: string): Promise<boolean> {
    try {
      const response = await retryWithBackoff(
        async () => await this.client.send(new DescribeReportDefinitionsCommand({})),
        undefined,
        { operation: 'checkReportExists', reportName }
      );
      
      if (!response.ReportDefinitions) {
        return false;
      }

      return response.ReportDefinitions.some(report => report.ReportName === reportName);
    } catch (error) {
      logger.error('Error checking report existence', { error: error as Error, reportName });
      throw error;
    }
  }

  /**
   * Create a new CUR report using Legacy CUR API
   * 
   * This method:
   * 1. Checks if report already exists (idempotency)
   * 2. Validates the report configuration
   * 3. Creates the report with BillingViewArn parameter
   * 4. Applies view-specific settings (timeUnit, format, compression, additionalSchemaElements, S3 settings)
   * 5. Excludes SPLIT_COST_ALLOCATION_DATA from additionalSchemaElements for showback views
   * 6. Applies resource tags (if supported)
   * 
   * @param request - Report creation request with all configuration
   * @returns Result indicating success, failure, or if report already existed
   */
  async createReport(request: CURReportCreationRequest): Promise<CURReportCreationResult> {
    try {
      // Check if report already exists (idempotency)
      const exists = await this.checkReportExists(request.reportName);
      
      if (exists) {
        logger.info('CUR report already exists, skipping creation', {
          reportName: request.reportName,
          billingViewArn: request.billingViewArn,
        });

        return {
          reportName: request.reportName,
          created: false,
          alreadyExisted: true,
        };
      }

      // Determine if this is a showback view based on the billing view ARN
      const isShowbackView = request.billingViewArn.includes('billing-transfer-showback');

      // Build additional schema elements
      let additionalSchemaElements = [...request.configuration.additionalSchemaElements];

      // CRITICAL: Exclude SPLIT_COST_ALLOCATION_DATA for showback views
      // For showback views, this MUST NOT be included as required by AWS
      if (isShowbackView) {
        additionalSchemaElements = additionalSchemaElements.filter(
          element => element !== 'SPLIT_COST_ALLOCATION_DATA'
        );
      }

      // Build report definition
      const reportDefinition: ReportDefinition = {
        ReportName: request.reportName,
        TimeUnit: request.configuration.timeUnit,
        Format: request.configuration.format,
        Compression: request.configuration.compression,
        AdditionalSchemaElements: additionalSchemaElements,
        S3Bucket: request.configuration.s3Bucket,
        S3Prefix: request.configuration.s3Prefix,
        S3Region: request.configuration.s3Region as any, // Type assertion for region string
        BillingViewArn: request.billingViewArn,  // CRITICAL: Links report to billing view
        RefreshClosedReports: request.configuration.refreshClosedReports,
        ReportVersioning: request.configuration.reportVersioning,
      };

      // Create the report using Legacy CUR API
      await retryWithBackoff(
        async () => await this.client.send(
          new PutReportDefinitionCommand({
            ReportDefinition: reportDefinition,
            Tags: request.tags ? Object.entries(request.tags).map(([Key, Value]) => ({ Key, Value })) : undefined,
          })
        ),
        undefined,
        { operation: 'createReport', reportName: request.reportName }
      );

      logger.info('CUR report created successfully', {
        reportName: request.reportName,
        billingViewArn: request.billingViewArn,
        timeUnit: request.configuration.timeUnit,
        format: request.configuration.format,
        tagsApplied: request.tags ? Object.keys(request.tags).length : 0,
      });

      return {
        reportName: request.reportName,
        created: true,
        alreadyExisted: false,
      };
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      
      logger.error('Failed to create CUR report', {
        error: error as Error,
        reportName: request.reportName,
        billingViewArn: request.billingViewArn,
      });

      return {
        reportName: request.reportName,
        created: false,
        alreadyExisted: false,
        errorMessage,
      };
    }
  }

  /**
   * Validate that an existing report has the correct billing view ARN
   * 
   * This ensures idempotency by verifying that an existing report
   * is configured correctly for the billing view.
   * 
   * @param reportName - Name of the report to validate
   * @param expectedBillingViewArn - Expected billing view ARN
   * @returns True if configuration is valid, false otherwise
   */
  async validateReportConfiguration(
    reportName: string,
    expectedBillingViewArn: string
  ): Promise<boolean> {
    try {
      const reportDefinition = await this.getReportByName(reportName);
      
      if (!reportDefinition) {
        return false;
      }

      // Check if billing view ARN matches
      const actualBillingViewArn = reportDefinition.BillingViewArn;
      
      if (actualBillingViewArn !== expectedBillingViewArn) {
        logger.warn('Report billing view ARN mismatch', {
          reportName,
          expectedBillingViewArn,
          actualBillingViewArn,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error validating report configuration', { error: error as Error, reportName });
      return false;
    }
  }

  /**
   * Get report definition by name
   * 
   * @param reportName - Name of the report
   * @returns Report definition or undefined if not found
   */
  private async getReportByName(reportName: string): Promise<ReportDefinition | undefined> {
    try {
      const response = await retryWithBackoff(
        async () => await this.client.send(new DescribeReportDefinitionsCommand({})),
        undefined,
        { operation: 'getReportByName', reportName }
      );
      
      if (!response.ReportDefinitions) {
        return undefined;
      }

      return response.ReportDefinitions.find(report => report.ReportName === reportName);
    } catch (error) {
      logger.error('Error getting report by name', { error: error as Error, reportName });
      return undefined;
    }
  }

  /**
   * Generate report name with account ID and view type
   * 
   * Format: billing-transfer-{accountId}-{viewType}
   * 
   * @param billSourceAccountId - Bill-source account ID
   * @param viewType - View type (my-view or showback-view)
   * @returns Generated report name
   */
  static generateReportName(
    billSourceAccountId: string,
    viewType: 'my-view' | 'showback-view'
  ): string {
    return `billing-transfer-${billSourceAccountId}-${viewType}`;
  }
}
