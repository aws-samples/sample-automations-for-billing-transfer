// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeEach } from '@jest/globals';
/**
 * Unit tests for the {@link IdempotentRole} L3 construct
 * (`lib/constructs/idempotent-role.ts`).
 *
 * These tests synthesize the construct onto a tiny throwaway CDK `Stack` and
 * assert on the resulting CloudFormation template via
 * `aws-cdk-lib/assertions`. They verify the design contract from
 * Components #3 and Requirements 6.7 / 6.8:
 *
 * - Exactly one `Custom::PartnerCentralChannelRole` resource is synthesized per
 *   construct instance (one custom resource per role, so the skip-if-exists
 *   decision and its recorded outcome are strictly per-role).
 * - The custom resource is wired to the provided provider service token.
 * - The declarative {@link RoleSpec} is forwarded to the custom resource
 *   properties, with policy documents stringified for the handler.
 * - The provisioning `outcome` and `roleName` are exposed as custom-resource
 *   `getAttString` tokens for downstream output wiring.
 *
 * No real AWS account number is ever used: the sample spec is built from the
 * AWS-documentation placeholder linked-account id `111122223333`, and the
 * provider service token is a dummy literal (never a real provider ARN).
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { IdempotentRole } from '../../../lib/constructs/idempotent-role.js';
import {
  RoleSpec,
  buildPayerTrustPolicy,
  buildReadOnlyPolicy,
} from '../../../lib/stacks/channel-role-specs.js';

/** CloudFormation custom-resource type emitted by {@link IdempotentRole}. */
const CUSTOM_RESOURCE_TYPE = 'Custom::PartnerCentralChannelRole';

/** Documentation placeholder linked-account id — never a real AWS account. */
const PLACEHOLDER_LINKED_ACCOUNT_ID = '111122223333';

/** Dummy provider service token — never a real `Provider.serviceToken` ARN. */
const DUMMY_SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:111122223333:function:dummy-provider';

/**
 * Builds a representative {@link RoleSpec} for the Billing Transfer Read-Only
 * role using the real policy builders, so the test exercises the same property
 * shapes the stack produces at synth time.
 */
function sampleRoleSpec(): RoleSpec {
  return {
    RoleName: 'PartnerCentralChannelBillingTransferReadOnly',
    AssumeRolePolicyDocument: buildPayerTrustPolicy(PLACEHOLDER_LINKED_ACCOUNT_ID),
    ManagedPolicyArns: [],
    InlinePolicies: [
      {
        PolicyName: 'BillingTransferReadOnlyPolicy',
        PolicyDocument: buildReadOnlyPolicy(),
      },
    ],
    Tags: [{ Key: 'Project', Value: 'BillingTransferAutomation' }],
    OwnershipTag: { Key: 'ManagedBy', Value: 'PartnerCentralChannelRolesStack' },
  };
}

describe('IdempotentRole construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
  });

  test('synthesizes exactly one custom resource per construct instance', () => {
    new IdempotentRole(stack, 'ReadOnlyRole', {
      serviceToken: DUMMY_SERVICE_TOKEN,
      spec: sampleRoleSpec(),
    });

    const template = Template.fromStack(stack);

    // One custom resource per role (Requirement 6.7 — strictly per-role).
    template.resourceCountIs(CUSTOM_RESOURCE_TYPE, 1);
  });

  test('wires the custom resource to the provided provider service token', () => {
    new IdempotentRole(stack, 'ReadOnlyRole', {
      serviceToken: DUMMY_SERVICE_TOKEN,
      spec: sampleRoleSpec(),
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
      ServiceToken: DUMMY_SERVICE_TOKEN,
    });
  });

  test('forwards the role spec to the custom resource properties', () => {
    const spec = sampleRoleSpec();

    new IdempotentRole(stack, 'ReadOnlyRole', {
      serviceToken: DUMMY_SERVICE_TOKEN,
      spec,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties(CUSTOM_RESOURCE_TYPE, {
      RoleName: spec.RoleName,
      // Policy documents are stringified so CloudFormation does not flatten
      // them to "[object Object]"; the handler parses them back.
      AssumeRolePolicyDocument: JSON.stringify(spec.AssumeRolePolicyDocument),
      ManagedPolicyArns: spec.ManagedPolicyArns,
      InlinePolicies: [
        {
          PolicyName: 'BillingTransferReadOnlyPolicy',
          PolicyDocument: JSON.stringify(spec.InlinePolicies[0].PolicyDocument),
        },
      ],
      Tags: Match.arrayWith([{ Key: 'Project', Value: 'BillingTransferAutomation' }]),
      OwnershipTag: { Key: 'ManagedBy', Value: 'PartnerCentralChannelRolesStack' },
    });
  });

  test('exposes outcome and roleName as unresolved getAttString tokens', () => {
    const construct = new IdempotentRole(stack, 'ReadOnlyRole', {
      serviceToken: DUMMY_SERVICE_TOKEN,
      spec: sampleRoleSpec(),
    });

    // Both attributes are exposed for downstream CfnOutput wiring (Req 6.8).
    expect(construct.outcome).toBeDefined();
    expect(construct.roleName).toBeDefined();

    // getAttString returns CloudFormation Fn::GetAtt tokens, not literal values.
    expect(cdk.Token.isUnresolved(construct.outcome)).toBe(true);
    expect(cdk.Token.isUnresolved(construct.roleName)).toBe(true);

    // The tokens resolve to Fn::GetAtt against the custom resource's logical id.
    const resolvedOutcome = stack.resolve(construct.outcome) as {
      'Fn::GetAtt': [string, string];
    };
    const resolvedRoleName = stack.resolve(construct.roleName) as {
      'Fn::GetAtt': [string, string];
    };

    const [outcomeLogicalId, outcomeAttr] = resolvedOutcome['Fn::GetAtt'];
    const [roleNameLogicalId, roleNameAttr] = resolvedRoleName['Fn::GetAtt'];

    // Both read attributes off the same custom resource under this construct.
    expect(outcomeAttr).toBe('Outcome');
    expect(roleNameAttr).toBe('RoleName');
    expect(outcomeLogicalId).toMatch(/ReadOnlyRole/);
    expect(roleNameLogicalId).toMatch(/ReadOnlyRole/);
    expect(outcomeLogicalId).toBe(roleNameLogicalId);
  });

  test('synthesizes one custom resource per instance when multiple are created', () => {
    new IdempotentRole(stack, 'ReadOnlyRole', {
      serviceToken: DUMMY_SERVICE_TOKEN,
      spec: sampleRoleSpec(),
    });
    new IdempotentRole(stack, 'HandshakeRole', {
      serviceToken: DUMMY_SERVICE_TOKEN,
      spec: {
        ...sampleRoleSpec(),
        RoleName: 'PartnerCentralChannelHandshakeApprovalManagement',
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/AWSPartnerCentralChannelHandshakeApprovalManagement',
        ],
        InlinePolicies: [],
      },
    });

    const template = Template.fromStack(stack);

    // Two construct instances => two independent custom resources.
    template.resourceCountIs(CUSTOM_RESOURCE_TYPE, 2);
  });
});
