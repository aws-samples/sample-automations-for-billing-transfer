// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CustomResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RoleSpec } from '../stacks/channel-role-specs.js';

/**
 * Props for the {@link IdempotentRole} construct.
 */
export interface IdempotentRoleProps {
  /**
   * The service token of the shared `custom-resources.Provider` that backs the
   * idempotent role-provisioning handler. Every {@link IdempotentRole} in a
   * stack binds to the same provider, so a single handler Lambda services all
   * roles.
   */
  readonly serviceToken: string;

  /**
   * Declarative desired state for the single IAM role this construct
   * provisions (trust policy, managed policy ARNs, inline policies, tags, and
   * ownership marker). The "what" lives in this spec; the "how / idempotency"
   * (create / update / skip-if-exists) lives in the provider Lambda handler.
   */
  readonly spec: RoleSpec;
}

/**
 * A reusable L3 construct that provisions exactly one named IAM role through a
 * single {@link CustomResource} bound to the shared idempotent-role provider.
 *
 * One custom resource is created per role (rather than one resource for all
 * roles) so that the skip-if-exists decision and its recorded outcome are
 * strictly per-role, and a failure provisioning one role does not block the
 * others.
 *
 * The custom resource properties are shaped to match the handler's expected
 * event contract: policy documents are stringified (CloudFormation custom
 * resource properties are flattened to strings, so pre-stringifying keeps the
 * JSON structure intact for the handler to parse).
 */
export class IdempotentRole extends Construct {
  /**
   * The provisioning outcome reported by the handler for this role:
   * `'created'`, `'updated'`, or `'skipped'`. Read from the custom resource
   * response data (`Outcome`).
   */
  public readonly outcome: string;

  /**
   * The exact name of the IAM role this construct manages, echoed back from the
   * custom resource response data (`RoleName`).
   */
  public readonly roleName: string;

  constructor(scope: Construct, id: string, props: IdempotentRoleProps) {
    super(scope, id);

    const { serviceToken, spec } = props;

    const resource = new CustomResource(this, 'Resource', {
      serviceToken,
      // The logical resource type as surfaced in CloudFormation events.
      resourceType: 'Custom::PartnerCentralChannelRole',
      properties: {
        RoleName: spec.RoleName,
        // CloudFormation flattens custom-resource properties to strings, so the
        // policy documents are stringified here and parsed in the handler.
        AssumeRolePolicyDocument: JSON.stringify(spec.AssumeRolePolicyDocument),
        ManagedPolicyArns: spec.ManagedPolicyArns,
        InlinePolicies: spec.InlinePolicies.map((policy) => ({
          PolicyName: policy.PolicyName,
          PolicyDocument: JSON.stringify(policy.PolicyDocument),
        })),
        Tags: spec.Tags,
        OwnershipTag: spec.OwnershipTag,
      },
    });

    this.outcome = resource.getAttString('Outcome');
    this.roleName = resource.getAttString('RoleName');
  }
}
