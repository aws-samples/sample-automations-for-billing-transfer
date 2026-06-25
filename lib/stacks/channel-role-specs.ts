// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared declarative data models and input validation for the Partner Central
 * channel roles feature.
 *
 * This module is intentionally free of any CDK or AWS SDK imports: it contains
 * only plain TypeScript types and pure functions so that the policy/spec
 * builders (added in later tasks) and the account-id validator can be exercised
 * directly by property-based tests without synthesizing or deploying a stack.
 *
 * No AWS account identifiers are hard-coded anywhere in this module. The
 * validator only checks the *shape* of an account id (exactly 12 numeric
 * digits); concrete values are always supplied at deploy time via stack props
 * and the CDK environment.
 */

/**
 * A single IAM policy statement, expressed as the plain JSON shape that IAM
 * accepts. Used for both trust (assume-role) policies and permission policies.
 */
export interface PolicyStatementJson {
  /** Optional statement identifier (e.g. `BillingTransferReadOnly`). */
  Sid?: string;
  /** Whether the statement allows or denies the listed actions. */
  Effect: 'Allow' | 'Deny';
  /**
   * The principal(s) the statement applies to. Present on trust policies
   * (e.g. `{ AWS: 'arn:aws:iam::<id>:root' }` or `{ Service: '...' }`);
   * omitted on identity/permission policies.
   */
  Principal?: Record<string, string | string[]>;
  /** A single action or a list of actions. */
  Action: string | string[];
  /** A single resource ARN/scope or a list of them. */
  Resource?: string | string[];
  /** Optional condition block (e.g. `StringEquals` on `aws:SourceAccount`). */
  Condition?: Record<string, Record<string, string | string[]>>;
}

/**
 * A complete IAM policy document (trust or permission policy).
 */
export interface PolicyDocumentJson {
  Version: '2012-10-17';
  Statement: PolicyStatementJson[];
}

/**
 * An inline permission policy to attach to a role, named and paired with its
 * document.
 */
export interface InlinePolicySpec {
  /** The inline policy name (e.g. `BillingTransferReadOnlyPolicy`). */
  PolicyName: string;
  /** The permission policy document. */
  PolicyDocument: PolicyDocumentJson;
}

/**
 * Declarative desired state for a single channel IAM role.
 *
 * The stack computes one `RoleSpec` per role and passes it to the idempotent
 * provisioning custom resource. The "what" lives here (trust policy, managed
 * policy ARNs, inline policies, tags); the "how / idempotency" lives in the
 * provider Lambda handler.
 */
export interface RoleSpec {
  /** Exact role name — no prefix, suffix, or custom path. */
  RoleName: string;
  /** The role's trust (assume-role) policy document. */
  AssumeRolePolicyDocument: PolicyDocumentJson;
  /** AWS managed policy ARNs to attach (may be empty). */
  ManagedPolicyArns: string[];
  /** Inline permission policies to attach (may be empty). */
  InlinePolicies: InlinePolicySpec[];
  /** Tags applied to the role on creation. */
  Tags: { Key: string; Value: string }[];
  /** Marker tag that designates this stack's ownership of the role. */
  OwnershipTag: { Key: string; Value: string };
}

/**
 * Matches a well-formed AWS account identifier: exactly 12 numeric digits.
 */
const ACCOUNT_ID_PATTERN = /^\d{12}$/;

/**
 * Returns `true` if and only if `value` is a string consisting of exactly 12
 * numeric digits.
 *
 * Rejects `undefined`, `null`, non-string values, empty strings, non-numeric
 * strings, and strings whose length is not exactly 12. Performs no network
 * calls and validates shape only — it does not check that the account exists.
 *
 * @param value - The value to validate.
 * @returns `true` for a 12-digit numeric string, otherwise `false`.
 */
export function isValidAccountId(value: unknown): boolean {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value);
}

/**
 * Asserts that `value` is a valid 12-digit AWS account id, throwing a
 * descriptive `Error` that names the offending input otherwise.
 *
 * Intended for synth-time props validation: callers invoke this before
 * constructing any IAM role resources so that an invalid input fails fast and
 * creates no resources.
 *
 * @param value - The value to validate.
 * @param label - A human-readable label for the input being validated
 *   (e.g. `'partnerCentralLinkedAccountId'`), included in the error message.
 * @returns The validated value, narrowed to `string`.
 * @throws {Error} If `value` is not a 12-digit numeric string.
 */
export function assertValidAccountId(value: unknown, label: string): string {
  if (!isValidAccountId(value)) {
    throw new Error(
      `${label} must be a 12-digit AWS account id (exactly 12 numeric digits); received: ${describeValue(value)}`
    );
  }
  return value as string;
}

/**
 * Produces a safe, human-readable description of an arbitrary value for use in
 * error messages, without throwing on unusual inputs.
 */
function describeValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  // Fallback for every other value (numbers, booleans, symbols, objects, ...).
  // `String(value)` can throw `TypeError: Cannot convert object to primitive
  // value` for objects with a null prototype (e.g. `Object.create(null)`) or
  // whose `toString`/`valueOf` throw. Guard the conversion so this helper
  // honours its contract of never throwing on unusual inputs, falling back to
  // a representation that is always safe to compute.
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return typeof value;
    }
  }
}

/**
 * Sid of the trust-policy statement that grants the Partner Central Linked
 * Account root principal permission to assume a payer-account channel role.
 */
const PAYER_TRUST_ROOT_SID = 'PartnerCentralAndLinkedAccountPrincipals';

/**
 * Sid of the trust-policy statement that grants the `lambda.amazonaws.com`
 * service principal permission to assume a payer-account channel role, scoped
 * to the linked account via an `aws:SourceAccount` condition.
 */
const PAYER_TRUST_LAMBDA_SID = 'LinkedAccountLambdaServicePrincipal';

/**
 * Builds the trust (assume-role) policy attached to every payer-account channel
 * role (Handshake Approval, Billing Transfer Read-Only, and — when enabled —
 * Billing Transfer Management).
 *
 * The policy contains exactly two Allow statements and trusts only the
 * configured Partner Central Linked Account:
 *
 * 1. `PartnerCentralAndLinkedAccountPrincipals` — allows the principal
 *    `arn:aws:iam::<linkedAccountId>:root` to `sts:AssumeRole`. The `:root`
 *    grant delegates to every IAM principal and federated console user in the
 *    linked account (subject to their own identity policies), which is what
 *    lets Partner Central and central-account operators assume the role.
 * 2. `LinkedAccountLambdaServicePrincipal` — allows the `lambda.amazonaws.com`
 *    service principal to `sts:AssumeRole`, constrained by a `StringEquals`
 *    condition on `aws:SourceAccount` equal to `<linkedAccountId>` so the grant
 *    is limited to Lambda usage originating from the linked account.
 *
 * No statement uses a wildcard (`*`) principal, the `:root` grant is always
 * retained alongside the Lambda grant, and the configured linked account is the
 * only account, principal, or service referenced anywhere in the document.
 *
 * @param linkedAccountId - The 12-digit Partner Central Linked Account id.
 *   Validated as exactly 12 numeric digits.
 * @returns The payer-role trust policy document.
 * @throws {Error} If `linkedAccountId` is not a 12-digit numeric string.
 */
export function buildPayerTrustPolicy(linkedAccountId: string): PolicyDocumentJson {
  const accountId = assertValidAccountId(linkedAccountId, 'linkedAccountId');

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: PAYER_TRUST_ROOT_SID,
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: 'sts:AssumeRole',
      },
      {
        Sid: PAYER_TRUST_LAMBDA_SID,
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': accountId },
        },
      },
    ],
  };
}

/**
 * Sid of the permission-policy statement attached to the Billing Transfer
 * Read-Only role.
 */
const READ_ONLY_STATEMENT_SID = 'BillingTransferReadOnly';

/**
 * The exact set of actions granted by the Billing Transfer Read-Only role —
 * four read-only AWS Organizations actions and nothing else.
 *
 * The list contains no `billingconductor:` action and no mutating
 * `organizations:` action (accept/decline/cancel/create/invite/update/
 * terminate), satisfying the least-privilege constraint for the read-only role.
 */
const READ_ONLY_ACTIONS: readonly string[] = [
  'organizations:DescribeResponsibilityTransfer',
  'organizations:ListHandshakesForOrganization',
  'organizations:ListInboundResponsibilityTransfers',
  'organizations:ListOutboundResponsibilityTransfers',
];

/**
 * Builds the permission policy attached to the Billing Transfer Read-Only role
 * (`PartnerCentralChannelBillingTransferReadOnly`).
 *
 * The policy contains a single Allow statement with Sid `BillingTransferReadOnly`
 * that grants exactly the four read-only AWS Organizations actions
 * (`organizations:DescribeResponsibilityTransfer`,
 * `organizations:ListHandshakesForOrganization`,
 * `organizations:ListInboundResponsibilityTransfers`, and
 * `organizations:ListOutboundResponsibilityTransfers`) and no other actions.
 * The resource scope is `*` because these list/describe actions do not support
 * resource-level permissions.
 *
 * @returns The read-only permission policy document.
 */
export function buildReadOnlyPolicy(): PolicyDocumentJson {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: READ_ONLY_STATEMENT_SID,
        Effect: 'Allow',
        Action: [...READ_ONLY_ACTIONS],
        Resource: '*',
      },
    ],
  };
}

/**
 * Sid of the permission-policy statement attached to the Billing Transfer
 * Management role.
 */
const MANAGEMENT_STATEMENT_SID = 'BillingTransferManagement';

/**
 * The exact set of actions granted by the Billing Transfer Management role —
 * thirteen actions and nothing else: two Billing Conductor actions used to
 * create billing groups, plus eleven AWS Organizations actions used to read and
 * manage responsibility transfers and handshakes.
 *
 * No action outside this list is granted, satisfying the least-privilege
 * constraint for the management role.
 */
const MANAGEMENT_ACTIONS: readonly string[] = [
  'billingconductor:CreateBillingGroup',
  'billingconductor:ListPricingPlans',
  'organizations:AcceptHandshake',
  'organizations:CancelHandshake',
  'organizations:DeclineHandshake',
  'organizations:DescribeResponsibilityTransfer',
  'organizations:InviteOrganizationToTransferResponsibility',
  'organizations:ListHandshakesForAccount',
  'organizations:ListHandshakesForOrganization',
  'organizations:ListInboundResponsibilityTransfers',
  'organizations:ListOutboundResponsibilityTransfers',
  'organizations:TerminateResponsibilityTransfer',
  'organizations:UpdateResponsibilityTransfer',
];

/**
 * Builds the permission policy attached to the Billing Transfer Management role
 * (`PartnerCentralChannelBillingTransferManagement`).
 *
 * The policy contains a single Allow statement with Sid
 * `BillingTransferManagement` that grants exactly the thirteen enumerated
 * actions (`billingconductor:CreateBillingGroup`,
 * `billingconductor:ListPricingPlans`, and the eleven `organizations:` actions
 * for managing responsibility transfers and handshakes) and no other actions.
 * The resource scope is `*` because these actions do not support resource-level
 * permissions.
 *
 * @returns The management permission policy document.
 */
export function buildManagementPolicy(): PolicyDocumentJson {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: MANAGEMENT_STATEMENT_SID,
        Effect: 'Allow',
        Action: [...MANAGEMENT_ACTIONS],
        Resource: '*',
      },
    ],
  };
}

/**
 * Exact name of the Handshake Approval Management role created in each payer
 * (Program Management) account. A fixed string literal with no prefix, suffix,
 * or path, and independent of account id and region.
 */
export const HANDSHAKE_APPROVAL_ROLE_NAME = 'PartnerCentralChannelHandshakeApprovalManagement';

/**
 * Exact name of the Billing Transfer Read-Only role created in each payer
 * (Program Management) account. A fixed string literal with no prefix, suffix,
 * or path, and independent of account id and region.
 */
export const READ_ONLY_ROLE_NAME = 'PartnerCentralChannelBillingTransferReadOnly';

/**
 * Exact name of the optional Billing Transfer Management role created in each
 * payer (Program Management) account when `enableManagementRole` is `true`. A
 * fixed string literal with no prefix, suffix, or path, and independent of
 * account id and region.
 */
export const MANAGEMENT_ROLE_NAME = 'PartnerCentralChannelBillingTransferManagement';

/**
 * ARN of the AWS managed policy attached to the Handshake Approval role. Uses
 * the standard AWS managed policy ARN form
 * (`arn:aws:iam::aws:policy/<name>`) and is independent of account id and
 * region.
 */
export const HANDSHAKE_APPROVAL_MANAGED_POLICY_ARN =
  'arn:aws:iam::aws:policy/AWSPartnerCentralChannelHandshakeApprovalManagement';

/**
 * Inline policy name for the Billing Transfer Read-Only role's permission
 * policy.
 */
const READ_ONLY_INLINE_POLICY_NAME = 'BillingTransferReadOnlyPolicy';

/**
 * Inline policy name for the Billing Transfer Management role's permission
 * policy.
 */
const MANAGEMENT_INLINE_POLICY_NAME = 'BillingTransferManagementPolicy';

/**
 * Project tag key/value applied to every channel role, matching the project's
 * standard tagging convention.
 */
const PROJECT_TAG: { Key: string; Value: string } = {
  Key: 'Project',
  Value: 'SampleAutomationsForBillingTransfer',
};

/**
 * Ownership marker tag applied to every role this feature creates. The provider
 * Lambda uses this tag to determine, on each invocation, whether a role is owned
 * (and therefore safely updatable/deletable) by this stack versus pre-existing
 * and out of scope for modification.
 */
const OWNERSHIP_TAG: { Key: string; Value: string } = {
  Key: 'ManagedBy',
  Value: 'partner-central-channel-roles',
};

/**
 * Inputs for {@link buildRoleSpecs}.
 *
 * Role names are fixed string literals and are deliberately independent of the
 * Program Management Account id and region, so the only input that influences
 * the produced specs is the Partner Central Linked Account id (which scopes the
 * trust policies) and the `enableManagementRole` gate.
 */
export interface BuildRoleSpecsProps {
  /**
   * REQUIRED. 12-digit account id of the Partner Central Linked Account. No
   * default. Validated as exactly 12 numeric digits via
   * {@link assertValidAccountId}.
   */
  readonly partnerCentralLinkedAccountId: string;

  /**
   * When `true`, the returned set additionally includes the optional Billing
   * Transfer Management role. The Management role is included if and only if
   * this value is strictly `true`.
   *
   * @default false
   */
  readonly enableManagementRole?: boolean;
}

/**
 * Assembles the full set of payer-account channel role specifications.
 *
 * The returned array always contains:
 *
 * 1. **Handshake Approval** (`PartnerCentralChannelHandshakeApprovalManagement`)
 *    — payer trust policy, the `AWSPartnerCentralChannelHandshakeApprovalManagement`
 *    AWS managed policy attached as a managed policy reference, and **no** inline
 *    permission policy.
 * 2. **Billing Transfer Read-Only**
 *    (`PartnerCentralChannelBillingTransferReadOnly`) — payer trust policy, no
 *    managed policy, and the inline read-only permission policy from
 *    {@link buildReadOnlyPolicy}.
 *
 * and, **only when `enableManagementRole` is strictly `true`**, additionally:
 *
 * 3. **Billing Transfer Management**
 *    (`PartnerCentralChannelBillingTransferManagement`) — payer trust policy, no
 *    managed policy, and the inline management permission policy from
 *    {@link buildManagementPolicy}.
 *
 * Every spec uses the shared payer trust policy ({@link buildPayerTrustPolicy})
 * scoped to the configured linked account, carries the standard project `Tags`,
 * and is marked with the {@link OWNERSHIP_TAG} ownership marker. Role names are
 * exact string literals (no prefix, suffix, or path) and are independent of the
 * Program Management Account id and region, so the produced name set is
 * identical across every payer account and region.
 *
 * @param props - The build inputs; see {@link BuildRoleSpecsProps}.
 * @returns The ordered list of role specs to provision in a payer account.
 * @throws {Error} If `partnerCentralLinkedAccountId` is not a 12-digit numeric
 *   string.
 */
export function buildRoleSpecs(props: BuildRoleSpecsProps): RoleSpec[] {
  const linkedAccountId = assertValidAccountId(
    props.partnerCentralLinkedAccountId,
    'partnerCentralLinkedAccountId'
  );

  const trustPolicy = buildPayerTrustPolicy(linkedAccountId);
  const tags: { Key: string; Value: string }[] = [{ ...PROJECT_TAG }];

  const specs: RoleSpec[] = [
    {
      RoleName: HANDSHAKE_APPROVAL_ROLE_NAME,
      AssumeRolePolicyDocument: trustPolicy,
      ManagedPolicyArns: [HANDSHAKE_APPROVAL_MANAGED_POLICY_ARN],
      InlinePolicies: [],
      Tags: tags.map((tag) => ({ ...tag })),
      OwnershipTag: { ...OWNERSHIP_TAG },
    },
    {
      RoleName: READ_ONLY_ROLE_NAME,
      AssumeRolePolicyDocument: buildPayerTrustPolicy(linkedAccountId),
      ManagedPolicyArns: [],
      InlinePolicies: [
        {
          PolicyName: READ_ONLY_INLINE_POLICY_NAME,
          PolicyDocument: buildReadOnlyPolicy(),
        },
      ],
      Tags: tags.map((tag) => ({ ...tag })),
      OwnershipTag: { ...OWNERSHIP_TAG },
    },
  ];

  if (props.enableManagementRole === true) {
    specs.push({
      RoleName: MANAGEMENT_ROLE_NAME,
      AssumeRolePolicyDocument: buildPayerTrustPolicy(linkedAccountId),
      ManagedPolicyArns: [],
      InlinePolicies: [
        {
          PolicyName: MANAGEMENT_INLINE_POLICY_NAME,
          PolicyDocument: buildManagementPolicy(),
        },
      ],
      Tags: tags.map((tag) => ({ ...tag })),
      OwnershipTag: { ...OWNERSHIP_TAG },
    });
  }

  return specs;
}
