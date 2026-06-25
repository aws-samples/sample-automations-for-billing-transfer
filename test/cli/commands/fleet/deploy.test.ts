// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
/**
 * Unit / example tests for the fleet-deploy handler (`bt fleet deploy`).
 *
 * The handler under test is {@link fleetDeploy} from
 * `cli/commands/fleet/deploy.ts`. Each case invokes the handler directly (no
 * `bt` spawning, per Req 22.3) with an in-memory {@link IoContext} whose
 * `tools` is a STUBBED {@link ExternalToolRunner} that records every
 * `cdk()`/`aws()` EXECUTION separately from `render()` planning, and whose
 * `fleet` is a stubbed {@link FleetRunner} that records each `run()` request.
 * The AWS probes the dry-run/execute planner issues are canned:
 *  - `aws sts get-caller-identity` → a 12-digit account id (or a non-zero exit
 *    to simulate an account-resolution failure);
 *  - `aws configure get region`     → a region.
 *
 * Coverage:
 *  - Single-account DRY-RUN (`global.execute === false`) renders the planned
 *    bootstrap + deploy commands via `ctx.tools.render`, performs NO `cdk()`
 *    execution, prints the planned actions, and exits zero (Req 13.1).
 *  - EXECUTE path runs `cdk bootstrap` then `cdk deploy` of
 *    {@link ResourceRegistry.pipelineStackName} (Req 13.1).
 *  - `--skip-bootstrap` omits the bootstrap step in both dry-run and execute
 *    (Req 13.3).
 *  - An account-resolution failure (`aws sts` non-zero / empty) records a failed
 *    account, performs no deploy, reports a credentials error to stderr only,
 *    and continues (Req 13.7).
 *  - The fleet path (`--all-profiles`) routes through `ctx.fleet` with the
 *    default sequential concurrency (1) when `--parallel` is absent and forwards
 *    `--skip-bootstrap` as a passthrough arg (Req 13.9).
 *
 * Requirements: 13.1, 13.3, 13.7, 13.9
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fleetDeploy } from '../../../../cli/commands/fleet/deploy.js';
import type { FleetDeployResult } from '../../../../cli/commands/fleet/deploy.js';

import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import { ResourceRegistry } from '../../../../cli/lib/resource-registry.js';
import { createOutputFormatter } from '../../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../../cli/lib/error-reporter.js';
import type {
  GlobalOptions,
  IoContext,
  OutputSink,
  Scope,
} from '../../../../cli/lib/io-context.js';
import type { AwsClientFactory } from '../../../../cli/lib/aws-clients.js';
import type {
  ExternalToolRunner,
  SpawnOpts,
  ToolResult,
} from '../../../../cli/lib/external-tool-runner.js';
import type {
  FleetRunner,
  FleetRunnerOptions,
  FleetResult,
} from '../../../../cli/lib/fleet-runner.js';

// ---------------------------------------------------------------------------
// In-memory output sinks
// ---------------------------------------------------------------------------

/** A buffered {@link OutputSink} that records everything written to it. */
class BufferSink implements OutputSink {
  text = '';
  write(chunk: string): void {
    this.text += chunk;
  }
  writeLine(line: string): void {
    this.text += `${line}\n`;
  }
}

// ---------------------------------------------------------------------------
// Stubbed ExternalToolRunner
// ---------------------------------------------------------------------------

/** One recorded external-tool invocation or render. */
interface ToolCall {
  tool: string;
  args: string[];
  opts: SpawnOpts;
}

/** Configuration for the stubbed tool runner's canned AWS probe responses. */
interface StubToolOptions {
  /** Exit code for `aws sts get-caller-identity` (default 0 → resolves). */
  stsExitCode?: number;
  /** stdout for `aws sts get-caller-identity` (default a 12-digit account id). */
  stsStdout?: string;
  /** stdout for `aws configure get region` (default `us-east-1`). */
  regionStdout?: string;
  /** Queue of exit codes for successive `cdk()` calls (default: all 0). */
  cdkExitCodes?: number[];
}

/**
 * Stubbed {@link ExternalToolRunner}. `cdk`/`git`/`aws`/`run` record an
 * EXECUTION and resolve a benign {@link ToolResult} (AWS probes return the
 * canned stdout the planner expects); `render` records a (non-executing) plan
 * and returns the command line WITHOUT spawning anything.
 */
class StubToolRunner implements ExternalToolRunner {
  readonly executions: ToolCall[] = [];
  readonly renders: ToolCall[] = [];
  private readonly opts: StubToolOptions;
  private readonly cdkExitCodes: number[];

  constructor(opts: StubToolOptions = {}) {
    this.opts = opts;
    this.cdkExitCodes = [...(opts.cdkExitCodes ?? [])];
  }

  cdk(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    this.executions.push({ tool: 'cdk', args, opts });
    const exitCode = this.cdkExitCodes.shift() ?? 0;
    return Promise.resolve(this.result('cdk', args, exitCode, ''));
  }

  git(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    this.executions.push({ tool: 'git', args, opts });
    return Promise.resolve(this.result('git', args, 0, ''));
  }

  aws(args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    this.executions.push({ tool: 'aws', args, opts });
    const { exitCode, stdout } = this.awsResponse(args);
    return Promise.resolve(this.result('aws', args, exitCode, stdout));
  }

  run(cmd: string, args: string[], opts: SpawnOpts = {}): Promise<ToolResult> {
    this.executions.push({ tool: cmd, args, opts });
    return Promise.resolve(this.result(cmd, args, 0, ''));
  }

  render(cmd: string, args: string[], opts: SpawnOpts = {}): string {
    this.renders.push({ tool: cmd, args, opts });
    return [cmd, ...args].join(' ');
  }

  /** All recorded `cdk()` executions, in call order. */
  get cdkExecutions(): ToolCall[] {
    return this.executions.filter((call) => call.tool === 'cdk');
  }

  private awsResponse(args: string[]): { exitCode: number; stdout: string } {
    if (args.includes('sts')) {
      return { exitCode: this.opts.stsExitCode ?? 0, stdout: this.opts.stsStdout ?? '123456789012' };
    }
    if (args.includes('configure')) {
      return { exitCode: 0, stdout: this.opts.regionStdout ?? 'us-east-1' };
    }
    return { exitCode: 0, stdout: '' };
  }

  private result(tool: string, args: string[], exitCode: number, stdout: string): ToolResult {
    return { command: [tool, ...args].join(' '), exitCode, stdout, stderr: '', signal: null };
  }
}

// ---------------------------------------------------------------------------
// Stubbed FleetRunner
// ---------------------------------------------------------------------------

/**
 * Stubbed {@link FleetRunner} that records each `run()` request and returns an
 * all-succeeded {@link FleetResult} derived from the supplied profile list, so
 * the calling handler computes a Success exit code.
 */
class StubFleetRunner implements FleetRunner {
  readonly runCalls: FleetRunnerOptions[] = [];

  run<TData>(opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    this.runCalls.push(opts);
    const accounts = opts.profiles.map((profile) => ({
      profile,
      status: 'ok' as const,
      exitCode: 0,
      data: {
        command: 'fleet-deploy',
        scope: 'single',
        mode: opts.execute ? 'execute' : 'dry-run',
        accounts: [
          {
            profile,
            outputDir: `cdk.out.${profile}`,
            bootstrap: opts.execute ? 'run' : 'planned',
            deploy: opts.execute ? 'succeeded' : 'planned',
            status: opts.execute ? 'deployed' : 'planned',
          },
        ],
        succeeded: 1,
        failed: 0,
      } as unknown as TData,
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

/** A FleetRunner that fails the test if it is ever invoked (single-account guard). */
class ThrowingFleetRunner implements FleetRunner {
  run<TData>(): Promise<FleetResult<TData>> {
    throw new Error('Fleet_Runner must not be invoked on the single-account path');
  }
  selfInvocation(): string[] {
    throw new Error('Fleet_Runner must not be invoked on the single-account path');
  }
}

// ---------------------------------------------------------------------------
// IoContext assembly
// ---------------------------------------------------------------------------

interface CtxOverrides {
  tools: ExternalToolRunner;
  fleet: FleetRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface Harness {
  ctx: IoContext;
  stdout: BufferSink;
  stderr: BufferSink;
}

/** Build an in-memory {@link IoContext} backed by buffered sinks and the stubs. */
function makeHarness(global: GlobalOptions, overrides: CtxOverrides): Harness {
  const stdout = new BufferSink();
  const stderr = new BufferSink();
  const ctx: IoContext = {
    stdout,
    stderr,
    env: overrides.env ?? {},
    cwd: overrides.cwd ?? '/work/repo',
    // Deploy never touches AWS SDK clients; provide an unused stub.
    clients: {} as unknown as AwsClientFactory,
    tools: overrides.tools,
    fleet: overrides.fleet,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };
  return { ctx, stdout, stderr };
}

/** Base GlobalOptions for a given scope (human output, dry-run by default). */
function baseGlobal(scope: Scope, overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    scope,
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleetDeploy handler (Req 13.1, 13.3, 13.7, 13.9)', () => {
  describe('single-account dry-run (Req 13.1)', () => {
    it('renders planned bootstrap + deploy, runs no cdk, prints the plan, and exits zero', async () => {
      const tools = new StubToolRunner();
      const global = baseGlobal({ kind: 'profile', profile: 'payer-a' });
      const { ctx, stdout, stderr } = makeHarness(global, {
        tools,
        fleet: new ThrowingFleetRunner(),
      });

      const { result, exitCode } = await fleetDeploy({ skipBootstrap: false, global }, ctx);

      // Dry-run mutates nothing: no cdk execution at all.
      expect(tools.cdkExecutions).toHaveLength(0);

      // Both bootstrap and deploy were RENDERED (planned) via ctx.tools.render.
      expect(tools.renders).toHaveLength(2);
      expect(tools.renders[0]).toMatchObject({
        tool: 'cdk',
        args: ['bootstrap', 'aws://123456789012/us-east-1'],
      });
      expect(tools.renders[1]).toMatchObject({
        tool: 'cdk',
        args: ['deploy', ResourceRegistry.pipelineStackName],
      });

      // Typed result reflects a planned-only outcome.
      expect(result.mode).toBe('dry-run');
      expect(result.scope).toBe('single');
      expect(result.accounts).toHaveLength(1);
      const [account] = result.accounts;
      expect(account.status).toBe('planned');
      expect(account.bootstrap).toBe('planned');
      expect(account.deploy).toBe('planned');
      expect(account.plannedActions).toEqual([
        `cdk bootstrap aws://123456789012/us-east-1`,
        `cdk deploy ${ResourceRegistry.pipelineStackName}`,
      ]);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);

      // The plan is printed to stdout (human mode), not stderr.
      expect(stdout.text).toContain('DRY-RUN');
      expect(stdout.text).toContain('Planned actions');
      expect(stdout.text).toContain(`cdk deploy ${ResourceRegistry.pipelineStackName}`);
      expect(stderr.text).toBe('');

      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('execute path (Req 13.1)', () => {
    it('runs cdk bootstrap then cdk deploy of the pipeline stack under the active profile', async () => {
      const tools = new StubToolRunner();
      const global = baseGlobal({ kind: 'profile', profile: 'payer-x' }, { execute: true });
      const outputDir = path.resolve('/work/repo', 'cdk.out.payer-x');
      const { ctx } = makeHarness(global, {
        tools,
        fleet: new ThrowingFleetRunner(),
        cwd: '/work/repo',
      });

      const { result, exitCode } = await fleetDeploy({ skipBootstrap: false, global }, ctx);

      // Exactly two cdk executions, in order: bootstrap then deploy.
      expect(tools.cdkExecutions).toHaveLength(2);
      expect(tools.cdkExecutions[0].args).toEqual(['bootstrap', 'aws://123456789012/us-east-1']);
      expect(tools.cdkExecutions[1].args).toEqual(['deploy', ResourceRegistry.pipelineStackName]);

      // Both run under the active profile into the isolated per-profile output dir.
      expect(tools.cdkExecutions[0].opts).toMatchObject({ profile: 'payer-x', outputDir });
      expect(tools.cdkExecutions[1].opts).toMatchObject({ profile: 'payer-x', outputDir });

      // No dry-run rendering happens on the execute path.
      expect(tools.renders).toHaveLength(0);

      expect(result.mode).toBe('execute');
      const [account] = result.accounts;
      expect(account.bootstrap).toBe('run');
      expect(account.deploy).toBe('succeeded');
      expect(account.status).toBe('deployed');
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('--skip-bootstrap (Req 13.3)', () => {
    it('omits the bootstrap from the dry-run plan', async () => {
      const tools = new StubToolRunner();
      const global = baseGlobal({ kind: 'profile', profile: 'payer-a' });
      const { ctx } = makeHarness(global, { tools, fleet: new ThrowingFleetRunner() });

      const { result } = await fleetDeploy({ skipBootstrap: true, global }, ctx);

      // Only deploy is rendered; bootstrap is not.
      expect(tools.renders).toHaveLength(1);
      expect(tools.renders[0].args).toEqual(['deploy', ResourceRegistry.pipelineStackName]);
      expect(tools.cdkExecutions).toHaveLength(0);

      const [account] = result.accounts;
      expect(account.bootstrap).toBe('skipped');
      expect(account.plannedActions).toEqual([`cdk deploy ${ResourceRegistry.pipelineStackName}`]);
    });

    it('omits the bootstrap from the execute path (deploy only)', async () => {
      const tools = new StubToolRunner();
      const global = baseGlobal({ kind: 'profile', profile: 'payer-a' }, { execute: true });
      const { ctx } = makeHarness(global, { tools, fleet: new ThrowingFleetRunner() });

      const { result, exitCode } = await fleetDeploy({ skipBootstrap: true, global }, ctx);

      // Exactly one cdk execution: deploy. No bootstrap was run.
      expect(tools.cdkExecutions).toHaveLength(1);
      expect(tools.cdkExecutions[0].args).toEqual(['deploy', ResourceRegistry.pipelineStackName]);
      expect(tools.executions.some((c) => c.tool === 'cdk' && c.args[0] === 'bootstrap')).toBe(
        false,
      );

      const [account] = result.accounts;
      expect(account.bootstrap).toBe('skipped');
      expect(account.deploy).toBe('succeeded');
      expect(account.status).toBe('deployed');
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('account-resolution failure (Req 13.7)', () => {
    it('records a failed account, performs no deploy, reports to stderr only, and continues', async () => {
      // `aws sts get-caller-identity` exits non-zero → account cannot be resolved.
      const tools = new StubToolRunner({ stsExitCode: 1 });
      const global = baseGlobal({ kind: 'profile', profile: 'payer-bad' }, { execute: true });
      const { ctx, stdout, stderr } = makeHarness(global, {
        tools,
        fleet: new ThrowingFleetRunner(),
      });

      const { result, exitCode } = await fleetDeploy({ skipBootstrap: false, global }, ctx);

      // No cdk execution and no render: deploy never happened.
      expect(tools.cdkExecutions).toHaveLength(0);
      expect(tools.renders).toHaveLength(0);
      // Only the sts probe was attempted (region resolution is never reached).
      expect(tools.executions.filter((c) => c.tool === 'aws')).toHaveLength(1);

      const [account] = result.accounts;
      expect(account.status).toBe('failed');
      expect(account.deploy).toBe('not-run');
      expect(account.failureDetail).toMatch(/payer-bad/);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);

      // The credentials error is reported on stderr only (Req 6.5).
      expect(stderr.text).toContain('credentials');
      expect(stdout.text).not.toContain('Unable to resolve AWS credentials');

      expect(exitCode).toBe(CliExitCode.GeneralError);
    });
  });

  describe('fleet path --all-profiles (Req 13.9)', () => {
    let tmpDir: string;
    let profilesFile: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fleet-deploy-test-'));
      profilesFile = path.join(tmpDir, 'payer-profiles.txt');
      fs.writeFileSync(profilesFile, 'payer-a\npayer-b\n', 'utf8');
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('routes through ctx.fleet with sequential concurrency (1) when --parallel is absent and forwards --skip-bootstrap', async () => {
      const tools = new StubToolRunner();
      const fleet = new StubFleetRunner();
      const global = baseGlobal(
        { kind: 'all-profiles' },
        { execute: true }, // --parallel intentionally absent → sequential
      );
      const { ctx } = makeHarness(global, {
        tools,
        fleet,
        env: { PAYER_PROFILES_FILE: profilesFile },
        cwd: tmpDir,
      });

      const { result, exitCode } = await fleetDeploy({ skipBootstrap: true, global }, ctx);

      // The Fleet_Runner is invoked exactly once for the fleet.
      expect(fleet.runCalls).toHaveLength(1);
      const [runOpts] = fleet.runCalls;

      // Default concurrency is sequential (1) when --parallel is not provided.
      expect(runOpts.parallel).toBe(1);
      // The single-account command is re-invoked per profile.
      expect(runOpts.command).toEqual(['fleet', 'deploy']);
      // --skip-bootstrap is forwarded verbatim to each child.
      expect(runOpts.passthroughArgs).toEqual(['--skip-bootstrap']);
      // The profile list resolved from the Profile_List_File, in order.
      expect(runOpts.profiles).toEqual(['payer-a', 'payer-b']);
      // The execute flag is forwarded so mutating children actually deploy.
      expect(runOpts.execute).toBe(true);

      // The parent process performs no cdk itself; the children (stubbed) do.
      expect(tools.cdkExecutions).toHaveLength(0);

      expect(result.scope).toBe('fleet');
      expect(result.parallel).toBe(1);
      expect(exitCode).toBe(CliExitCode.Success);
    });

    it('forwards no passthrough args when --skip-bootstrap is not set', async () => {
      const tools = new StubToolRunner();
      const fleet = new StubFleetRunner();
      const global = baseGlobal({ kind: 'all-profiles' }, { execute: true });
      const { ctx } = makeHarness(global, {
        tools,
        fleet,
        env: { PAYER_PROFILES_FILE: profilesFile },
        cwd: tmpDir,
      });

      await fleetDeploy({ skipBootstrap: false, global }, ctx);

      expect(fleet.runCalls).toHaveLength(1);
      expect(fleet.runCalls[0].passthroughArgs).toEqual([]);
    });
  });
});
