// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared AWS SDK Clients
 *
 * Centralized client instances for all AWS services used by the Billing Transfer
 * Automation project. Clients are created at module level for Lambda warm start
 * optimization and reused across invocations.
 *
 * Configuration:
 * - Region: us-east-1 (global services endpoint)
 * - Max Attempts: 3 (automatic retries for transient failures)
 * - Retry Mode: adaptive (intelligent backoff based on service responses)
 *
 * @module clients
 */

import { BillingconductorClient } from '@aws-sdk/client-billingconductor';
import { BillingClient } from '@aws-sdk/client-billing';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { CostAndUsageReportServiceClient } from '@aws-sdk/client-cost-and-usage-report-service';
import { GLOBAL_SERVICES_REGION } from '../constants.js';

/**
 * Default client configuration for all AWS SDK clients
 */
const DEFAULT_CLIENT_CONFIG = {
  region: GLOBAL_SERVICES_REGION,
  maxAttempts: 3,
  retryMode: 'adaptive' as const,
};

/**
 * AWS Billing Conductor client
 * Used for billing groups and pricing plans
 */
export const billingConductorClient = new BillingconductorClient(DEFAULT_CLIENT_CONFIG);

/**
 * AWS Billing client
 * Used for billing views
 */
export const billingClient = new BillingClient(DEFAULT_CLIENT_CONFIG);

/**
 * AWS Organizations client
 * Used for billing transfer discovery
 */
export const organizationsClient = new OrganizationsClient(DEFAULT_CLIENT_CONFIG);

/**
 * AWS Cost and Usage Report Service client
 * Used for CUR report configurations
 */
export const curClient = new CostAndUsageReportServiceClient(DEFAULT_CLIENT_CONFIG);
