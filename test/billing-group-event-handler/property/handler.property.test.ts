// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Property-based tests for the Billing Group Event Handler Lambda.
 *
 * Covers handler-level correctness properties from the design document:
 * - Property 1: Lambda response structure (Requirements 1.2)
 * - Property 4: Bill-Source Account extraction (Requirements 4.1)
 * - Property 4a: Transfer ARN extraction (Requirements 4.2)
 * - Property 6: Idempotent duplicate handling (Requirements 4.3)
 *
 * Each property runs a minimum of 100 iterations.
 */

import fc from 'fast-check';
import type { Context } from 'aws-lambda';
import type {
  handler as HandlerType,
  BillingTransferEvent,
} from '../../../lib/lambda/billing-group-event-handler/index.js';

// --- Module mocks (mirror unit/index.test.ts so the handler is exercised in isolation) ---

// Module-scoped mock fn referenced by both the mock factory and the tests.
const mockEnsureBillingGroup = jest.fn();

jest.unstable_mockModule('../../../lib/lambda/common/utils/tracer.js', () => ({
  tracer: {
    captureAWSv3Client: jest.fn((client) => client),
    getSegment: jest.fn(),
    setSegment: jest.fn(),
    annotateColdStart: jest.fn(),
    addServiceNameAnnotation: jest.fn(),
  },
}));

jest.unstable_mockModule('@middy/core', () => ({
  __esModule: true,
  default: (handler: any) => {
    const middyHandler = (event: any, context: any) => handler(event, context);
    middyHandler.use = () => middyHandler;
    return middyHandler;
  },
}));

jest.unstable_mockModule('@aws-lambda-powertools/idempotency', () => ({
  __esModule: true,
  makeIdempotent: (fn: any) => fn,
  IdempotencyConfig: jest.fn().mockImplementation(() => ({})),
}));

jest.unstable_mockModule('@aws-lambda-powertools/idempotency/dynamodb', () => ({
  __esModule: true,
  DynamoDBPersistenceLayer: jest.fn().mockImplementation(() => ({})),
}));

jest.unstable_mockModule('@aws-sdk/client-organizations', () => ({
  OrganizationsClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  DescribeResponsibilityTransferCommand: jest.fn().mockImplementation((params) => params),
}));

jest.unstable_mockModule(
  '../../../lib/lambda/common/services/billing-conductor-service.js',
  () => ({
    __esModule: true,
    ensureBillingGroup: mockEnsureBillingGroup,
    findBillingGroupByAccount: jest.fn(),
    getBasicPricingPlanArn: jest.fn(),
  })
);

let handler: typeof HandlerType;

beforeAll(async () => {
  ({ handler } = await import('../../../lib/lambda/billing-group-event-handler/index.js'));
});

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'billing-group-event-handler',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:billing-group-event-handler',
  memoryLimitInMB: '256',
  awsRequestId: 'test-request-id',
  logGroupName: '/aws/lambda/billing-group-event-handler',
  logStreamName: '2026/05/30/[$LATEST]test',
  getRemainingTimeInMillis: () => 120000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

// --- Arbitraries ---

/** AWS 12-digit account ID */
const accountIdArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** Transfer ID like rt-xxxx */
const transferIdArb = fc
  .string({ minLength: 6, maxLength: 12, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) })
  .map((s) => `rt-${s}`);

interface EventParts {
  sourceAccountId: string;
  targetAccountId: string;
  transferId: string;
}

const eventPartsArb: fc.Arbitrary<EventParts> = fc.record({
  sourceAccountId: accountIdArb,
  targetAccountId: accountIdArb,
  transferId: transferIdArb,
});

function buildAcceptedEvent(parts: EventParts): { event: BillingTransferEvent; transferArn: string } {
  const transferArn = `arn:aws:organizations::${parts.targetAccountId}:transfer/o-abc123/billing/inbound/${parts.transferId}`;
  const event: BillingTransferEvent = {
    version: '0',
    id: `evt-${parts.transferId}`,
    'detail-type': 'AWS Service Event via CloudTrail',
    source: 'aws.organizations',
    account: parts.targetAccountId,
    time: new Date().toISOString(),
    region: 'us-east-1',
    detail: {
      eventVersion: '1.11',
      eventTime: new Date().toISOString(),
      eventName: 'ResponsibilityTransferAccepted',
      eventSource: 'organizations.amazonaws.com',
      eventType: 'AwsServiceEvent',
      serviceEventDetails: {
        id: parts.transferId,
        arn: transferArn,
        transferChain: [parts.transferId],
        type: 'BILLING',
        status: 'ACCEPTED',
        source: { managementAccountId: parts.sourceAccountId },
        target: { managementAccountId: parts.targetAccountId },
        requester: `arn:aws:iam::${parts.sourceAccountId}:root`,
        startTimestamp: Date.now(),
      },
    },
  };
  return { event, transferArn };
}

describe('Billing Group Event Handler - property tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Feature: billing-group-event-handler, Property 1: Lambda response structure
  it('returns statusCode 200 with message, accountId, and action for any valid accepted event', async () => {
    await fc.assert(
      fc.asyncProperty(
        eventPartsArb,
        fc.constantFrom<'created' | 'exists'>('created', 'exists'),
        async (parts, action) => {
          jest.clearAllMocks();
          const { event } = buildAcceptedEvent(parts);

          mockEnsureBillingGroup.mockResolvedValue({
            success: true,
            billingGroupArn: `arn:aws:billingconductor::${parts.targetAccountId}:billing-group/bg-${parts.sourceAccountId}`,
            billingGroupName: `bg-${parts.sourceAccountId}`,
            accountId: parts.sourceAccountId,
            action,
          });

          const result = await handler(event, mockContext);

          expect(result.statusCode).toBe(200);
          expect(typeof result.body.message).toBe('string');
          expect(result.body.message.length).toBeGreaterThan(0);
          expect(result.body.accountId).toBe(parts.sourceAccountId);
          expect(['created', 'exists', 'skipped']).toContain(result.body.action);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 4: Bill-Source Account extraction
  it('extracts source.managementAccountId as the Bill-Source Account for any accepted event', async () => {
    await fc.assert(
      fc.asyncProperty(eventPartsArb, async (parts) => {
        jest.clearAllMocks();
        const { event } = buildAcceptedEvent(parts);

        mockEnsureBillingGroup.mockResolvedValue({
          success: true,
          billingGroupArn: `arn:aws:billingconductor::${parts.targetAccountId}:billing-group/bg-${parts.sourceAccountId}`,
          billingGroupName: `bg-${parts.sourceAccountId}`,
          accountId: parts.sourceAccountId,
          action: 'created',
        });

        const result = await handler(event, mockContext);

        // The account passed to the service (first arg) is the bill-source account
        expect(mockEnsureBillingGroup).toHaveBeenCalledTimes(1);
        expect(mockEnsureBillingGroup.mock.calls[0][0]).toBe(parts.sourceAccountId);
        expect(result.body.accountId).toBe(parts.sourceAccountId);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 4a: Transfer ARN extraction
  it('extracts serviceEventDetails.arn as the transfer ARN for any accepted event', async () => {
    await fc.assert(
      fc.asyncProperty(eventPartsArb, async (parts) => {
        jest.clearAllMocks();
        const { event, transferArn } = buildAcceptedEvent(parts);

        mockEnsureBillingGroup.mockResolvedValue({
          success: true,
          billingGroupArn: `arn:aws:billingconductor::${parts.targetAccountId}:billing-group/bg-${parts.sourceAccountId}`,
          billingGroupName: `bg-${parts.sourceAccountId}`,
          accountId: parts.sourceAccountId,
          action: 'created',
        });

        await handler(event, mockContext);

        // The ARN passed to the service (second arg) matches the event ARN
        expect(mockEnsureBillingGroup).toHaveBeenCalledTimes(1);
        expect(mockEnsureBillingGroup.mock.calls[0][1]).toBe(transferArn);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: billing-group-event-handler, Property 6: Idempotent duplicate handling
  it('returns success with the existing billing group ARN when a group already exists', async () => {
    await fc.assert(
      fc.asyncProperty(eventPartsArb, async (parts) => {
        jest.clearAllMocks();
        const { event } = buildAcceptedEvent(parts);
        const existingArn = `arn:aws:billingconductor::${parts.targetAccountId}:billing-group/bg-${parts.sourceAccountId}`;

        // Simulate idempotent path: group already exists, no creation performed
        mockEnsureBillingGroup.mockResolvedValue({
          success: true,
          billingGroupArn: existingArn,
          billingGroupName: `bg-${parts.sourceAccountId}`,
          accountId: parts.sourceAccountId,
          action: 'exists',
        });

        const result = await handler(event, mockContext);

        expect(result.statusCode).toBe(200);
        expect(result.body.action).toBe('exists');
        // Existing ARN is surfaced (logged) in the response body
        expect(result.body.billingGroupArn).toBe(existingArn);
      }),
      { numRuns: 100 }
    );
  });
});
