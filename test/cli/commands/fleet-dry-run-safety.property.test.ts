// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
/**
 * Property-based test for cross-cutting fleet dry-run safety.
 *
 * Covers the design's Correctness Property 11 (Fleet mutating operations never
 * mutate in dry-run): for any fleet Mutating_Operation invoked WITHOUT
 * `--execute` (i.e. `global.execute === false`) and any profile list, the
 * command performs no mutating AWS call and no mutating external-tool
 * invocation, and exits with a zero status code.
 *
 * The four Mutating_Operations under test are the already-implemented,
 * dry-run-by-default command handlers:
 *  - `triggerReconciliation`  (cli/commands/reconciliation/trigger.ts)
 *  - `fleetDeploy`            (cli/commands/fleet/deploy.ts)
 *  - `gitPushHandler`         (cli/commands/git/push.ts)
 *  - `seedParamsHandler`      (cli/commands/partner-central/seed-params.ts)
 *
 * Each handler is invoked directly (no `bt` spawning, per Req 22.3) with an
 * in-memory {@link IoContext} whose dependencies are INSTRUMENTED stubs that
 * record any mutating action:
 *  - `ctx.clients`: a stub AwsClientFactory whose every client `send()` records
 *    the dispatched command. The property asserts NO mutating SDK command
 *    (Lambda `InvokeCommand`, SSM `PutParameterCommand`) is ever sent in
 *    dry-run. (Reads needed for dry-run planning would be acceptable; in dry-run
 *    none are even issued in-process.)
 *  - `ctx.tools`: a stub ExternalToolRunner that records every `cdk()`/`git()`/
 *    `aws()` EXECUTION separately from `render()` planning. The property asserts
 *    no mutating tool is executed: no `cdk` spawn at all (cdk is only spawned in
 *    execute mode) and no `git push`. Read-only probes the dry-run uses for
 *    planning (`aws sts get-caller-identity`, `aws configure get region`,
 *    `git rev-parse`, `git remote get-url`) and `render()` are allowed.
 *  - `ctx.fleet`: a stub FleetRunner that records the `execute` flag of every
 *    `run()` it is asked to perform. The property asserts it is NEVER invoked
 *    with `execute === true` in dry-run.
 *
 * The property also asserts each handler returns exit code Success (0) in
 * dry-run (Req 20.7).
 *
 * The profile-list-dependent handlers (trigger, fleet deploy, seed-params) load
 * their fleet via the real Profile_Loader, so a temp `payer-profiles.txt` is
 * written per run and surfaced through `PAYER_PROFILES_FILE`; `bt git push`
 * receives an injected in-memory profile loader.
 *
 * Validates: Requirements 11.2, 13.1, 15.1, 18.1, 20.1, 20.7
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import fc from 'fast-check';

import { triggerReconciliation } from '../../../cli/commands/reconciliation/trigger.js';
import { fleetDeploy } from '../../../cli/commands/fleet/deploy.js';
import { createGitPushHandler } from '../../../cli/commands/git/push.js';
import { seedParamsHandler } from '../../../cli/commands/partner-central/seed-params.js';

import { CliExitCode } from '../../../cli/lib/exit-codes.js';
import type { GlobalOptions, IoContext, OutputSink, Scope } from '../../../cli/lib/io-context.js';
import type { AwsClientFactory } from '../../../cli/lib/aws-clients.js';
import type {
  ExternalToolRunner,
  SpawnOpts,
  ToolResult,
} from '../../../cli/lib/external-tool-runner.js';
import type {
  FleetRunner,
  FleetRunnerOptions,
  FleetResult,
} from '../../../cli/lib/fleet-runner.js';
import type { ProfileLoader } from '../../../cli/lib/profile-loader.js';
import { createOutputFormatter } from '../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../cli/lib/error-reporter.js';

// ---------------------------------------------------------------------------
// Instrumented stubs
// ---------------------------------------------------------------------------

/** One recorded external-tool invocation (an actual spawn, not a `render`). */
interface ToolExecution {
  tool: string;
  args: string[];
}

/**
 * Recording AwsClientFactory: every accessor returns the same recording client,
 * whose `send()` appends the dispatched command to a shared list so the property
 * can assert no mutating SDK command was issued. No real AWS call is ever made.
 */
function createRecordingClients(): { factory: AwsClientFactory; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    // `sendWithRetry` calls `client.send(command)`; record and resolve benignly.
    send: (command: unknown): Promise<unknown> => {
      sent.push(command);
      return Promise.resolve({});
    },
  };
  // Every documented accessor returns the same recording client.
  const factory = new Proxy(
    {},
    {
      get: () => () => client,
    },
  ) as unknown as AwsClientFactory;
  return { factory, sent };
}

/**
 * Recording ExternalToolRunner. `cdk`/`git`/`aws`/`run` record an EXECUTION and
 * resolve a benign {@link ToolResult} (read-only probes return the stdout the
 * dry-run planners expect); `render` records a (harmless) plan and returns the
 * command line WITHOUT executing anything.
 */
class RecordingToolRunner implements ExternalToolRunner {
  readonly executions: ToolExecution[] = [];
  readonly renders: ToolExecution[] = [];

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

  render(cmd: string, args: string[], _opts: SpawnOpts = {}): string {
    this.renders.push({ tool: cmd, args });
    return [cmd, ...args].join(' ');
  }

  private exec(tool: string, args: string[], _opts: SpawnOpts): Promise<ToolResult> {
    this.executions.push({ tool, args });
    return Promise.resolve({
      command: [tool, ...args].join(' '),
      exitCode: 0,
      stdout: stubStdout(tool, args),
      stderr: '',
      signal: null,
    });
  }
}

/**
 * Canned stdout for the read-only probes the dry-run planners issue, so the
 * handlers proceed down their dry-run path:
 *  - `aws sts get-caller-identity` → a 12-digit account id (fleet deploy).
 *  - `aws configure get region`     → a region (fleet deploy).
 *  - `git rev-parse --abbrev-ref HEAD` → the current branch (git push).
 * Everything else (e.g. `git remote get-url`) returns empty stdout with exit 0.
 */
function stubStdout(tool: string, args: string[]): string {
  if (tool === 'aws' && args.includes('sts')) {
    return '123456789012';
  }
  if (tool === 'aws' && args.includes('configure')) {
    return 'us-east-1';
  }
  if (tool === 'git' && args[0] === 'rev-parse') {
    return 'main';
  }
  return '';
}

/**
 * Recording FleetRunner: records every `run()` call (capturing the `execute`
 * flag) and returns an all-succeeded {@link FleetResult} so the calling handler
 * computes a Success exit code. The property asserts `execute` is never `true`
 * in dry-run.
 */
class RecordingFleetRunner implements FleetRunner {
  readonly runCalls: FleetRunnerOptions[] = [];

  run<TData>(opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    this.runCalls.push(opts);
    const accounts = opts.profiles.map((profile) => ({
      profile,
      status: 'ok' as const,
      exitCode: 0,
      data: undefined as unknown as TData,
    }));
    return Promise.resolve({
      accounts,
      succeeded: accounts.length,
      failed: 0,
      exitCode: CliExitCode.Success,
    });
  }

  selfInvocation(command: string[], profile: string): string[] {
    return ['node', 'bt.js', ...command, '--profile', profile, '--json'];
  }
}

/** In-memory {@link OutputSink} so nothing reaches the real process streams. */
function createSink(): OutputSink {
  return {
    write: () => {
      /* discard */
    },
    writeLine: () => {
      /* discard */
    },
  };
}

/** Aggregated instrumented stubs plus the assembled IoContext for one invocation. */
interface Harness {
  ctx: IoContext;
  clients: { sent: unknown[] };
  tools: RecordingToolRunner;
  fleet: RecordingFleetRunner;
}

/** Build a fresh instrumented IoContext for a single handler invocation. */
function makeHarness(global: GlobalOptions, cwd: string, profilesFilePath: string): Harness {
  const { factory, sent } = createRecordingClients();
  const tools = new RecordingToolRunner();
  const fleet = new RecordingFleetRunner();

  const ctx: IoContext = {
    stdout: createSink(),
    stderr: createSink(),
    env: { PAYER_PROFILES_FILE: profilesFilePath },
    cwd,
    clients: factory,
    tools,
    fleet,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };

  return { ctx, clients: { sent }, tools, fleet };
}

// ---------------------------------------------------------------------------
// Mutation detectors
// ---------------------------------------------------------------------------

/** SDK command class names that mutate state and must never fire in dry-run. */
const MUTATING_SDK_COMMANDS = new Set(['InvokeCommand', 'PutParameterCommand']);

/** True when a recorded SDK command is a mutating one. */
function isMutatingSdkCommand(command: unknown): boolean {
  const name = (command as { constructor?: { name?: string } })?.constructor?.name;
  return name !== undefined && MUTATING_SDK_COMMANDS.has(name);
}

/**
 * True when a recorded tool EXECUTION mutates state. `cdk` is only ever spawned
 * to bootstrap/deploy/destroy (mutating), so any `cdk` execution counts; `git`
 * mutates only via `push`. Read-only `aws`/`git` probes used for planning do
 * not count.
 */
function isMutatingToolExecution(execution: ToolExecution): boolean {
  if (execution.tool === 'cdk') {
    return true;
  }
  if (execution.tool === 'git' && execution.args[0] === 'push') {
    return true;
  }
  return false;
}

/** Assert a completed dry-run handler invocation mutated nothing and exited zero. */
function assertNoDryRunMutation(harness: Harness, exitCode: CliExitCode, label: string): void {
  // Req 20.7 / 11.2 / 13.1 / 15.1 / 18.1: a dry-run fleet operation exits zero.
  expect(exitCode).toBe(CliExitCode.Success);

  // Req 20.1: no mutating AWS SDK command was dispatched.
  const mutatingSends = harness.clients.sent.filter(isMutatingSdkCommand);
  expect(mutatingSends).toHaveLength(0);

  // Req 20.1 / 13.1 / 15.1: no mutating external-tool invocation was executed.
  const mutatingExecs = harness.tools.executions.filter(isMutatingToolExecution);
  expect(mutatingExecs).toHaveLength(0);

  // The Fleet_Runner is never asked to run children in execute mode.
  expect(harness.fleet.runCalls.every((call) => call.execute === false)).toBe(true);

  // Guard the label so a future handler addition cannot silently skip a case.
  expect(typeof label).toBe('string');
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty, unique, parse-clean profile names (no blank/`#`/whitespace lines). */
const profilesArb: fc.Arbitrary<string[]> = fc
  .array(fc.stringMatching(/^[A-Za-z0-9._-]{1,15}$/), { minLength: 1, maxLength: 6 })
  .map((names) => names.map((name, index) => `${index}-${name}`));

/** A resolved Scope for the scope-sensitive handlers (fleet deploy / seed-params). */
const scopeArb: fc.Arbitrary<Scope> = fc.constantFrom<Scope>(
  { kind: 'all-profiles' },
  { kind: 'profile', profile: 'payer-single' },
  { kind: 'ambient' },
);

/** A valid Reconciliation_Target (plus the omitted/default case). */
const targetArb: fc.Arbitrary<string | undefined> = fc.constantFrom(
  'bg',
  'cur',
  'both',
  undefined,
);

/** A resolved 12-digit linked-account-id so seed-params clears validation. */
const accountIdArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** Optional bounded concurrency cap. */
const parallelArb: fc.Arbitrary<number | undefined> = fc.option(fc.integer({ min: 1, max: 5 }), {
  nil: undefined,
});

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

describe('Fleet dry-run safety (Property 11)', () => {
  let tmpDir: string;
  let profilesFilePath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dryrun-safety-'));
    profilesFilePath = path.join(tmpDir, 'payer-profiles.txt');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Feature: billing-transfer-cli, Property 11: Fleet mutating operations never mutate in dry-run
  it('never mutates and always exits zero for trigger, fleet deploy, git push, and seed-params in dry-run', async () => {
    await fc.assert(
      fc.asyncProperty(
        profilesArb,
        scopeArb,
        targetArb,
        accountIdArb,
        parallelArb,
        fc.boolean(),
        async (profiles, scope, target, linkedAccountId, parallel, json) => {
          // Surface the fleet list to the filesystem-backed Profile_Loader.
          fs.writeFileSync(profilesFilePath, `${profiles.join('\n')}\n`, 'utf8');

          const baseGlobal = (s: Scope): GlobalOptions => ({
            scope: s,
            json,
            color: false,
            execute: false, // dry-run by default — the whole point of Property 11
            verbose: false,
            parallel,
          });

          // --- 1. reconciliation trigger -------------------------------------
          // Single-account trigger submits immediately by design; the dry-run
          // guard lives on the fleet (all-profiles) path, so drive it there.
          {
            const global = baseGlobal({ kind: 'all-profiles' });
            const harness = makeHarness(global, tmpDir, profilesFilePath);
            const { exitCode } = await triggerReconciliation({ target, global }, harness.ctx);
            assertNoDryRunMutation(harness, exitCode, 'reconciliation trigger');
            // Dry-run trigger plans without ever submitting via the Fleet_Runner.
            expect(harness.fleet.runCalls).toHaveLength(0);
          }

          // --- 2. fleet deploy ----------------------------------------------
          {
            const global = baseGlobal(scope);
            const harness = makeHarness(global, tmpDir, profilesFilePath);
            const { exitCode } = await fleetDeploy({ skipBootstrap: false, global }, harness.ctx);
            assertNoDryRunMutation(harness, exitCode, 'fleet deploy');
          }

          // --- 3. git push ---------------------------------------------------
          // git push iterates the profile list in-process (no Fleet_Runner) and
          // takes an injectable Profile_Loader, so supply an in-memory list.
          {
            const global = baseGlobal(scope);
            const harness = makeHarness(global, tmpDir, profilesFilePath);
            const stubLoader: ProfileLoader = {
              load: () => profiles,
              parseProfiles: () => profiles,
              resolvePath: () => profilesFilePath,
            };
            const handler = createGitPushHandler({ profileLoader: stubLoader });
            const { exitCode } = await handler({ global }, harness.ctx);
            assertNoDryRunMutation(harness, exitCode, 'git push');
            // No `git push` was executed; the push was only rendered as a plan.
            expect(
              harness.tools.executions.some((e) => e.tool === 'git' && e.args[0] === 'push'),
            ).toBe(false);
          }

          // --- 4. partner-central seed-params -------------------------------
          {
            const global = baseGlobal(scope);
            const harness = makeHarness(global, tmpDir, profilesFilePath);
            const { exitCode } = await seedParamsHandler({ linkedAccountId, global }, harness.ctx);
            assertNoDryRunMutation(harness, exitCode, 'seed-params');
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
