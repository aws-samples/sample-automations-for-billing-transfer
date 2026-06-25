// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
/**
 * Property-based tests for the Partner Central channel-roles provider Lambda
 * create / update / skip decision in
 * `lib/lambda/partner-central-channel-roles/index.ts`.
 *
 * Covers the correctness property from the design document:
 * - Property 6: Per-role provisioning decision is create / update / skip by
 *   ownership (Requirements 6.6, 6.7, 6.8, 8.1, 8.3, 8.4)
 *
 * Two layers are exercised:
 *   1. The pure `decideAction(requestType, getRoleResult)` function over every
 *      combination of request type (`Create`/`Update`) and live role state
 *      (absent, present-with-ownership-tag, present-without-ownership-tag).
 *   2. The `onEvent` handler with IAM mocked via `aws-sdk-client-mock`, asserting
 *      that:
 *        - an absent role is created and tagged with the ownership marker
 *          (Outcome `created`);
 *        - a present, stack-owned role is updated (Outcome `updated`);
 *        - a present, foreign (un-owned) role is skipped with ZERO mutating IAM
 *          calls (no CreateRole/PutRolePolicy/AttachRolePolicy/
 *          UpdateAssumeRolePolicy/DeleteRole) and a "skipped because it already
 *          existed" log entry (Outcome `skipped`);
 *        - the response data always records the per-role `RoleName` and the
 *          correct `Outcome`;
 *        - the decision is evaluated independently per role.
 *
 * Each property runs a minimum of 100 iterations.
 *
 * No real AWS account number is ever hard-coded: every ARN is built from a
 * fast-check-generated 12-digit placeholder, and role names are synthetic.
 */

import fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  DeleteRoleCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const iamMock = mockClient(IAMClient);

import {
  onEvent,
  decideAction,
  type RoleLookupResult,
} from '../../../lib/lambda/partner-central-channel-roles/index.js';
import { logger } from '../../../lib/lambda/common/utils/logger.js';
import type { PolicyDocumentJson } from '../../../lib/stacks/channel-role-specs.js';

// --- Fixtures ---

/** The stack's ownership marker tag (matches the design's `OwnershipTag`). */
const OWNERSHIP_TAG = { Key: 'ManagedBy', Value: 'partner-central-channel-roles' };

/** The three live states a target role can be in when the handler runs. */
type RoleState = 'absent' | 'owned' | 'foreign';

/** The Outcome the handler is expected to report for each state. */
function expectedOutcome(state: RoleState): 'created' | 'updated' | 'skipped' {
  if (state === 'absent') return 'created';
  if (state === 'owned') return 'updated';
  return 'skipped';
}

/** Mutating IAM commands that must NEVER fire on the skip path. */
const MUTATING_COMMANDS = [
  CreateRoleCommand,
  PutRolePolicyCommand,
  AttachRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
] as const;

/**
 * Build an IAM "role does not exist" exception (the only error the handler
 * treats as a definitive "absent" result).
 */
function noSuchEntityError(): Error {
  return new NoSuchEntityException({
    message: 'The role with name does not exist.',
    $metadata: {},
  });
}

/** A minimal, valid permission/policy document for inline policies & trust. */
function samplePolicyDoc(): PolicyDocumentJson {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'organizations:DescribeResponsibilityTransfer',
        Resource: '*',
      },
    ],
  };
}

/**
 * Configure the IAM mock so that every command the create/update path may issue
 * resolves successfully. `GetRole` is configured per-test on top of this.
 */
function stubMutatingCommands(roleArn: string): void {
  iamMock.on(CreateRoleCommand).resolves({ Role: { RoleName: 'r', Arn: roleArn } as any });
  iamMock.on(PutRolePolicyCommand).resolves({});
  iamMock.on(UpdateAssumeRolePolicyCommand).resolves({});
  iamMock.on(AttachRolePolicyCommand).resolves({});
  iamMock.on(DetachRolePolicyCommand).resolves({});
  iamMock.on(DeleteRolePolicyCommand).resolves({});
  iamMock.on(DeleteRoleCommand).resolves({});
  // Pagination terminators for the update reconcile path.
  iamMock.on(ListRolePoliciesCommand).resolves({ PolicyNames: [], IsTruncated: false });
  iamMock
    .on(ListAttachedRolePoliciesCommand)
    .resolves({ AttachedPolicies: [], IsTruncated: false });
}

/** Build a Create/Update custom-resource event for a single role. */
function makeEvent(
  requestType: 'Create' | 'Update',
  roleName: string,
  options: {
    managedPolicyArns?: string[];
    inlinePolicies?: { PolicyName: string; PolicyDocument: PolicyDocumentJson }[];
  } = {}
) {
  return {
    RequestType: requestType,
    ResourceProperties: {
      RoleName: roleName,
      AssumeRolePolicyDocument: samplePolicyDoc(),
      ManagedPolicyArns: options.managedPolicyArns ?? [],
      InlinePolicies: options.inlinePolicies ?? [],
      Tags: [{ Key: 'Project', Value: 'SampleAutomationsForBillingTransfer' }],
      OwnershipTag: OWNERSHIP_TAG,
    },
  } as Parameters<typeof onEvent>[0];
}

// --- Arbitraries ---

/** A 12-digit placeholder account id (never a real account number). */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** CloudFormation request types that flow through the create/update decision. */
const requestTypeArb = fc.constantFrom<'Create' | 'Update'>('Create', 'Update');

/** A synthetic, fixed-name channel role (no account/region in the name). */
const roleNameArb = fc.constantFrom(
  'PartnerCentralChannelHandshakeApprovalManagement',
  'PartnerCentralChannelBillingTransferReadOnly',
  'PartnerCentralChannelBillingTransferManagement',
  'PartnerCentralRoleForChannel'
);

/** One of the three live role states. */
const stateArb = fc.constantFrom<RoleState>('absent', 'owned', 'foreign');

/** Tags for a "foreign" role: guaranteed NOT to contain the ownership marker. */
const foreignTagsArb = fc
  .array(
    fc.record({
      Key: fc.string({ minLength: 1, maxLength: 16 }),
      Value: fc.string({ minLength: 0, maxLength: 16 }),
    }),
    { maxLength: 3 }
  )
  .map((tags) =>
    tags.filter((t) => !(t.Key === OWNERSHIP_TAG.Key && t.Value === OWNERSHIP_TAG.Value))
  );

/** 0-2 inline policies. */
const inlinePoliciesArb = fc.array(
  fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((s) => s.trim().length > 0)
    .map((name) => ({ PolicyName: `${name}Policy`, PolicyDocument: samplePolicyDoc() })),
  { maxLength: 2 }
);

/** 0-2 AWS-managed policy ARNs (account segment is the literal `aws`). */
const managedArnsArb = fc.array(
  fc.constantFrom(
    'arn:aws:iam::aws:policy/AWSPartnerCentralChannelHandshakeApprovalManagement',
    'arn:aws:iam::aws:policy/AWSPartnerCentralChannelManagement'
  ),
  { maxLength: 2 }
);

// --- Logger spy ---

let infoSpy: jest.SpyInstance;

beforeEach(() => {
  iamMock.reset();
  infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  infoSpy.mockRestore();
});

describe('Partner Central channel roles - create/update/skip decision (property tests)', () => {
  // Feature: partner-central-channel-roles, Property 6: Per-role provisioning decision is create / update / skip by ownership
  it('decideAction maps (requestType x live state) to create/update/skip purely by existence + ownership', () => {
    const caseArb = fc.oneof(
      fc.constant<{ state: RoleState; lookup: RoleLookupResult }>({
        state: 'absent',
        lookup: { exists: false, ownedByStack: false },
      }),
      accountIdArb.map((acct) => ({
        state: 'owned' as RoleState,
        lookup: {
          exists: true,
          ownedByStack: true,
          roleArn: `arn:aws:iam::${acct}:role/PartnerCentralChannelTestRole`,
        },
      })),
      accountIdArb.map((acct) => ({
        state: 'foreign' as RoleState,
        lookup: {
          exists: true,
          ownedByStack: false,
          roleArn: `arn:aws:iam::${acct}:role/PartnerCentralChannelTestRole`,
        },
      }))
    );

    fc.assert(
      fc.property(requestTypeArb, caseArb, (requestType, { state, lookup }) => {
        const action = decideAction(requestType, lookup);

        if (state === 'absent') {
          expect(action).toBe('create');
        } else if (state === 'owned') {
          expect(action).toBe('update');
        } else {
          expect(action).toBe('skip');
        }

        // The decision is existence/ownership-driven and identical for Create
        // and Update — the request type must not change it.
        expect(decideAction('Create', lookup)).toBe(action);
        expect(decideAction('Update', lookup)).toBe(action);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: partner-central-channel-roles, Property 6: Per-role provisioning decision is create / update / skip by ownership
  it('onEvent creates+tags when absent, updates when stack-owned, and skips (zero mutating IAM calls) when foreign', async () => {
    await fc.assert(
      fc.asyncProperty(
        requestTypeArb,
        stateArb,
        roleNameArb,
        accountIdArb,
        foreignTagsArb,
        inlinePoliciesArb,
        managedArnsArb,
        async (
          requestType,
          state,
          roleName,
          accountId,
          foreignTags,
          inlinePolicies,
          managedPolicyArns
        ) => {
          iamMock.reset();
          infoSpy.mockClear();

          const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
          stubMutatingCommands(roleArn);

          // Configure GetRole to reflect the generated live state.
          if (state === 'absent') {
            iamMock.on(GetRoleCommand).rejects(noSuchEntityError());
          } else {
            const tags =
              state === 'owned'
                ? [OWNERSHIP_TAG, ...foreignTags]
                : foreignTags;
            iamMock.on(GetRoleCommand).resolves({
              Role: { RoleName: roleName, Arn: roleArn, Tags: tags } as any,
            });
          }

          const response = await onEvent(
            makeEvent(requestType, roleName, { inlinePolicies, managedPolicyArns })
          );

          // Response data always records the per-role name and correct outcome.
          expect(response.PhysicalResourceId).toBe(roleName);
          expect(response.Data.RoleName).toBe(roleName);
          expect(response.Data.Outcome).toBe(expectedOutcome(state));

          const createCalls = iamMock.commandCalls(CreateRoleCommand);

          if (state === 'absent') {
            // Created exactly once and tagged with the ownership marker.
            expect(createCalls.length).toBe(1);
            const input = createCalls[0].args[0].input as {
              RoleName?: string;
              Tags?: { Key?: string; Value?: string }[];
            };
            expect(input.RoleName).toBe(roleName);
            expect(input.Tags).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  Key: OWNERSHIP_TAG.Key,
                  Value: OWNERSHIP_TAG.Value,
                }),
              ])
            );
          } else if (state === 'owned') {
            // Updated in place: trust policy refreshed, never created/deleted.
            expect(createCalls.length).toBe(0);
            expect(iamMock.commandCalls(UpdateAssumeRolePolicyCommand).length).toBe(1);
            expect(iamMock.commandCalls(DeleteRoleCommand).length).toBe(0);
          } else {
            // Foreign role: skipped with ZERO mutating IAM calls.
            for (const command of MUTATING_COMMANDS) {
              expect(iamMock.commandCalls(command).length).toBe(0);
            }
            // Skips emit a "skipped because it already existed" log entry.
            const skipLogged = infoSpy.mock.calls.some(
              (call) =>
                typeof call[0] === 'string' &&
                /skipped/i.test(call[0]) &&
                (call[1] as { outcome?: string } | undefined)?.outcome === 'skipped'
            );
            expect(skipLogged).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: partner-central-channel-roles, Property 6: Per-role provisioning decision is create / update / skip by ownership
  it('decides each role independently: mixed states processed against one account yield per-role correct outcomes', async () => {
    const rolesArb = fc
      .array(stateArb, { minLength: 2, maxLength: 4 })
      .map((states) =>
        states.map((state, index) => ({
          roleName: `PartnerCentralChannelTestRole${index}`,
          state,
        }))
      );

    await fc.assert(
      fc.asyncProperty(rolesArb, accountIdArb, async (roles, accountId) => {
        iamMock.reset();
        infoSpy.mockClear();

        stubMutatingCommands(`arn:aws:iam::${accountId}:role/placeholder`);

        // Configure a per-role GetRole response reflecting that role's state.
        for (const { roleName, state } of roles) {
          const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
          if (state === 'absent') {
            iamMock.on(GetRoleCommand, { RoleName: roleName }).rejects(noSuchEntityError());
          } else {
            iamMock.on(GetRoleCommand, { RoleName: roleName }).resolves({
              Role: {
                RoleName: roleName,
                Arn: roleArn,
                Tags: state === 'owned' ? [OWNERSHIP_TAG] : [],
              } as any,
            });
          }
        }

        // Process each role and assert its own outcome — independent of the others.
        for (const { roleName, state } of roles) {
          const response = await onEvent(makeEvent('Create', roleName));
          expect(response.Data.RoleName).toBe(roleName);
          expect(response.Data.Outcome).toBe(expectedOutcome(state));

          if (state === 'foreign') {
            // No mutating call targeted this specific role.
            for (const command of MUTATING_COMMANDS) {
              const callsForRole = iamMock
                .commandCalls(command)
                .filter(
                  (call) =>
                    (call.args[0].input as { RoleName?: string }).RoleName === roleName
                );
              expect(callsForRole.length).toBe(0);
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
