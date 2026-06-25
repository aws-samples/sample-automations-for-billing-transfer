// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Billing Group Validation Models
 *
 * Models for validating billing group existence and status.
 * Used to check if billing groups are properly configured for
 * billing transfer relationships.
 *
 * @module billing-group
 */

/**
 * Result of billing group validation
 *
 * Represents the outcome of checking whether a billing group exists
 * and is properly configured for a billing transfer relationship.
 */
export interface BillingGroupValidationResult {
  /** Whether the billing group exists */
  exists: boolean;

  /** ARN of the billing group (present if exists is true) */
  billingGroupArn?: string;

  /** Status of the billing group */
  status?: 'ACTIVE' | 'PRIMARY_ACCOUNT_MISSING';

  /** Error message if validation failed */
  errorMessage?: string;

  /** Steps to remediate any issues found */
  remediationSteps?: string[];
}
