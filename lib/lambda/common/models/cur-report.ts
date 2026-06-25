// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CUR Report Models
 *
 * Models for creating and managing Cost and Usage Reports
 * using the Legacy CUR API with billing view ARNs.
 *
 * @module cur-report
 */

import { ViewReportConfig } from './cur-configuration.js';

/**
 * Request to create a CUR report using Legacy CUR API
 */
export interface CURReportCreationRequest {
  /** Name of the report to create */
  reportName: string;

  /** ARN of the billing view to associate with the report */
  billingViewArn: string;

  /** View-specific configuration for the report */
  configuration: ViewReportConfig;

  /** Optional tags to apply to the report */
  tags?: Record<string, string>;
}

/**
 * Result of CUR report creation
 */
export interface CURReportCreationResult {
  /** Name of the report */
  reportName: string;

  /** Whether the report was created */
  created: boolean;

  /** Whether the report already existed */
  alreadyExisted: boolean;

  /** Error message if creation failed */
  errorMessage?: string;
}
