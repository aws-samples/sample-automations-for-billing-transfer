// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Billing View Models
 *
 * Represents AWS Billing views used for billing transfer relationships.
 * Billing views provide visibility into billing data for transferred accounts.
 *
 * @module billing-view
 */

/**
 * Represents a billing view
 *
 * A billing view provides access to billing data for accounts involved
 * in billing transfer relationships.
 */
export interface BillingView {
  /** ARN of the billing view */
  arn: string;

  /** Name of the billing view */
  name: string;

  /** Type of billing view */
  billingViewType: 'PRIMARY' | 'BILLING_TRANSFER' | 'BILLING_TRANSFER_SHOWBACK' | 'BILLING_GROUP';

  /** Owner account ID of the billing view */
  ownerAccountId: string;

  /** Source account ID associated with this billing view (optional for non-transfer views) */
  sourceAccountId?: string;
}
