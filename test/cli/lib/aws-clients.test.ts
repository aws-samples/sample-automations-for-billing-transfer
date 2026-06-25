// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Unit tests for the AwsClientFactory mock seam (Req 22.4).
 *
 * These tests prove the per-invocation factory is the injection seam that lets a
 * handler be unit-tested with mocked AWS clients and **without making any real
 * AWS call**: every constructed client is intercepted by `aws-sdk-client-mock`,
 * and because clients are built per invocation (no module-level singletons) a
 * fresh factory yields independent, independently-mockable client instances.
 */

import { mockClient } from 'aws-sdk-client-mock';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { BillingClient } from '@aws-sdk/client-billing';
import { BillingconductorClient } from '@aws-sdk/client-billingconductor';
import { CostAndUsageReportServiceClient } from '@aws-sdk/client-cost-and-usage-report-service';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CodePipelineClient } from '@aws-sdk/client-codepipeline';

import {
  createAwsClientFactory,
  DefaultAwsClientFactory,
  sendWithRetry,
  type AwsClientFactory,
} from '../../../cli/lib/aws-clients.js';

// Intercept the two representative clients used to prove the mock seam. The
// factory constructs these same classes, so `mockClient` patches every instance
// it builds — no network/credential resolution occurs for a mocked command.
const orgMock = mockClient(OrganizationsClient);
const lambdaMock = mockClient(LambdaClient);

/** Every accessor on the factory, with the SDK client class it must return. */
const ACCESSORS: ReadonlyArray<[keyof AwsClientFactory, Function]> = [
  // Global_Service clients (pinned to Default_Region us-east-1).
  ['organizations', OrganizationsClient],
  ['billing', BillingClient],
  ['billingConductor', BillingconductorClient],
  ['cur', CostAndUsageReportServiceClient],
  // Regional_Service clients (active-profile region, Default_Region fallback).
  ['lambda', LambdaClient],
  ['cloudWatchLogs', CloudWatchLogsClient],
  ['sqs', SQSClient],
  ['ssm', SSMClient],
  ['cloudFormation', CloudFormationClient],
  ['codePipeline', CodePipelineClient],
];

describe('AwsClientFactory mock seam (Req 22.4)', () => {
  beforeEach(() => {
    orgMock.reset();
    lambdaMock.reset();
  });

  describe('client construction', () => {
    it('exposes exactly the ten documented accessors', () => {
      // Guards the accessor inventory so the construction/cache assertions below
      // cannot silently miss a service.
      expect(ACCESSORS).toHaveLength(10);
    });

    it('constructs a defined, usable client from every accessor', () => {
      const factory = createAwsClientFactory();

      for (const [name, ClientClass] of ACCESSORS) {
        const client = (factory[name] as () => unknown)();

        expect(client).toBeDefined();
        // A usable v3 client exposes a `send` method...
        expect(typeof (client as { send?: unknown }).send).toBe('function');
        // ...and is an instance of the expected SDK client class.
        expect(client).toBeInstanceOf(ClientClass as new (...args: never[]) => object);
      }
    });

    it('caches one client per service within a single factory instance', () => {
      const factory = createAwsClientFactory();

      for (const [name] of ACCESSORS) {
        // Invoke with `.call(factory)` to preserve the method's `this` binding.
        const accessor = factory[name] as () => unknown;
        expect(accessor.call(factory)).toBe(accessor.call(factory));
      }
    });

    it('createAwsClientFactory returns a DefaultAwsClientFactory', () => {
      expect(createAwsClientFactory()).toBeInstanceOf(DefaultAwsClientFactory);
    });
  });

  describe('mock interception — no real AWS call is made', () => {
    it('intercepts a Global_Service command sent via sendWithRetry', async () => {
      orgMock.on(ListAccountsCommand).resolves({
        Accounts: [{ Id: '111111111111', Name: 'mock-account' }],
      });

      const factory = createAwsClientFactory();
      const result = await sendWithRetry(factory.organizations(), new ListAccountsCommand({}));

      // The mocked response is returned (so the call never left the process).
      expect(result.Accounts).toEqual([{ Id: '111111111111', Name: 'mock-account' }]);
      // And the mock confirms it intercepted exactly one send.
      expect(orgMock.calls()).toHaveLength(1);
      expect(orgMock.commandCalls(ListAccountsCommand)).toHaveLength(1);
    });

    it('intercepts a Regional_Service command sent via sendWithRetry', async () => {
      lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });

      // A non-default region exercises the Regional_Service config path.
      const factory = createAwsClientFactory({ region: 'us-west-2' });
      const result = await sendWithRetry(
        factory.lambda(),
        new InvokeCommand({ FunctionName: 'reconciliation', InvocationType: 'Event' }),
      );

      expect(result.StatusCode).toBe(202);
      expect(lambdaMock.calls()).toHaveLength(1);
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    });

    it('propagates a mocked error without any real AWS call', async () => {
      // A generic Error is non-retryable, so retryWithBackoff surfaces it
      // immediately (no backoff delay) — proving the rejection came from the mock.
      orgMock.on(ListAccountsCommand).rejects(new Error('mocked-failure'));

      const factory = createAwsClientFactory();

      await expect(
        sendWithRetry(factory.organizations(), new ListAccountsCommand({})),
      ).rejects.toThrow('mocked-failure');
      expect(orgMock.commandCalls(ListAccountsCommand)).toHaveLength(1);
    });
  });

  describe('per-invocation factory — independently mockable clients', () => {
    it('builds distinct client instances across separate factories', () => {
      const factoryA = createAwsClientFactory();
      const factoryB = createAwsClientFactory();

      // No module-level singleton: each invocation owns its own client instances.
      expect(factoryA.organizations()).not.toBe(factoryB.organizations());
      expect(factoryA.lambda()).not.toBe(factoryB.lambda());
    });

    it('intercepts clients from independent factories with the same mock seam', async () => {
      orgMock.on(ListAccountsCommand).resolves({ Accounts: [{ Id: '222222222222' }] });

      const factoryA = createAwsClientFactory();
      const factoryB = createAwsClientFactory({ profile: 'other-profile' });

      const a = await sendWithRetry(factoryA.organizations(), new ListAccountsCommand({}));
      const b = await sendWithRetry(factoryB.organizations(), new ListAccountsCommand({}));

      expect(a.Accounts).toEqual([{ Id: '222222222222' }]);
      expect(b.Accounts).toEqual([{ Id: '222222222222' }]);
      // Both per-invocation clients were intercepted (two sends, zero real calls).
      expect(orgMock.calls()).toHaveLength(2);
    });
  });
});
