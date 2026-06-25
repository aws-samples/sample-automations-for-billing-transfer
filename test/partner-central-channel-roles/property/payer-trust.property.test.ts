// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for the payer-account trust policy builder
 * (`buildPayerTrustPolicy`) used by the Partner Central channel roles feature.
 *
 * Covers the design's Correctness Property 2: payer-role trust policies trust
 * only the configured Partner Central Linked Account.
 *
 * No real AWS account identifiers are used: every linked-account id is a
 * fast-check-generated 12-digit string.
 */

import fc from 'fast-check';
import {
  buildPayerTrustPolicy,
  PolicyDocumentJson,
  PolicyStatementJson,
} from '../../../lib/stacks/channel-role-specs.js';

// --- Arbitraries ---

/** A well-formed AWS 12-digit account id (never a real account number). */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

// --- Helpers ---

/** Collects every principal value (string) across all statements. */
function collectPrincipalValues(statement: PolicyStatementJson): string[] {
  const principal = statement.Principal;
  if (!principal) {
    return [];
  }
  const values: string[] = [];
  for (const entry of Object.values(principal)) {
    if (Array.isArray(entry)) {
      values.push(...entry);
    } else {
      values.push(entry);
    }
  }
  return values;
}

describe('buildPayerTrustPolicy - property tests', () => {
  // Feature: partner-central-channel-roles, Property 2: Payer-role trust policies trust only the configured linked account
  it('trusts only the configured linked account: :root + scoped lambda service principal, no wildcard, no other principal', () => {
    fc.assert(
      fc.property(accountIdArb, (linkedAccountId) => {
        const policy: PolicyDocumentJson = buildPayerTrustPolicy(linkedAccountId);

        // Document shape: version + exactly two statements.
        expect(policy.Version).toBe('2012-10-17');
        expect(Array.isArray(policy.Statement)).toBe(true);
        expect(policy.Statement).toHaveLength(2);

        const expectedRootArn = `arn:aws:iam::${linkedAccountId}:root`;

        // --- Statement 1: the :root principal grant is present and retained ---
        const rootStatement = policy.Statement.find(
          (s) => s.Sid === 'PartnerCentralAndLinkedAccountPrincipals'
        );
        expect(rootStatement).toBeDefined();
        expect(rootStatement!.Effect).toBe('Allow');
        expect(rootStatement!.Action).toBe('sts:AssumeRole');
        expect(rootStatement!.Principal).toEqual({ AWS: expectedRootArn });
        // No source-account-style condition narrows the :root delegation away.
        expect(rootStatement!.Condition).toBeUndefined();

        // --- Statement 2: the lambda service principal grant, source-account scoped ---
        const lambdaStatement = policy.Statement.find(
          (s) => s.Sid === 'LinkedAccountLambdaServicePrincipal'
        );
        expect(lambdaStatement).toBeDefined();
        expect(lambdaStatement!.Effect).toBe('Allow');
        expect(lambdaStatement!.Action).toBe('sts:AssumeRole');
        expect(lambdaStatement!.Principal).toEqual({ Service: 'lambda.amazonaws.com' });
        // Lambda grant is constrained to the linked account via aws:SourceAccount.
        expect(lambdaStatement!.Condition).toEqual({
          StringEquals: { 'aws:SourceAccount': linkedAccountId },
        });

        // --- :root grant is retained alongside the lambda grant (both present) ---
        // (verified above by finding both statements; assert the trusted-principal
        // set is exactly these two grants and nothing else)
        const trustedPrincipals = policy.Statement.flatMap(collectPrincipalValues).sort();
        expect(trustedPrincipals).toEqual(
          [expectedRootArn, 'lambda.amazonaws.com'].sort()
        );

        // --- No wildcard principal anywhere ---
        for (const statement of policy.Statement) {
          for (const value of collectPrincipalValues(statement)) {
            expect(value).not.toBe('*');
            expect(value.includes('*')).toBe(false);
          }
        }

        // --- The configured linked account is the ONLY account/principal/service
        //     that appears anywhere in the serialized document ---
        const serialized = JSON.stringify(policy);

        // (a) The only 12-digit string present equals the input id. Extract every
        //     maximal run of digits and check those that are exactly 12 long.
        const digitRuns = serialized.match(/\d+/g) ?? [];
        const twelveDigitRuns = digitRuns.filter((run) => run.length === 12);
        // The id appears twice: in the :root ARN and in aws:SourceAccount.
        expect(twelveDigitRuns.length).toBeGreaterThanOrEqual(2);
        for (const run of twelveDigitRuns) {
          expect(run).toBe(linkedAccountId);
        }
        // No digit run longer than 12 (which could embed a different account id).
        for (const run of digitRuns) {
          expect(run.length).toBeLessThanOrEqual(12);
        }

        // (b) No other service principal appears: the only *.amazonaws.com value
        //     in the document is lambda.amazonaws.com.
        const serviceMentions = serialized.match(/[a-z0-9.-]+\.amazonaws\.com/g) ?? [];
        expect(serviceMentions.length).toBeGreaterThanOrEqual(1);
        for (const service of serviceMentions) {
          expect(service).toBe('lambda.amazonaws.com');
        }

        // (c) No other account-root ARN appears for a different account.
        const rootArns = serialized.match(/arn:aws:iam::\d+:root/g) ?? [];
        for (const arn of rootArns) {
          expect(arn).toBe(expectedRootArn);
        }
      }),
      { numRuns: 100 }
    );
  });
});
