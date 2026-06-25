// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Partner Central Channel Roles — Provider Lambda handler
 *
 * Backs the CDK `custom-resources.Provider` custom resource that provisions a
 * single named Partner Central channel IAM role idempotently. Because Partner
 * Central requires roles with exact, fixed names, a native `AWS::IAM::Role`
 * resource fails with `EntityAlreadyExists` when a same-named role already
 * exists out-of-band. This handler instead performs a per-role existence check
 * (`iam:GetRole`) and then creates, updates, or skips the role, failing closed
 * when existence cannot be determined.
 *
 * Ownership is tag-based: every role this stack creates is tagged with an
 * `OwnershipTag` marker. Because `iam:GetRole` returns the role's tags,
 * ownership is re-derived from the live role on every invocation, making the
 * decision stateless and idempotent.
 *
 * Lifecycle behavior:
 * - `Create` / `Update`: `GetRole(name)` → branch on existence + ownership tag.
 *   - absent              → `CreateRole` + tag + inline policies + managed
 *                           policy attach (Outcome `created`).
 *   - present & owned     → update trust policy + reconcile inline/managed
 *                           policies (Outcome `updated`).
 *   - present & NOT owned → zero mutating IAM calls; log + skip (Outcome
 *                           `skipped`).
 * - `Delete`: delete only if the role carries this stack's ownership tag;
 *   never delete a foreign / pre-existing role.
 *
 * Fail-closed: any non-`NoSuchEntity` `GetRole` error (AccessDenied, throttle
 * after retries exhausted, unknown) throws an error naming the role and issues
 * no `CreateRole`.
 *
 * Reuses `lib/lambda/common/utils`: `logger`, `retryWithBackoff`, `toError`,
 * `getErrorCode`.
 *
 * _Requirements: 1.5, 6.6, 6.7, 6.8, 8.1, 8.2, 8.3, 8.4_
 * _Design: Components #4 (Provider Lambda handler), Existence-Check and
 * Provisioning Flow, Error Handling (deploy-time)._
 */

import type { Context } from 'aws-lambda';
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
  type Tag,
} from '@aws-sdk/client-iam';

import { logger } from '../common/utils/logger.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../common/utils/retry.js';
import { toError, getErrorCode, getErrorMessage } from '../common/utils/errors.js';
import type {
  PolicyDocumentJson,
  InlinePolicySpec,
} from '../../stacks/channel-role-specs.js';

/**
 * The provisioning action chosen for a role on the Create/Update path.
 */
export type RoleAction = 'create' | 'update' | 'skip';

/**
 * Normalized result of looking a role up in the target account. This is the
 * sole input (besides the request type) to the pure {@link decideAction}
 * decision function, which keeps the decision logic independently testable.
 */
export interface RoleLookupResult {
  /** Whether a role with the target name currently exists. */
  readonly exists: boolean;
  /**
   * Whether the existing role carries this stack's ownership tag. Only
   * meaningful when {@link exists} is `true`.
   */
  readonly ownedByStack: boolean;
  /** The existing role's ARN, when it exists. */
  readonly roleArn?: string;
}

/**
 * A tag key/value pair (matches both the IAM SDK `Tag` shape and the stack's
 * declarative tag spec).
 */
interface TagPair {
  readonly Key: string;
  readonly Value: string;
}

/**
 * The parsed, normalized custom-resource properties the stack passes to the
 * handler (see the design "Custom resource event properties" data model).
 */
interface HandlerProps {
  readonly roleName: string;
  readonly assumeRolePolicyDocument: PolicyDocumentJson;
  readonly managedPolicyArns: string[];
  readonly inlinePolicies: InlinePolicySpec[];
  readonly tags: TagPair[];
  readonly ownershipTag: TagPair;
}

/**
 * The response shape the CDK Provider framework consumes. `Data` is surfaced
 * to CloudFormation and the stack's per-role `CfnOutput`s.
 */
interface OnEventResponse {
  readonly PhysicalResourceId: string;
  readonly Data: {
    readonly RoleName: string;
    readonly RoleArn: string;
    readonly Outcome: string;
    readonly Reason: string;
  };
}

/** Module-level IAM client (reused across warm invocations and mockable in tests). */
const iam = new IAMClient({});

/**
 * Pure decision function: given the CloudFormation request type and the result
 * of looking the role up, decide whether to create, update, or skip the role.
 *
 * The decision is driven entirely by existence and ownership and is identical
 * for `Create` and `Update` requests (existence — not the request type —
 * determines whether the role is created, updated, or left alone):
 *
 * - role absent                       → `create`
 * - role present and stack-owned      → `update`
 * - role present and NOT stack-owned  → `skip`
 *
 * `Delete` requests are handled separately by the handler and never reach this
 * function.
 *
 * @param requestType - The CloudFormation request type (`Create` | `Update`).
 * @param getRoleResult - The normalized lookup result for the target role.
 * @returns The provisioning action to take.
 */
export function decideAction(
  requestType: string,
  getRoleResult: RoleLookupResult
): RoleAction {
  // requestType is retained for traceability/clarity; Create and Update share
  // identical existence-driven semantics.
  void requestType;

  if (!getRoleResult.exists) {
    return 'create';
  }
  return getRoleResult.ownedByStack ? 'update' : 'skip';
}

/**
 * CloudFormation custom-resource `onEvent` handler. Routes Create/Update vs.
 * Delete and returns the per-role outcome.
 *
 * @param event - The CloudFormation custom-resource event.
 * @param context - The Lambda context (optional; used for log correlation).
 * @returns The provider response (`PhysicalResourceId` + `Data`).
 */
export const onEvent = async (
  event: CloudFormationCustomResourceEvent,
  context?: Context
): Promise<OnEventResponse> => {
  if (context) {
    logger.addContext(context);
  }

  const props = parseProps(event.ResourceProperties);
  logger.info('Processing channel-role custom resource event', {
    requestType: event.RequestType,
    roleName: props.roleName,
  });

  try {
    if (event.RequestType === 'Delete') {
      return await handleDelete(props);
    }
    return await handleCreateOrUpdate(event.RequestType, props);
  } catch (error) {
    const err = toError(error);
    logger.error('Channel-role custom resource event failed', {
      requestType: event.RequestType,
      roleName: props.roleName,
      error: err,
    });
    throw err;
  }
};

/**
 * Alias for {@link onEvent} so the stack may wire either name as the provider's
 * onEvent handler.
 */
export const handler = onEvent;

/**
 * Handle a Create or Update request: look the role up, decide, and act.
 */
async function handleCreateOrUpdate(
  requestType: string,
  props: HandlerProps
): Promise<OnEventResponse> {
  const lookup = await lookupRole(props.roleName, props.ownershipTag);
  const action = decideAction(requestType, lookup);

  if (action === 'skip') {
    // Requirement 6.6 / 6.8 / 8.3: zero mutating IAM calls; emit a log entry
    // stating the role was skipped because it already existed.
    const reason =
      'Role already existed and is not managed by this stack; left unchanged.';
    logger.info(
      'Skipped channel role: it already existed and is not managed by this stack',
      { roleName: props.roleName, outcome: 'skipped' }
    );
    return buildResponse(props.roleName, lookup.roleArn, 'skipped', reason);
  }

  if (action === 'create') {
    return createRole(props);
  }

  return updateRole(props, lookup);
}

/**
 * Create the role from scratch: `CreateRole` (with tags + ownership marker),
 * inline policies, then managed-policy attaches. If a managed-policy attach
 * fails, best-effort roll back the partially created role and throw, so no
 * role persists without its required managed policy (Requirement 1.5).
 */
async function createRole(props: HandlerProps): Promise<OnEventResponse> {
  const { roleName, assumeRolePolicyDocument, inlinePolicies, managedPolicyArns } =
    props;
  const tags = mergeTags(props.tags, props.ownershipTag);

  const created = await retryWithBackoff(
    () =>
      iam.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicyDocument),
          Tags: tags as Tag[],
        })
      ),
    DEFAULT_RETRY_CONFIG,
    { operation: 'CreateRole', roleName }
  );
  const roleArn = created.Role?.Arn;

  for (const policy of inlinePolicies) {
    await retryWithBackoff(
      () =>
        iam.send(
          new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policy.PolicyName,
            PolicyDocument: JSON.stringify(policy.PolicyDocument),
          })
        ),
      DEFAULT_RETRY_CONFIG,
      { operation: 'PutRolePolicy', roleName, policyName: policy.PolicyName }
    );
  }

  try {
    for (const policyArn of managedPolicyArns) {
      await retryWithBackoff(
        () =>
          iam.send(
            new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
          ),
        DEFAULT_RETRY_CONFIG,
        { operation: 'AttachRolePolicy', roleName, policyArn }
      );
    }
  } catch (error) {
    // Requirement 1.5: do not leave a role without its required managed policy.
    await rollbackCreatedRole(roleName, inlinePolicies, managedPolicyArns);
    throw new Error(
      `Failed to attach managed policy to role "${roleName}"; rolled back the ` +
        `partially created role so no role persists without its managed policy. ` +
        `Cause: ${getErrorMessage(error)}`
    );
  }

  logger.info('Created channel role', { roleName, outcome: 'created' });
  return buildResponse(
    roleName,
    roleArn,
    'created',
    'Role created, tagged, and configured by this stack.'
  );
}

/**
 * Update a stack-owned role in place: refresh the trust policy, reconcile inline
 * policies, and reconcile attached managed policies to the desired set.
 */
async function updateRole(
  props: HandlerProps,
  lookup: RoleLookupResult
): Promise<OnEventResponse> {
  const { roleName, assumeRolePolicyDocument, inlinePolicies, managedPolicyArns } =
    props;

  await retryWithBackoff(
    () =>
      iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: roleName,
          PolicyDocument: JSON.stringify(assumeRolePolicyDocument),
        })
      ),
    DEFAULT_RETRY_CONFIG,
    { operation: 'UpdateAssumeRolePolicy', roleName }
  );

  // Reconcile inline policies: put desired ones, remove stale ones.
  const desiredPolicyNames = new Set(inlinePolicies.map((p) => p.PolicyName));
  for (const policy of inlinePolicies) {
    await retryWithBackoff(
      () =>
        iam.send(
          new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policy.PolicyName,
            PolicyDocument: JSON.stringify(policy.PolicyDocument),
          })
        ),
      DEFAULT_RETRY_CONFIG,
      { operation: 'PutRolePolicy', roleName, policyName: policy.PolicyName }
    );
  }
  const existingInline = await listInlinePolicyNames(roleName);
  for (const name of existingInline) {
    if (!desiredPolicyNames.has(name)) {
      await retryWithBackoff(
        () =>
          iam.send(
            new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name })
          ),
        DEFAULT_RETRY_CONFIG,
        { operation: 'DeleteRolePolicy', roleName, policyName: name }
      );
    }
  }

  // Reconcile managed policies: attach desired, detach stale.
  const desiredArns = new Set(managedPolicyArns);
  const attachedArns = await listAttachedManagedArns(roleName);
  const attachedSet = new Set(attachedArns);
  for (const policyArn of managedPolicyArns) {
    if (!attachedSet.has(policyArn)) {
      await retryWithBackoff(
        () =>
          iam.send(
            new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
          ),
        DEFAULT_RETRY_CONFIG,
        { operation: 'AttachRolePolicy', roleName, policyArn }
      );
    }
  }
  for (const policyArn of attachedArns) {
    if (!desiredArns.has(policyArn)) {
      await retryWithBackoff(
        () =>
          iam.send(
            new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
          ),
        DEFAULT_RETRY_CONFIG,
        { operation: 'DetachRolePolicy', roleName, policyArn }
      );
    }
  }

  logger.info('Updated channel role', { roleName, outcome: 'updated' });
  return buildResponse(
    roleName,
    lookup.roleArn,
    'updated',
    'Role is managed by this stack; trust policy and inline/managed policies reconciled.'
  );
}

/**
 * Handle a Delete request. Only delete the role if it carries this stack's
 * ownership tag; otherwise leave a foreign / pre-existing role untouched.
 */
async function handleDelete(props: HandlerProps): Promise<OnEventResponse> {
  const { roleName, ownershipTag } = props;
  const lookup = await lookupRole(roleName, ownershipTag);

  if (!lookup.exists) {
    logger.info('Delete: role does not exist; nothing to do', { roleName });
    return buildResponse(
      roleName,
      undefined,
      'skipped',
      'Role does not exist; nothing to delete.'
    );
  }

  if (!lookup.ownedByStack) {
    logger.info(
      'Delete: role exists but is not managed by this stack; left untouched',
      { roleName, outcome: 'skipped' }
    );
    return buildResponse(
      roleName,
      lookup.roleArn,
      'skipped',
      'Role is not managed by this stack; not deleted.'
    );
  }

  // Owned: detach managed policies and delete inline policies, then the role.
  const inlineNames = await listInlinePolicyNames(roleName);
  for (const name of inlineNames) {
    await retryWithBackoff(
      () =>
        iam.send(
          new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name })
        ),
      DEFAULT_RETRY_CONFIG,
      { operation: 'DeleteRolePolicy', roleName, policyName: name }
    );
  }
  const attachedArns = await listAttachedManagedArns(roleName);
  for (const policyArn of attachedArns) {
    await retryWithBackoff(
      () =>
        iam.send(
          new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
        ),
      DEFAULT_RETRY_CONFIG,
      { operation: 'DetachRolePolicy', roleName, policyArn }
    );
  }
  await retryWithBackoff(
    () => iam.send(new DeleteRoleCommand({ RoleName: roleName })),
    DEFAULT_RETRY_CONFIG,
    { operation: 'DeleteRole', roleName }
  );

  logger.info('Deleted channel role managed by this stack', {
    roleName,
    outcome: 'deleted',
  });
  return buildResponse(
    roleName,
    lookup.roleArn,
    'deleted',
    'Role managed by this stack was deleted.'
  );
}

/**
 * Look the role up via `GetRole` (wrapped in `retryWithBackoff`) and normalize
 * the result. A `NoSuchEntity` result means the role is absent; any other error
 * fails closed by throwing an error that names the role (Requirement 8.2), so no
 * `CreateRole` is attempted on uncertainty.
 */
async function lookupRole(
  roleName: string,
  ownershipTag: TagPair
): Promise<RoleLookupResult> {
  try {
    const result = await retryWithBackoff(
      () => iam.send(new GetRoleCommand({ RoleName: roleName })),
      DEFAULT_RETRY_CONFIG,
      { operation: 'GetRole', roleName }
    );
    const tags = (result.Role?.Tags ?? []) as TagPair[];
    return {
      exists: true,
      ownedByStack: hasOwnershipTag(tags, ownershipTag),
      roleArn: result.Role?.Arn,
    };
  } catch (error) {
    if (isNoSuchEntity(error)) {
      return { exists: false, ownedByStack: false };
    }
    // Fail closed — existence/ownership could not be determined.
    throw new Error(
      `Unable to determine whether IAM role "${roleName}" exists ` +
        `(error code: ${getErrorCode(error) || 'unknown'}): ${getErrorMessage(error)}. ` +
        `Failing closed; no role was created.`
    );
  }
}

/**
 * Best-effort rollback of a partially created role: delete inline policies,
 * detach managed policies, then delete the role. Each step swallows its own
 * errors so the rollback is non-fatal; the caller throws afterward.
 */
async function rollbackCreatedRole(
  roleName: string,
  inlinePolicies: InlinePolicySpec[],
  managedPolicyArns: string[]
): Promise<void> {
  for (const policy of inlinePolicies) {
    try {
      await iam.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policy.PolicyName,
        })
      );
    } catch (error) {
      logger.warn('Rollback: failed to delete inline policy (continuing)', {
        roleName,
        policyName: policy.PolicyName,
        error: getErrorMessage(error),
      });
    }
  }
  for (const policyArn of managedPolicyArns) {
    try {
      await iam.send(
        new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
      );
    } catch (error) {
      logger.warn('Rollback: failed to detach managed policy (continuing)', {
        roleName,
        policyArn,
        error: getErrorMessage(error),
      });
    }
  }
  try {
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch (error) {
    logger.warn('Rollback: failed to delete partially created role (continuing)', {
      roleName,
      error: getErrorMessage(error),
    });
  }
}

/**
 * List a role's inline policy names, following pagination.
 */
async function listInlinePolicyNames(roleName: string): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const resp = await retryWithBackoff(
      () => iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker })),
      DEFAULT_RETRY_CONFIG,
      { operation: 'ListRolePolicies', roleName }
    );
    names.push(...(resp.PolicyNames ?? []));
    marker = resp.IsTruncated ? resp.Marker : undefined;
  } while (marker);
  return names;
}

/**
 * List a role's attached managed-policy ARNs, following pagination.
 */
async function listAttachedManagedArns(roleName: string): Promise<string[]> {
  const arns: string[] = [];
  let marker: string | undefined;
  do {
    const resp = await retryWithBackoff(
      () =>
        iam.send(
          new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker })
        ),
      DEFAULT_RETRY_CONFIG,
      { operation: 'ListAttachedRolePolicies', roleName }
    );
    for (const attached of resp.AttachedPolicies ?? []) {
      if (attached.PolicyArn) {
        arns.push(attached.PolicyArn);
      }
    }
    marker = resp.IsTruncated ? resp.Marker : undefined;
  } while (marker);
  return arns;
}

/**
 * Returns `true` if `tags` contains the exact ownership marker key/value.
 */
function hasOwnershipTag(tags: TagPair[], ownershipTag: TagPair): boolean {
  return tags.some(
    (tag) => tag.Key === ownershipTag.Key && tag.Value === ownershipTag.Value
  );
}

/**
 * Merge the role's declarative tags with the ownership marker, ensuring the
 * ownership tag is present exactly once (it takes precedence on key collision).
 */
function mergeTags(tags: TagPair[], ownershipTag: TagPair): TagPair[] {
  const merged = tags.filter((tag) => tag.Key !== ownershipTag.Key);
  merged.push(ownershipTag);
  return merged;
}

/**
 * Determine whether an error represents IAM's "role does not exist" condition.
 * Robust to both the SDK exception class and the wire error code/name.
 */
function isNoSuchEntity(error: unknown): boolean {
  if (error instanceof NoSuchEntityException) {
    return true;
  }
  const code = getErrorCode(error);
  return code === 'NoSuchEntity' || code === 'NoSuchEntityException';
}

/**
 * Parse and normalize the custom-resource `ResourceProperties` into
 * {@link HandlerProps}. Policy documents may arrive stringified (per the design
 * event shape) or as already-parsed objects; both are accepted.
 */
function parseProps(raw: unknown): HandlerProps {
  const props = (raw ?? {}) as Record<string, unknown>;

  const roleName = props.RoleName;
  if (typeof roleName !== 'string' || roleName.length === 0) {
    throw new Error('ResourceProperties.RoleName is required and must be a non-empty string');
  }

  const ownershipTag = props.OwnershipTag as TagPair | undefined;
  if (
    !ownershipTag ||
    typeof ownershipTag.Key !== 'string' ||
    typeof ownershipTag.Value !== 'string'
  ) {
    throw new Error(
      `ResourceProperties.OwnershipTag is required for role "${roleName}" and must have string Key and Value`
    );
  }

  const inlinePoliciesRaw = (props.InlinePolicies as unknown[]) ?? [];
  const inlinePolicies: InlinePolicySpec[] = inlinePoliciesRaw.map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      PolicyName: String(e.PolicyName),
      PolicyDocument: coerceJson<PolicyDocumentJson>(e.PolicyDocument),
    };
  });

  return {
    roleName,
    assumeRolePolicyDocument: coerceJson<PolicyDocumentJson>(
      props.AssumeRolePolicyDocument
    ),
    managedPolicyArns: ((props.ManagedPolicyArns as string[]) ?? []).map(String),
    inlinePolicies,
    tags: ((props.Tags as TagPair[]) ?? []).map((t) => ({
      Key: String(t.Key),
      Value: String(t.Value),
    })),
    ownershipTag: { Key: ownershipTag.Key, Value: ownershipTag.Value },
  };
}

/**
 * Parse a value that may be a JSON string or an already-parsed object.
 */
function coerceJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

/**
 * Build the provider response with the required `PhysicalResourceId` and `Data`.
 */
function buildResponse(
  roleName: string,
  roleArn: string | undefined,
  outcome: string,
  reason: string
): OnEventResponse {
  return {
    PhysicalResourceId: roleName,
    Data: {
      RoleName: roleName,
      RoleArn: roleArn ?? '',
      Outcome: outcome,
      Reason: reason,
    },
  };
}

/**
 * Minimal structural type for the CloudFormation custom-resource event the
 * CDK Provider framework forwards to `onEvent`. Defined locally to avoid
 * coupling to a specific `@types/aws-lambda` union shape while still
 * discriminating on `RequestType`.
 */
interface CloudFormationCustomResourceEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResourceProperties: Record<string, unknown>;
  readonly PhysicalResourceId?: string;
  readonly [key: string]: unknown;
}
