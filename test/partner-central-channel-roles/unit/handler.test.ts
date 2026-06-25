// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Unit tests for the Partner Central channel-roles provider Lambda handler
 * (`lib/lambda/partner-central-channel-roles/index.ts`).
 *
 * These example-based tests exercise the two deploy-time safety behaviors from
 * the design's "Error Handling" section that are not covered by the pure
 * decision-function property tests:
 *
 * - Managed-policy attach failure on the create path (Requirement 1.5): when
 *   `AttachRolePolicy` fails after the role and its inline policies were
 *   created, the handler best-effort rolls back (deletes inline policies +
 *   detaches managed policies + deletes the role) and throws, so no role
 *   persists without its required managed policy.
 * - Delete safety (Requirements 8.3, 8.4): on `Delete`, a role that does not
 *   carry this stack's ownership tag is left untouched (no `DeleteRole`), while
 *   a role that does carry the ownership tag is deleted.
 *
 * IAM is mocked with `aws-sdk-client-mock` per the project test conventions.
 *
 * No real AWS account number appears anywhere: a clearly-synthetic placeholder
 * 12-digit id is used to build the trust policy.
 */

import { mockClient } from 'aws-sdk-client-mock';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  DeleteRoleCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const iamMock = mockClient(IAMClient);

import { onEvent } from '../../../lib/lambda/partner-central-channel-roles/index.js';
import {
  buildPayerTrustPolicy,
  buildReadOnlyPolicy,
} from '../../../lib/stacks/channel-role-specs.js';

// --- Test fixtures (no real account ids) -----------------------------------

/** Clearly-synthetic placeholder linked account id — never a real account. */
const PLACEHOLDER_LINKED_ACCOUNT_ID = '000000000000';

/** The stack's ownership marker tag, matching the design data model. */
const OWNERSHIP_TAG = { Key: 'ManagedBy', Value: 'partner-central-channel-roles' };

const ROLE_NAME = 'PartnerCentralChannelBillingTransferReadOnly';
const ROLE_ARN = `arn:aws:iam::${PLACEHOLDER_LINKED_ACCOUNT_ID}:role/${ROLE_NAME}`;
const INLINE_POLICY_NAME = 'BillingTransferReadOnlyPolicy';
const MANAGED_POLICY_ARN =
  'arn:aws:iam::aws:policy/AWSPartnerCentralChannelHandshakeApprovalManagement';

/**
 * Build the custom-resource `ResourceProperties` in the design event shape:
 * stringified `AssumeRolePolicyDocument`, `ManagedPolicyArns`, `InlinePolicies`
 * with stringified `PolicyDocument`, `Tags`, and the `OwnershipTag` marker.
 */
function makeResourceProperties(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    RoleName: ROLE_NAME,
    AssumeRolePolicyDocument: JSON.stringify(
      buildPayerTrustPolicy(PLACEHOLDER_LINKED_ACCOUNT_ID)
    ),
    ManagedPolicyArns: [MANAGED_POLICY_ARN],
    InlinePolicies: [
      {
        PolicyName: INLINE_POLICY_NAME,
        PolicyDocument: JSON.stringify(buildReadOnlyPolicy()),
      },
    ],
    Tags: [{ Key: 'Project', Value: 'SampleAutomationsForBillingTransfer' }],
    OwnershipTag: OWNERSHIP_TAG,
    ...overrides,
  };
}

type HandlerEvent = Parameters<typeof onEvent>[0];

/** Construct a typed custom-resource event for the handler. */
function makeEvent(
  requestType: 'Create' | 'Update' | 'Delete',
  resourceProperties: Record<string, unknown>
): HandlerEvent {
  return { RequestType: requestType, ResourceProperties: resourceProperties } as HandlerEvent;
}

/** A `NoSuchEntity` error that makes `GetRole` report "role absent". */
function noSuchEntity(): NoSuchEntityException {
  return new NoSuchEntityException({ message: 'Role not found', $metadata: {} });
}

describe('Partner Central channel roles - provider handler (unit)', () => {
  beforeEach(() => {
    iamMock.reset();
  });

  // Requirement 1.5: managed-policy attach failure rolls back the partial role.
  describe('attach-failure rollback on the create path (Req 1.5)', () => {
    it('rolls back (deletes inline policies + role) and throws when AttachRolePolicy fails', async () => {
      // Create path: role absent -> create + inline policy succeed, attach fails.
      iamMock.on(GetRoleCommand).rejects(noSuchEntity());
      iamMock.on(CreateRoleCommand).resolves({ Role: { RoleName: ROLE_NAME, Arn: ROLE_ARN } as never });
      iamMock.on(PutRolePolicyCommand).resolves({});
      // Non-retryable failure (e.g. the managed policy ARN cannot be resolved).
      iamMock
        .on(AttachRolePolicyCommand)
        .rejects(new Error('The managed policy ARN could not be resolved'));
      // Rollback steps succeed.
      iamMock.on(DeleteRolePolicyCommand).resolves({});
      iamMock.on(DetachRolePolicyCommand).resolves({});
      iamMock.on(DeleteRoleCommand).resolves({});

      const event = makeEvent('Create', makeResourceProperties());

      // The handler throws so the deploy fails with a clear message.
      await expect(onEvent(event)).rejects.toThrow(/managed policy/i);

      // The role was created and an attach was attempted before the failure.
      expect(iamMock.commandCalls(CreateRoleCommand).length).toBe(1);
      expect(iamMock.commandCalls(AttachRolePolicyCommand).length).toBe(1);

      // Rollback deleted the role so none persists without its managed policy.
      const deleteRoleCalls = iamMock.commandCalls(DeleteRoleCommand);
      expect(deleteRoleCalls.length).toBe(1);
      expect(deleteRoleCalls[0].args[0].input).toMatchObject({ RoleName: ROLE_NAME });

      // Rollback also removed the inline policy that had been put on the role.
      const deletePolicyCalls = iamMock.commandCalls(DeleteRolePolicyCommand);
      expect(deletePolicyCalls.length).toBe(1);
      expect(deletePolicyCalls[0].args[0].input).toMatchObject({
        RoleName: ROLE_NAME,
        PolicyName: INLINE_POLICY_NAME,
      });
    });
  });

  // Requirements 8.3, 8.4: never delete a role this stack does not own.
  describe('delete safety (Reqs 8.3, 8.4)', () => {
    it('leaves a foreign role (without the ownership tag) untouched and reports "skipped"', async () => {
      // Role exists but lacks this stack's ownership tag.
      iamMock.on(GetRoleCommand).resolves({
        Role: {
          RoleName: ROLE_NAME,
          Arn: ROLE_ARN,
          Tags: [{ Key: 'SomeOtherOwner', Value: 'not-this-stack' }],
        } as never,
      });

      const event = makeEvent('Delete', makeResourceProperties());
      const response = await onEvent(event);

      // No destructive call was made against the foreign role.
      expect(iamMock.commandCalls(DeleteRoleCommand).length).toBe(0);
      expect(iamMock.commandCalls(DeleteRolePolicyCommand).length).toBe(0);
      expect(iamMock.commandCalls(DetachRolePolicyCommand).length).toBe(0);

      expect(response.Data.Outcome).toBe('skipped');
      expect(response.Data.RoleName).toBe(ROLE_NAME);
    });

    it('deletes an owned role (carrying the ownership tag)', async () => {
      // Role exists and carries this stack's ownership tag.
      iamMock.on(GetRoleCommand).resolves({
        Role: {
          RoleName: ROLE_NAME,
          Arn: ROLE_ARN,
          Tags: [
            { Key: 'Project', Value: 'SampleAutomationsForBillingTransfer' },
            OWNERSHIP_TAG,
          ],
        } as never,
      });
      // The role has one inline policy and one attached managed policy to clean up.
      iamMock
        .on(ListRolePoliciesCommand)
        .resolves({ PolicyNames: [INLINE_POLICY_NAME], IsTruncated: false });
      iamMock
        .on(ListAttachedRolePoliciesCommand)
        .resolves({ AttachedPolicies: [{ PolicyArn: MANAGED_POLICY_ARN }], IsTruncated: false });
      iamMock.on(DeleteRolePolicyCommand).resolves({});
      iamMock.on(DetachRolePolicyCommand).resolves({});
      iamMock.on(DeleteRoleCommand).resolves({});

      const event = makeEvent('Delete', makeResourceProperties());
      const response = await onEvent(event);

      // The owned role is detached/cleaned up and deleted.
      const deleteRoleCalls = iamMock.commandCalls(DeleteRoleCommand);
      expect(deleteRoleCalls.length).toBe(1);
      expect(deleteRoleCalls[0].args[0].input).toMatchObject({ RoleName: ROLE_NAME });

      expect(iamMock.commandCalls(DeleteRolePolicyCommand).length).toBe(1);
      expect(iamMock.commandCalls(DetachRolePolicyCommand).length).toBe(1);

      expect(response.Data.Outcome).toBe('deleted');
      expect(response.Data.RoleName).toBe(ROLE_NAME);
    });
  });
});
