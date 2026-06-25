// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared Constants
 *
 * Centralized constants used across Lambda functions and services.
 *
 * @module constants
 */

/**
 * AWS Region for global services
 *
 * Organizations, Billing Conductor, and Billing APIs are global services
 * that use the us-east-1 endpoint regardless of where resources are deployed.
 */
export const GLOBAL_SERVICES_REGION = 'us-east-1';

/**
 * Default pricing plan name for billing groups
 *
 * The BasicPricingPlan is an AWS-managed pricing plan that calculates
 * pro forma costs pre-discounts, excluding credits, taxes, and support charges.
 */
export const DEFAULT_PRICING_PLAN_NAME = 'BasicPricingPlan';

/**
 * Project identifier for tagging resources
 */
export const PROJECT_NAME = 'SampleAutomationsForBillingTransfer';

/**
 * Billing group name prefix
 */
export const BILLING_GROUP_PREFIX = 'bg-';
