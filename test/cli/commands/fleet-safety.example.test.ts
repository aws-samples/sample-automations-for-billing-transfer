// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect, beforeAll, afterAll } from '@jest/globals';
/**
 * Cross-cutting fleet safety example tests (Requirement 20.2, 20.3, 20.4, 20.5).
 *
 * Where the companion property test (`fleet-dry-run-safety.property.test.ts`)
 * proves the *dry-run* contract, this example suite exercises the *execute*
 * mode of the three mutating fleet command handlers and pins down the
 * aggregated-summary / per-account-failure / continue-on-failure / exit-code
 * behavior with concrete, mixed-outcome examples:
 *
 *  - `triggerReconciliation` (cli/commands/reconciliation/trigger.ts)
 *  - `fleetDeploy`           (cli/commands/fleet/deploy.ts)
 *  - `seedParamsHandler`     (cli/commands/partner-central/seed-params.ts)
 *
 * Each handler is invoked directly (no `bt` spawning, per Req 22.3) with
 * `global.scope = { kind: 'all-profiles' }` and `global.execute = true`, driven
 * through a STUB {@link FleetRunner} that returns a {@link FleetResult} with a
 * deterministic mix of `ok` and `failed` {@link AccountResult}s. Failed accounts
 * carry either a failure-cause detail or a per-account log pointer, mirroring the
 * two forms the real Fleet_Runner produces (Req 20.4).
 *
 * The fleet path loads its profile list through the real Profile_Loader, so a
 * temp `payer-profiles.txt` is written and surfaced via `PAYER_PROFILES_FILE`.
 * The Output_Formatter is the real one in `--json` mode, so the assertions cover
 * both the typed result the handler returns and the single JSON document it
 * actually emits to stdout.
 *
 * Asserted across all three commands:
 *  - Aggregated success/failure summary: emitted `succeeded`/`failed` counts
 *    match the fleet outcome (Req 20.2, 20.3).
 *  - Continue-on-failure: every account in the resolved profile list appears in
 *    the emitted result even when some failed (Req 20.3).
 *  - Per-failed-account detail: each failed account surfaces a non-empty failure
 *    detail or a per-account log pointer (Req 20.4).
 *  - Exit code: non-zero (`FleetPartialFailure`) when any account failed
 *    (Req 20.4), and zero (`Success`) when all accounts succeed (Req 20.5).
 *
 * Validates: Requirements 20.2, 20.3, 20.4, 20.5
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { triggerReconciliation } from '../../../cli/commands/reconciliation/trigger.js';
import { fleetDeploy } from '../../../cli/commands/fleet/deploy.js';
import { seedParamsHandler } from '../../../cli/commands/partner-central/seed-params.js';

import { CliExitCode } from '../../../cli/lib/exit-codes.js';
import type { GlobalOptions, IoContext, OutputSink } from '../../../cli/lib/io-context.js';
import type { AwsClientFactory } from '../../../cli/lib/aws-clients.js';
import type { ExternalToolRunner, SpawnOpts, ToolResult } from '../../../cli/lib/external-tool-runner.js';
import type {
  AccountResult,
  FleetRunner,
  FleetRunnerOptions,
  FleetResult,
} from '../../../cli/lib/fleet-runner.js';
import { createOutputFormatter } from '../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../cli/lib/error-reporter.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Ordered fleet under test: four payer profiles. */
const PROFILES = ['payer-0', 'payer-1', 'payer-2', 'payer-3'];

/** Indexes that fail in the mixed-outcome scenario (one log-pointer, one cause). */
const FAILED_INDEXES = new Set([1, 3]);

/** A valid 12-digit linked-account-id so seed-params clears validation before any write. */
const LINKED_ACCOUNT_ID = '123456789012';

/**
 * Failure detail for a failed account, alternating between the two forms the
 * real Fleet_Runner emits so Req 20.4 ("a failure detail describing the cause
 * OR a pointer to that account's per-account log") is covered by both shapes.
 */
function failureDetailFor(profile: string, index: number): string {
  return index === 1
    ? `child exited with code 1; see /tmp/bt-logs/${profile}.log` // per-account log pointer
    : `operation failed for ${profile}: simulated cause`; //         failure cause
}

// ---------------------------------------------------------------------------
// Stub FleetRunner: returns a deterministic mix of ok/failed AccountResults
// ---------------------------------------------------------------------------

/** How one profile resolves in a fleet run. */
type Outcome = { status: 'ok'; data?: unknown } | { status: 'failed'; failureDetail: string };

/**
 * Stub {@link FleetRunner} that turns the resolved profile list into a
 * {@link FleetResult} using an injected classifier, then computes the
 * aggregate counts and exit code exactly as the real runner does (non-zero iff
 * any account failed). It records each `run()` call so the test can confirm the
 * handler routed through the fleet in execute mode.
 */
class StubFleetRunner implements FleetRunner {
  readonly runCalls: FleetRunnerOptions[] = [];

  constructor(private readonly classify: (profile: string, index: number) => Outcome) {}

  run<TData>(opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    this.runCalls.push(opts);

    const accounts: AccountResult<TData>[] = opts.profiles.map((profile, index) => {
      const outcome = this.classify(profile, index);
      if (outcome.status === 'ok') {
        return { profile, status: 'ok', exitCode: 0, data: outcome.data as TData };
      }
      return { profile, status: 'failed', exitCode: 1, failureDetail: outcome.failureDetail };
    });

    const failed = accounts.filter((account) => account.status === 'failed').length;
    const succeeded = accounts.length - failed;
    return Promise.resolve({
      accounts,
      succeeded,
      failed,
      exitCode: failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success,
    });
  }

  selfInvocation(command: string[], profile: string): string[] {
    return ['node', 'bt.js', ...command, '--profile', profile, '--json'];
  }
}

/**
 * `data` payload an `ok` child returns for `bt fleet deploy`: its single-account
 * result. `fleetDeploy` reconstitutes per-account outcomes from `data.accounts[0]`,
 * so an ok deploy account must carry a deployed single-account result; the other
 * two handlers ignore child `data` on the fleet path.
 */
function deployChildData(profile: string): unknown {
  return {
    command: 'fleet-deploy',
    scope: 'single',
    mode: 'execute',
    accounts: [
      {
        profile,
        account: LINKED_ACCOUNT_ID,
        region: 'us-east-1',
        outputDir: `cdk.out.${profile}`,
        bootstrap: 'run',
        deploy: 'succeeded',
        status: 'deployed',
      },
    ],
    succeeded: 1,
    failed: 0,
  };
}

// ---------------------------------------------------------------------------
// IoContext harness
// ---------------------------------------------------------------------------

/** In-memory {@link OutputSink} that captures everything written to it. */
function createCapturingSink(): { sink: OutputSink; text: () => string } {
  let buffer = '';
  return {
    sink: {
      write: (text: string) => {
        buffer += text;
      },
      writeLine: (line: string) => {
        buffer += `${line}\n`;
      },
    },
    text: () => buffer,
  };
}

/**
 * Benign stub {@link ExternalToolRunner}. The fleet (all-profiles) execute path
 * of every handler under test delegates to the Fleet_Runner and never spawns a
 * tool in-process, so these resolve harmlessly and are not asserted on.
 */
class StubToolRunner implements ExternalToolRunner {
  cdk(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec('cdk', args, opts);
  }
  git(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec('git', args, opts);
  }
  aws(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec('aws', args, opts);
  }
  run(cmd: string, args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.exec(cmd, args, opts);
  }
  render(cmd: string, args: string[]): string {
    return [cmd, ...args].join(' ');
  }
  private exec(tool: string, args: string[], _opts: SpawnOpts): Promise<ToolResult> {
    return Promise.resolve({
      command: [tool, ...args].join(' '),
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
    });
  }
}

/** AwsClientFactory whose every accessor returns a benign no-op client (unused on the fleet path). */
function createStubClients(): AwsClientFactory {
  const client = { send: (): Promise<unknown> => Promise.resolve({}) };
  return new Proxy(
    {},
    {
      get: () => () => client,
    },
  ) as unknown as AwsClientFactory;
}

interface Harness {
  ctx: IoContext;
  stdout: () => string;
  fleet: StubFleetRunner;
}

/** Build a fresh IoContext wired to the stub fleet, capturing stdout for JSON assertions. */
function makeHarness(global: GlobalOptions, cwd: string, profilesFilePath: string, fleet: StubFleetRunner): Harness {
  const stdout = createCapturingSink();
  const stderr = createCapturingSink();

  const ctx: IoContext = {
    stdout: stdout.sink,
    stderr: stderr.sink,
    env: { PAYER_PROFILES_FILE: profilesFilePath },
    cwd,
    clients: createStubClients(),
    tools: new StubToolRunner(),
    fleet,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };

  return { ctx, stdout: stdout.text, fleet };
}

/** Build resolved global options for an all-profiles, execute-mode, JSON run. */
function fleetExecuteGlobal(): GlobalOptions {
  return {
    scope: { kind: 'all-profiles' },
    json: true, // assert the emitted single JSON document, not just the returned value
    color: false,
    execute: true,
    verbose: false,
  };
}

// ---------------------------------------------------------------------------
// Common result shape across the three handlers
// ---------------------------------------------------------------------------

/** The aggregate fields every mutating fleet result exposes at its top level. */
interface FleetResultShape {
  accounts: Array<{ profile?: string; status?: string; failureDetail?: string }>;
  succeeded: number;
  failed: number;
}

/** One handler under test, described uniformly so the assertions can be shared. */
interface HandlerCase {
  name: string;
  /** `data` for an `ok` child (deploy needs a real single-account result; others ignore it). */
  okData: (profile: string) => unknown;
  /** Invoke the handler in all-profiles execute mode. */
  invoke: (ctx: IoContext, global: GlobalOptions) => Promise<{ result: FleetResultShape; exitCode: CliExitCode }>;
}

const HANDLER_CASES: HandlerCase[] = [
  {
    name: 'reconciliation trigger',
    okData: () => undefined,
    invoke: (ctx, global) =>
      triggerReconciliation({ target: 'both', global }, ctx) as Promise<{
        result: FleetResultShape;
        exitCode: CliExitCode;
      }>,
  },
  {
    name: 'fleet deploy',
    okData: (profile) => deployChildData(profile),
    invoke: (ctx, global) =>
      fleetDeploy({ skipBootstrap: false, global }, ctx) as Promise<{
        result: FleetResultShape;
        exitCode: CliExitCode;
      }>,
  },
  {
    name: 'partner-central seed-params',
    okData: () => undefined,
    invoke: (ctx, global) =>
      seedParamsHandler({ linkedAccountId: LINKED_ACCOUNT_ID, global }, ctx) as Promise<{
        result: FleetResultShape;
        exitCode: CliExitCode;
      }>,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cross-cutting fleet safety in execute mode (Req 20.2-20.5)', () => {
  let tmpDir: string;
  let profilesFilePath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fleet-safety-'));
    profilesFilePath = path.join(tmpDir, 'payer-profiles.txt');
    fs.writeFileSync(profilesFilePath, `${PROFILES.join('\n')}\n`, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.each(HANDLER_CASES)('$name', (handlerCase) => {
    it('reports the aggregated summary, surfaces per-failed-account detail, continues on failure, and exits non-zero', async () => {
      // Mixed outcome: two accounts fail (indexes 1 and 3), two succeed.
      const fleet = new StubFleetRunner((profile, index) =>
        FAILED_INDEXES.has(index)
          ? { status: 'failed', failureDetail: failureDetailFor(profile, index) }
          : { status: 'ok', data: handlerCase.okData(profile) },
      );
      const global = fleetExecuteGlobal();
      const harness = makeHarness(global, tmpDir, profilesFilePath, fleet);

      const { result, exitCode } = await handlerCase.invoke(harness.ctx, global);

      // The handler routed through the Fleet_Runner in execute mode over the
      // full resolved profile list.
      expect(harness.fleet.runCalls).toHaveLength(1);
      expect(harness.fleet.runCalls[0].execute).toBe(true);
      expect(harness.fleet.runCalls[0].profiles).toEqual(PROFILES);

      const expectedFailed = FAILED_INDEXES.size;
      const expectedSucceeded = PROFILES.length - expectedFailed;

      // Req 20.2 / 20.3: aggregated success/failure summary in the returned result.
      expect(result.succeeded).toBe(expectedSucceeded);
      expect(result.failed).toBe(expectedFailed);

      // Req 20.3 (continue-on-failure): every account in the profile list is
      // present in the result, even though some failed.
      expect(result.accounts).toHaveLength(PROFILES.length);
      expect(result.accounts.map((account) => account.profile).sort()).toEqual([...PROFILES].sort());

      // Req 20.4: each failed account surfaces a failure detail or a log pointer.
      for (const index of FAILED_INDEXES) {
        const profile = PROFILES[index];
        const account = result.accounts.find((entry) => entry.profile === profile);
        expect(account).toBeDefined();
        expect(account?.failureDetail).toBe(failureDetailFor(profile, index));
        expect((account?.failureDetail ?? '').length).toBeGreaterThan(0);
      }

      // Req 20.4: any account failing yields a non-zero (FleetPartialFailure) exit.
      expect(exitCode).toBe(CliExitCode.FleetPartialFailure);
      expect(exitCode).not.toBe(CliExitCode.Success);

      // The emitted single JSON document carries the same summary and details to stdout.
      const emitted = JSON.parse(harness.stdout()) as FleetResultShape;
      expect(emitted.succeeded).toBe(expectedSucceeded);
      expect(emitted.failed).toBe(expectedFailed);
      expect(emitted.accounts).toHaveLength(PROFILES.length);
      for (const index of FAILED_INDEXES) {
        const profile = PROFILES[index];
        const account = emitted.accounts.find((entry) => entry.profile === profile);
        expect(account?.failureDetail).toBe(failureDetailFor(profile, index));
      }
    });

    it('exits zero with a clean summary when every account succeeds', async () => {
      // All accounts succeed.
      const fleet = new StubFleetRunner((profile) => ({ status: 'ok', data: handlerCase.okData(profile) }));
      const global = fleetExecuteGlobal();
      const harness = makeHarness(global, tmpDir, profilesFilePath, fleet);

      const { result, exitCode } = await handlerCase.invoke(harness.ctx, global);

      expect(harness.fleet.runCalls).toHaveLength(1);
      expect(harness.fleet.runCalls[0].execute).toBe(true);

      // Req 20.2 / 20.3: aggregated summary reports all succeeded, none failed.
      expect(result.succeeded).toBe(PROFILES.length);
      expect(result.failed).toBe(0);
      expect(result.accounts).toHaveLength(PROFILES.length);
      expect(result.accounts.map((account) => account.profile).sort()).toEqual([...PROFILES].sort());

      // No account carries a failure detail when all succeed.
      expect(result.accounts.every((account) => !account.failureDetail)).toBe(true);

      // Req 20.5: all accounts succeed in execute mode ⇒ zero exit code.
      expect(exitCode).toBe(CliExitCode.Success);

      const emitted = JSON.parse(harness.stdout()) as FleetResultShape;
      expect(emitted.succeeded).toBe(PROFILES.length);
      expect(emitted.failed).toBe(0);
    });
  });
});
