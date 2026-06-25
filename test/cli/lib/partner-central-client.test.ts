// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Unit tests for BOTH Partner Central client implementations (Task 8.2,
 * Requirements 17.2, 22.4).
 *
 * The PMA-registration flow must parse Partner Central API responses in
 * TypeScript with no external runtime interpreter (Req 17.2 — never `python3`),
 * and every Command handler must be unit-testable with substitute (mocked) AWS
 * clients and no real AWS call (Req 22.4). This suite exercises the two
 * implementations behind the single {@link PartnerCentralClient} interface:
 *
 *  1. {@link SdkPartnerCentralClient} — the primary, typed AWS SDK v3 client.
 *     The SDK client is injected through the `options.createClient` seam as a
 *     fake whose `send()` returns canned, typed response shapes. The three
 *     methods must return the parsed `{ pmaId }` / `{ handshakeId }` / `{ status }`
 *     drawn from `programManagementAccountDetail.id`, `channelHandshakeDetail.id`,
 *     and `channelHandshakeDetail.status`. A second pass drives the *default*
 *     construction path through `aws-sdk-client-mock` to prove the real client
 *     is intercepted with no network call.
 *
 *  2. {@link CliPartnerCentralClient} — the contingency fallback. A stub
 *     {@link ExternalToolRunner} returns a {@link ToolResult} with canned
 *     `--output json` stdout; the three methods must `JSON.parse` that stdout in
 *     TypeScript and return the same ids/status. The stub records every
 *     invocation so the test can assert the spawned tool is always
 *     `aws partnercentral-channel ... --output json` and that `python3` is never
 *     invoked. A non-zero exit code must surface as a thrown error.
 *
 * No test makes a real AWS call or spawns a real process.
 */

import { mockClient } from 'aws-sdk-client-mock';
import {
  PartnerCentralChannelClient,
  CreateProgramManagementAccountCommand,
  CreateChannelHandshakeCommand,
  AcceptChannelHandshakeCommand,
} from '@aws-sdk/client-partnercentral-channel';

import {
  SdkPartnerCentralClient,
  CliPartnerCentralClient,
  createPartnerCentralClient,
  type CreatePmaInput,
  type CreateHandshakeInput,
  type AcceptHandshakeInput,
} from '../../../cli/lib/partner-central-client.js';
import type {
  ExternalToolRunner,
  ToolResult,
  SpawnOpts,
} from '../../../cli/lib/external-tool-runner.js';
import { ResourceRegistry } from '../../../cli/lib/resource-registry.js';

// ---------------------------------------------------------------------------
// Canned, typed Partner Central response/identifier fixtures
// ---------------------------------------------------------------------------

const PMA_ID = 'pma-0123456789abcdef';
const HANDSHAKE_ID = 'handshake-fedcba9876543210';
const ACCEPTED_STATUS = 'ACCEPTED';
const CATALOG = 'AWS';
const CENTRAL_PROFILE = 'central-account';
const PAYER_PROFILE = 'payer-account';
const ACCOUNT_ID = '123456789012';

const createPmaInput: CreatePmaInput = {
  catalog: CATALOG,
  program: 'DISTRIBUTION',
  displayName: 'PMA-DP-9012',
  accountId: ACCOUNT_ID,
  profile: CENTRAL_PROFILE,
};

const createHandshakeInput: CreateHandshakeInput = {
  catalog: CATALOG,
  handshakeType: 'PROGRAM_MANAGEMENT_ACCOUNT',
  associatedResourceIdentifier: PMA_ID,
  profile: CENTRAL_PROFILE,
};

const acceptHandshakeInput: AcceptHandshakeInput = {
  catalog: CATALOG,
  identifier: HANDSHAKE_ID,
  profile: PAYER_PROFILE,
};

// ---------------------------------------------------------------------------
// Fakes / stubs
// ---------------------------------------------------------------------------

/**
 * An in-memory fake of the SDK {@link PartnerCentralChannelClient} injected via
 * the `options.createClient` seam. `send()` is fully synchronous and canned, so
 * no network call is ever made; it routes on the command type and records every
 * command and the config it was constructed with.
 */
class FakeSdkChannelClient {
  /** Commands passed to `send`, in order. */
  readonly sentCommands: unknown[] = [];

  constructor(readonly config: { profile?: string; region: string }) {}

  // Matches the subset of the SDK client's `send` overload the code under test uses.
  send = async (command: { constructor: { name: string } }): Promise<unknown> => {
    this.sentCommands.push(command);
    switch (command.constructor.name) {
      case 'CreateProgramManagementAccountCommand':
        return { programManagementAccountDetail: { id: PMA_ID, arn: `arn:aws:::${PMA_ID}` } };
      case 'CreateChannelHandshakeCommand':
        return { channelHandshakeDetail: { id: HANDSHAKE_ID, arn: `arn:aws:::${HANDSHAKE_ID}` } };
      case 'AcceptChannelHandshakeCommand':
        return { channelHandshakeDetail: { id: HANDSHAKE_ID, status: ACCEPTED_STATUS } };
      default:
        throw new Error(`FakeSdkChannelClient received unexpected command: ${command.constructor.name}`);
    }
  };
}

/** A single recorded external-tool invocation. */
interface RecordedCall {
  tool: 'cdk' | 'git' | 'aws' | string;
  args: string[];
  opts?: SpawnOpts;
}

/**
 * Stub {@link ExternalToolRunner} for the CLI fallback. Records every invocation
 * and returns a canned {@link ToolResult} for `aws` from an injectable responder.
 * The `cdk`/`git`/`run` paths fail loudly so a test notices any unexpected spawn.
 */
class StubToolRunner implements ExternalToolRunner {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly awsResponder: (args: string[]) => ToolResult) {}

  async aws(args: string[], opts?: SpawnOpts): Promise<ToolResult> {
    this.calls.push({ tool: 'aws', args, opts });
    return this.awsResponder(args);
  }

  async cdk(args: string[], opts?: SpawnOpts): Promise<ToolResult> {
    this.calls.push({ tool: 'cdk', args, opts });
    throw new Error('CliPartnerCentralClient must not invoke cdk');
  }

  async git(args: string[], opts?: SpawnOpts): Promise<ToolResult> {
    this.calls.push({ tool: 'git', args, opts });
    throw new Error('CliPartnerCentralClient must not invoke git');
  }

  async run(cmd: string, args: string[], opts?: SpawnOpts): Promise<ToolResult> {
    this.calls.push({ tool: cmd, args, opts });
    throw new Error(`CliPartnerCentralClient must not invoke arbitrary command: ${cmd}`);
  }

  render(cmd: string, args: string[], opts?: SpawnOpts): string {
    this.calls.push({ tool: cmd, args, opts });
    return [cmd, ...args].join(' ');
  }

  /** Convenience: the subcommand verb (args[1]) of each recorded `aws` call. */
  awsSubcommands(): string[] {
    return this.calls.filter((c) => c.tool === 'aws').map((c) => c.args[1]);
  }
}

/** Build a canned, successful `--output json` ToolResult for an aws subcommand. */
function awsOk(payload: unknown): ToolResult {
  return {
    command: 'aws partnercentral-channel ... --output json',
    exitCode: 0,
    stdout: JSON.stringify(payload),
    stderr: '',
    signal: null,
  };
}

/** A canned aws responder that maps each PMA subcommand to its typed JSON shape. */
function cannedAwsResponder(args: string[]): ToolResult {
  const subcommand = args[1];
  switch (subcommand) {
    case 'create-program-management-account':
      return awsOk({ programManagementAccountDetail: { id: PMA_ID, arn: `arn:aws:::${PMA_ID}` } });
    case 'create-channel-handshake':
      return awsOk({ channelHandshakeDetail: { id: HANDSHAKE_ID, arn: `arn:aws:::${HANDSHAKE_ID}` } });
    case 'accept-channel-handshake':
      return awsOk({ channelHandshakeDetail: { id: HANDSHAKE_ID, status: ACCEPTED_STATUS } });
    default:
      throw new Error(`Unexpected aws subcommand: ${subcommand}`);
  }
}

// ===========================================================================
// (1) SdkPartnerCentralClient — primary, typed SDK path (Req 17.2, 22.4)
// ===========================================================================

describe('SdkPartnerCentralClient — injected SDK client (Req 22.4)', () => {
  it('parses programManagementAccountDetail.id into { pmaId }', async () => {
    const created: FakeSdkChannelClient[] = [];
    const client = new SdkPartnerCentralClient({
      createClient: (config) => {
        const fake = new FakeSdkChannelClient(config);
        created.push(fake);
        return fake as unknown as PartnerCentralChannelClient;
      },
    });

    const result = await client.createProgramManagementAccount(createPmaInput);

    expect(result).toEqual({ pmaId: PMA_ID });
    // The injected fake was used (so no real client/network) ...
    expect(created).toHaveLength(1);
    // ... constructed for the central profile and the default region.
    expect(created[0].config).toEqual({ profile: CENTRAL_PROFILE, region: ResourceRegistry.defaultRegion });
    // ... and a typed SDK command (not a string/CLI arg list) was sent.
    expect(created[0].sentCommands).toHaveLength(1);
    expect((created[0].sentCommands[0] as object).constructor.name).toBe(
      'CreateProgramManagementAccountCommand',
    );
  });

  it('parses channelHandshakeDetail.id into { handshakeId }', async () => {
    const client = new SdkPartnerCentralClient({
      createClient: (config) => new FakeSdkChannelClient(config) as unknown as PartnerCentralChannelClient,
    });

    const result = await client.createChannelHandshake(createHandshakeInput);

    expect(result).toEqual({ handshakeId: HANDSHAKE_ID });
  });

  it('parses channelHandshakeDetail.status into { status }', async () => {
    const client = new SdkPartnerCentralClient({
      createClient: (config) => new FakeSdkChannelClient(config) as unknown as PartnerCentralChannelClient,
    });

    const result = await client.acceptChannelHandshake(acceptHandshakeInput);

    expect(result).toEqual({ status: ACCEPTED_STATUS });
  });

  it('honors a per-input region override and reuses one cached client per profile|region', async () => {
    const created: FakeSdkChannelClient[] = [];
    const client = new SdkPartnerCentralClient({
      createClient: (config) => {
        const fake = new FakeSdkChannelClient(config);
        created.push(fake);
        return fake as unknown as PartnerCentralChannelClient;
      },
    });

    // Steps 1 and 2 share the central profile + an explicit region → one client.
    await client.createProgramManagementAccount({ ...createPmaInput, region: 'eu-west-1' });
    await client.createChannelHandshake({ ...createHandshakeInput, region: 'eu-west-1' });
    // Step 3 targets the payer profile → a distinct client.
    await client.acceptChannelHandshake({ ...acceptHandshakeInput, region: 'eu-west-1' });

    expect(created).toHaveLength(2);
    expect(created[0].config).toEqual({ profile: CENTRAL_PROFILE, region: 'eu-west-1' });
    expect(created[0].sentCommands).toHaveLength(2); // create-pma + create-handshake reused the cached client
    expect(created[1].config).toEqual({ profile: PAYER_PROFILE, region: 'eu-west-1' });
    expect(created[1].sentCommands).toHaveLength(1);
  });

  it('throws when the register response omits programManagementAccountDetail.id', async () => {
    const client = new SdkPartnerCentralClient({
      createClient: () =>
        ({ send: async () => ({ programManagementAccountDetail: {} }) }) as unknown as PartnerCentralChannelClient,
    });

    await expect(client.createProgramManagementAccount(createPmaInput)).rejects.toThrow(
      /no programManagementAccountDetail\.id/,
    );
  });

  it('throws when the handshake response omits channelHandshakeDetail.id', async () => {
    const client = new SdkPartnerCentralClient({
      createClient: () =>
        ({ send: async () => ({ channelHandshakeDetail: {} }) }) as unknown as PartnerCentralChannelClient,
    });

    await expect(client.createChannelHandshake(createHandshakeInput)).rejects.toThrow(
      /no channelHandshakeDetail\.id/,
    );
  });
});

describe('SdkPartnerCentralClient — default construction intercepted by aws-sdk-client-mock (Req 22.4)', () => {
  const sdkMock = mockClient(PartnerCentralChannelClient);

  beforeEach(() => {
    sdkMock.reset();
  });

  it('drives the real client construction path with no real AWS call', async () => {
    sdkMock
      .on(CreateProgramManagementAccountCommand)
      .resolves({ programManagementAccountDetail: { id: PMA_ID } });
    sdkMock
      .on(CreateChannelHandshakeCommand)
      .resolves({ channelHandshakeDetail: { id: HANDSHAKE_ID } });
    sdkMock
      .on(AcceptChannelHandshakeCommand)
      .resolves({ channelHandshakeDetail: { id: HANDSHAKE_ID, status: ACCEPTED_STATUS } });

    // No createClient seam → exercises the real `new PartnerCentralChannelClient(...)`.
    const client = new SdkPartnerCentralClient();

    await expect(client.createProgramManagementAccount(createPmaInput)).resolves.toEqual({
      pmaId: PMA_ID,
    });
    await expect(client.createChannelHandshake(createHandshakeInput)).resolves.toEqual({
      handshakeId: HANDSHAKE_ID,
    });
    await expect(client.acceptChannelHandshake(acceptHandshakeInput)).resolves.toEqual({
      status: ACCEPTED_STATUS,
    });

    // Exactly the three typed commands were issued through the SDK.
    expect(sdkMock.commandCalls(CreateProgramManagementAccountCommand)).toHaveLength(1);
    expect(sdkMock.commandCalls(CreateChannelHandshakeCommand)).toHaveLength(1);
    expect(sdkMock.commandCalls(AcceptChannelHandshakeCommand)).toHaveLength(1);
  });
});

// ===========================================================================
// (2) CliPartnerCentralClient — contingency fallback, TS-only parsing (Req 17.2)
// ===========================================================================

describe('CliPartnerCentralClient — TypeScript JSON parsing of aws CLI output (Req 17.2)', () => {
  it('parses create-program-management-account stdout into { pmaId }', async () => {
    const tools = new StubToolRunner(cannedAwsResponder);
    const client = new CliPartnerCentralClient(tools);

    const result = await client.createProgramManagementAccount(createPmaInput);

    expect(result).toEqual({ pmaId: PMA_ID });

    const call = tools.calls[0];
    expect(call.tool).toBe('aws');
    expect(call.args[0]).toBe('partnercentral-channel');
    expect(call.args[1]).toBe('create-program-management-account');
    // The CLI is always asked for machine-readable JSON it parses in TypeScript.
    expect(call.args).toContain('--output');
    expect(call.args[call.args.indexOf('--output') + 1]).toBe('json');
    // Region defaulted from the Resource_Registry; profile threaded through opts.
    expect(call.args).toContain('--region');
    expect(call.args[call.args.indexOf('--region') + 1]).toBe(ResourceRegistry.defaultRegion);
    expect(call.opts?.profile).toBe(CENTRAL_PROFILE);
  });

  it('parses create-channel-handshake stdout into { handshakeId }', async () => {
    const tools = new StubToolRunner(cannedAwsResponder);
    const client = new CliPartnerCentralClient(tools);

    const result = await client.createChannelHandshake(createHandshakeInput);

    expect(result).toEqual({ handshakeId: HANDSHAKE_ID });
    expect(tools.calls[0].args[1]).toBe('create-channel-handshake');
    expect(tools.calls[0].args).toContain('--output');
  });

  it('parses accept-channel-handshake stdout into { status }', async () => {
    const tools = new StubToolRunner(cannedAwsResponder);
    const client = new CliPartnerCentralClient(tools);

    const result = await client.acceptChannelHandshake(acceptHandshakeInput);

    expect(result).toEqual({ status: ACCEPTED_STATUS });
    expect(tools.calls[0].args[1]).toBe('accept-channel-handshake');
    expect(tools.calls[0].opts?.profile).toBe(PAYER_PROFILE);
  });

  it('NEVER invokes python3 (or any non-aws tool) across the whole flow (Req 17.2)', async () => {
    const tools = new StubToolRunner(cannedAwsResponder);
    const client = new CliPartnerCentralClient(tools);

    await client.createProgramManagementAccount(createPmaInput);
    await client.createChannelHandshake(createHandshakeInput);
    await client.acceptChannelHandshake(acceptHandshakeInput);

    // Every spawned tool was `aws partnercentral-channel ...` with --output json.
    expect(tools.calls).toHaveLength(3);
    for (const call of tools.calls) {
      expect(call.tool).toBe('aws');
      expect(call.args[0]).toBe('partnercentral-channel');
      expect(call.args).toContain('--output');
      // No external interpreter anywhere — not as the tool, not buried in args.
      expect(call.tool).not.toBe('python3');
      expect(call.args).not.toContain('python3');
      expect(call.args.some((a) => a.includes('python'))).toBe(false);
      expect(call.args.some((a) => a.includes('jq'))).toBe(false);
    }
    expect(tools.awsSubcommands()).toEqual([
      'create-program-management-account',
      'create-channel-handshake',
      'accept-channel-handshake',
    ]);
  });

  it('throws on a non-zero exit code, surfacing stderr detail', async () => {
    const tools = new StubToolRunner(() => ({
      command: 'aws partnercentral-channel create-program-management-account ...',
      exitCode: 255,
      stdout: '',
      stderr: 'AccessDeniedException: not authorized',
      signal: null,
    }));
    const client = new CliPartnerCentralClient(tools);

    await expect(client.createProgramManagementAccount(createPmaInput)).rejects.toThrow(
      /create-program-management-account failed: AccessDeniedException: not authorized/,
    );
  });

  it('throws a clear error when the CLI stdout is not valid JSON', async () => {
    const tools = new StubToolRunner(() => ({
      command: 'aws partnercentral-channel create-program-management-account ...',
      exitCode: 0,
      stdout: 'not-json{',
      stderr: '',
      signal: null,
    }));
    const client = new CliPartnerCentralClient(tools);

    await expect(client.createProgramManagementAccount(createPmaInput)).rejects.toThrow(
      /Failed to parse JSON output/,
    );
  });

  it('throws when valid JSON is missing the expected id field', async () => {
    const tools = new StubToolRunner(() => awsOk({ programManagementAccountDetail: {} }));
    const client = new CliPartnerCentralClient(tools);

    await expect(client.createProgramManagementAccount(createPmaInput)).rejects.toThrow(
      /no programManagementAccountDetail\.id/,
    );
  });
});

// ===========================================================================
// Factory — selects the right implementation (Req 17.2, 22.4)
// ===========================================================================

describe('createPartnerCentralClient factory', () => {
  it('defaults to the SDK implementation', () => {
    expect(createPartnerCentralClient()).toBeInstanceOf(SdkPartnerCentralClient);
  });

  it('threads the createClient seam through to the SDK implementation', async () => {
    const created: FakeSdkChannelClient[] = [];
    const client = createPartnerCentralClient({
      createClient: (config) => {
        const fake = new FakeSdkChannelClient(config);
        created.push(fake);
        return fake as unknown as PartnerCentralChannelClient;
      },
    });

    await expect(client.createProgramManagementAccount(createPmaInput)).resolves.toEqual({
      pmaId: PMA_ID,
    });
    expect(created).toHaveLength(1);
  });

  it('returns the CLI implementation when prefer: cli with a tools runner', () => {
    const tools = new StubToolRunner(cannedAwsResponder);
    expect(createPartnerCentralClient({ prefer: 'cli', tools })).toBeInstanceOf(
      CliPartnerCentralClient,
    );
  });

  it('throws when prefer: cli is requested without a tools runner', () => {
    expect(() => createPartnerCentralClient({ prefer: 'cli' })).toThrow(/requires an ExternalToolRunner/);
  });
});
