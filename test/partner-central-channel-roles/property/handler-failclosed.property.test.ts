// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, afterAll, jest } from '@jest/globals';
/**
 * Property-based tests for the Partner Central channel-roles provider Lambda
 * handler's fail-closed behavior on indeterminate role existence.
 *
 * Covers the correctness property from the design document:
 * - Property 7: Indeterminate existence fails closed (Requirements 8.2)
 *
 * The property runs a minimum of 100 iterations.
 *
 * The handler wraps `GetRole` in `retryWithBackoff` and fails closed: on any
 * `GetRole` error that is NOT a definitive `NoSuchEntity` result, it throws an
 * error naming the affected role and issues no `CreateRole` for that role. This
 * test mocks the `IAMClient` with `aws-sdk-client-mock` and drives a wide range
 * of non-`NoSuchEntity` error codes through the handler:
 *  - non-retryable codes (AccessDenied, AccessDeniedException, ServiceFailure,
 *    ValidationError, ...),
 *  - retryable throttling codes (ThrottlingException, TooManyRequestsException,
 *    ServiceUnavailableException) that reject on EVERY attempt so the retries
 *    are exhausted, and
 *  - arbitrary unknown codes.
 *
 * No real AWS account number is ever hard-coded: the linked-account id used in
 * the trust policy is a fast-check-generated 12-digit placeholder string.
 */

import fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
} from '@aws-sdk/client-iam';

const iamMock = mockClient(IAMClient);

import { onEvent } from '../../../lib/lambda/partner-central-channel-roles/index.js';

// --- Arbitraries ---

/** A 12-digit AWS account id placeholder (never a real account number). */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** The exact, fixed channel role names this handler may provision. */
const roleNameArb = fc.constantFrom(
  'PartnerCentralChannelHandshakeApprovalManagement',
  'PartnerCentralChannelBillingTransferReadOnly',
  'PartnerCentralChannelBillingTransferManagement'
);

/**
 * A curated set of non-`NoSuchEntity` IAM/STS-style error codes:
 * - non-retryable (AccessDenied, ServiceFailure, ValidationError, ...), and
 * - retryable throttling codes whose retries we will exhaust by rejecting on
 *   every attempt.
 */
const KNOWN_NON_NOSUCHENTITY_CODES = [
  'AccessDenied',
  'AccessDeniedException',
  'ServiceFailure',
  'ValidationError',
  'InvalidInputException',
  'InternalFailure',
  'UnauthorizedException',
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
] as const;

/** Identifier-like characters used to synthesize arbitrary unknown error codes. */
const codeCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
);

/** Arbitrary unknown, non-empty error codes that never denote "does not exist". */
const arbitraryCodeArb = fc
  .array(codeCharArb, { minLength: 3, maxLength: 24 })
  .map((chars) => chars.join(''))
  .filter((code) => !/NoSuchEntity/i.test(code));

/** Any non-`NoSuchEntity` error code: a known code or an arbitrary unknown one. */
const errorCodeArb = fc.oneof(
  fc.constantFrom(...KNOWN_NON_NOSUCHENTITY_CODES),
  arbitraryCodeArb
);

// --- Helpers ---

/**
 * Build an AWS-SDK-style error carrying both `name` and `code` (the shape the
 * shared error utilities inspect) for the given error code.
 */
function makeAwsError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated GetRole failure`), {
    name: code,
    code,
    $metadata: { httpStatusCode: 400 },
  });
}

/**
 * Build valid custom-resource `ResourceProperties` (per the design event shape)
 * for the given role name and placeholder linked-account id. Policy documents
 * are stringified exactly as the stack passes them.
 */
function buildResourceProperties(
  roleName: string,
  linkedAccountId: string
): Record<string, unknown> {
  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PartnerCentralAndLinkedAccountPrincipals',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${linkedAccountId}:root` },
        Action: 'sts:AssumeRole',
      },
      {
        Sid: 'LinkedAccountLambdaServicePrincipal',
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'aws:SourceAccount': linkedAccountId } },
      },
    ],
  };

  const inlinePolicyDocument = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BillingTransferReadOnly',
        Effect: 'Allow',
        Action: [
          'organizations:DescribeResponsibilityTransfer',
          'organizations:ListHandshakesForOrganization',
          'organizations:ListInboundResponsibilityTransfers',
          'organizations:ListOutboundResponsibilityTransfers',
        ],
        Resource: '*',
      },
    ],
  };

  return {
    RoleName: roleName,
    AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
    ManagedPolicyArns: [
      'arn:aws:iam::aws:policy/AWSPartnerCentralChannelHandshakeApprovalManagement',
    ],
    InlinePolicies: [
      {
        PolicyName: 'BillingTransferReadOnlyPolicy',
        PolicyDocument: JSON.stringify(inlinePolicyDocument),
      },
    ],
    Tags: [{ Key: 'Project', Value: 'SampleAutomationsForBillingTransfer' }],
    OwnershipTag: { Key: 'ManagedBy', Value: 'partner-central-channel-roles' },
  };
}

describe('Partner Central channel roles - handler fail-closed (property tests)', () => {
  // Make exponential-backoff sleeps resolve instantly so the throttling-retry
  // path (which exhausts retries on every attempt) stays fast across 100 runs.
  let setTimeoutSpy: jest.SpyInstance;

  beforeAll(() => {
    setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((cb: (...args: unknown[]) => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);
  });

  afterAll(() => {
    setTimeoutSpy.mockRestore();
  });

  beforeEach(() => {
    iamMock.reset();
  });

  // Feature: partner-central-channel-roles, Property 7: Indeterminate existence fails closed
  it('throws an error naming the role and issues no CreateRole for any non-NoSuchEntity GetRole error', async () => {
    await fc.assert(
      fc.asyncProperty(
        roleNameArb,
        accountIdArb,
        errorCodeArb,
        async (roleName, linkedAccountId, errorCode) => {
          iamMock.reset();

          // Guard: the generated code never denotes "role does not exist".
          expect(errorCode).not.toBe('NoSuchEntity');
          expect(errorCode).not.toBe('NoSuchEntityException');

          // GetRole rejects on EVERY attempt, so even throttling retries are
          // exhausted and the handler must fail closed.
          iamMock.on(GetRoleCommand).rejects(makeAwsError(errorCode));

          const event = {
            RequestType: 'Create' as const,
            ResourceProperties: buildResourceProperties(roleName, linkedAccountId),
          };

          let threw = false;
          let message = '';
          try {
            await onEvent(event as never);
          } catch (err) {
            threw = true;
            expect(err).toBeInstanceOf(Error);
            message = (err as Error).message;
          }

          // Fails closed: it throws...
          expect(threw).toBe(true);
          // ...with an error that names the affected role...
          expect(message).toContain(roleName);
          // ...and never attempts to create the role.
          expect(iamMock.commandCalls(CreateRoleCommand).length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
