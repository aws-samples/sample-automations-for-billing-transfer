# Requirements Document

## Introduction

This feature provisions the IAM roles required by AWS Partner Central's "Access for the Channel API" into the program management (Bill-Transfer / payer) AWS accounts of the billing transfer automation solution. AWS Partner Central operates from a central linked AWS account whose identifier is supplied as a configuration input (referred to in AWS documentation as `PartnerCentralLinkedAccountId`). To manage channel billing transfers, Partner Central must be able to assume cross-account roles in each payer account to read and manage AWS Organizations responsibility transfers and Billing Conductor billing groups.

The roles are delivered as a new AWS CDK (TypeScript) stack that follows the existing project conventions (props-based configuration, resource-constrained IAM where supported, cdk-nag/Checkov compliance). The roles are deployed into each payer/program-management account. The roles are provisioned idempotently: when a role with the same name already exists in a target Program Management Account, the Channel Roles Stack leaves the existing role in place and skips its creation rather than failing the deployment, and continues provisioning the remaining roles.

Beyond the trust relationship described in the AWS documentation (which trusts the central account root principal), this feature additionally requires the payer-account roles to be assumable by IAM/federated console users in the central account and by AWS services (for example, AWS Lambda) running in the central account, so that operational automation and human operators in the central account can exercise these roles.

## Glossary

- **Partner Central**: The AWS Partner Central service that manages channel partner relationships and channel billing transfers.
- **Channel API**: The AWS Partner Central Channel API that drives channel billing transfer operations.
- **Partner Central Linked Account**: The central AWS account whose 12-digit identifier is supplied to the stack as a configuration input. Referred to in AWS documentation as `PartnerCentralLinkedAccountId`.
- **Program Management Account**: An AWS payer / Bill-Transfer account into which the channel roles are deployed. Also referred to as a payer account.
- **Bill-Transfer Account**: A payer account that manages and pays for another organization's consolidated bill (synonym for Program Management Account in this document).
- **Channel Roles Stack**: The AWS CDK stack that creates the Partner Central channel IAM roles in a Program Management Account.
- **Handshake Approval Role**: The IAM role named `PartnerCentralChannelHandshakeApprovalManagement` created in a Program Management Account.
- **Billing Transfer Read Only Role**: The IAM role named `PartnerCentralChannelBillingTransferReadOnly` created in a Program Management Account.
- **Billing Transfer Management Role**: The IAM role named `PartnerCentralChannelBillingTransferManagement` created in a Program Management Account.
- **Central Channel Role**: The IAM role named `PartnerCentralRoleForChannel` created in the Partner Central Linked Account.
- **Managed Policy**: An AWS managed IAM policy referenced by name or ARN rather than defined inline.
- **Trust Policy**: The IAM role assume-role policy document that defines which principals may assume the role.
- **Permission Policy**: The IAM identity policy document attached to a role that defines allowed actions and resources.
- **Console User**: An IAM principal or federated identity in the Partner Central Linked Account that assumes a role through the AWS Management Console or `sts:AssumeRole`.
- **Service Principal**: An AWS service identity (for example, `lambda.amazonaws.com`) used in a trust policy.

## Requirements

### Requirement 1: Handshake Approval Management Role

**User Story:** As a billing operations engineer, I want a Partner Central channel handshake approval role in each payer account, so that Partner Central can approve channel handshakes on behalf of the program management account.

#### Acceptance Criteria

1. WHEN the Channel Roles Stack is deployed to a Program Management Account, THE Channel Roles Stack SHALL create an IAM role whose role name is exactly `PartnerCentralChannelHandshakeApprovalManagement`, without any additional prefix, suffix, or custom path.
2. WHEN the Handshake Approval Role is created, THE Channel Roles Stack SHALL attach the AWS managed policy `AWSPartnerCentralChannelHandshakeApprovalManagement` to the Handshake Approval Role as a managed policy reference, and SHALL NOT attach any additional managed or inline Permission Policy to the Handshake Approval Role.
3. WHEN the Handshake Approval Role is created, THE Channel Roles Stack SHALL configure the Trust Policy of the Handshake Approval Role with an Allow statement that permits the principal `arn:aws:iam::<PartnerCentralLinkedAccountId>:root` to perform only the `sts:AssumeRole` action.
4. THE Channel Roles Stack SHALL NOT grant assume-role access to a wildcard (`*`) principal in the Trust Policy of the Handshake Approval Role.
5. IF the AWS managed policy `AWSPartnerCentralChannelHandshakeApprovalManagement` cannot be resolved or attached during deployment, THEN THE Channel Roles Stack SHALL report a deployment error indicating that the managed policy could not be attached and SHALL NOT create the Handshake Approval Role without the managed policy attached.

### Requirement 2: Billing Transfer Read-Only Role

**User Story:** As a billing operations engineer, I want a read-only cross-account role in each payer account, so that Partner Central can inspect responsibility transfers without making changes.

#### Acceptance Criteria

1. WHEN the Channel Roles Stack is deployed to a Program Management Account, THE Channel Roles Stack SHALL create exactly one IAM role named `PartnerCentralChannelBillingTransferReadOnly`.
2. WHEN the Billing Transfer Read Only Role is created, THE Channel Roles Stack SHALL configure the Trust Policy of the Billing Transfer Read Only Role with a single statement of effect Allow that permits the principal `arn:aws:iam::<PartnerCentralLinkedAccountId>:root` to perform the `sts:AssumeRole` action.
3. WHEN the Billing Transfer Read Only Role is created, THE Channel Roles Stack SHALL attach a Permission Policy whose statement with identifier `BillingTransferReadOnly` has effect Allow and grants exactly the four actions `organizations:DescribeResponsibilityTransfer`, `organizations:ListHandshakesForOrganization`, `organizations:ListInboundResponsibilityTransfers`, and `organizations:ListOutboundResponsibilityTransfers`, and no other actions.
4. THE Permission Policy of the Billing Transfer Read Only Role SHALL set the resource scope of the `BillingTransferReadOnly` statement to `*`.
5. THE Permission Policy of the Billing Transfer Read Only Role SHALL NOT grant any action other than the four actions enumerated in the `BillingTransferReadOnly` statement, and in particular SHALL NOT grant any `billingconductor:` action or any `organizations:` action that accepts, declines, cancels, creates, invites, updates, or terminates a responsibility transfer or handshake.

### Requirement 3: Billing Transfer Management Role

**User Story:** As a billing operations engineer, I want an optional management cross-account role in each payer account, so that Partner Central can create billing groups and manage responsibility transfers when management capability is required.

#### Acceptance Criteria

1. WHERE the management capability input for the target Program Management Account is `true`, THE Channel Roles Stack SHALL create an IAM role named exactly `PartnerCentralChannelBillingTransferManagement`.
2. WHEN the Billing Transfer Management Role is created, THE Channel Roles Stack SHALL configure the Trust Policy of the Billing Transfer Management Role to allow the principal `arn:aws:iam::<PartnerCentralLinkedAccountId>:root` to perform `sts:AssumeRole`.
3. WHEN the Billing Transfer Management Role is created, THE Channel Roles Stack SHALL attach a Permission Policy containing a statement with effect Allow and statement identifier `BillingTransferManagement` that allows the actions `billingconductor:CreateBillingGroup`, `billingconductor:ListPricingPlans`, `organizations:AcceptHandshake`, `organizations:CancelHandshake`, `organizations:DeclineHandshake`, `organizations:DescribeResponsibilityTransfer`, `organizations:InviteOrganizationToTransferResponsibility`, `organizations:ListHandshakesForAccount`, `organizations:ListHandshakesForOrganization`, `organizations:ListInboundResponsibilityTransfers`, `organizations:ListOutboundResponsibilityTransfers`, `organizations:TerminateResponsibilityTransfer`, and `organizations:UpdateResponsibilityTransfer`.
4. THE Permission Policy of the Billing Transfer Management Role SHALL set the resource scope of the `BillingTransferManagement` statement to `*`.
5. THE Permission Policy of the Billing Transfer Management Role SHALL exclude any action not listed in the `BillingTransferManagement` statement.
6. WHERE the management capability input for the target Program Management Account is not `true`, THE Channel Roles Stack SHALL omit the Billing Transfer Management Role from the deployment.

### Requirement 4: Expanded Trust for Central Account Console Users and Services

**User Story:** As a central account operator, I want the payer-account channel roles to also trust console users and AWS services in the central account, so that human operators and automation in the central account can assume these roles in addition to Partner Central.

#### Acceptance Criteria

1. WHEN a payer-account channel role is created, THE Channel Roles Stack SHALL configure the Trust Policy of the payer-account channel role with an Allow statement that permits the principal `arn:aws:iam::<PartnerCentralLinkedAccountId>:root` to perform `sts:AssumeRole`, thereby allowing IAM principals and federated Console Users in the Partner Central Linked Account to assume the role.
2. WHEN a payer-account channel role is created, THE Channel Roles Stack SHALL configure the Trust Policy of the payer-account channel role to allow the `lambda.amazonaws.com` Service Principal to perform `sts:AssumeRole`.
3. WHERE the Trust Policy of a payer-account channel role grants assume-role access to the `lambda.amazonaws.com` Service Principal, THE Channel Roles Stack SHALL constrain that grant to the configured Partner Central Linked Account identifier using a source account condition.
4. WHEN the expanded trust is applied, THE Channel Roles Stack SHALL retain, without removing or overwriting, the trust grant to the principal `arn:aws:iam::<PartnerCentralLinkedAccountId>:root` defined for Partner Central.
5. WHERE the management capability is enabled, THE Channel Roles Stack SHALL apply the expanded Trust Policy consistently to each payer-account channel role that is created, namely the Handshake Approval Role, the Billing Transfer Read Only Role, and the Billing Transfer Management Role.
6. THE Channel Roles Stack SHALL NOT grant assume-role access in any payer-account channel Trust Policy to a principal, account, or service that is not the configured Partner Central Linked Account.

### Requirement 5: Central Account Channel Role (Conditional / In Question)

**User Story:** As a billing operations engineer, I want the option to provision the central-account channel role, so that the Partner Central Linked Account has the role required to call the Channel API when this account is in scope for the project.

#### Acceptance Criteria

1. WHERE provisioning of the Central Channel Role is enabled, THE Channel Roles Stack SHALL create an IAM role named `PartnerCentralRoleForChannel` in the configured Partner Central Linked Account.
2. WHERE the Central Channel Role is created, THE Channel Roles Stack SHALL configure the Trust Policy of the Central Channel Role to allow the Service Principal `partnercentral-account-management.amazonaws.com` to perform `sts:AssumeRole`.
3. WHERE the Trust Policy of the Central Channel Role grants assume-role access to the Service Principal `partnercentral-account-management.amazonaws.com`, THE Channel Roles Stack SHALL constrain that grant to the configured Partner Central Linked Account identifier using a source account condition.
4. WHERE the Central Channel Role is created, THE Channel Roles Stack SHALL attach the AWS managed policy `AWSPartnerCentralChannelManagement` to the Central Channel Role.
5. WHERE provisioning of the Central Channel Role is disabled, THE Channel Roles Stack SHALL NOT create the Central Channel Role in the Partner Central Linked Account.

### Requirement 6: Multi-Account Deployment Configuration

**User Story:** As a deployment engineer, I want to deploy the channel roles across multiple payer accounts, so that every program management account in the solution exposes the roles Partner Central requires.

#### Acceptance Criteria

1. THE Channel Roles Stack SHALL accept, as deployment configuration inputs, the target Program Management Account identifier as a 12-digit AWS account identifier and the target deployment region as an AWS region identifier.
2. THE Channel Roles Stack SHALL require the Partner Central Linked Account identifier as a mandatory configuration input that accepts a 12-digit AWS account identifier, with no hardcoded default value.
3. IF the management capability input is not provided as a Boolean value of `true` or `false`, THEN THE Channel Roles Stack SHALL report a deployment error indicating the missing or invalid management capability input and SHALL NOT create any IAM roles.
4. WHEN the management capability input is `true`, THE Channel Roles Stack SHALL create the Billing Transfer Management Role.
5. WHEN the Channel Roles Stack is deployed to two or more Program Management Accounts, THE Channel Roles Stack SHALL assign each created role a name that is identical across every Program Management Account and independent of the Program Management Account identifier and region.
6. IF a role with a name the Channel Roles Stack would create already exists in the target Program Management Account, THEN THE Channel Roles Stack SHALL skip creation of that role, SHALL NOT modify or delete the existing role (its Trust Policy, attached Managed Policies, and inline Permission Policies are left unchanged), and SHALL continue creating the remaining roles and completing the deployment successfully.
7. THE Channel Roles Stack SHALL make the skip-if-exists decision per-role, such that one existing role does not prevent the creation of any other role the Channel Roles Stack manages.
8. WHEN the Channel Roles Stack skips creation of a role because a role with that name already exists, THE Channel Roles Stack SHALL record an indication, such as a log entry or a stack output, that identifies the role name and reports that the role was skipped because it already existed, so that operators can detect skipped roles.
9. WHERE a role is skipped because it already exists, THE Channel Roles Stack SHALL NOT guarantee that the existing role's Trust Policy and Permission Policies match those defined in this document, and reconciliation of a skipped role to this specification is out of scope.
10. IF the target Program Management Account identifier is not a 12-digit numeric value or the target deployment region is not a valid AWS region identifier, THEN THE Channel Roles Stack SHALL report a deployment error identifying the invalid input and SHALL NOT create any IAM roles.
11. IF the Partner Central Linked Account identifier is not provided as a valid 12-digit AWS account identifier, THEN THE Channel Roles Stack SHALL report a deployment error identifying the missing or invalid Partner Central Linked Account identifier and SHALL NOT create any IAM roles.

### Requirement 7: Project Convention and Security Compliance

**User Story:** As a maintainer, I want the channel roles stack to follow the project's CDK and security conventions, so that the new stack integrates cleanly with the existing solution and passes compliance scans.

#### Acceptance Criteria

1. THE Channel Roles Stack SHALL be implemented in TypeScript as a single AWS CDK stack class located under `lib/stacks`, and SHALL receive all deployment configuration through a constructor props interface rather than hard-coded account or region values, in the same manner as the existing stacks under `lib/stacks`.
2. THE Channel Roles Stack SHALL define each role's Permission Policy to include exactly the actions enumerated for that role in this requirements document, and SHALL NOT grant any action that is not enumerated for that role.
3. WHERE an IAM action supports resource-level permissions, THE Channel Roles Stack SHALL constrain that action to specific resource ARNs and SHALL NOT use a resource scope of `*` for that action.
4. WHERE an IAM action does not support resource-level permissions, THE Channel Roles Stack SHALL set that action's resource scope to `*` and SHALL attach a documented suppression annotation that identifies the affected cdk-nag and Checkov finding and records the justification for the `*` scope.
5. WHEN the Channel Roles Stack is synthesized, THE Channel Roles Stack SHALL produce a CloudFormation template for which every cdk-nag finding is either resolved or covered by a documented suppression recording its justification, with zero un-suppressed cdk-nag errors remaining.
6. WHEN the synthesized CloudFormation template of the Channel Roles Stack is scanned with Checkov, THE Channel Roles Stack SHALL produce a result in which every Checkov finding is either resolved or covered by a documented suppression recording its justification, with zero un-suppressed Checkov failures remaining.

### Requirement 8: Idempotent Role Provisioning

**User Story:** As a deployment engineer, I want role provisioning to be idempotent across re-deployments and pre-existing roles, so that deploying the channel roles into an account that already contains a same-named role succeeds without failing on an EntityAlreadyExists condition.

#### Acceptance Criteria

1. WHEN the Channel Roles Stack is deployed, THE Channel Roles Stack SHALL determine, for each role it manages, whether an IAM role with that name already exists in the target Program Management Account before attempting to create that role.
2. IF the existence check for a role cannot be completed, for example due to insufficient permissions or an API error, THEN THE Channel Roles Stack SHALL report a deployment error identifying the role whose existence could not be determined and SHALL NOT create that role.
3. WHERE re-deployment occurs and a role was previously created by the Channel Roles Stack itself, THE Channel Roles Stack SHALL continue to manage that role and apply updates to that role, such that skip-if-exists applies to roles not managed by the Channel Roles Stack while roles owned by the Channel Roles Stack are updated normally.
4. THE Channel Roles Stack SHALL apply the same skip-if-exists existence check to the Handshake Approval Role, the Billing Transfer Read Only Role, the Billing Transfer Management Role when the management capability is enabled, and the Central Channel Role when Central Channel Role provisioning is enabled.
