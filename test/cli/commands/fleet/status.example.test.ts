// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
/**
 * Unit/example tests for the fleet deployment-health status command
 * (Task 12.4, Requirements 16.3, 16.5).
 *
 * The handler under test is the already-implemented
 * `fleetStatusHandler` from `cli/commands/fleet/status.ts`. It is invoked
 * directly (no `bt` spawning, per Req 22.3) with an in-memory {@link IoContext}.
 *
 * Two concerns are covered:
 *
 *  - **Classification thresholds (Req 16.3).** Driving the single-account path
 *    with mocked CloudFormation (`DescribeStacksCommand`) and CodePipeline
 *    (`ListPipelineExecutionsCommand`) clients, the test pins each of the three
 *    mutually exclusive classes:
 *      - **no-pipeline** — the pipeline stack does not exist (DescribeStacks
 *        throws a `ValidationError` whose message contains "does not exist");
 *      - **fully-deployed** — the pipeline stack is present and *every* tracked
 *        feature stack is deployed (deployed count === total count); and
 *      - **partially-deployed** — the pipeline stack is present but *fewer than
 *        all* feature stacks are deployed (deployed count < total count).
 *    The total count always equals {@link FEATURE_STACK_COUNT} resolved from the
 *    Resource_Registry (Req 16.2), never a hard-coded literal.
 *
 *  - **Continue-on-failure (Req 16.5).** Driving the fleet (`--all-profiles`)
 *    path with a stub {@link FleetRunner} that returns a mix of `ok` and
 *    `failed` per-account results, the test asserts the rollup classifies and
 *    counts every account (no account is dropped — the run continued past the
 *    failures), records failed accounts distinctly, and exits non-zero
 *    (`FleetPartialFailure`) exactly when at least one account failed.
 *
 * Mocked AWS clients are intercepted by `aws-sdk-client-mock`, so no real AWS
 * call is ever made; the CloudFormation `ValidationError` is non-retryable, so
 * `retryWithBackoff` surfaces it immediately (no backoff delay).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CodePipelineClient,
  ListPipelineExecutionsCommand,
} from '@aws-sdk/client-codepipeline';

import {
  fleetStatusHandler,
  type AccountDeploymentHealth,
  type FleetStatusRollup,
} from '../../../../cli/commands/fleet/status.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import {
  ResourceRegistry,
  FEATURE_STACK_COUNT,
} from '../../../../cli/lib/resource-registry.js';
import { createAwsClientFactory } from '../../../../cli/lib/aws-clients.js';
import { createOutputFormatter } from '../../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../../cli/lib/error-reporter.js';
import type {
  GlobalOptions,
  IoContext,
  OutputSink,
  Scope,
} from '../../../../cli/lib/io-context.js';
import type {
  AccountResult,
  FleetResult,
  FleetRunner,
  FleetRunnerOptions,
} from '../../../../cli/lib/fleet-runner.js';

// ---------------------------------------------------------------------------
// AWS client mocks — every CloudFormation / CodePipeline client the factory
// constructs is intercepted, so no real AWS call leaves the process (Req 22.4).
// ---------------------------------------------------------------------------

const cfnMock = mockClient(CloudFormationClient);
const codePipelineMock = mockClient(CodePipelineClient);

/** An {@link OutputSink} that captures everything written to it for assertions. */
class CapturingSink implements OutputSink {
  readonly raw: string[] = [];
  readonly lines: string[] = [];

  write(text: string): void {
    this.raw.push(text);
  }

  writeLine(line: string): void {
    this.lines.push(line);
  }

  /** Everything that reached this stream, concatenated (writeLine adds a newline). */
  text(): string {
    return this.raw.join('') + this.lines.map((l) => `${l}\n`).join('');
  }

  isEmpty(): boolean {
    return this.raw.length === 0 && this.lines.length === 0;
  }
}

/**
 * A stub {@link FleetRunner} that returns a fixed {@link FleetResult} regardless
 * of inputs, so the handler's rollup aggregation can be asserted deterministically
 * without spawning child processes. Records the options it was asked to run so a
 * test can confirm the read-only contract (`execute === false`).
 */
class StubFleetRunner implements FleetRunner {
  readonly runCalls: FleetRunnerOptions[] = [];

  constructor(private readonly canned: AccountResult<AccountDeploymentHealth>[]) {}

  run<TData>(opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    this.runCalls.push(opts);
    const failed = this.canned.reduce((n, a) => (a.status === 'failed' ? n + 1 : n), 0);
    return Promise.resolve({
      accounts: this.canned as unknown as AccountResult<TData>[],
      succeeded: this.canned.length - failed,
      failed,
      exitCode: failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success,
    });
  }

  selfInvocation(command: string[], profile: string): string[] {
    return ['node', 'bt.js', ...command, '--profile', profile, '--json'];
  }
}

/** Build a fresh in-memory {@link IoContext} backed by mockable AWS clients. */
function makeCtx(
  global: GlobalOptions,
  fleet: FleetRunner,
  cwd: string,
): { ctx: IoContext; stdout: CapturingSink; stderr: CapturingSink } {
  const stdout = new CapturingSink();
  const stderr = new CapturingSink();
  const ctx: IoContext = {
    stdout,
    stderr,
    env: {},
    cwd,
    clients: createAwsClientFactory(),
    // The status command never spawns external tools; a throwing proxy guards that.
    tools: new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('ExternalToolRunner must not be used by fleet status');
        },
      },
    ) as unknown as IoContext['tools'],
    fleet,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };
  return { ctx, stdout, stderr };
}

/** Global options for a single-account (ambient) invocation. */
function singleAccountGlobal(): GlobalOptions {
  return {
    scope: { kind: 'ambient' } as Scope,
    json: false,
    color: false,
    execute: false,
    verbose: false,
  };
}

/** Global options for a fleet (`--all-profiles`) invocation. */
function fleetGlobal(profilesFile: string): GlobalOptions {
  return {
    scope: { kind: 'all-profiles' } as Scope,
    profilesFile,
    json: false,
    color: false,
    execute: false,
    verbose: false,
  };
}

/** A CloudFormation `ValidationError` indicating the stack does not exist. */
function stackDoesNotExistError(stackName: string): Error {
  const error = new Error(
    `Stack with id ${stackName} does not exist`,
  );
  error.name = 'ValidationError';
  return error;
}

// A FleetRunner the single-account tests never touch.
const UNUSED_FLEET = new StubFleetRunner([]);

beforeEach(() => {
  cfnMock.reset();
  codePipelineMock.reset();
});

// ---------------------------------------------------------------------------
// Classification thresholds — single account (Req 16.3)
// ---------------------------------------------------------------------------

describe('fleet status — classification thresholds (Req 16.3)', () => {
  it('classifies no-pipeline when the pipeline stack does not exist', async () => {
    // DescribeStacks on the pipeline stack reports it does not exist.
    cfnMock
      .on(DescribeStacksCommand, { StackName: ResourceRegistry.pipelineStackName })
      .rejects(stackDoesNotExistError(ResourceRegistry.pipelineStackName));

    const global = singleAccountGlobal();
    const { ctx } = makeCtx(global, UNUSED_FLEET, process.cwd());

    const { result, exitCode } = await fleetStatusHandler({ global }, ctx);
    const health = result as AccountDeploymentHealth;

    expect(health.classification).toBe('no-pipeline');
    expect(health.pipelinePresent).toBe(false);
    expect(health.pipelineStatus).toBe('NONE');
    expect(health.deployedFeatureCount).toBe(0);
    expect(health.totalFeatureCount).toBe(FEATURE_STACK_COUNT);
    expect(exitCode).toBe(CliExitCode.Success);

    // No-pipeline short-circuits: the latest execution is never queried.
    expect(codePipelineMock.commandCalls(ListPipelineExecutionsCommand)).toHaveLength(0);
  });

  it('classifies fully-deployed when the pipeline and every feature stack are deployed', async () => {
    // Pipeline stack present and complete.
    cfnMock
      .on(DescribeStacksCommand, { StackName: ResourceRegistry.pipelineStackName })
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });

    // Every tracked feature stack is deployed (*_COMPLETE).
    for (const stackName of ResourceRegistry.featureStacks) {
      cfnMock
        .on(DescribeStacksCommand, { StackName: stackName })
        .resolves({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' } as never] });
    }

    codePipelineMock
      .on(ListPipelineExecutionsCommand)
      .resolves({ pipelineExecutionSummaries: [{ status: 'Succeeded' } as never] });

    const global = singleAccountGlobal();
    const { ctx } = makeCtx(global, UNUSED_FLEET, process.cwd());

    const { result, exitCode } = await fleetStatusHandler({ global }, ctx);
    const health = result as AccountDeploymentHealth;

    expect(health.classification).toBe('fully-deployed');
    expect(health.pipelinePresent).toBe(true);
    expect(health.pipelineStatus).toBe('CREATE_COMPLETE');
    expect(health.executionStatus).toBe('Succeeded');
    // deployed count === total count is the fully-deployed threshold (Req 16.3).
    expect(health.deployedFeatureCount).toBe(FEATURE_STACK_COUNT);
    expect(health.totalFeatureCount).toBe(FEATURE_STACK_COUNT);
    expect(exitCode).toBe(CliExitCode.Success);
  });

  it('classifies partially-deployed when fewer than all feature stacks are deployed', async () => {
    // Pipeline stack present and complete.
    cfnMock
      .on(DescribeStacksCommand, { StackName: ResourceRegistry.pipelineStackName })
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });

    // Deploy all but the last two feature stacks: one mid-deploy (not *_COMPLETE),
    // one absent — so the deployed count is strictly below the total.
    const featureStacks = ResourceRegistry.featureStacks;
    const deployedStacks = featureStacks.slice(0, featureStacks.length - 2);
    const inProgressStack = featureStacks[featureStacks.length - 2];
    const missingStack = featureStacks[featureStacks.length - 1];

    for (const stackName of deployedStacks) {
      cfnMock
        .on(DescribeStacksCommand, { StackName: stackName })
        .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
    }
    cfnMock
      .on(DescribeStacksCommand, { StackName: inProgressStack })
      .resolves({ Stacks: [{ StackStatus: 'CREATE_IN_PROGRESS' } as never] });
    cfnMock
      .on(DescribeStacksCommand, { StackName: missingStack })
      .rejects(stackDoesNotExistError(missingStack));

    codePipelineMock
      .on(ListPipelineExecutionsCommand)
      .resolves({ pipelineExecutionSummaries: [{ status: 'InProgress' } as never] });

    const global = singleAccountGlobal();
    const { ctx } = makeCtx(global, UNUSED_FLEET, process.cwd());

    const { result, exitCode } = await fleetStatusHandler({ global }, ctx);
    const health = result as AccountDeploymentHealth;

    expect(health.classification).toBe('partially-deployed');
    expect(health.pipelinePresent).toBe(true);
    // Exactly the *_COMPLETE feature stacks count as deployed, and that count is
    // strictly below the total (the partially-deployed threshold, Req 16.3).
    expect(health.deployedFeatureCount).toBe(deployedStacks.length);
    expect(health.deployedFeatureCount).toBeLessThan(FEATURE_STACK_COUNT);
    expect(health.totalFeatureCount).toBe(FEATURE_STACK_COUNT);
    expect(exitCode).toBe(CliExitCode.Success);
  });
});

// ---------------------------------------------------------------------------
// Continue-on-failure — fleet rollup (Req 16.5)
// ---------------------------------------------------------------------------

describe('fleet status — continue-on-failure rollup (Req 16.5)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fleet-status-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a profile-list file with the given profiles and return its path. */
  function writeProfiles(name: string, profiles: string[]): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, `${profiles.join('\n')}\n`, 'utf8');
    return file;
  }

  /** Build an `ok` per-account result carrying a typed health payload. */
  function okAccount(
    profile: string,
    classification: AccountDeploymentHealth['classification'],
    deployedFeatureCount: number,
  ): AccountResult<AccountDeploymentHealth> {
    return {
      profile,
      status: 'ok',
      exitCode: 0,
      data: {
        profile,
        pipelineStatus: classification === 'no-pipeline' ? 'NONE' : 'CREATE_COMPLETE',
        pipelinePresent: classification !== 'no-pipeline',
        executionStatus: classification === 'no-pipeline' ? '-' : 'Succeeded',
        deployedFeatureCount,
        totalFeatureCount: FEATURE_STACK_COUNT,
        classification,
      },
    };
  }

  /** Build a `failed` per-account result. */
  function failedAccount(profile: string): AccountResult<AccountDeploymentHealth> {
    return {
      profile,
      status: 'failed',
      exitCode: 1,
      failureDetail: `child exited with code 1; see ${profile}.log`,
    };
  }

  it('counts each class, records failures distinctly, and exits non-zero when any account failed', async () => {
    const profiles = ['payer-a', 'payer-b', 'payer-c', 'payer-d'];
    const profilesFile = writeProfiles('mixed.txt', profiles);

    const canned: AccountResult<AccountDeploymentHealth>[] = [
      okAccount('payer-a', 'fully-deployed', FEATURE_STACK_COUNT),
      okAccount('payer-b', 'partially-deployed', FEATURE_STACK_COUNT - 1),
      okAccount('payer-c', 'no-pipeline', 0),
      failedAccount('payer-d'),
    ];
    const fleet = new StubFleetRunner(canned);

    const global = fleetGlobal(profilesFile);
    const { ctx } = makeCtx(global, fleet, tmpDir);

    const { result, exitCode } = await fleetStatusHandler({ global }, ctx);
    const rollup = result as FleetStatusRollup;

    // The run continued past the failure: every account is represented.
    expect(rollup.totalProfiles).toBe(profiles.length);
    expect(rollup.accounts).toHaveLength(profiles.length);
    expect(rollup.accounts.map((a) => a.profile)).toEqual(profiles);

    // Each class is counted exactly once (Req 16.3 figures from the rollup).
    expect(rollup.fullyDeployed).toBe(1);
    expect(rollup.partiallyDeployed).toBe(1);
    expect(rollup.noPipeline).toBe(1);
    expect(rollup.failed).toBe(1);
    expect(rollup.totalFeatureCount).toBe(FEATURE_STACK_COUNT);

    // The failed account is marked distinctly with a failure detail.
    const failedRow = rollup.accounts.find((a) => a.profile === 'payer-d');
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.failureDetail).toContain('child exited with code 1');

    // A successful row carries its classification.
    const fullyRow = rollup.accounts.find((a) => a.profile === 'payer-a');
    expect(fullyRow?.status).toBe('ok');
    expect(fullyRow?.classification).toBe('fully-deployed');

    // Non-zero exactly when at least one account failed (Req 16.5).
    expect(exitCode).toBe(CliExitCode.FleetPartialFailure);

    // Read-only: the fleet children are never run in execute mode (Req 16.4).
    expect(fleet.runCalls).toHaveLength(1);
    expect(fleet.runCalls[0].execute).toBe(false);
  });

  it('treats an ok child with no usable health payload as failed (Req 16.5)', async () => {
    const profiles = ['payer-x', 'payer-y'];
    const profilesFile = writeProfiles('empty-payload.txt', profiles);

    const canned: AccountResult<AccountDeploymentHealth>[] = [
      okAccount('payer-x', 'fully-deployed', FEATURE_STACK_COUNT),
      // ok exit but no parsed payload (e.g. empty stdout) must not mask the account.
      { profile: 'payer-y', status: 'ok', exitCode: 0, data: undefined },
    ];
    const fleet = new StubFleetRunner(canned);

    const global = fleetGlobal(profilesFile);
    const { ctx } = makeCtx(global, fleet, tmpDir);

    const { result, exitCode } = await fleetStatusHandler({ global }, ctx);
    const rollup = result as FleetStatusRollup;

    expect(rollup.fullyDeployed).toBe(1);
    expect(rollup.failed).toBe(1);
    const masked = rollup.accounts.find((a) => a.profile === 'payer-y');
    expect(masked?.status).toBe('failed');
    expect(exitCode).toBe(CliExitCode.FleetPartialFailure);
  });

  it('exits zero when every account is determined successfully', async () => {
    const profiles = ['payer-1', 'payer-2', 'payer-3'];
    const profilesFile = writeProfiles('all-ok.txt', profiles);

    const canned: AccountResult<AccountDeploymentHealth>[] = [
      okAccount('payer-1', 'fully-deployed', FEATURE_STACK_COUNT),
      okAccount('payer-2', 'partially-deployed', 2),
      okAccount('payer-3', 'no-pipeline', 0),
    ];
    const fleet = new StubFleetRunner(canned);

    const global = fleetGlobal(profilesFile);
    const { ctx } = makeCtx(global, fleet, tmpDir);

    const { result, exitCode } = await fleetStatusHandler({ global }, ctx);
    const rollup = result as FleetStatusRollup;

    expect(rollup.failed).toBe(0);
    expect(rollup.fullyDeployed).toBe(1);
    expect(rollup.partiallyDeployed).toBe(1);
    expect(rollup.noPipeline).toBe(1);
    expect(exitCode).toBe(CliExitCode.Success);
  });
});
