// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * PartnerCentralClient — the typed seam the `bt partner-central register-pma`
 * command uses to drive the three-step PMA registration flow that the legacy
 * `scripts/register-pma.sh` performed with the `aws` CLI and `python3` JSON
 * parsing:
 *
 *   1. register the PMA                       (`create-program-management-account`)
 *   2. create the confirmation handshake      (`create-channel-handshake`,
 *                                               `PROGRAM_MANAGEMENT_ACCOUNT`)
 *   3. accept the handshake from the payer     (`accept-channel-handshake`)
 *
 * Requirement 17.2 forbids an external runtime interpreter (`python3`), and
 * Req 22.5 forbids requiring `jq`/`python3` at runtime. Both implementations in
 * this module therefore parse Partner Central API responses in TypeScript only.
 *
 * Two implementations sit behind the one {@link PartnerCentralClient} interface
 * (design "PartnerCentral client (decision)"):
 *
 * - {@link SdkPartnerCentralClient} — **DEFAULT / PRIMARY.** Uses the typed AWS
 *   SDK v3 client `@aws-sdk/client-partnercentral-channel` with the
 *   `CreateProgramManagementAccountCommand`, `CreateChannelHandshakeCommand`,
 *   and `AcceptChannelHandshakeCommand` operations. No external process, no
 *   `python3`. SDK calls are wrapped with the shared `retryWithBackoff`. The SDK
 *   module is loaded lazily (dynamic `import`) so this file can be imported — and
 *   the CLI fallback used — even in an environment where the SDK package is not
 *   installed.
 *
 * - {@link CliPartnerCentralClient} — **CONTINGENCY FALLBACK ONLY.** Spawns
 *   `aws partnercentral-channel ... --output json` through the shared
 *   {@link ExternalToolRunner} and `JSON.parse`s the captured stdout in
 *   TypeScript. Used only for environments where the SDK dependency cannot be
 *   resolved/installed; it still never invokes `python3`.
 *
 * The three-step ordering, the central/payer profile split, the default display
 * name, and the failure semantics are owned by the command handler (Task 14.1);
 * this module only exposes the three typed operations and the per-call profile
 * and region each step targets.
 *
 * Requirements: 17.2, 22.5
 *
 * @module partner-central-client
 */

import type {
  PartnerCentralChannelClient,
  Program,
  HandshakeType,
} from '@aws-sdk/client-partnercentral-channel';
import { retryWithBackoff } from '../../lib/lambda/common/utils/retry.js';
import { getErrorMessage } from '../../lib/lambda/common/utils/errors.js';
import { ResourceRegistry } from './resource-registry.js';
import type { ExternalToolRunner, ToolResult } from './external-tool-runner.js';

// ---------------------------------------------------------------------------
// Inputs and the PartnerCentralClient interface
// ---------------------------------------------------------------------------

/**
 * Input for step 1 — register a Program Management Account from the central
 * (Partner Central linked) account. Mirrors the `create-program-management-account`
 * fields used by `register-pma.sh`.
 */
export interface CreatePmaInput {
  /** Partner Central catalog (e.g. `AWS`). */
  catalog: string;
  /** Program enum: `DISTRIBUTION` | `SOLUTION_PROVIDER` | `DISTRIBUTION_SELLER`. */
  program: Program;
  /** Human-readable display name (defaulted by the handler to `PMA-<TYPE>-<last4>`). */
  displayName: string;
  /** The 12-digit AWS account id to register (validated by the handler before any call). */
  accountId: string;
  /** Optional idempotency token. */
  clientToken?: string;
  /** AWS CLI/SDK profile for the central account; ambient credentials when omitted. */
  profile?: string;
  /** Region override; defaults to {@link ResourceRegistry.defaultRegion}. */
  region?: string;
}

/**
 * Input for step 2 — create the `PROGRAM_MANAGEMENT_ACCOUNT` confirmation
 * handshake from the central account. Mirrors the `create-channel-handshake`
 * fields used by `register-pma.sh`.
 */
export interface CreateHandshakeInput {
  /** Partner Central catalog (e.g. `AWS`). */
  catalog: string;
  /** Handshake type; the PMA confirmation flow uses `PROGRAM_MANAGEMENT_ACCOUNT`. */
  handshakeType: HandshakeType;
  /** Identifier of the resource the handshake is for — the PMA id from step 1. */
  associatedResourceIdentifier: string;
  /** Optional idempotency token. */
  clientToken?: string;
  /** AWS CLI/SDK profile for the central account; ambient credentials when omitted. */
  profile?: string;
  /** Region override; defaults to {@link ResourceRegistry.defaultRegion}. */
  region?: string;
}

/**
 * Input for step 3 — accept the confirmation handshake from the payer account.
 * Mirrors the `accept-channel-handshake` fields used by `register-pma.sh`.
 */
export interface AcceptHandshakeInput {
  /** Partner Central catalog (e.g. `AWS`). */
  catalog: string;
  /** Identifier of the handshake to accept — the handshake id from step 2. */
  identifier: string;
  /** AWS CLI/SDK profile for the payer account; ambient credentials when omitted. */
  profile?: string;
  /** Region override; defaults to {@link ResourceRegistry.defaultRegion}. */
  region?: string;
}

/**
 * The three typed Partner Central operations the PMA-registration command drives.
 * Implemented by {@link SdkPartnerCentralClient} (primary) and
 * {@link CliPartnerCentralClient} (contingency); both parse responses in
 * TypeScript with no external interpreter (Req 17.2, 22.5).
 */
export interface PartnerCentralClient {
  /** Step 1: register the PMA; resolves with the created PMA identifier. */
  createProgramManagementAccount(input: CreatePmaInput): Promise<{ pmaId: string }>;
  /** Step 2: create the confirmation handshake; resolves with the handshake identifier. */
  createChannelHandshake(input: CreateHandshakeInput): Promise<{ handshakeId: string }>;
  /** Step 3: accept the handshake from the payer; resolves with the resulting status. */
  acceptChannelHandshake(input: AcceptHandshakeInput): Promise<{ status: string }>;
}

// ---------------------------------------------------------------------------
// SdkPartnerCentralClient — DEFAULT / PRIMARY (typed AWS SDK v3)
// ---------------------------------------------------------------------------

/** Type-only view of the lazily-loaded SDK module (erased at compile time). */
type PartnerCentralSdkModule = typeof import('@aws-sdk/client-partnercentral-channel');

/**
 * Factory for the underlying SDK client, keyed by the per-step profile/region.
 * Injectable so unit tests can supply a substitute; the default constructs a
 * real {@link PartnerCentralChannelClient} with adaptive retry.
 */
export type SdkClientFactory = (config: {
  profile?: string;
  region: string;
}) => PartnerCentralChannelClient;

/** Options for {@link SdkPartnerCentralClient}. */
export interface SdkPartnerCentralClientOptions {
  /** Region used when an input does not specify one; defaults to the Default_Region. */
  defaultRegion?: string;
  /**
   * Injectable SDK-client factory (Req 22.4). When omitted, a real client is
   * constructed from the lazily-loaded SDK module with `retryMode: 'adaptive'`.
   */
  createClient?: SdkClientFactory;
}

/**
 * Primary {@link PartnerCentralClient}: the typed AWS SDK v3 client. The SDK
 * module is imported lazily and cached, so importing this file never requires
 * the SDK to be installed — only constructing/using this implementation does.
 * Underlying clients are cached per `profile|region` and reused across steps
 * (the central profile is shared by steps 1 and 2).
 */
export class SdkPartnerCentralClient implements PartnerCentralClient {
  private readonly defaultRegion: string;
  private readonly createClient?: SdkClientFactory;
  private sdkModulePromise?: Promise<PartnerCentralSdkModule>;
  private readonly clientCache = new Map<string, PartnerCentralChannelClient>();

  constructor(options: SdkPartnerCentralClientOptions = {}) {
    this.defaultRegion = options.defaultRegion ?? ResourceRegistry.defaultRegion;
    this.createClient = options.createClient;
  }

  async createProgramManagementAccount(input: CreatePmaInput): Promise<{ pmaId: string }> {
    const sdk = await this.loadSdk();
    const region = input.region ?? this.defaultRegion;
    const client = await this.getClient(sdk, input.profile, region);

    const command = new sdk.CreateProgramManagementAccountCommand({
      catalog: input.catalog,
      program: input.program,
      displayName: input.displayName,
      accountId: input.accountId,
      clientToken: input.clientToken,
    });

    const response = await retryWithBackoff(() => client.send(command), undefined, {
      operation: 'partnercentral-channel:CreateProgramManagementAccount',
      accountId: input.accountId,
    });

    const pmaId = response.programManagementAccountDetail?.id;
    if (!pmaId) {
      throw new Error(
        'CreateProgramManagementAccount succeeded but returned no programManagementAccountDetail.id',
      );
    }
    return { pmaId };
  }

  async createChannelHandshake(input: CreateHandshakeInput): Promise<{ handshakeId: string }> {
    const sdk = await this.loadSdk();
    const region = input.region ?? this.defaultRegion;
    const client = await this.getClient(sdk, input.profile, region);

    const command = new sdk.CreateChannelHandshakeCommand({
      catalog: input.catalog,
      handshakeType: input.handshakeType,
      associatedResourceIdentifier: input.associatedResourceIdentifier,
      clientToken: input.clientToken,
    });

    const response = await retryWithBackoff(() => client.send(command), undefined, {
      operation: 'partnercentral-channel:CreateChannelHandshake',
      associatedResourceIdentifier: input.associatedResourceIdentifier,
    });

    const handshakeId = response.channelHandshakeDetail?.id;
    if (!handshakeId) {
      throw new Error(
        'CreateChannelHandshake succeeded but returned no channelHandshakeDetail.id',
      );
    }
    return { handshakeId };
  }

  async acceptChannelHandshake(input: AcceptHandshakeInput): Promise<{ status: string }> {
    const sdk = await this.loadSdk();
    const region = input.region ?? this.defaultRegion;
    const client = await this.getClient(sdk, input.profile, region);

    const command = new sdk.AcceptChannelHandshakeCommand({
      catalog: input.catalog,
      identifier: input.identifier,
    });

    const response = await retryWithBackoff(() => client.send(command), undefined, {
      operation: 'partnercentral-channel:AcceptChannelHandshake',
      identifier: input.identifier,
    });

    return { status: response.channelHandshakeDetail?.status ?? '' };
  }

  /** Lazily import and cache the SDK module so this file loads without it installed. */
  private loadSdk(): Promise<PartnerCentralSdkModule> {
    if (!this.sdkModulePromise) {
      this.sdkModulePromise = import('@aws-sdk/client-partnercentral-channel');
    }
    return this.sdkModulePromise;
  }

  /** Construct (or reuse a cached) SDK client for the given profile/region. */
  private async getClient(
    sdk: PartnerCentralSdkModule,
    profile: string | undefined,
    region: string,
  ): Promise<PartnerCentralChannelClient> {
    const key = `${profile ?? ''}|${region}`;
    const cached = this.clientCache.get(key);
    if (cached) {
      return cached;
    }

    const client = this.createClient
      ? this.createClient({ profile, region })
      : new sdk.PartnerCentralChannelClient({
          region,
          // Setting a profile here is equivalent to AWS_PROFILE for this client
          // instance only; omitted (undefined) falls back to the ambient chain.
          profile,
          // Adaptive retry complements the shared retryWithBackoff wrapper.
          retryMode: 'adaptive',
        });

    this.clientCache.set(key, client);
    return client;
  }
}

// ---------------------------------------------------------------------------
// CliPartnerCentralClient — CONTINGENCY FALLBACK ONLY (aws CLI, TS parsing)
// ---------------------------------------------------------------------------

/** Minimal shapes parsed from `aws partnercentral-channel ... --output json`. */
interface CreatePmaCliResponse {
  programManagementAccountDetail?: { id?: string; arn?: string };
}
interface CreateHandshakeCliResponse {
  channelHandshakeDetail?: { id?: string; arn?: string };
}
interface AcceptHandshakeCliResponse {
  channelHandshakeDetail?: { id?: string; arn?: string; status?: string };
}

/** Options for {@link CliPartnerCentralClient}. */
export interface CliPartnerCentralClientOptions {
  /** Region used when an input does not specify one; defaults to the Default_Region. */
  defaultRegion?: string;
}

/**
 * Contingency {@link PartnerCentralClient}: spawns the `aws partnercentral-channel`
 * subcommands through the injected {@link ExternalToolRunner} (which always adds
 * `--no-cli-pager` and exports `AWS_PROFILE`) and parses the captured stdout with
 * `JSON.parse` in TypeScript — never `python3` (Req 17.2, 22.5). Used only where
 * the SDK dependency cannot be installed.
 */
export class CliPartnerCentralClient implements PartnerCentralClient {
  private readonly tools: ExternalToolRunner;
  private readonly defaultRegion: string;

  constructor(tools: ExternalToolRunner, options: CliPartnerCentralClientOptions = {}) {
    this.tools = tools;
    this.defaultRegion = options.defaultRegion ?? ResourceRegistry.defaultRegion;
  }

  async createProgramManagementAccount(input: CreatePmaInput): Promise<{ pmaId: string }> {
    const args = [
      'partnercentral-channel',
      'create-program-management-account',
      '--catalog', input.catalog,
      '--program', input.program,
      '--display-name', input.displayName,
      '--account-id', input.accountId,
    ];
    if (input.clientToken) {
      args.push('--client-token', input.clientToken);
    }
    this.appendCommonArgs(args, input.region);

    const result = await this.tools.aws(args, { profile: input.profile });
    const parsed = this.parseJson<CreatePmaCliResponse>(
      result,
      'create-program-management-account',
    );

    const pmaId = parsed.programManagementAccountDetail?.id;
    if (!pmaId) {
      throw new Error(
        'create-program-management-account returned no programManagementAccountDetail.id',
      );
    }
    return { pmaId };
  }

  async createChannelHandshake(input: CreateHandshakeInput): Promise<{ handshakeId: string }> {
    const args = [
      'partnercentral-channel',
      'create-channel-handshake',
      '--catalog', input.catalog,
      '--handshake-type', input.handshakeType,
      '--associated-resource-identifier', input.associatedResourceIdentifier,
    ];
    if (input.clientToken) {
      args.push('--client-token', input.clientToken);
    }
    this.appendCommonArgs(args, input.region);

    const result = await this.tools.aws(args, { profile: input.profile });
    const parsed = this.parseJson<CreateHandshakeCliResponse>(
      result,
      'create-channel-handshake',
    );

    const handshakeId = parsed.channelHandshakeDetail?.id;
    if (!handshakeId) {
      throw new Error('create-channel-handshake returned no channelHandshakeDetail.id');
    }
    return { handshakeId };
  }

  async acceptChannelHandshake(input: AcceptHandshakeInput): Promise<{ status: string }> {
    const args = [
      'partnercentral-channel',
      'accept-channel-handshake',
      '--catalog', input.catalog,
      '--identifier', input.identifier,
    ];
    this.appendCommonArgs(args, input.region);

    const result = await this.tools.aws(args, { profile: input.profile });
    const parsed = this.parseJson<AcceptHandshakeCliResponse>(
      result,
      'accept-channel-handshake',
    );

    return { status: parsed.channelHandshakeDetail?.status ?? '' };
  }

  /** Append the `--region` and `--output json` flags shared by every subcommand. */
  private appendCommonArgs(args: string[], region: string | undefined): void {
    args.push('--region', region ?? this.defaultRegion, '--output', 'json');
  }

  /**
   * Parse a tool result as JSON in TypeScript. Throws on a non-zero exit (so the
   * handler can short-circuit the flow) and on malformed JSON. No `python3`.
   */
  private parseJson<T>(result: ToolResult, subcommand: string): T {
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`aws partnercentral-channel ${subcommand} failed: ${detail}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON output from 'aws partnercentral-channel ${subcommand}': ${getErrorMessage(error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Options for {@link createPartnerCentralClient}. */
export interface CreatePartnerCentralClientOptions {
  /**
   * Select the implementation. `'sdk'` (default) returns the typed SDK client;
   * `'cli'` returns the contingency CLI-spawn fallback (requires `tools`).
   */
  prefer?: 'sdk' | 'cli';
  /** External-tool runner required by the CLI fallback. */
  tools?: ExternalToolRunner;
  /** Region used when an input does not specify one. */
  defaultRegion?: string;
  /** Injectable SDK-client factory passed through to {@link SdkPartnerCentralClient}. */
  createClient?: SdkClientFactory;
}

/**
 * Construct a {@link PartnerCentralClient}. Defaults to the primary
 * {@link SdkPartnerCentralClient}; pass `prefer: 'cli'` (with a `tools` runner)
 * to use the {@link CliPartnerCentralClient} contingency fallback for
 * environments where the SDK dependency is unavailable.
 */
export function createPartnerCentralClient(
  options: CreatePartnerCentralClientOptions = {},
): PartnerCentralClient {
  if (options.prefer === 'cli') {
    if (!options.tools) {
      throw new Error('CliPartnerCentralClient requires an ExternalToolRunner (options.tools)');
    }
    return new CliPartnerCentralClient(options.tools, { defaultRegion: options.defaultRegion });
  }
  return new SdkPartnerCentralClient({
    defaultRegion: options.defaultRegion,
    createClient: options.createClient,
  });
}
