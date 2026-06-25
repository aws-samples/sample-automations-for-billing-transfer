// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based template test for the provider handler's execution-role IAM
 * scoping in {@link PartnerCentralChannelRolesStack}
 * (`lib/stacks/partner-central-channel-roles-stack.ts`).
 *
 * Covers the design's Correctness Property 9 and Requirement 7.3 (handler
 * execution-role least privilege): the role-lifecycle IAM actions the provider
 * handler is granted must be constrained to the exact managed role-name ARNs
 * and must never use a wildcard (`*`) resource.
 *
 * The stack is synthesized with `Template.fromStack` for fast-check-generated
 * inputs, and every IAM policy statement that grants a role-management action
 * (`iam:GetRole`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`,
 * `iam:AttachRolePolicy`, `iam:TagRole`) is asserted to scope its `Resource`
 * to only the specific `arn:aws:iam::<account>:role/PartnerCentralChannel...`
 * ARNs this stack manages, never `*`. Statements that grant only other actions
 * (for example X-Ray `PutTraceSegments`/`PutTelemetryRecords`, which legitimately
 * use a wildcard resource, or the CDK Provider framework's
 * `lambda:InvokeFunction`) are ignored by filtering on the relevant `iam:`
 * role-management actions.
 *
 * No real AWS account number is ever used: every linked-account id and every
 * deployment env account is a fast-check-generated 12-digit string (or a
 * documentation placeholder), never a real account number.
 */

import fc from 'fast-check';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { PartnerCentralChannelRolesStack } from '../../../lib/stacks/partner-central-channel-roles-stack.js';
import { buildRoleSpecs } from '../../../lib/stacks/channel-role-specs.js';

/**
 * The role-management IAM actions whose statements must be ARN-scoped per
 * Property 9 / Requirement 7.3. A statement is "relevant" if it grants any of
 * these actions.
 */
const ROLE_MANAGEMENT_ACTIONS: readonly string[] = [
  'iam:GetRole',
  'iam:CreateRole',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:TagRole',
];

/** A well-formed AWS 12-digit account id (never a real account number). */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** Normalizes a single-or-list IAM JSON value (Action/Resource) to an array. */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** The set of managed role-name ARNs the stack scopes the handler to. */
function expectedManagedRoleArns(
  envAccountId: string,
  partnerCentralLinkedAccountId: string,
  enableManagementRole: boolean
): string[] {
  return buildRoleSpecs({
    partnerCentralLinkedAccountId,
    enableManagementRole,
  }).map((spec) => `arn:aws:iam::${envAccountId}:role/${spec.RoleName}`);
}

describe('PartnerCentralChannelRolesStack - handler execution-role ARN scoping (property test)', () => {
  // Feature: partner-central-channel-roles, Property 9: Handler execution role is constrained to the managed role-name ARNs
  it('scopes every role-management IAM statement to only the managed role-name ARNs and never to "*"', () => {
    fc.assert(
      fc.property(
        accountIdArb,
        accountIdArb,
        fc.boolean(),
        (linkedAccountId, envAccountId, enableManagementRole) => {
          const app = new cdk.App();
          const stack = new PartnerCentralChannelRolesStack(
            app,
            'HandlerRoleScopingTestStack',
            {
              env: { account: envAccountId, region: 'us-east-1' },
              partnerCentralLinkedAccountId: linkedAccountId,
              enableManagementRole,
            }
          );

          const template = Template.fromStack(stack);

          const expectedArns = expectedManagedRoleArns(
            envAccountId,
            linkedAccountId,
            enableManagementRole
          );
          const expectedArnSet = new Set(expectedArns);

          // Scan every IAM policy statement in the template. For each statement
          // that grants any role-management action, its Resource must be the
          // exact managed role-name ARN set and must never be '*'.
          const policies = template.findResources('AWS::IAM::Policy');
          let relevantStatementCount = 0;

          for (const policyKey of Object.keys(policies)) {
            const statements = toArray(
              policies[policyKey].Properties?.PolicyDocument?.Statement
            ) as Array<{
              Sid?: string;
              Action?: string | string[];
              Resource?: string | string[];
            }>;

            for (const statement of statements) {
              const actions = toArray(statement.Action);
              const grantsRoleManagement = actions.some((action) =>
                ROLE_MANAGEMENT_ACTIONS.includes(action)
              );
              if (!grantsRoleManagement) {
                continue; // ignore X-Ray, lambda:InvokeFunction, logs, etc.
              }

              relevantStatementCount += 1;

              const resources = toArray(statement.Resource);

              // Never a wildcard resource — neither '*' alone nor within a list.
              expect(resources).not.toContain('*');

              // Every resource is a concrete managed role-name ARN of the
              // expected shape (account is concrete, so no unresolved tokens).
              for (const resource of resources) {
                expect(typeof resource).toBe('string');
                expect(resource).not.toBe('*');
                expect(resource).toMatch(
                  /^arn:aws:iam::\d{12}:role\/PartnerCentralChannel/
                );
              }

              // The statement is scoped to ONLY the managed role-name ARNs.
              expect(new Set(resources)).toEqual(expectedArnSet);
            }
          }

          // The stack must actually grant the role-management actions, so the
          // property is not vacuously satisfied: the ManageChannelRoles
          // statement (Get/Create/Delete/Tag/Put/DeleteRolePolicy/...) and the
          // AttachChannelManagedPolicies statement (AttachRolePolicy) are both
          // present and ARN-scoped.
          expect(relevantStatementCount).toBeGreaterThanOrEqual(2);

          // A positive Match-based assertion of the ARN shape: the
          // ManageChannelRoles statement constrains its Resource to the
          // role-name ARNs and never to '*'.
          template.hasResourceProperties(
            'AWS::IAM::Policy',
            Match.objectLike({
              PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                  Match.objectLike({
                    Sid: 'ManageChannelRoles',
                    Resource: Match.arrayWith([
                      Match.stringLikeRegexp(
                        '^arn:aws:iam::[0-9]{12}:role/PartnerCentralChannel'
                      ),
                    ]),
                  }),
                ]),
              }),
            })
          );
        }
      ),
      { numRuns: 100 }
    );
  }, 600000);
});
