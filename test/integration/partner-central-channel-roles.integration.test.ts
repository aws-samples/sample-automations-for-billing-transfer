// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
/**
 * OPTIONAL sandbox integration / smoke test — skip-if-exists behavior.
 *
 * Verifies Requirements 6.6 and 6.9 end-to-end against a real (sandbox) AWS
 * account: when a role with one of the channel role names already exists
 * out-of-band (i.e. it does NOT carry this stack's ownership tag), the provider
 * handler leaves the pre-existing role completely unchanged and reports an
 * `Outcome` of `skipped`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS TEST IS SKIPPED BY DEFAULT.
 * ──────────────────────────────────────────────────────────────────────────
 * It makes live AWS IAM calls (CreateRole / GetRole / DeleteRole) and therefore
 * requires real AWS credentials and a disposable sandbox account. It is NOT run
 * by the default `npm test` / CI:
 *
 *  1. `jest.config.js` excludes `test/integration/**` via `testPathIgnorePatterns`,
 *     so it is not even collected by the default suite; and
 *  2. even when explicitly targeted (e.g.
 *     `npx jest test/integration/partner-central-channel-roles.integration.test.ts`),
 *     the whole suite is guarded by `describe.skip` unless the required
 *     environment variables below are set — so it reports as skipped (0
 *     failures) without credentials.
 *
 * Required environment variables to ENABLE this test (all must be set):
 *
 *   RUN_INTEGRATION_TESTS=true
 *       Master switch. Must be exactly "true".
 *
 *   PCCR_INTEGRATION_SANDBOX_ACCOUNT=<12-digit sandbox account id>
 *       The disposable sandbox AWS account the test runs against. There is NO
 *       hardcoded account number anywhere in this file — it is read from this
 *       variable. The ambient AWS credentials (env / profile / role) MUST
 *       resolve to this same account.
 *
 * Optional environment variables:
 *
 *   PCCR_INTEGRATION_REGION=<aws-region>        (default: us-east-1)
 *       Region for the IAM client (IAM is global, but the client needs a region).
 *
 *   PCCR_INTEGRATION_LINKED_ACCOUNT=<12-digit id> (default: placeholder 111122223333)
 *       The Partner Central Linked Account id used only to BUILD the desired
 *       role spec (its trust policy). Because the role is skipped, this desired
 *       trust policy is never written, so a documentation placeholder is fine.
 *
 *   PCCR_INTEGRATION_ROLE_NAME=<role name>      (default: PartnerCentralChannelBillingTransferReadOnly)
 *       Which managed channel role name to exercise the skip path against.
 *
 * Smoke flow (only executed when configured):
 *  1. Pre-create a same-named IAM role out-of-band via `CreateRole`, WITHOUT
 *     this stack's ownership tag and with a deliberately distinct trust policy
 *     + marker tag (simulating a role owned by someone else).
 *  2. Snapshot the pre-existing role (`GetRole`): its trust policy + tags.
 *  3. Invoke the provider handler's `onEvent` with a `Create` event whose
 *     `ResourceProperties` are the realistic, stringified shape the
 *     `IdempotentRole` construct emits — built from the shared
 *     `buildRoleSpecs` role-spec builders.
 *  4. Assert the returned `Data.Outcome === 'skipped'`.
 *  5. Snapshot the role again (`GetRole`) and assert the trust policy + tags are
 *     UNCHANGED (the handler performed zero mutating IAM calls).
 *  6. Clean up the role this test created.
 *
 * Manual run:
 *   RUN_INTEGRATION_TESTS=true \
 *   PCCR_INTEGRATION_SANDBOX_ACCOUNT=<sandbox-account-id> \
 *   PCCR_INTEGRATION_REGION=us-east-1 \
 *   npx jest test/integration/partner-central-channel-roles.integration.test.ts \
 *     --testPathIgnorePatterns=/node_modules/
 */

import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

import { onEvent } from '../../lib/lambda/partner-central-channel-roles/index.js';
import {
  buildRoleSpecs,
  READ_ONLY_ROLE_NAME,
  type RoleSpec,
} from '../../lib/stacks/channel-role-specs.js';

// ---------------------------------------------------------------------------
// Sandbox configuration — read entirely from the environment. NO real account
// number is hardcoded anywhere in this file.
// ---------------------------------------------------------------------------
const SANDBOX_ACCOUNT = process.env.PCCR_INTEGRATION_SANDBOX_ACCOUNT;
const REGION = process.env.PCCR_INTEGRATION_REGION ?? 'us-east-1';

/** Documentation placeholder linked-account id (used only to build the spec). */
const LINKED_ACCOUNT = process.env.PCCR_INTEGRATION_LINKED_ACCOUNT ?? '111122223333';

/** Which managed channel role name to drive the skip path against. */
const TARGET_ROLE_NAME = process.env.PCCR_INTEGRATION_ROLE_NAME ?? READ_ONLY_ROLE_NAME;

/**
 * The test is enabled only when explicitly opted in AND a sandbox account is
 * configured. Otherwise the suite is skipped (0 failures) so it never runs in
 * the default `npm test` / CI or without credentials.
 */
const runIntegration =
  process.env.RUN_INTEGRATION_TESTS === 'true' && !!SANDBOX_ACCOUNT;

const describeIntegration = runIntegration ? describe : describe.skip;

/** This stack's ownership marker tag (matches the design data model). */
const OWNERSHIP_TAG = { Key: 'ManagedBy', Value: 'partner-central-channel-roles' };

/**
 * A deliberately distinct marker tag applied to the OUT-OF-BAND, pre-existing
 * role so it is unambiguously "not owned by this stack" and so we can assert it
 * survives the skip untouched.
 */
const FOREIGN_TAG = { Key: 'IntegrationTestOwner', Value: 'pccr-skip-if-exists' };

describeIntegration(
  'Partner Central channel roles — sandbox skip-if-exists (integration)',
  () => {
    const iam = new IAMClient({ region: REGION });

    /**
     * Build the realistic, stringified custom-resource `ResourceProperties` for
     * the target role exactly the way the `IdempotentRole` construct does (so
     * the handler parses the same event shape it sees in a real deployment).
     */
    function buildResourceProperties(): Record<string, unknown> {
      // Reuse the shared role-spec builders to construct realistic specs, then
      // select the one matching the target role name.
      const specs: RoleSpec[] = buildRoleSpecs({
        partnerCentralLinkedAccountId: LINKED_ACCOUNT,
        enableManagementRole: true,
      });
      const spec = specs.find((s) => s.RoleName === TARGET_ROLE_NAME) ?? specs[0];

      return {
        RoleName: spec.RoleName,
        AssumeRolePolicyDocument: JSON.stringify(spec.AssumeRolePolicyDocument),
        ManagedPolicyArns: spec.ManagedPolicyArns,
        InlinePolicies: spec.InlinePolicies.map((policy) => ({
          PolicyName: policy.PolicyName,
          PolicyDocument: JSON.stringify(policy.PolicyDocument),
        })),
        Tags: spec.Tags,
        OwnershipTag: spec.OwnershipTag,
      };
    }

    /**
     * The trust policy used for the PRE-EXISTING (out-of-band) role. It is
     * intentionally different from the stack's desired payer trust policy: it
     * simply trusts the sandbox account root, so we can detect any unexpected
     * mutation by the handler. Uses only the configured sandbox account.
     */
    function foreignTrustPolicy(): string {
      return JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: `arn:aws:iam::${SANDBOX_ACCOUNT}:root` },
            Action: 'sts:AssumeRole',
          },
        ],
      });
    }

    /** Normalize an IAM-returned (URL-encoded) trust policy document for comparison. */
    function normalizeTrustDoc(doc: string | undefined): unknown {
      if (!doc) {
        return undefined;
      }
      return JSON.parse(decodeURIComponent(doc));
    }

    /** Snapshot a role's trust policy + tags for before/after comparison. */
    async function snapshotRole(
      roleName: string
    ): Promise<{ trust: unknown; tags: { Key?: string; Value?: string }[] }> {
      const resp = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      return {
        trust: normalizeTrustDoc(resp.Role?.AssumeRolePolicyDocument),
        tags: (resp.Role?.Tags ?? []).map((t) => ({ Key: t.Key, Value: t.Value })),
      };
    }

    /** Best-effort delete of the target role (detach/cleanup first), idempotent. */
    async function deleteRoleIfExists(roleName: string): Promise<void> {
      try {
        // Remove any inline policies.
        const inline = await iam.send(
          new ListRolePoliciesCommand({ RoleName: roleName })
        );
        for (const policyName of inline.PolicyNames ?? []) {
          await iam.send(
            new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName })
          );
        }
        // Detach any managed policies.
        const attached = await iam.send(
          new ListAttachedRolePoliciesCommand({ RoleName: roleName })
        );
        for (const policy of attached.AttachedPolicies ?? []) {
          if (policy.PolicyArn) {
            await iam.send(
              new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.PolicyArn })
            );
          }
        }
        await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          return; // already gone — nothing to clean up
        }
        // Surface non-"absent" cleanup errors so a leaked sandbox role is visible.
        throw error;
      }
    }

    // Ensure no leftover role from a prior failed run, and clean up afterward.
    beforeAll(async () => {
      await deleteRoleIfExists(TARGET_ROLE_NAME);
    }, 60_000);

    afterAll(async () => {
      await deleteRoleIfExists(TARGET_ROLE_NAME);
    }, 60_000);

    test(
      'leaves a pre-existing, non-owned role unchanged and reports "skipped"',
      async () => {
        // Sanity: ambient credentials must resolve to the configured sandbox
        // account, so the handler's IAM client operates on the same account the
        // test pre-creates the role in.
        // (We assert the configured account shape; the actual STS identity is
        // exercised implicitly by the IAM calls below.)
        expect(SANDBOX_ACCOUNT).toMatch(/^\d{12}$/);

        // 1. Pre-create the same-named role OUT-OF-BAND (no ownership tag, a
        //    distinct trust policy, and a foreign marker tag).
        await iam.send(
          new CreateRoleCommand({
            RoleName: TARGET_ROLE_NAME,
            AssumeRolePolicyDocument: foreignTrustPolicy(),
            Description:
              'Pre-existing out-of-band role for PCCR skip-if-exists integration test',
            Tags: [FOREIGN_TAG],
          })
        );

        // 2. Snapshot the pre-existing role (trust policy + tags).
        const before = await snapshotRole(TARGET_ROLE_NAME);

        // The pre-existing role must NOT carry this stack's ownership tag.
        expect(
          before.tags.some(
            (t) => t.Key === OWNERSHIP_TAG.Key && t.Value === OWNERSHIP_TAG.Value
          )
        ).toBe(false);

        // 3. Invoke the provider handler with a realistic Create event.
        const event = {
          RequestType: 'Create',
          ResourceProperties: buildResourceProperties(),
        } as Parameters<typeof onEvent>[0];

        const response = await onEvent(event);

        // 4. The handler must report a skip (zero mutating IAM calls).
        expect(response.Data.Outcome).toBe('skipped');
        expect(response.Data.RoleName).toBe(TARGET_ROLE_NAME);

        // 5. Snapshot again and assert the pre-existing role is UNCHANGED.
        const after = await snapshotRole(TARGET_ROLE_NAME);

        // Trust policy unchanged (still the foreign trust, NOT the stack's desired one).
        expect(after.trust).toEqual(before.trust);
        // Tags unchanged (still the foreign marker; ownership tag never added).
        expect(after.tags).toEqual(before.tags);
        expect(
          after.tags.some(
            (t) => t.Key === OWNERSHIP_TAG.Key && t.Value === OWNERSHIP_TAG.Value
          )
        ).toBe(false);
      },
      120_000
    );
  }
);
