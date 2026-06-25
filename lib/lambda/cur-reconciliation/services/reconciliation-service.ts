// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Reconciliation Service
 * 
 * Orchestrates the full CUR automation workflow using TransferAnalysisService:
 * 1. Analyze all billing transfer relationships with their resources
 * 2. Filter for transfers needing CUR reports (have billing group, missing CUR)
 * 3. Process My View reports (if configured and enabled)
 * 4. Process Showback View reports (if configured and enabled)
 * 5. Create support cases for backfill (if enabled)
 * 6. Generate comprehensive reconciliation summary
 * 
 * Key features:
 * - Uses TransferAnalysisService for unified transfer discovery and resource matching
 * - Uses cached resources from analysis (no separate billing view API calls)
 * - Independent processing of My View and Showback View
 * - Error isolation (continue processing on failures)
 * - Comprehensive logging and summary generation
 * - Support for conditional view processing based on configuration
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 5.2, 8.2, 8.3, 8.4
 */

import { analyzeTransfers } from '../../common/services/transfer-analysis-service.js';
import { BillingTransferWithResourcesModel } from '../../common/models/billing-transfer-resources.js';
import { CURReportService } from './cur-report-service.js';
import { S3ValidationService } from './s3-validation-service.js';
import { SupportCaseService } from './support-case-service.js';
import { ConfigurationService } from './configuration-service.js';
import { logger } from '../../common/utils/logger.js';
import {
  getErrorMessage,
  getErrorCode,
} from '../../common/utils/errors.js';
import {
  handleError,
  categorizeError,
  ErrorCategory,
} from '../../common/utils/error-handler.js';
import {
  ensureCURReportTags,
} from '../../common/services/tagging-service.js';
import {
  ReportConfigurationTemplate,
  ViewReportConfig,
} from '../../common/models/cur-configuration.js';
import { CURReconciliationSummary } from '../models/reconciliation.js';
import { CURReportCreationRequest } from '../../common/models/cur-report.js';
import { BackfillRequest } from '../models/support-case.js';

export class ReconciliationService {
  private readonly curReportService: CURReportService;
  private readonly s3ValidationService: S3ValidationService;
  private readonly supportCaseService: SupportCaseService;
  private readonly configurationService: ConfigurationService;

  constructor(
    curReportService?: CURReportService,
    s3ValidationService?: S3ValidationService,
    supportCaseService?: SupportCaseService,
    configurationService?: ConfigurationService
  ) {
    this.curReportService = curReportService || new CURReportService();
    this.s3ValidationService = s3ValidationService || new S3ValidationService();
    this.supportCaseService = supportCaseService || new SupportCaseService();
    this.configurationService = configurationService || new ConfigurationService();
  }

  /**
   * Reconcile all billing transfers and create CUR reports
   * 
   * This method:
   * 1. Uses TransferAnalysisService to discover all transfers with resources
   * 2. Filters for transfers that have billing groups but missing CUR configurations
   * 3. For each transfer needing CUR:
   *    a. Validates billing group exists using resourcesFound.billingGroup
   *    b. Uses billing view from model (resources.billingView)
   *    c. Processes My View reports (if myViewReportConfig present and enabled)
   *    d. Processes Showback View reports (if showbackViewReportConfig present and enabled)
   * 4. Generates comprehensive reconciliation summary
   * 
   * Error isolation: Failures processing one transfer don't affect others
   * 
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.4, 5.2, 8.2, 8.3, 8.4
   * 
   * @param config - Report configuration template
   * @returns Reconciliation summary with view-specific counts
   */
  async reconcileAllTransfers(
    config: ReportConfigurationTemplate
  ): Promise<CURReconciliationSummary> {
    logger.info('Starting CUR reconciliation', {
      hasMyViewConfig: this.configurationService.hasMyViewConfig(config),
      hasShowbackViewConfig: this.configurationService.hasShowbackViewConfig(config),
      myViewEnabled: this.configurationService.isMyViewEnabled(config),
      showbackViewEnabled: this.configurationService.isShowbackViewEnabled(config),
    });

    // Initialize summary
    const summary: CURReconciliationSummary = {
      totalTransfersProcessed: 0,
      myViewReportsCreated: 0,
      myViewReportsAlreadyExisted: 0,
      myViewReportsFailed: 0,
      myViewReportsSkipped: 0,
      showbackViewReportsCreated: 0,
      showbackViewReportsAlreadyExisted: 0,
      showbackViewReportsFailed: 0,
      showbackViewReportsSkipped: 0,
      failedTransfers: [],
      supportCasesCreated: 0,
      supportCasesFailed: 0,
      tagging: {
        curReportsTagged: 0,
        curReportsTaggingFailed: 0,
      },
    };

    try {
      // Step 1: Get all transfers with their resources using TransferAnalysisService
      // Requirements: 2.1, 8.2, 8.3, 8.4
      const { summary: analysisSummary } = await analyzeTransfers({ 
        relationshipState: 'ACCEPTED' 
      });
      
      logger.info('Transfer analysis completed', {
        totalTransfers: analysisSummary.totalTransfers,
        directTransferCount: analysisSummary.directTransferCount,
        indirectTransferCount: analysisSummary.indirectTransferCount,
        withBillingGroups: analysisSummary.resourceCounts.withBillingGroups,
        missingBillingGroups: analysisSummary.resourceCounts.missingBillingGroups,
        withCURConfigurations: analysisSummary.resourceCounts.withCURConfigurations,
        missingCURConfigurations: analysisSummary.resourceCounts.missingCURConfigurations,
      });

      if (analysisSummary.totalTransfers === 0) {
        logger.info('No billing transfers to reconcile');
        return summary;
      }

      // Step 2: Filter for transfers that need any CUR work.
      // A transfer needs processing if it has a billing group AND is missing
      // either its My View CUR or its Showback CUR. We can no longer gate on a
      // single curConfiguration flag, because a transfer often has the My View
      // CUR but is still missing the Showback CUR (they are separate reports on
      // separate billing views). createReport is idempotent, so reprocessing a
      // transfer whose My View report already exists is safe.
      // Requirements: 2.2, 2.4
      const myViewEnabled = this.configurationService.isMyViewEnabled(config);
      const showbackEnabled = this.configurationService.isShowbackViewEnabled(config);

      const needsCur = (t: BillingTransferWithResourcesModel): boolean => {
        if (!t.resourcesFound.billingGroup) {
          return false;
        }
        // Missing My View CUR while a My View billing view exists and is enabled
        if (myViewEnabled && t.resourcesFound.billingView && !t.resourcesFound.curConfiguration) {
          return true;
        }
        // Missing Showback CUR while a Showback billing view exists and is enabled
        if (
          showbackEnabled &&
          t.resourcesFound.showbackBillingView &&
          !t.resourcesFound.showbackCurConfiguration
        ) {
          return true;
        }
        return false;
      };

      const transfersNeedingCUR = analysisSummary.transfers.filter(needsCur);

      // Transfers that already have every applicable CUR report.
      const transfersWithCUR = analysisSummary.transfers.filter(
        (t) => t.resourcesFound.billingGroup && !needsCur(t)
      );

      // Track transfers missing billing groups (for logging/warning)
      const transfersMissingBillingGroup = analysisSummary.transfers.filter(
        (t) => !t.resourcesFound.billingGroup
      );

      logger.info('Filtered transfers for CUR reconciliation', {
        needingCUR: transfersNeedingCUR.length,
        alreadyHaveCUR: transfersWithCUR.length,
        missingBillingGroup: transfersMissingBillingGroup.length,
      });

      // Log errors for transfers missing billing groups. This is logged at
      // error level (not warn) because a missing billing group means the CUR
      // for this transfer cannot be created — it is an actionable condition the
      // operator needs surfaced, and it points at billing group reconciliation
      // (which should have created the group at :00/:30) as the thing to check.
      // Requirements: 3.2
      for (const transfer of transfersMissingBillingGroup) {
        logger.error('Cannot create CUR: transfer is missing its billing group', {
          transferId: transfer.transfer.id,
          billSourceAccountId: transfer.transfer.billSourceAccountId,
          resourceState: transfer.resourcesFound,
          remediation:
            'Billing group reconciliation creates the billing group; verify the ' +
            'billing-group-reconciliation Lambda has run and succeeded for this account.',
        });
      }

      // Step 3: Process each transfer that needs CUR reports
      for (const transferWithResources of transfersNeedingCUR) {
        await this.processTransfer(transferWithResources, config, summary);
      }

      // Update total processed count
      summary.totalTransfersProcessed = analysisSummary.totalTransfers;

      // Log completion
      logger.info('CUR reconciliation execution completed', {
        totalTransfersProcessed: summary.totalTransfersProcessed,
        myViewReportsCreated: summary.myViewReportsCreated,
        myViewReportsAlreadyExisted: summary.myViewReportsAlreadyExisted,
        myViewReportsFailed: summary.myViewReportsFailed,
        myViewReportsSkipped: summary.myViewReportsSkipped,
        showbackViewReportsCreated: summary.showbackViewReportsCreated,
        showbackViewReportsAlreadyExisted: summary.showbackViewReportsAlreadyExisted,
        showbackViewReportsFailed: summary.showbackViewReportsFailed,
        showbackViewReportsSkipped: summary.showbackViewReportsSkipped,
        supportCasesCreated: summary.supportCasesCreated,
        supportCasesFailed: summary.supportCasesFailed,
        failedTransfersCount: summary.failedTransfers.length,
        tagging: summary.tagging,
      });

      return summary;
    } catch (error) {
      // Requirements: 4.3 - Include detailed error context
      // Requirements: 5.4 - Throw critical errors to trigger EventBridge retry
      const category = categorizeError(error);
      
      // Use handleError for consistent logging and critical error handling
      // handleError will throw for CRITICAL errors, return ErrorDetails for others
      if (category === ErrorCategory.CRITICAL) {
        handleError(error, {
          operation: 'reconcileAllTransfers',
        });
        // handleError throws for critical errors, but TypeScript doesn't know that
        throw error;
      }

      // Log non-critical errors with detailed context
      logger.error('Reconciliation failed', { 
        error: error instanceof Error ? error : new Error(String(error)),
        operation: 'reconcileAllTransfers',
        category,
        errorCode: getErrorCode(error),
        errorMessage: getErrorMessage(error),
      });

      // Return partial summary for non-critical errors
      return summary;
    }
  }


  /**
   * Process a single billing transfer with resources
   * 
   * This method:
   * 1. Validates billing group exists using resourcesFound.billingGroup
   * 2. Uses billing view from model (resources.billingView) for CUR creation
   * 3. Processes My View reports (if configured and enabled)
   * 4. Processes Showback View reports (if configured and enabled)
   * 
   * Errors are isolated - failures don't prevent processing other transfers
   * 
   * Requirements: 2.3, 3.1, 3.2, 3.3, 3.4
   * 
   * @param transferWithResources - Billing transfer with resources to process
   * @param config - Report configuration template
   * @param summary - Reconciliation summary to update
   */
  private async processTransfer(
    transferWithResources: BillingTransferWithResourcesModel,
    config: ReportConfigurationTemplate,
    summary: CURReconciliationSummary
  ): Promise<void> {
    const { transfer, resources, resourcesFound } = transferWithResources;

    logger.info('Processing billing transfer for CUR', {
      transferId: transfer.id,
      billSourceAccountId: transfer.billSourceAccountId,
      hasBillingGroup: resourcesFound.billingGroup,
      hasBillingView: resourcesFound.billingView,
      hasCURConfiguration: resourcesFound.curConfiguration,
    });

    try {
      // Step 1: Validate billing group exists using resourcesFound
      // Requirements: 3.1, 3.2
      if (!resourcesFound.billingGroup) {
        logger.warn('Billing group validation failed - missing billing group', {
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          resourceState: resourcesFound,
        });

        // Add to failed transfers for enabled view types since we can't process either
        // Requirements: 5.3 - Error objects include accountId, error message, and timestamp
        if (this.configurationService.isMyViewEnabled(config)) {
          summary.failedTransfers.push({
            transferId: transfer.id,
            billSourceAccountId: transfer.billSourceAccountId,
            viewType: 'MY_VIEW',
            errorMessage: 'Billing group does not exist for this transfer',
            timestamp: new Date().toISOString(),
          });
          summary.myViewReportsFailed++;
        }

        if (this.configurationService.isShowbackViewEnabled(config)) {
          summary.failedTransfers.push({
            transferId: transfer.id,
            billSourceAccountId: transfer.billSourceAccountId,
            viewType: 'SHOWBACK_VIEW',
            errorMessage: 'Billing group does not exist for this transfer',
            timestamp: new Date().toISOString(),
          });
          summary.showbackViewReportsFailed++;
        }

        return; // Skip this transfer
      }

      // Step 2: Per-view-type processing resolves its own (type-appropriate)
      // billing view and skips cleanly when that view type is not present, so
      // there is no longer a single "billing view" gate here. A transfer can
      // legitimately have only one of the two view types.

      // Step 3: Process My View reports (if configured and enabled)
      if (this.configurationService.isMyViewEnabled(config)) {
        await this.processTransferForViewType(
          transferWithResources,
          'BILLING_TRANSFER',
          config.myViewReportConfig!,
          'MY_VIEW',
          summary
        );
      } else if (this.configurationService.hasMyViewConfig(config)) {
        logger.info('My View reports disabled by configuration', {
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
        });
      }

      // Step 4: Process Showback View reports (if configured and enabled)
      if (this.configurationService.isShowbackViewEnabled(config)) {
        await this.processTransferForViewType(
          transferWithResources,
          'BILLING_TRANSFER_SHOWBACK',
          config.showbackViewReportConfig!,
          'SHOWBACK_VIEW',
          summary
        );
      } else if (this.configurationService.hasShowbackViewConfig(config)) {
        logger.info('Showback View reports disabled by configuration', {
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
        });
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const errorCode = getErrorCode(error);
      const timestamp = new Date().toISOString();
      const category = categorizeError(error);
      
      // Requirements: 5.4 - Throw critical errors to trigger EventBridge retry
      if (category === ErrorCategory.CRITICAL) {
        // Use handleError for consistent critical error handling
        handleError(error, {
          transferId: transfer.id,
          accountId: transfer.billSourceAccountId,
          resourceState: resourcesFound,
          operation: 'processTransfer',
        });
        // handleError throws for critical errors, but TypeScript doesn't know that
        throw error;
      }
      
      // Requirements: 3.4 - Error isolation for non-critical errors
      // Requirements: 4.3 - Include transfer ID, account ID, and resource state in error logs
      logger.error('Error processing transfer', {
        error: error instanceof Error ? error : new Error(String(error)),
        transferId: transfer.id,
        accountId: transfer.billSourceAccountId,
        resourceState: resourcesFound,
        operation: 'processTransfer',
        category,
        errorCode,
      });

      // Requirements: 5.3 - Error objects include accountId, error message, and timestamp
      // Add to failed transfers for enabled view types
      if (this.configurationService.isMyViewEnabled(config)) {
        summary.failedTransfers.push({
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          viewType: 'MY_VIEW',
          errorMessage: `${errorCode ? errorCode + ': ' : ''}${errorMessage}`,
          timestamp,
        });
        summary.myViewReportsFailed++;
      }

      if (this.configurationService.isShowbackViewEnabled(config)) {
        summary.failedTransfers.push({
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          viewType: 'SHOWBACK_VIEW',
          errorMessage: `${errorCode ? errorCode + ': ' : ''}${errorMessage}`,
          timestamp,
        });
        summary.showbackViewReportsFailed++;
      }
    }
  }


  /**
   * Process a billing transfer for a specific view type
   *
   * This method:
   * 1. Validates S3 bucket configuration
   * 2. Uses billing view from model (resources.billingView) only - no fallback API calls
   * 3. If billing view type doesn't match, skips processing and logs info message
   * 4. Creates CUR report with the billing view
   * 5. Creates support case for backfill (if enabled and report was created)
   *
   * Requirements: 2.1, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4
   *
   * @param transferWithResources - Billing transfer with resources
   * @param billingViewType - Type of billing view (BILLING_TRANSFER or BILLING_TRANSFER_SHOWBACK)
   * @param viewConfig - View-specific configuration
   * @param summaryViewType - View type for summary tracking (MY_VIEW or SHOWBACK_VIEW)
   * @param summary - Reconciliation summary to update
   */
  private async processTransferForViewType(
    transferWithResources: BillingTransferWithResourcesModel,
    billingViewType: 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK',
    viewConfig: ViewReportConfig,
    summaryViewType: 'MY_VIEW' | 'SHOWBACK_VIEW',
    summary: CURReconciliationSummary
  ): Promise<void> {
    const { transfer, resources } = transferWithResources;
    const viewTypeLabel = summaryViewType === 'MY_VIEW' ? 'My View' : 'Showback View';

    // Select the billing view that matches the requested view type. The model
    // now carries both a My View (resources.billingView) and a Showback view
    // (resources.showbackBillingView); previously only one view was attached,
    // which caused the Showback path to always see the My View and skip.
    const selectedBillingView =
      billingViewType === 'BILLING_TRANSFER_SHOWBACK'
        ? resources.showbackBillingView
        : resources.billingView;

    try {
      // Step 1: Validate S3 bucket configuration (do this first to fail fast)
      const s3ValidationResult = await this.s3ValidationService.validateBucket(
        viewConfig.s3Bucket,
        viewConfig.s3Region
      );

      if (!s3ValidationResult.bucketExists || !s3ValidationResult.policyIsValid) {
        const errorMessage = s3ValidationResult.errorMessage || 'S3 bucket validation failed';

        logger.error(`S3 validation failed for ${viewTypeLabel}`, {
          error: new Error(errorMessage),
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          bucket: viewConfig.s3Bucket,
          remediationSteps: s3ValidationResult.remediationSteps?.join('; '),
        });

        // Requirements: 5.3 - Error objects include accountId, error message, and timestamp
        summary.failedTransfers.push({
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          viewType: summaryViewType,
          errorMessage,
          timestamp: new Date().toISOString(),
        });

        if (summaryViewType === 'MY_VIEW') {
          summary.myViewReportsFailed++;
        } else {
          summary.showbackViewReportsFailed++;
        }

        return;
      }

      // Step 2: Use the type-appropriate billing view from the model only - no
      // fallback API calls.
      // Requirements: 2.1, 2.3, 3.1, 3.2, 3.3, 3.4
      if (!selectedBillingView || selectedBillingView.billingViewType !== billingViewType) {
        // View type not applicable for this transfer - skip it.
        // This is NOT a failure: many transfers legitimately have only a
        // My View billing view and no Showback view (or vice versa). Counting
        // these as failures produced false "ATTENTION" status across the fleet.
        // Requirements: 3.3
        logger.info('Billing view not available for view type, skipping', {
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          requestedViewType: billingViewType,
          modelViewType: selectedBillingView?.billingViewType || 'none',
        });

        if (summaryViewType === 'MY_VIEW') {
          summary.myViewReportsSkipped++;
        } else {
          summary.showbackViewReportsSkipped++;
        }

        return;
      }

      // Use the selected (type-matched) billing view from the model
      const billingView = {
        arn: selectedBillingView.arn,
        name: selectedBillingView.name,
      };

      logger.info('Using billing view from analysis model', {
        billSourceAccountId: transfer.billSourceAccountId,
        billingViewType,
        billingViewArn: billingView.arn,
      });

      // Step 3: Generate report name and tags
      const reportName = CURReportService.generateReportName(
        transfer.billSourceAccountId,
        summaryViewType === 'MY_VIEW' ? 'my-view' : 'showback-view'
      );

      const tags: Record<string, string> = {
        CreatedBy: 'CURReconciliation',
        BillSourceAccountId: transfer.billSourceAccountId,
        CreationTimestamp: new Date().toISOString(),
        ViewType: summaryViewType,
        ...viewConfig.tags,
      };

      // Step 4: Create CUR report with the billing view
      logger.info('Attempting CUR creation with billing view', {
        reportName,
        billingViewArn: billingView.arn,
        billingViewName: billingView.name,
        billSourceAccountId: transfer.billSourceAccountId,
      });

      const reportRequest: CURReportCreationRequest = {
        reportName,
        billingViewArn: billingView.arn,
        configuration: viewConfig,
        tags,
      };

      const reportResult = await this.curReportService.createReport(reportRequest);

      if (reportResult.alreadyExisted) {
        // Report already exists - success (idempotent)
        logger.info('CUR report already exists', {
          reportName,
          billSourceAccountId: transfer.billSourceAccountId,
          viewType: summaryViewType,
        });

        // Ensure existing report has tags
        const curTagResult = await ensureCURReportTags(
          reportName,
          transfer.billSourceAccountId,
          summaryViewType,
          billingView.arn
        );
        if (curTagResult.action === 'tagged') {
          summary.tagging.curReportsTagged++;
        } else if (curTagResult.action === 'failed') {
          summary.tagging.curReportsTaggingFailed++;
        }

        if (summaryViewType === 'MY_VIEW') {
          summary.myViewReportsAlreadyExisted++;
        } else {
          summary.showbackViewReportsAlreadyExisted++;
        }
        return;
      }

      if (reportResult.created) {
        // Success!
        logger.info('CUR report created successfully', {
          reportName,
          billingViewArn: billingView.arn,
          billSourceAccountId: transfer.billSourceAccountId,
          viewType: summaryViewType,
        });

        if (summaryViewType === 'MY_VIEW') {
          summary.myViewReportsCreated++;
        } else {
          summary.showbackViewReportsCreated++;
        }

        // Tag the newly created CUR report (tags may not have been applied during creation)
        const curTagResult = await ensureCURReportTags(
          reportName,
          transfer.billSourceAccountId,
          summaryViewType,
          billingView.arn
        );
        if (curTagResult.action === 'tagged') {
          summary.tagging.curReportsTagged++;
        } else if (curTagResult.action === 'failed') {
          summary.tagging.curReportsTaggingFailed++;
        }

        // Step 5: Create support case for backfill (if enabled and report was created)
        if (viewConfig.backfill?.enabled) {
          await this.createBackfillSupportCase(
            reportName,
            billingView.arn,
            viewConfig,
            viewTypeLabel,
            summary
          );
        }
      } else {
        // CUR creation failed
        const errorMessage = reportResult.errorMessage || 'Unknown error creating CUR report';

        logger.error(`Failed to create ${viewTypeLabel} report`, {
          error: new Error(errorMessage),
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          reportName,
          billingViewArn: billingView.arn,
        });

        // Requirements: 5.3 - Error objects include accountId, error message, and timestamp
        summary.failedTransfers.push({
          transferId: transfer.id,
          billSourceAccountId: transfer.billSourceAccountId,
          viewType: summaryViewType,
          errorMessage,
          timestamp: new Date().toISOString(),
        });

        if (summaryViewType === 'MY_VIEW') {
          summary.myViewReportsFailed++;
        } else {
          summary.showbackViewReportsFailed++;
        }
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const errorCode = getErrorCode(error);
      const timestamp = new Date().toISOString();
      const category = categorizeError(error);

      // Requirements: 5.4 - Throw critical errors to trigger EventBridge retry
      if (category === ErrorCategory.CRITICAL) {
        // Use handleError for consistent critical error handling
        handleError(error, {
          transferId: transfer.id,
          accountId: transfer.billSourceAccountId,
          operation: 'processTransferForViewType',
          viewType: summaryViewType,
        });
        // handleError throws for critical errors, but TypeScript doesn't know that
        throw error;
      }

      // Requirements: 4.3 - Include transfer ID, account ID, and resource state in error logs
      logger.error(`Error processing ${viewTypeLabel}`, {
        error: error instanceof Error ? error : new Error(String(error)),
        transferId: transfer.id,
        accountId: transfer.billSourceAccountId,
        operation: 'processTransferForViewType',
        viewType: summaryViewType,
        category,
        errorCode,
      });

      // Requirements: 5.3 - Error objects include accountId, error message, and timestamp
      summary.failedTransfers.push({
        transferId: transfer.id,
        billSourceAccountId: transfer.billSourceAccountId,
        viewType: summaryViewType,
        errorMessage: `${errorCode ? errorCode + ': ' : ''}${errorMessage}`,
        timestamp,
      });

      if (summaryViewType === 'MY_VIEW') {
        summary.myViewReportsFailed++;
      } else {
        summary.showbackViewReportsFailed++;
      }
    }
  }


  /**
   * Create a support case for historical data backfill
   * 
   * This method creates an AWS Support case requesting historical data backfill
   * for a newly created CUR report. Support case creation failures are logged
   * but don't prevent processing of other reports.
   * 
   * @param reportName - Name of the CUR report
   * @param billingViewArn - Billing view ARN
   * @param viewConfig - View-specific configuration
   * @param viewTypeLabel - Human-readable view type label
   * @param summary - Reconciliation summary to update
   */
  private async createBackfillSupportCase(
    reportName: string,
    billingViewArn: string,
    viewConfig: ViewReportConfig,
    viewTypeLabel: string,
    summary: CURReconciliationSummary
  ): Promise<void> {
    try {
      // Backfill is guaranteed to be defined and enabled when this method is called
      if (!viewConfig.backfill || !viewConfig.backfill.billingPeriodRange || !viewConfig.backfill.severityCode) {
        throw new Error('Backfill configuration is missing required fields');
      }

      const backfillRequest: BackfillRequest = {
        exportName: reportName,  // Using reportName for consistency
        billingViewArn,
        billingPeriodRange: viewConfig.backfill.billingPeriodRange,
        severityCode: viewConfig.backfill.severityCode,
      };

      const caseResult = await this.supportCaseService.createBackfillCase(backfillRequest);

      if (caseResult.created && caseResult.caseId) {
        const viewType = viewTypeLabel === 'My View' ? 'MY_VIEW' : 'SHOWBACK_VIEW';
        // Extract account ID from report name (format: billing-transfer-{accountId}-{viewType})
        const accountId = reportName.split('-')[2];
        
        logger.info('Support case created for backfill', {
          caseId: caseResult.caseId,
          reportName,
          billSourceAccountId: accountId,
          viewType,
          operation: 'createSupportCase',
        });

        summary.supportCasesCreated++;
      } else {
        const viewType = viewTypeLabel === 'My View' ? 'MY_VIEW' : 'SHOWBACK_VIEW';
        const accountId = reportName.split('-')[2];
        
        logger.error('Support case creation failed', {
          error: new Error(caseResult.errorMessage || 'Unknown error'),
          reportName,
          billSourceAccountId: accountId,
          viewType,
          operation: 'createSupportCase',
        });

        summary.supportCasesFailed++;
      }
    } catch (error) {
      const viewType = viewTypeLabel === 'My View' ? 'MY_VIEW' : 'SHOWBACK_VIEW';
      const accountId = reportName.split('-')[2];
      
      logger.error('Support case creation failed', {
        error: error instanceof Error ? error : new Error(String(error)),
        reportName,
        billSourceAccountId: accountId,
        viewType,
        operation: 'createSupportCase',
      });

      summary.supportCasesFailed++;
    }
  }
}
