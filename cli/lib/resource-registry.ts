// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Resource_Registry — the single in-code source of truth for AWS resource
 * names used by the `bt` CLI (Requirement 21).
 *
 * Ports the constants block of `scripts/lib/common.sh` (and the SSM parameter
 * paths from `scripts/seed-channel-role-params.sh`) into one TypeScript module
 * so renaming a stack, function, queue, or parameter happens in exactly one
 * place. Nothing outside this module hard-codes these names; commands obtain
 * every resource name from here (Req 21.1, 21.3).
 *
 * `defaultRegion` is the Default_Region (Req 21.2): the global-endpoint region
 * for Global_Services (Organizations, Billing, Billing Conductor, CUR) and the
 * regional fallback when an active profile has no configured region.
 */
export const ResourceRegistry = {
  /** Default_Region (Req 21.2): global-endpoint region + regional fallback. */
  defaultRegion: 'us-east-1',

  /** CDK Pipeline stack, deployed once per payer account. */
  pipelineStackName: 'SampleAutomationsForBillingTransfer-PipelineStack',
  /** CodePipeline execution name created by the pipeline stack. */
  pipelineName: 'SampleAutomationsForBillingTransferPipeline',

  /**
   * Feature stacks deployed by the pipeline. Kept in sync with the CDK app;
   * the fleet-status feature count is derived from this list (never
   * hard-coded), mirroring the legacy `fleet-status.sh`.
   */
  featureStacks: [
    'BT-BillingGroupEventHandlerStack',
    'BT-BillingGroupReconciliationStack',
    'BT-CURReconciliationStack',
    'BT-BillingTransferTerminationStack',
    'BT-PartnerCentralChannelRolesStack',
  ] as const,

  /** Lambda function names (Req 21.1). */
  functions: {
    billingGroupReconciliation: 'billing-group-reconciliation',
    curReconciliation: 'cur-reconciliation',
    terminationHandler: 'billing-transfer-termination-handler',
  },

  /** Dead-letter-queue names for the reconciliation functions (Req 21.1). */
  dlqs: {
    billingGroupReconciliation: 'billing-reconciliation-dlq',
    curReconciliation: 'cur-reconciliation-dlq',
  },

  /**
   * Partner Central channel-role SSM parameter paths seeded into payer
   * accounts (ported from `scripts/seed-channel-role-params.sh`).
   */
  ssmParams: {
    linkedAccountId: '/billing-transfer/partner-central/linked-account-id',
    enableManagementRole: '/billing-transfer/partner-central/enable-management-role',
  },
} as const;

/** Feature-stack count is derived, never hard-coded (mirrors fleet-status.sh). */
export const FEATURE_STACK_COUNT = ResourceRegistry.featureStacks.length;
