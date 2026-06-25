// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * AwsClientFactory — per-invocation construction of the AWS SDK v3 clients the
 * `bt` CLI's single-account, in-process command handlers use for direct AWS
 * calls (those not already covered by a reused Shared_Service).
 *
 * The factory centralizes two cross-cutting concerns so individual handlers do
 * not repeat them (mirroring `lib/lambda/common/utils/clients.ts`):
 *
 *  1. **Region selection (Req 21.4, 21.5).** It distinguishes two service
 *     classes. **Global_Service** clients — Organizations, Billing, Billing
 *     Conductor, CUR — are pinned to the Default_Region (`us-east-1`) because the
 *     billing-transfer control-plane services are reached through a global
 *     endpoint there. **Regional_Service** clients — Lambda, CloudWatch Logs,
 *     SQS, SSM, CloudFormation, CodePipeline — are built for the region resolved
 *     for the active profile, falling back to the Default_Region when that
 *     profile has no configured region. The global-vs-regional classification
 *     lives here (not at each call site) so the Resource_Registry stays a pure
 *     name/region source of truth.
 *  2. **Adaptive retry.** Every client is constructed with `retryMode:
 *     'adaptive'` and `maxAttempts`, matching the shared Lambda client config.
 *     This complements — it does not replace — the Shared_Utilities
 *     {@link retryWithBackoff} wrapper that handlers apply around direct SDK
 *     calls (Req 24.2); the convenience {@link sendWithRetry} helper exported
 *     here wraps `client.send(command)` in exactly that helper.
 *
 * Unlike the Lambda code's module-level singleton clients, this factory is
 * constructed **per invocation** (no module-scoped client instances), which is
 * what lets unit tests intercept every client with `aws-sdk-client-mock` so no
 * real AWS call is made (Req 22.4). Credential resolution is by ambient profile:
 * the optional `profile` is equivalent to `AWS_PROFILE` for the constructed
 * client instances only; when omitted, the standard AWS credential chain applies
 * (Req 3.3, 3.4). The CLI does not require any specific credential source.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 21.4, 22.4, 24.2
 *
 * @module aws-clients
 */

import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { BillingClient } from '@aws-sdk/client-billing';
import { BillingconductorClient } from '@aws-sdk/client-billingconductor';
import { CostAndUsageReportServiceClient } from '@aws-sdk/client-cost-and-usage-report-service';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CodePipelineClient } from '@aws-sdk/client-codepipeline';
import type { Client, Command, MetadataBearer } from '@smithy/types';

import { retryWithBackoff, type RetryConfig } from '../../lib/lambda/common/utils/retry.js';
import { ResourceRegistry } from './resource-registry.js';

/**
 * Per-context AWS SDK clients, constructed per invocation and mockable in tests.
 *
 * Each accessor returns a ready-to-use client; repeated calls within a single
 * factory instance return the same cached client. The two groups differ only in
 * which region they target (see the module overview): Global_Service clients are
 * pinned to the Default_Region, Regional_Service clients use the active-profile
 * region with the Default_Region as fallback.
 */
export interface AwsClientFactory {
  // --- Global_Service clients: pinned to Default_Region us-east-1 (global endpoint) (Req 21.4) ---
  /** AWS Organizations — billing-transfer discovery. */
  organizations(): OrganizationsClient;
  /** AWS Billing — billing views. */
  billing(): BillingClient;
  /** AWS Billing Conductor — billing groups and pricing plans. */
  billingConductor(): BillingconductorClient;
  /** AWS Cost and Usage Report Service — CUR report configurations. */
  cur(): CostAndUsageReportServiceClient;

  // --- Regional_Service clients: active-profile region, Default_Region fallback (Req 21.5) ---
  /** AWS Lambda — reconciliation trigger (async invoke). */
  lambda(): LambdaClient;
  /** Amazon CloudWatch Logs — reconciliation status markers. */
  cloudWatchLogs(): CloudWatchLogsClient;
  /** Amazon SQS — dead-letter-queue depth for reconciliation status. */
  sqs(): SQSClient;
  /** AWS Systems Manager — Partner Central channel-role parameter seeding. */
  ssm(): SSMClient;
  /** AWS CloudFormation — fleet status / git setup (stack outputs). */
  cloudFormation(): CloudFormationClient;
  /** AWS CodePipeline — fleet status (latest pipeline execution). */
  codePipeline(): CodePipelineClient;
}

/**
 * Options that select credentials and region for a per-invocation factory.
 *
 * All fields are optional: with none provided the factory pins Global_Services
 * to {@link ResourceRegistry.defaultRegion}, builds Regional_Services in that
 * same Default_Region, and resolves credentials through the ambient AWS chain.
 */
export interface AwsClientFactoryOptions {
  /**
   * Active AWS profile name (`--profile <name>`). Equivalent to `AWS_PROFILE`
   * for the constructed clients only; omitted → ambient credential chain
   * (Req 3.2, 3.3, 3.4).
   */
  profile?: string;
  /**
   * Region resolved for the active profile. Regional_Service clients use this
   * value; when it is absent they fall back to {@link defaultRegion} (Req 21.5).
   * Global_Service clients ignore it and always use {@link defaultRegion}.
   */
  region?: string;
  /**
   * Default_Region: the global-endpoint region for Global_Services and the
   * regional fallback (Req 21.2, 21.4). Defaults to
   * {@link ResourceRegistry.defaultRegion} (`us-east-1`).
   */
  defaultRegion?: string;
}

/**
 * SDK client-level retry attempts. Matches the shared Lambda client config in
 * `lib/lambda/common/utils/clients.ts`; the adaptive strategy complements the
 * shared {@link retryWithBackoff} wrapper applied by handlers.
 */
const CLIENT_MAX_ATTEMPTS = 3;

/** Shape of the constructor config shared by every AWS SDK v3 client used here. */
interface BaseClientConfig {
  region: string;
  profile?: string;
  maxAttempts: number;
  retryMode: 'adaptive';
}

/**
 * Concrete {@link AwsClientFactory}. Constructed per invocation; clients are
 * created lazily and cached for the lifetime of this instance so a single
 * handler invocation reuses one client per service while different invocations
 * (and tests) never share client state.
 */
export class DefaultAwsClientFactory implements AwsClientFactory {
  private readonly profile?: string;
  private readonly defaultRegion: string;
  private readonly regionalRegion: string;

  private organizationsClient?: OrganizationsClient;
  private billingClient?: BillingClient;
  private billingConductorClient?: BillingconductorClient;
  private curClient?: CostAndUsageReportServiceClient;
  private lambdaClient?: LambdaClient;
  private cloudWatchLogsClient?: CloudWatchLogsClient;
  private sqsClient?: SQSClient;
  private ssmClient?: SSMClient;
  private cloudFormationClient?: CloudFormationClient;
  private codePipelineClient?: CodePipelineClient;

  constructor(options: AwsClientFactoryOptions = {}) {
    this.profile = options.profile;
    this.defaultRegion = options.defaultRegion ?? ResourceRegistry.defaultRegion;
    // Regional_Service region: active-profile region, Default_Region fallback (Req 21.5).
    this.regionalRegion = options.region ?? this.defaultRegion;
  }

  /** Config for Global_Service clients — pinned to the Default_Region (Req 21.4). */
  private globalConfig(): BaseClientConfig {
    return this.clientConfig(this.defaultRegion);
  }

  /** Config for Regional_Service clients — active-profile region or fallback (Req 21.5). */
  private regionalConfig(): BaseClientConfig {
    return this.clientConfig(this.regionalRegion);
  }

  /** Build a fresh client config for the given region with adaptive retry. */
  private clientConfig(region: string): BaseClientConfig {
    return {
      region,
      // Equivalent to AWS_PROFILE for this client instance only; undefined falls
      // back to the ambient credential chain (Req 3.3, 3.4).
      profile: this.profile,
      maxAttempts: CLIENT_MAX_ATTEMPTS,
      retryMode: 'adaptive',
    };
  }

  organizations(): OrganizationsClient {
    return (this.organizationsClient ??= new OrganizationsClient(this.globalConfig()));
  }

  billing(): BillingClient {
    return (this.billingClient ??= new BillingClient(this.globalConfig()));
  }

  billingConductor(): BillingconductorClient {
    return (this.billingConductorClient ??= new BillingconductorClient(this.globalConfig()));
  }

  cur(): CostAndUsageReportServiceClient {
    return (this.curClient ??= new CostAndUsageReportServiceClient(this.globalConfig()));
  }

  lambda(): LambdaClient {
    return (this.lambdaClient ??= new LambdaClient(this.regionalConfig()));
  }

  cloudWatchLogs(): CloudWatchLogsClient {
    return (this.cloudWatchLogsClient ??= new CloudWatchLogsClient(this.regionalConfig()));
  }

  sqs(): SQSClient {
    return (this.sqsClient ??= new SQSClient(this.regionalConfig()));
  }

  ssm(): SSMClient {
    return (this.ssmClient ??= new SSMClient(this.regionalConfig()));
  }

  cloudFormation(): CloudFormationClient {
    return (this.cloudFormationClient ??= new CloudFormationClient(this.regionalConfig()));
  }

  codePipeline(): CodePipelineClient {
    return (this.codePipelineClient ??= new CodePipelineClient(this.regionalConfig()));
  }
}

/**
 * Construct a per-invocation {@link AwsClientFactory}.
 *
 * This is the seam handlers use to obtain clients and tests use to inject mocks:
 * because a new factory (and thus new client instances) is built per call rather
 * than at module scope, `aws-sdk-client-mock` intercepts every constructed client
 * and no real AWS call is made (Req 22.4).
 *
 * @param options - profile/region selection; see {@link AwsClientFactoryOptions}.
 * @returns a fresh factory whose clients are created lazily and cached per instance.
 */
export function createAwsClientFactory(options: AwsClientFactoryOptions = {}): AwsClientFactory {
  return new DefaultAwsClientFactory(options);
}

/**
 * Send an AWS SDK v3 command through the Shared_Utilities retry-with-backoff
 * helper (Req 24.2).
 *
 * Handlers making a direct SDK call that is not routed through a Shared_Service
 * should send it via this helper so transient failures are retried consistently
 * with the rest of the codebase. The client's own adaptive retry still applies
 * underneath; this wrapper adds the shared exponential-backoff-with-jitter policy
 * and structured retry diagnostics.
 *
 * @typeParam Input - the client's union of accepted input types.
 * @typeParam Output - the client's union of produced output types.
 * @typeParam ResolvedConfiguration - the client's resolved configuration type.
 * @typeParam InputType - the specific command input type.
 * @typeParam OutputType - the specific command output type.
 * @param client - the AWS SDK v3 client to send through.
 * @param command - the command to execute.
 * @param context - optional structured context (operation name, ids) for retry logs.
 * @param config - optional retry configuration; defaults to the shared default policy.
 * @returns the command output.
 */
export function sendWithRetry<
  Input extends object,
  Output extends MetadataBearer,
  ResolvedConfiguration,
  InputType extends Input,
  OutputType extends Output,
>(
  client: Client<Input, Output, ResolvedConfiguration>,
  command: Command<Input, InputType, Output, OutputType, ResolvedConfiguration>,
  context: Record<string, unknown> = {},
  config?: RetryConfig,
): Promise<OutputType> {
  return retryWithBackoff(() => client.send(command), config, context);
}
