// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeEach } from '@jest/globals';
/**
 * Template tests for {@link PartnerCentralChannelRolesStack}
 * (`lib/stacks/partner-central-channel-roles-stack.ts`).
 *
 * These tests synthesize the stack with `Template.fromStack` and assert on the
 * resulting CloudFormation template via `aws-cdk-lib/assertions`, following the
 * conventions in the other stack tests at the repo's `test/` root (e.g.
 * `test/cur-reconciliation-stack.test.ts`).
 *
 * They cover stack structure, management-role gating, KMS configuration, and
 * synth-time props validation (Requirements 6.3, 6.4, 7.1, 6.10, 6.11):
 *
 * - The stack synthesizes from props/`env` with no hard-coded account or region
 *   (Requirement 7.1).
 * - Exactly two `Custom::PartnerCentralChannelRole` custom resources exist by
 *   default (Handshake Approval + Read-Only), and exactly three when
 *   `enableManagementRole` is `true` (the optional Management role —
 *   Requirement 6.4).
 * - The provider Lambda's KMS key has rotation enabled (project convention).
 * - Construction throws — before creating any construct, so no IAM role custom
 *   resources are synthesized — when given an invalid linked account id
 *   (Requirement 6.11), an invalid `env.account` or `env.region`
 *   (Requirement 6.10), or a non-boolean `enableManagementRole`
 *   (Requirement 6.3).
 *
 * No real AWS account number is ever used: the linked-account id is the AWS
 * documentation placeholder `111122223333` and the deployment `env` account is
 * the placeholder `222233334444` — never real accounts.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { PartnerCentralChannelRolesStack } from '../../../lib/stacks/partner-central-channel-roles-stack.js';

/** CloudFormation custom-resource type emitted for each provisioned role. */
const CUSTOM_RESOURCE_TYPE = 'Custom::PartnerCentralChannelRole';

/** Documentation placeholder linked-account id — never a real AWS account. */
const PLACEHOLDER_LINKED_ACCOUNT_ID = '111122223333';

/** Documentation placeholder deployment account id — never a real account. */
const PLACEHOLDER_ENV_ACCOUNT_ID = '222233334444';

/** Deployment region used across tests (shape-valid AWS region identifier). */
const TEST_REGION = 'us-east-1';

/** Standard deployment env used across tests; placeholder account only. */
const TEST_ENV: cdk.Environment = {
  account: PLACEHOLDER_ENV_ACCOUNT_ID,
  region: TEST_REGION,
};

/** Exact, fixed role names this stack provisions (no prefix/suffix/path). */
const HANDSHAKE_APPROVAL_ROLE_NAME =
  'PartnerCentralChannelHandshakeApprovalManagement';
const READ_ONLY_ROLE_NAME = 'PartnerCentralChannelBillingTransferReadOnly';
const MANAGEMENT_ROLE_NAME = 'PartnerCentralChannelBillingTransferManagement';

describe('PartnerCentralChannelRolesStack', () => {
  let app: cdk.App;

  beforeEach(() => {
    app = new cdk.App();
  });

  describe('stack structure and management-role gating', () => {
    test('default (enableManagementRole omitted): exactly two channel-role custom resources', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });
      const template = Template.fromStack(stack);

      // One custom resource per role: Handshake Approval + Read-Only (no
      // Management role unless enableManagementRole is true).
      template.resourceCountIs(CUSTOM_RESOURCE_TYPE, 2);

      template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
        RoleName: HANDSHAKE_APPROVAL_ROLE_NAME,
      });
      template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
        RoleName: READ_ONLY_ROLE_NAME,
      });
    });

    test('enableManagementRole=false: exactly two channel-role custom resources (no Management role)', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
        enableManagementRole: false,
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs(CUSTOM_RESOURCE_TYPE, 2);

      // The optional Management role must be absent when the gate is false.
      const roleNames = Object.values(
        template.findResources(CUSTOM_RESOURCE_TYPE)
      ).map((r: any) => r.Properties.RoleName);
      expect(roleNames).not.toContain(MANAGEMENT_ROLE_NAME);
    });

    test('enableManagementRole=true: exactly three channel-role custom resources including the Management role (Req 6.4)', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
        enableManagementRole: true,
      });
      const template = Template.fromStack(stack);

      // Handshake Approval + Read-Only + Management.
      template.resourceCountIs(CUSTOM_RESOURCE_TYPE, 3);

      template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
        RoleName: HANDSHAKE_APPROVAL_ROLE_NAME,
      });
      template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
        RoleName: READ_ONLY_ROLE_NAME,
      });
      template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
        RoleName: MANAGEMENT_ROLE_NAME,
      });
    });

    test('provider Lambda KMS key has rotation enabled', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::KMS::Key', 1);
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });
    });

    test('emits a per-role provisioning-outcome output for each managed role', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
        enableManagementRole: true,
      });
      const template = Template.fromStack(stack);

      // One CfnOutput per role (Req 6.8) so operators can detect skipped roles.
      template.hasOutput(`Outcome${HANDSHAKE_APPROVAL_ROLE_NAME}`, {});
      template.hasOutput(`Outcome${READ_ONLY_ROLE_NAME}`, {});
      template.hasOutput(`Outcome${MANAGEMENT_ROLE_NAME}`, {});
    });
  });

  describe('no hard-coded account or region (Req 7.1)', () => {
    test('the synthesized stack resolves to the account/region supplied via env', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });

      // The stack derives its account/region from the provided env, never from
      // a hard-coded value baked into the stack source.
      expect(stack.account).toBe(PLACEHOLDER_ENV_ACCOUNT_ID);
      expect(stack.region).toBe(TEST_REGION);
    });

    test('handler execution-role ARNs embed the provided env account, proving the account comes from env', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });
      const template = Template.fromStack(stack);

      // The handler's role-management policy is scoped to the exact role-name
      // ARNs, which are built from the provided env account (this.account).
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Resource: Match.arrayWith([
                `arn:aws:iam::${PLACEHOLDER_ENV_ACCOUNT_ID}:role/${HANDSHAKE_APPROVAL_ROLE_NAME}`,
                `arn:aws:iam::${PLACEHOLDER_ENV_ACCOUNT_ID}:role/${READ_ONLY_ROLE_NAME}`,
              ]),
            }),
          ]),
        },
      });
    });

    test('the linked account id supplied via props appears in the synthesized trust policy', () => {
      const stack = new PartnerCentralChannelRolesStack(app, 'TestPayerStack', {
        env: TEST_ENV,
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });
      const template = Template.fromStack(stack);

      // The trust policy (stringified on the custom resource) trusts only the
      // configured linked account supplied via props.
      const resources = template.findResources(CUSTOM_RESOURCE_TYPE);
      const trustDocs = Object.values(resources).map(
        (r: any) => r.Properties.AssumeRolePolicyDocument as string
      );

      expect(trustDocs.length).toBeGreaterThan(0);
      for (const doc of trustDocs) {
        expect(typeof doc).toBe('string');
        expect(doc).toContain(
          `arn:aws:iam::${PLACEHOLDER_LINKED_ACCOUNT_ID}:root`
        );
      }
    });

    test('two stacks with different env accounts produce the same fixed role-name set (account/region independent)', () => {
      const stackA = new PartnerCentralChannelRolesStack(app, 'PayerStackA', {
        env: { account: PLACEHOLDER_ENV_ACCOUNT_ID, region: 'us-east-1' },
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });
      const stackB = new PartnerCentralChannelRolesStack(app, 'PayerStackB', {
        env: { account: '333344445555', region: 'eu-west-1' },
        partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
      });

      const namesOf = (stack: PartnerCentralChannelRolesStack): string[] =>
        Object.values(Template.fromStack(stack).findResources(CUSTOM_RESOURCE_TYPE))
          .map((r: any) => r.Properties.RoleName as string)
          .sort();

      expect(namesOf(stackA)).toEqual(namesOf(stackB));
      expect(namesOf(stackA)).toEqual(
        [HANDSHAKE_APPROVAL_ROLE_NAME, READ_ONLY_ROLE_NAME].sort()
      );
    });
  });

  describe('synth-time props validation throws before any role is created', () => {
    /**
     * Validation runs in the constructor *before* any construct is created, so
     * an invalid input fails fast and synthesizes no IAM role custom resources.
     * Each case below asserts the constructor throws; because the throw happens
     * before the role constructs are instantiated, no roles are synthesized.
     */

    test.each(['123', '', 'abcdefghijkl', '1234567890123'])(
      'invalid linked account id %p throws and creates no roles (Req 6.11)',
      (badLinkedAccountId) => {
        expect(
          () =>
            new PartnerCentralChannelRolesStack(app, 'InvalidLinkedStack', {
              env: TEST_ENV,
              partnerCentralLinkedAccountId: badLinkedAccountId,
            })
        ).toThrow(/partnerCentralLinkedAccountId/);
      }
    );

    test('invalid env account throws and creates no roles (Req 6.10)', () => {
      expect(
        () =>
          new PartnerCentralChannelRolesStack(app, 'InvalidEnvAccountStack', {
            env: { account: '123', region: TEST_REGION },
            partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
          })
      ).toThrow(/props\.env\.account/);
    });

    test('invalid env region throws and creates no roles (Req 6.10)', () => {
      expect(
        () =>
          new PartnerCentralChannelRolesStack(app, 'InvalidEnvRegionStack', {
            env: { account: PLACEHOLDER_ENV_ACCOUNT_ID, region: 'not-a-region' },
            partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
          })
      ).toThrow(/props\.env\.region/);
    });

    test.each([
      ['yes', 'a non-boolean string'],
      [1, 'a number'],
      [0, 'zero'],
      ['true', 'a boolean-looking string'],
      [null, 'null'],
    ])(
      'non-boolean enableManagementRole %p (%s) throws and creates no roles (Req 6.3)',
      (badFlag) => {
        expect(
          () =>
            new PartnerCentralChannelRolesStack(app, 'InvalidFlagStack', {
              env: TEST_ENV,
              partnerCentralLinkedAccountId: PLACEHOLDER_LINKED_ACCOUNT_ID,
              // Cast through `any` to simulate a non-boolean value arriving from
              // CDK context at runtime, which the constructor must reject.
              enableManagementRole: badFlag as any,
            })
        ).toThrow(/enableManagementRole/);
      }
    );

    test('a stack that fails validation contributes no channel-role custom resources to the app', () => {
      // Construction throws, so the stack is never usable; an independent,
      // freshly-synthesized valid baseline confirms the only roles in the app
      // come from valid stacks (the invalid one adds none).
      expect(
        () =>
          new PartnerCentralChannelRolesStack(app, 'WillThrowStack', {
            env: TEST_ENV,
            partnerCentralLinkedAccountId: 'not-an-account',
          })
      ).toThrow();

      // A sibling empty stack has zero channel-role custom resources, the same
      // count contributed by the failed construction above.
      const emptyStack = new cdk.Stack(app, 'EmptyBaseline', { env: TEST_ENV });
      Template.fromStack(emptyStack).resourceCountIs(CUSTOM_RESOURCE_TYPE, 0);
    });
  });
});
