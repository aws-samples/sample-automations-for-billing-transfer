// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Transfer Analysis Service
 *
 * High-level orchestration service that coordinates Transfer Discovery Service,
 * Billing Transfer Resources Service, and Validation Service to provide
 * comprehensive analysis of billing transfers.
 *
 * Features:
 * - Orchestrates discovery and resource matching operations
 * - Provides comprehensive analysis summaries
 * - Supports conditional validation inclusion
 * - Tracks execution metadata and performance metrics
 * - Supports account-specific analysis
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 4.1, 5.1, 5.3, 5.5
 *
 * @module transfer-analysis-service
 */

import { logger } from '../utils/logger.js';
import { RelationshipState } from '../models/billing-transfer.js';
import {
  AnalysisSummaryModel,
  createAnalysisSummary,
  createEmptyAnalysisSummary,
  filterByAccountId,
} from '../models/analysis-summary.js';
import { ValidationResultModel } from '../models/validation-result.js';
import {
  findAllTransfers,
  TransferDiscoveryResult,
} from './transfer-discovery-service.js';
import {
  getResourcesForTransfers,
  listAllResources,
  clearResourceCache,
} from './billing-transfer-resources-service.js';
import { validateTransferConsistency } from './validation-service.js';

/**
 * Options for analysis operations
 *
 * Configures how transfers are analyzed and what data is included.
 *
 * Requirements: 6.1, 6.3
 */
export interface AnalysisOptions {
  /**
   * Relationship state to analyze.
   * Default: 'ACCEPTED' (active transfers only)
   */
  relationshipState?: RelationshipState;

  /**
   * Include validation results in the analysis.
   * When true, the analysis will also run validation checks.
   * Default: false
   */
  includeValidation?: boolean;
}

/**
 * Options for validation operations
 *
 * Configures how validation is performed.
 *
 * Requirements: 6.3
 */
export interface ValidationOptions {
  /**
   * Relationship state to validate.
   * Default: 'ACCEPTED' (active transfers only)
   */
  relationshipState?: RelationshipState;
}

/**
 * Default analysis options
 */
export const DEFAULT_ANALYSIS_OPTIONS: Required<AnalysisOptions> = {
  relationshipState: 'ACCEPTED',
  includeValidation: false,
};

/**
 * Default validation options
 */
export const DEFAULT_VALIDATION_OPTIONS: Required<ValidationOptions> = {
  relationshipState: 'ACCEPTED',
};


/**
 * Result of an analysis operation with optional validation
 */
export interface AnalysisResult {
  /** Analysis summary with transfer data and statistics */
  summary: AnalysisSummaryModel;
  /** Validation results (only present if includeValidation was true) */
  validation?: ValidationResultModel;
}

/**
 * Analyzes all billing transfers
 *
 * Orchestrates Transfer Discovery Service and Billing Transfer Resources Service
 * to provide comprehensive analysis of billing transfers. Optionally includes
 * validation results.
 *
 * Process:
 * 1. Discover all transfers (direct and indirect) using Transfer Discovery Service
 * 2. Get resources for all transfers using Billing Transfer Resources Service
 * 3. Create analysis summary with statistics
 * 4. Optionally run validation if configured
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5
 *
 * @param options - Analysis options including relationship state and validation flag
 * @returns AnalysisResult with summary and optional validation
 * @throws {Error} If discovery or resource retrieval fails
 */
export async function analyzeTransfers(
  options?: AnalysisOptions
): Promise<AnalysisResult> {
  const opts = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  const startTime = Date.now();

  logger.info('Starting transfer analysis', {
    relationshipState: opts.relationshipState,
    includeValidation: opts.includeValidation,
    operation: 'analyzeTransfers',
  });

  try {
    // Clear resource cache to ensure fresh data
    clearResourceCache();

    // Step 1: Discover all transfers (direct and indirect)
    // Requirements: 6.1
    const discoveryResult: TransferDiscoveryResult = await findAllTransfers({
      relationshipState: opts.relationshipState,
    });

    logger.info('Transfer discovery completed', {
      totalTransfers: discoveryResult.transfers.length,
      directCount: discoveryResult.directCount,
      indirectCount: discoveryResult.indirectCount,
      discoveryTimeMs: discoveryResult.executionTimeMs,
      operation: 'analyzeTransfers',
    });

    // Handle case with no transfers
    if (discoveryResult.transfers.length === 0) {
      const executionTimeMs = Date.now() - startTime;
      const summary = createEmptyAnalysisSummary(opts.relationshipState);
      summary.executionTimeMs = executionTimeMs;

      logger.info('No transfers found for analysis', {
        relationshipState: opts.relationshipState,
        executionTimeMs,
        operation: 'analyzeTransfers',
      });

      return { summary };
    }

    // Step 2: Get resources for all transfers
    // Requirements: 6.1
    const transfersWithResources = await getResourcesForTransfers(
      discoveryResult.transfers
    );

    // Step 3: Create analysis summary
    // Requirements: 6.2
    const executionTimeMs = Date.now() - startTime;
    const summary = createAnalysisSummary(
      transfersWithResources,
      opts.relationshipState,
      executionTimeMs
    );

    // Log summary statistics
    // Requirements: 5.1, 5.3, 5.5
    logger.info('Transfer analysis completed', {
      totalTransfers: summary.totalTransfers,
      directTransferCount: summary.directTransferCount,
      indirectTransferCount: summary.indirectTransferCount,
      resourceCounts: summary.resourceCounts,
      executionTimeMs,
      relationshipState: opts.relationshipState,
      operation: 'analyzeTransfers',
    });

    // Step 4: Optionally run validation
    // Requirements: 6.3
    let validation: ValidationResultModel | undefined;
    if (opts.includeValidation) {
      const allResources = await listAllResources();
      validation = await validateTransferConsistency(
        transfersWithResources,
        allResources,
        { relationshipState: opts.relationshipState }
      );

      logger.info('Validation included in analysis', {
        isValid: validation.isValid,
        totalIssues: validation.totalIssues,
        operation: 'analyzeTransfers',
      });
    }

    return { summary, validation };
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;

    // Provide detailed error context while maintaining service boundaries
    // Requirements: 6.4
    logger.error('Transfer analysis failed', {
      error: error as Error,
      relationshipState: opts.relationshipState,
      includeValidation: opts.includeValidation,
      executionTimeMs,
      operation: 'analyzeTransfers',
    });

    throw error;
  }
}


/**
 * Validates transfer resources
 *
 * Performs comprehensive validation of billing transfers and their associated
 * resources. This method discovers transfers, retrieves their resources, and
 * runs validation checks.
 *
 * Requirements: 6.3
 *
 * @param options - Validation options including relationship state
 * @returns ValidationResultModel with detailed findings
 * @throws {Error} If discovery, resource retrieval, or validation fails
 */
export async function validateTransferResources(
  options?: ValidationOptions
): Promise<ValidationResultModel> {
  const opts = { ...DEFAULT_VALIDATION_OPTIONS, ...options };
  const startTime = Date.now();

  logger.info('Starting transfer resource validation', {
    relationshipState: opts.relationshipState,
    operation: 'validateTransferResources',
  });

  try {
    // Clear resource cache to ensure fresh data
    clearResourceCache();

    // Step 1: Discover all transfers
    const discoveryResult = await findAllTransfers({
      relationshipState: opts.relationshipState,
    });

    logger.info('Transfer discovery for validation completed', {
      totalTransfers: discoveryResult.transfers.length,
      operation: 'validateTransferResources',
    });

    // Step 2: Get resources for all transfers
    const transfersWithResources = await getResourcesForTransfers(
      discoveryResult.transfers
    );

    // Step 3: Get all resources for orphan detection
    const allResources = await listAllResources();

    // Step 4: Run validation
    const validationResult = await validateTransferConsistency(
      transfersWithResources,
      allResources,
      { relationshipState: opts.relationshipState }
    );

    const executionTimeMs = Date.now() - startTime;

    logger.info('Transfer resource validation completed', {
      isValid: validationResult.isValid,
      totalIssues: validationResult.totalIssues,
      issuesByType: validationResult.issuesByType,
      executionTimeMs,
      relationshipState: opts.relationshipState,
      operation: 'validateTransferResources',
    });

    return validationResult;
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;

    logger.error('Transfer resource validation failed', {
      error: error as Error,
      relationshipState: opts.relationshipState,
      executionTimeMs,
      operation: 'validateTransferResources',
    });

    throw error;
  }
}


/**
 * Analyzes transfers for a specific account
 *
 * Performs analysis filtered to a specific bill source account ID.
 * This is useful for investigating transfers related to a particular customer.
 *
 * Requirements: 4.1
 *
 * @param accountId - The bill source account ID to filter by
 * @param options - Analysis options including relationship state and validation flag
 * @returns AnalysisResult with summary filtered to the specified account
 * @throws {Error} If analysis fails
 */
export async function analyzeAccountTransfers(
  accountId: string,
  options?: AnalysisOptions
): Promise<AnalysisResult> {
  const opts = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  const startTime = Date.now();

  logger.info('Starting account-specific transfer analysis', {
    accountId,
    relationshipState: opts.relationshipState,
    includeValidation: opts.includeValidation,
    operation: 'analyzeAccountTransfers',
  });

  try {
    // First, get the full analysis
    const fullResult = await analyzeTransfers({
      relationshipState: opts.relationshipState,
      includeValidation: false, // We'll handle validation separately for filtered data
    });

    // Filter the summary by account ID
    const filteredSummary = filterByAccountId(fullResult.summary, accountId);

    // Update execution time to reflect the full operation
    const executionTimeMs = Date.now() - startTime;
    filteredSummary.executionTimeMs = executionTimeMs;

    logger.info('Account-specific analysis completed', {
      accountId,
      totalTransfers: filteredSummary.totalTransfers,
      directTransferCount: filteredSummary.directTransferCount,
      indirectTransferCount: filteredSummary.indirectTransferCount,
      resourceCounts: filteredSummary.resourceCounts,
      executionTimeMs,
      relationshipState: opts.relationshipState,
      operation: 'analyzeAccountTransfers',
    });

    // Optionally run validation on filtered transfers
    let validation: ValidationResultModel | undefined;
    if (opts.includeValidation && filteredSummary.transfers.length > 0) {
      const allResources = await listAllResources();
      validation = await validateTransferConsistency(
        filteredSummary.transfers,
        allResources,
        { relationshipState: opts.relationshipState }
      );

      logger.info('Validation included in account analysis', {
        accountId,
        isValid: validation.isValid,
        totalIssues: validation.totalIssues,
        operation: 'analyzeAccountTransfers',
      });
    }

    return { summary: filteredSummary, validation };
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;

    logger.error('Account-specific transfer analysis failed', {
      error: error as Error,
      accountId,
      relationshipState: opts.relationshipState,
      includeValidation: opts.includeValidation,
      executionTimeMs,
      operation: 'analyzeAccountTransfers',
    });

    throw error;
  }
}


/**
 * Execution metadata for analysis operations
 */
export interface ExecutionMetadata {
  /** Operation name */
  operation: string;
  /** Relationship state analyzed */
  relationshipState: RelationshipState;
  /** Start timestamp */
  startTimestamp: number;
  /** End timestamp */
  endTimestamp: number;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Whether validation was included */
  includeValidation: boolean;
}

/**
 * Performance metrics for analysis operations
 */
export interface PerformanceMetrics {
  /** Total transfers processed */
  transfersProcessed: number;
  /** Direct transfers count */
  directTransfers: number;
  /** Indirect transfers count */
  indirectTransfers: number;
  /** Resources matched */
  resourcesMatched: {
    billingViews: number;
    billingGroups: number;
    pricingPlans: number;
    curConfigurations: number;
  };
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

/**
 * Gets execution metadata from an analysis result
 *
 * Extracts execution metadata from the analysis summary for logging
 * and monitoring purposes.
 *
 * Requirements: 6.5
 *
 * @param result - The analysis result
 * @param operation - The operation name
 * @param includeValidation - Whether validation was included
 * @returns ExecutionMetadata object
 */
export function getExecutionMetadata(
  result: AnalysisResult,
  operation: string,
  includeValidation: boolean
): ExecutionMetadata {
  return {
    operation,
    relationshipState: result.summary.relationshipState,
    startTimestamp: result.summary.analysisTimestamp - result.summary.executionTimeMs,
    endTimestamp: result.summary.analysisTimestamp,
    executionTimeMs: result.summary.executionTimeMs,
    includeValidation,
  };
}

/**
 * Gets performance metrics from an analysis result
 *
 * Extracts performance metrics from the analysis summary for monitoring
 * and optimization purposes.
 *
 * Requirements: 5.3, 5.5, 6.5
 *
 * @param result - The analysis result
 * @returns PerformanceMetrics object
 */
export function getPerformanceMetrics(result: AnalysisResult): PerformanceMetrics {
  return {
    transfersProcessed: result.summary.totalTransfers,
    directTransfers: result.summary.directTransferCount,
    indirectTransfers: result.summary.indirectTransferCount,
    resourcesMatched: {
      billingViews: result.summary.resourceCounts.withBillingViews,
      billingGroups: result.summary.resourceCounts.withBillingGroups,
      pricingPlans: result.summary.resourceCounts.withPricingPlans,
      curConfigurations: result.summary.resourceCounts.withCURConfigurations,
    },
    executionTimeMs: result.summary.executionTimeMs,
  };
}

/**
 * Logs analysis summary statistics
 *
 * Logs comprehensive summary statistics for an analysis operation.
 * Uses consistent field names and formats for structured logging.
 *
 * Requirements: 5.1, 5.5
 *
 * @param result - The analysis result to log
 * @param operation - The operation name for context
 */
export function logAnalysisSummary(
  result: AnalysisResult,
  operation: string
): void {
  const metrics = getPerformanceMetrics(result);

  logger.info('Analysis summary statistics', {
    operation,
    relationshipState: result.summary.relationshipState,
    totalTransfers: metrics.transfersProcessed,
    directTransfers: metrics.directTransfers,
    indirectTransfers: metrics.indirectTransfers,
    withBillingViews: metrics.resourcesMatched.billingViews,
    withBillingGroups: metrics.resourcesMatched.billingGroups,
    withPricingPlans: metrics.resourcesMatched.pricingPlans,
    withCURConfigurations: metrics.resourcesMatched.curConfigurations,
    missingBillingViews: result.summary.resourceCounts.missingBillingViews,
    missingBillingGroups: result.summary.resourceCounts.missingBillingGroups,
    missingPricingPlans: result.summary.resourceCounts.missingPricingPlans,
    missingCURConfigurations: result.summary.resourceCounts.missingCURConfigurations,
    executionTimeMs: metrics.executionTimeMs,
    hasValidation: !!result.validation,
    validationIsValid: result.validation?.isValid,
    validationTotalIssues: result.validation?.totalIssues,
  });
}

