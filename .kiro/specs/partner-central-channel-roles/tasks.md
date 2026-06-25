# Implementation Plan: Partner Central Channel Roles

## Overview

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

This plan builds the feature bottom-up: pure spec/policy builders and the account-id validator first (the property-based-test targets), then the provider Lambda decision logic, then the reusable `IdempotentRole` construct, then the two stacks, then the `bin/app.ts` wiring, and finally the cdk-nag/Checkov compliance gates and full build/synth/test gate. Property-based tests are wired in next to each pure unit so correctness is validated as early as possible.

Implementation language: **TypeScript (AWS CDK)** — taken directly from the design; no language selection required.

Project conventions to follow throughout (per `.kiro/steering/development-guide.md`):
- `NodejsFunction` standard config: `runtime: NODEJS_22_X`, `architecture: ARM_64`, `tracing: ACTIVE`, `reservedConcurrentExecutions`, `environmentEncryption` (KMS), and `bundling.externalModules: []` so the IAM SDK client is bundled.
- Reuse `lib/lambda/common/utils`: `logger` (Powertools singleton, never `console.log`), `retryWithBackoff` for all IAM calls, `toError` / `getErrorCode` for error classification.
- KMS key with `enableKeyRotation: true` for Lambda env encryption.
- Tests use `fast-check` (property tests, ≥100 runs) and `aws-cdk-lib/assertions` `Template`/`Match` (template tests); IAM is mocked with `aws-sdk-client-mock`.
- **No hardcoded AWS account IDs** in any source, test, or doc. The Partner Central Linked Account id is a required, validated 12-digit prop; tests use fast-check-generated or placeholder 12-digit values, never a real account number.

## Tasks

- [x] 1. Create shared spec types and the account-id validator
  - [x] 1.1 Define `RoleSpec` data model and the account-id validator in `lib/stacks/channel-role-specs.ts`
    - Create `lib/stacks/channel-role-specs.ts` with the `PolicyStatementJson`, `PolicyDocumentJson`, `InlinePolicySpec`, and `RoleSpec` interfaces from the design Data Models section.
    - Implement an exported `isValidAccountId(value: unknown): boolean` (and/or an `assertValidAccountId(value, label)` that throws a descriptive `Error` naming the offending input) that accepts a string **if and only if** it matches `/^\d{12}$/`; reject `undefined`, empty, non-numeric, and wrong-length values.
    - No hardcoded account ids; the validator only checks shape.
    - _Requirements: 6.1, 6.2, 6.10, 6.11, 7.1_
    - _Design: Components and Interfaces #5 (builders), Data Models (RoleSpec), Error Handling (synth-time)_

  - [x]* 1.2 Write property test for the account-id validator
    - File: `test/partner-central-channel-roles/property/validator.property.test.ts`
    - **Property 5: Account-id validation accepts exactly 12-digit numeric strings** — *for any* string input, the validator accepts it iff it consists of exactly 12 numeric digits; every rejected input (undefined, empty, non-numeric, wrong-length) is reported with an error identifying the offending input and constructs no IAM role.
    - Tag: `// Feature: partner-central-channel-roles, Property 5: Account-id validation accepts exactly 12-digit numeric strings`; configure `{ numRuns: 100 }`. Generate valid 12-digit strings and a wide range of invalid strings; never use a real account number.
    - **Validates: Requirements 6.2, 6.10, 6.11**
    - _Design: Correctness Properties (Property 5)_

- [x] 2. Implement the pure policy/spec builders
  - [x] 2.1 Implement `buildPayerTrustPolicy(linkedAccountId)` in `lib/stacks/channel-role-specs.ts`
    - Produce the two-statement payer trust policy: statement 1 allows principal `arn:aws:iam::<linkedAccountId>:root` to `sts:AssumeRole`; statement 2 allows the `lambda.amazonaws.com` service principal to `sts:AssumeRole` with a `StringEquals` `aws:SourceAccount = <linkedAccountId>` condition. No wildcard principal; the `:root` grant is always retained alongside the Lambda grant; the only account/principal/service referenced is the configured linked account.
    - _Requirements: 1.3, 1.4, 2.2, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
    - _Design: Components #5, Data Models (payer trust policy example), Security Model (trust model for payer-account roles)_

  - [x]* 2.2 Write property test for the payer trust policy
    - File: `test/partner-central-channel-roles/property/payer-trust.property.test.ts`
    - **Property 2: Payer-role trust policies trust only the configured linked account** — *for any* valid linked account id, the trusted principals are exactly { `:root` of `<linkedAccountId>` for `sts:AssumeRole`, and `lambda.amazonaws.com` for `sts:AssumeRole` with `aws:SourceAccount = <linkedAccountId>` }; no wildcard principal; `:root` retained; no other account/principal/service appears anywhere.
    - Tag: `// Feature: partner-central-channel-roles, Property 2: Payer-role trust policies trust only the configured linked account`; `{ numRuns: 100 }`; generate 12-digit ids with fast-check.
    - **Validates: Requirements 1.3, 1.4, 2.2, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**
    - _Design: Correctness Properties (Property 2)_

  - [x] 2.3 Implement `buildReadOnlyPolicy()` in `lib/stacks/channel-role-specs.ts`
    - Return a policy with a single statement `Sid: BillingTransferReadOnly`, `Effect: Allow`, `Resource: '*'`, and exactly the four actions `organizations:DescribeResponsibilityTransfer`, `organizations:ListHandshakesForOrganization`, `organizations:ListInboundResponsibilityTransfers`, `organizations:ListOutboundResponsibilityTransfers` — and no other actions.
    - _Requirements: 2.3, 2.4, 2.5, 7.2_
    - _Design: Components #5, Data Models (read-only permission policy example), Security Model (permission policies)_

  - [x]* 2.4 Write property test for the read-only permission policy
    - File: `test/partner-central-channel-roles/property/readonly-policy.property.test.ts`
    - **Property 3: Read-only permission policy grants exactly the four read actions** — *for any* invocation, exactly one statement `Sid BillingTransferReadOnly`, `Allow`, `Resource '*'`, action set equal to the four read actions, containing no `billingconductor:` action and no mutating `organizations:` action.
    - Tag: `// Feature: partner-central-channel-roles, Property 3: Read-only permission policy grants exactly the four read actions`; `{ numRuns: 100 }`.
    - **Validates: Requirements 2.3, 2.4, 2.5, 7.2**
    - _Design: Correctness Properties (Property 3)_

  - [x] 2.5 Implement `buildManagementPolicy()` in `lib/stacks/channel-role-specs.ts`
    - Return a policy with a single statement `Sid: BillingTransferManagement`, `Effect: Allow`, `Resource: '*'`, and exactly the thirteen enumerated actions (`billingconductor:CreateBillingGroup`, `billingconductor:ListPricingPlans`, and the eleven enumerated `organizations:` actions) — with no additional action.
    - _Requirements: 3.3, 3.4, 3.5, 7.2_
    - _Design: Components #5, Data Models (management permission policy example), Security Model (permission policies)_

  - [x]* 2.6 Write property test for the management permission policy
    - File: `test/partner-central-channel-roles/property/management-policy.property.test.ts`
    - **Property 4: Management permission policy grants exactly the enumerated action set** — *for any* invocation, exactly one statement `Sid BillingTransferManagement`, `Allow`, `Resource '*'`, action set equal to the thirteen enumerated actions, with no additional action present.
    - Tag: `// Feature: partner-central-channel-roles, Property 4: Management permission policy grants exactly the enumerated action set`; `{ numRuns: 100 }`.
    - **Validates: Requirements 3.3, 3.4, 3.5, 7.2**
    - _Design: Correctness Properties (Property 4)_

  - [x] 2.7 Implement `buildCentralTrustPolicy(linkedAccountId)` in `lib/stacks/channel-role-specs.ts`
    - Produce a trust policy whose only grant is to the `partnercentral-account-management.amazonaws.com` service principal for `sts:AssumeRole`, constrained by `StringEquals` `aws:SourceAccount = <linkedAccountId>`.
    - _Requirements: 5.2, 5.3, 5.4_
    - _Design: Components #2 (CentralChannelRoleStack), Components #5_

  - [x]* 2.8 Write property test for the central trust policy
    - File: `test/partner-central-channel-roles/property/central-trust.property.test.ts`
    - **Property 8: Central-role trust is scoped to the Partner Central service principal and linked account** — *for any* valid linked account id, the only grant is `partnercentral-account-management.amazonaws.com` for `sts:AssumeRole` with `aws:SourceAccount = <linkedAccountId>`, and the central role spec attaches the `AWSPartnerCentralChannelManagement` managed policy.
    - Tag: `// Feature: partner-central-channel-roles, Property 8: Central-role trust is scoped to the Partner Central service principal and linked account`; `{ numRuns: 100 }`.
    - **Validates: Requirements 5.2, 5.3, 5.4**
    - _Design: Correctness Properties (Property 8)_

  - [x] 2.9 Implement `buildRoleSpecs(props)` in `lib/stacks/channel-role-specs.ts`
    - Assemble the full `RoleSpec[]`: Handshake Approval (`PartnerCentralChannelHandshakeApprovalManagement`, payer trust, managed policy `AWSPartnerCentralChannelHandshakeApprovalManagement`, no inline policy), Read-Only (`PartnerCentralChannelBillingTransferReadOnly`, payer trust, inline read-only policy), and — only when `enableManagementRole` is `true` — Management (`PartnerCentralChannelBillingTransferManagement`, payer trust, inline management policy). Role names are exact string literals (no prefix/suffix/path) and independent of account id/region. Set `Tags` and the `OwnershipTag` marker (e.g. `ManagedBy=partner-central-channel-roles`) on every spec.
    - _Requirements: 1.1, 1.2, 2.1, 3.1, 3.6, 6.4, 6.5_
    - _Design: Components #5 (buildRoleSpecs), Data Models (RoleSpec), Multi-Account Deployment_

  - [x]* 2.10 Write property test for role-set composition
    - File: `test/partner-central-channel-roles/property/role-specs.property.test.ts`
    - **Property 1: Role-set composition is correct, fixed-named, and account/region independent** — *for any* valid linked account id and *for any* two distinct `(programManagementAccountId, region)` inputs, `buildRoleSpecs` yields the exact fixed role names (Management present iff `enableManagementRole` is true), identical name set across both inputs, the handshake spec attaches exactly the handshake managed policy and no inline policy.
    - Tag: `// Feature: partner-central-channel-roles, Property 1: Role-set composition is correct, fixed-named, and account/region independent`; `{ numRuns: 100 }`; generate account ids, account/region pairs, and the `enableManagementRole` boolean.
    - **Validates: Requirements 1.1, 1.2, 2.1, 3.1, 3.6, 6.4, 6.5**
    - _Design: Correctness Properties (Property 1)_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the provider Lambda handler and its decision logic
  - [x] 4.1 Implement the handler in `lib/lambda/partner-central-channel-roles/index.ts`
    - Implement an exported pure decision function (e.g. `decideAction(requestType, getRoleResult)`) returning `create` | `update` | `skip` based on existence + presence of the `OwnershipTag`, plus the CloudFormation `onEvent` handler that calls it.
    - Create/Update flow: `GetRole(name)` (wrapped in `retryWithBackoff`) → if absent (`NoSuchEntity`) `CreateRole` + tag with `OwnershipTag` + `PutRolePolicy` per inline policy + `AttachRolePolicy` per managed ARN (Outcome `created`); if present and stack-owned, update trust policy + inline + reconcile managed policies (Outcome `updated`); if present but not stack-owned, perform **zero mutating IAM calls** and emit a `logger.info` stating the role was skipped because it already existed (Outcome `skipped`).
    - Fail closed: any non-`NoSuchEntity` `GetRole` error (AccessDenied, throttle after retries exhausted, unknown) throws an error naming the role and issues no `CreateRole`.
    - Managed-policy attach failure on the create path: best-effort rollback (delete inline policies + the partially created role) then throw, so no role persists without its managed policy.
    - Delete flow: delete the role only if it carries this stack's `OwnershipTag`; never delete a foreign/pre-existing role.
    - Return `PhysicalResourceId = roleName` and `Data = { RoleName, RoleArn, Outcome, Reason }`. Reuse `logger`, `retryWithBackoff`, `toError`, `getErrorCode` from `lib/lambda/common/utils`.
    - _Requirements: 1.5, 6.6, 6.7, 6.8, 8.1, 8.2, 8.3, 8.4_
    - _Design: Components #4 (Provider Lambda handler), Existence-Check and Provisioning Flow, Error Handling (deploy-time)_

  - [x]* 4.2 Write property test for the create/update/skip decision
    - File: `test/partner-central-channel-roles/property/handler-decision.property.test.ts`; mock IAM with `aws-sdk-client-mock`.
    - **Property 6: Per-role provisioning decision is create / update / skip by ownership** — *for any* request type (`Create`/`Update`) and *for any* live role state (absent, present-with-ownership-tag, present-without-ownership-tag): chooses create+tag when absent; update when present and stack-owned; skip with **zero mutating IAM calls** when present but not owned; response data records `RoleName` and the correct `Outcome`; skips emit a log entry; decision is independent per role.
    - Tag: `// Feature: partner-central-channel-roles, Property 6: Per-role provisioning decision is create / update / skip by ownership`; `{ numRuns: 100 }`; generators produce request type, existence, and tag presence/absence. No real account ids.
    - **Validates: Requirements 6.6, 6.7, 6.8, 8.1, 8.3, 8.4**
    - _Design: Correctness Properties (Property 6), Existence-Check and Provisioning Flow_

  - [x]* 4.3 Write property test for fail-closed on indeterminate existence
    - File: `test/partner-central-channel-roles/property/handler-failclosed.property.test.ts`; mock IAM with `aws-sdk-client-mock`.
    - **Property 7: Indeterminate existence fails closed** — *for any* `GetRole` error that is not a definitive `NoSuchEntity` (e.g. `AccessDenied`, throttling after retries exhausted, any other API error), the handler throws an error naming the affected role and issues no `CreateRole` for that role.
    - Tag: `// Feature: partner-central-channel-roles, Property 7: Indeterminate existence fails closed`; `{ numRuns: 100 }`; generate a set of non-`NoSuchEntity` error codes.
    - **Validates: Requirements 8.2**
    - _Design: Correctness Properties (Property 7), Error Handling (deploy-time)_

  - [x]* 4.4 Write unit tests for attach-failure rollback and delete safety
    - File: `test/partner-central-channel-roles/unit/handler.test.ts`; mock IAM with `aws-sdk-client-mock`.
    - Case (Req 1.5): `AttachRolePolicy` rejects on the create path → handler performs rollback (delete inline policies + role) and throws so no role persists without its managed policy.
    - Case (delete safety): on `Delete`, a role without the ownership tag is left untouched; a role with the ownership tag is deleted.
    - _Requirements: 1.5, 8.3, 8.4_
    - _Design: Error Handling (managed-policy attach failure, delete safety)_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the `IdempotentRole` L3 construct
  - [x] 6.1 Implement `lib/constructs/idempotent-role.ts`
    - Implement the `IdempotentRoleProps` interface (`serviceToken`, `spec: RoleSpec`) and the `IdempotentRole` construct that creates exactly **one** `CustomResource` bound to the shared provider service token, passing the spec fields as resource properties (stringifying policy documents per the design event-properties shape). Expose `outcome` (`created`|`updated`|`skipped`, read from custom-resource response data) and `roleName`.
    - _Requirements: 6.7, 6.8_
    - _Design: Components #3 (IdempotentRole construct), Data Models (custom resource event/response)_

  - [x]* 6.2 Write unit test for the `IdempotentRole` construct
    - File: `test/partner-central-channel-roles/unit/idempotent-role.test.ts` using `Template.fromStack` on a tiny test stack.
    - Assert exactly one `Custom::` resource is synthesized per construct instance, wired to the provided service token, and that `outcome`/`roleName` are exposed via custom-resource `getAttString`.
    - _Requirements: 6.7, 6.8_
    - _Design: Components #3_

- [x] 7. Implement `PartnerCentralChannelRolesStack` (payer account)
  - [x] 7.1 Implement `lib/stacks/partner-central-channel-roles-stack.ts`
    - Implement `PartnerCentralChannelRolesStackProps` (`partnerCentralLinkedAccountId` required, `enableManagementRole?` boolean). In the constructor, **validate first** (linked account id `/^\d{12}$/`; `props.env.account` 12 digits and `props.env.region` valid AWS region shape; `enableManagementRole` strict boolean if sourced from context) and throw descriptive errors before creating any construct, so an invalid input creates no IAM role resources.
    - Create a KMS key (`enableKeyRotation: true`) for the provider Lambda env encryption. Create the provider Lambda handler (`NodejsFunction`, NODEJS_22_X, ARM_64, ACTIVE tracing, `reservedConcurrentExecutions`, `environmentEncryption`, `bundling.externalModules: []`) and a single `custom-resources.Provider`.
    - Call `buildRoleSpecs(...)` and instantiate one `IdempotentRole` per spec wired to the shared provider. Emit one `CfnOutput` per role exposing `Outcome` and role name (Req 6.8).
    - Scope the handler's **execution role** to the specific managed role-name ARNs only (`arn:aws:iam::<account>:role/PartnerCentralChannel...` for the exact names managed) for `iam:GetRole`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:AttachRolePolicy`, `iam:TagRole` — never `*`; pair `iam:AttachRolePolicy` with a condition limiting attachable policies to the specific AWS managed channel policy ARNs; do not grant `iam:PassRole`.
    - Apply standard project tags. No hardcoded account ids — all derived from props/`env`.
    - _Requirements: 6.1, 6.2, 6.3, 6.8, 6.10, 6.11, 7.1, 7.3_
    - _Design: Components #1, Existence-Check Flow, Security Model (handler execution-role least privilege), Error Handling (synth-time)_

  - [x] 7.2 Add documented cdk-nag and Checkov suppressions to the stack
    - Add `NagSuppressions.addResourceSuppressions` (scoped, with non-empty `reason` and `appliesTo`) for: `AwsSolutions-IAM5 (Resource::*)` on the channel roles' inline permission policies (justification: the granted `organizations:`/`billingconductor:` list/describe actions do not support resource-level permissions — Req 7.4); `AwsSolutions-IAM4` on the handler role (`AWSLambdaBasicExecutionRole`); `AwsSolutions-L1` on the handler (Node.js 22.x latest LTS); and `AwsSolutions-IAM5` on the CDK Provider framework wiring. Ensure the inline-policy `Resource: '*'` findings are covered by the existing `CKV_AWS_111` skip / a documented justification in `.checkov.yaml`. No literal account ids in any suppression text.
    - _Requirements: 7.4, 7.5, 7.6_
    - _Design: cdk-nag / Checkov Suppression Plan, Security Model (permission policies)_

  - [x]* 7.3 Write template test for handler execution-role ARN scoping
    - File: `test/partner-central-channel-roles/stack/handler-role-scoping.test.ts` using `Template.fromStack`.
    - **Property 9: Handler execution role is constrained to the managed role-name ARNs** — *for any* generated stack, every handler execution-role statement granting `iam:GetRole`/`iam:CreateRole`/`iam:PutRolePolicy`/`iam:DeleteRolePolicy`/`iam:AttachRolePolicy`/`iam:TagRole` sets `Resource` to only the specific managed role-name ARNs and never `*`.
    - Tag: `// Feature: partner-central-channel-roles, Property 9: Handler execution role is constrained to the managed role-name ARNs`; `{ numRuns: 100 }`, generating 12-digit linked-account ids / placeholder env accounts (never a real account number). Use `Match` to assert the ARN shape and the absence of `*`.
    - **Validates: Requirements 7.3**
    - _Design: Correctness Properties (Property 9), Security Model (handler execution-role least privilege)_

  - [x]* 7.4 Write template tests for stack structure, props validation, and management gating
    - File: `test/partner-central-channel-roles/stack/structure.test.ts` using `Template.fromStack`.
    - Assert the stack synthesizes from props with no hard-coded account/region; exactly the expected custom resources exist (2 roles by default, 3 when `enableManagementRole` is true — Req 6.4); the KMS key has rotation enabled; constructing with an invalid linked account id, invalid env account/region, or a non-boolean `enableManagementRole` throws and synthesizes no roles (Req 6.3, 6.10, 6.11). Use generated/placeholder 12-digit ids only.
    - _Requirements: 6.3, 6.4, 7.1, 6.10, 6.11_
    - _Design: Testing Strategy (example/edge-case unit tests), Error Handling (synth-time)_

  - [x]* 7.5 Write template test asserting documented suppressions are present
    - File: `test/partner-central-channel-roles/stack/suppressions.test.ts`.
    - Assert the documented cdk-nag suppressions exist on the expected resources with non-empty justification text (Req 7.4) and contain no literal account ids.
    - _Requirements: 7.4_
    - _Design: cdk-nag / Checkov Suppression Plan, Testing Strategy_

- [x] 8. Implement `CentralChannelRoleStack` (linked account)
  - [x] 8.1 Implement `lib/stacks/central-channel-role-stack.ts`
    - Implement `CentralChannelRoleStackProps` (`partnerCentralLinkedAccountId` required, validated 12 digits). Reuse the `IdempotentRole` construct + provider handler pattern to provision a single `PartnerCentralRoleForChannel` role spec built from `buildCentralTrustPolicy(...)` with the `AWSPartnerCentralChannelManagement` managed policy. Emit the per-role outcome `CfnOutput`. The stack is instantiated only when gated externally by `provisionCentralChannelRole` (handled in `bin/app.ts`). No hardcoded account ids.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
    - _Design: Components #2 (CentralChannelRoleStack), Architecture (central role diagram)_

  - [x]* 8.2 Write template test for central-role gating and structure
    - File: `test/partner-central-channel-role-stack.test.ts` using `Template.fromStack`.
    - Assert that when instantiated the stack synthesizes exactly the `PartnerCentralRoleForChannel` custom resource with the central trust + managed policy; the central role is absent unless the stack is instantiated (gating verified at the `bin/app.ts` boundary). Use placeholder 12-digit ids.
    - _Requirements: 5.1, 5.5_
    - _Design: Testing Strategy (central-role gating), Multi-Account Deployment_

- [x] 9. Wire both stacks into the CDK app
  - [x] 9.1 Update `bin/app.ts` to instantiate the payer and central stacks
    - Instantiate `PartnerCentralChannelRolesStack` with `env` bound from `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`, and `partnerCentralLinkedAccountId` + `enableManagementRole` supplied via props/CDK context (no hardcoded account ids). Instantiate `CentralChannelRoleStack` only when the `provisionCentralChannelRole` context/prop flag is true, targeting the linked account. Keep the existing `AwsSolutionsChecks` aspect applied to the app.
    - _Requirements: 5.1, 5.5, 6.1, 6.2, 7.1_
    - _Design: Multi-Account Deployment, Architecture_

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Compliance gates and optional deploy-time verification
  - [x] 11.1 Wire and pass the cdk-nag + Checkov compliance gates
    - Run `npm run cdk:synth` (applies the `AwsSolutionsChecks` aspect) and the Checkov scan over `cdk.out`; resolve or add documented suppressions until there are zero un-suppressed cdk-nag errors and zero un-suppressed Checkov failures for the new stacks. Record any new Checkov justification in `.checkov.yaml` with a comment; no literal account ids in suppressions.
    - _Requirements: 7.5, 7.6_
    - _Design: cdk-nag / Checkov Suppression Plan, Testing Strategy (compliance gates)_

  - [x]* 11.2 Write optional sandbox skip-if-exists integration test
    - File: `test/integration/partner-central-channel-roles.integration.test.ts` (skipped unless a sandbox account/credentials are configured).
    - Pre-create a same-named role out-of-band, deploy the stack, assert the role is left unchanged and its custom-resource output reports `skipped`. Use only the configured sandbox/placeholder account values — no real account number hardcoded.
    - _Requirements: 6.6, 6.9_
    - _Design: Testing Strategy (integration / smoke tests)_

- [x] 12. Final checkpoint - Run the full build/synth/test gate
  - Run `npm run build`, `npm test`, and `npm run cdk:synth`; ensure compilation, all unit/property/template tests, and cdk-nag/Checkov gates pass with zero un-suppressed findings. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (test and verification sub-tasks) and can be skipped for a faster MVP, but they encode the correctness guarantees and are strongly recommended.
- Each task references specific requirements (`_Requirements: X.Y_`) and design sections (`_Design: ..._`) for traceability.
- Every correctness property has a dedicated property-based test task referencing the property by number and text, tagged `Feature: partner-central-channel-roles, Property {n}: {text}` and configured for ≥100 runs: P1→2.10, P2→2.2, P3→2.4, P4→2.6, P5→1.2, P6→4.2, P7→4.3, P8→2.8, P9→7.3.
- **No hardcoded AWS account IDs** anywhere: the linked account id is a required validated prop, and all tests use fast-check-generated or placeholder 12-digit values.
- Checkpoints (tasks 3, 5, 10, 12) ensure incremental validation; the final task runs the full build/synth/test gate.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "4.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.2", "4.3", "4.4", "6.2"] },
    { "id": 3, "tasks": ["2.4", "2.5"] },
    { "id": 4, "tasks": ["2.6", "2.7"] },
    { "id": 5, "tasks": ["2.8", "2.9"] },
    { "id": 6, "tasks": ["2.10", "7.1", "8.1"] },
    { "id": 7, "tasks": ["7.2", "8.2", "9.1"] },
    { "id": 8, "tasks": ["7.3", "7.4", "7.5"] },
    { "id": 9, "tasks": ["11.1"] },
    { "id": 10, "tasks": ["11.2"] }
  ]
}
```
