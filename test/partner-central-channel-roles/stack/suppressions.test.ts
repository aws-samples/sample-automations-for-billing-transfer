// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect } from '@jest/globals';
/**
 * Template test asserting the documented cdk-nag suppressions are present on
 * the synthesized {@link PartnerCentralChannelRolesStack}
 * (`lib/stacks/partner-central-channel-roles-stack.ts`).
 *
 * This is an *example-based* template test (not a property-based test): the
 * suppression set is fixed and does not vary meaningfully with input, so a
 * single deterministic synthesis is the appropriate check (see the design's
 * Testing Strategy, "Why not PBT for some criteria").
 *
 * cdk-nag records each suppression as CloudFormation metadata on the affected
 * resource under the `cdk_nag` key, i.e.
 * `Resources[<logicalId>].Metadata.cdk_nag.rules_to_suppress`, where each entry
 * is `{ id, reason, applies_to? }`. To assert the suppressions are present we
 * synthesize the stack and walk every resource's metadata.
 *
 * Verifies Requirement 7.4:
 *  - the documented cdk-nag suppression ids (`AwsSolutions-IAM4`,
 *    `AwsSolutions-IAM5`, `AwsSolutions-L1`) are present;
 *  - every suppression carries a non-empty `reason` justification; and
 *  - no suppression `reason` contains a literal 12-digit AWS account id.
 *
 * No real AWS account number is ever used: the deployment env account is the
 * documentation placeholder `111122223333` and the linked-account id is the
 * placeholder `222233334444` — never real accounts.
 */

import * as cdk from 'aws-cdk-lib';

import { PartnerCentralChannelRolesStack } from '../../../lib/stacks/partner-central-channel-roles-stack.js';

/** Documentation placeholder deployment (program management) account id. */
const PLACEHOLDER_ENV_ACCOUNT_ID = '111122223333';

/** Documentation placeholder Partner Central Linked Account id. */
const PLACEHOLDER_LINKED_ACCOUNT_ID = '222233334444';

/** Standard deployment env used across tests; placeholder account only. */
const TEST_ENV: cdk.Environment = {
  account: PLACEHOLDER_ENV_ACCOUNT_ID,
  region: 'us-east-1',
};

/**
 * The cdk-nag finding ids the stack documents suppressions for (per the
 * design's "cdk-nag / Checkov Suppression Plan").
 */
const EXPECTED_SUPPRESSION_IDS = [
  'AwsSolutions-IAM4',
  'AwsSolutions-IAM5',
  'AwsSolutions-L1',
] as const;

/** Matches any run of exactly 12 digits — a literal AWS account id. */
const TWELVE_DIGIT_PATTERN = /\d{12}/;

/** A single cdk-nag suppression entry, as serialized into resource metadata. */
interface RuleToSuppress {
  readonly id: string;
  readonly reason: string;
  readonly applies_to?: unknown[];
}

/**
 * Synthesize the stack with the management role enabled (so all suppression
 * sites are exercised) and collect every cdk-nag suppression across the
 * template, tagged with the logical id of the resource it sits on.
 */
function collectSuppressions(): { logicalId: string; rule: RuleToSuppress }[] {
  const app = new cdk.App();
  const stack = new PartnerCentralChannelRolesStack(app, 'SuppressionsTestStack', {
    env: TEST_ENV,
    partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
    enableManagementRole: true,
  });

  const template = app.synth().getStackArtifact(stack.artifactId).template as {
    Resources?: Record<
      string,
      { Metadata?: { cdk_nag?: { rules_to_suppress?: RuleToSuppress[] } } }
    >;
  };

  const collected: { logicalId: string; rule: RuleToSuppress }[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    const rules = resource.Metadata?.cdk_nag?.rules_to_suppress;
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        collected.push({ logicalId, rule });
      }
    }
  }
  return collected;
}

describe('PartnerCentralChannelRolesStack cdk-nag suppressions', () => {
  test('synthesizes a non-empty set of documented suppressions', () => {
    const suppressions = collectSuppressions();

    // The stack documents suppressions for the provider handler and the CDK
    // Provider framework wiring — the set must not be empty (Requirement 7.4).
    expect(suppressions.length).toBeGreaterThan(0);
  });

  test.each(EXPECTED_SUPPRESSION_IDS)(
    'includes a documented suppression for %s',
    (expectedId) => {
      const suppressions = collectSuppressions();
      const matching = suppressions.filter(({ rule }) => rule.id === expectedId);

      // The documented finding id must appear on at least one resource.
      expect(matching.length).toBeGreaterThan(0);
    }
  );

  test('every suppression has a non-empty reason justification (Req 7.4)', () => {
    const suppressions = collectSuppressions();

    for (const { logicalId, rule } of suppressions) {
      expect(typeof rule.reason).toBe('string');
      // Non-empty after trimming whitespace — a real justification, not blank.
      expect(rule.reason.trim().length).toBeGreaterThan(0);

      // Guard against an accidental wrong-typed/empty reason on a known id.
      if (rule.reason.trim().length === 0) {
        throw new Error(
          `Suppression ${rule.id} on ${logicalId} has an empty reason`
        );
      }
    }
  });

  test('no suppression reason contains a literal 12-digit account id (Req 7.4)', () => {
    const suppressions = collectSuppressions();

    for (const { logicalId, rule } of suppressions) {
      expect(TWELVE_DIGIT_PATTERN.test(rule.reason)).toBe(false);

      if (TWELVE_DIGIT_PATTERN.test(rule.reason)) {
        throw new Error(
          `Suppression ${rule.id} on ${logicalId} leaks a 12-digit id in its reason`
        );
      }
    }
  });

  test('the placeholder linked/env account ids do not appear in any reason', () => {
    const suppressions = collectSuppressions();

    // Belt-and-suspenders: even the placeholder ids used to synthesize the
    // stack must not bleed into a suppression justification (justifications are
    // account-agnostic).
    for (const { rule } of suppressions) {
      expect(rule.reason).not.toContain(PLACEHOLDER_LINKED_ACCOUNT_ID);
      expect(rule.reason).not.toContain(PLACEHOLDER_ENV_ACCOUNT_ID);
    }
  });

  test('the handler Lambda carries IAM4, IAM5 and L1 suppressions', () => {
    const suppressions = collectSuppressions();

    // The provider handler function resource (logical id begins with
    // "ChannelRolesProviderHandler") should carry all three documented
    // findings — this is where the stack's own suppressions land.
    const handlerFnSuppressionIds = new Set(
      suppressions
        .filter(
          ({ logicalId }) =>
            logicalId.startsWith('ChannelRolesProviderHandler') &&
            !logicalId.includes('ServiceRole') &&
            !logicalId.includes('DefaultPolicy')
        )
        .map(({ rule }) => rule.id)
    );

    expect(handlerFnSuppressionIds).toEqual(
      new Set(['AwsSolutions-IAM4', 'AwsSolutions-IAM5', 'AwsSolutions-L1'])
    );
  });

  test('the CDK Provider framework wiring carries documented suppressions', () => {
    const suppressions = collectSuppressions();

    // The custom-resources.Provider framework Lambda/role wiring (logical id
    // contains "ChannelRolesProviderframework") must also be suppressed with
    // documented justifications.
    const frameworkSuppressions = suppressions.filter(({ logicalId }) =>
      logicalId.includes('ChannelRolesProviderframework')
    );

    expect(frameworkSuppressions.length).toBeGreaterThan(0);
    for (const { rule } of frameworkSuppressions) {
      expect(rule.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
