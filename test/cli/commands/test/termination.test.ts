// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect, beforeEach } from '@jest/globals';
/**
 * Unit/example tests for the `bt test termination` command handler
 * ({@link runTerminationTest}) — Requirements 19.3, 19.4, 19.6, 19.7.
 *
 * These are concrete, example-based assertions (the companion to the optional
 * fleet-safety property tests) that pin down the command's orchestration
 * contract WITHOUT spawning `bt` and without making any real AWS call. The
 * handler is invoked directly (Req 22.3) with an in-memory {@link IoContext}
 * whose dependencies are test doubles:
 *
 *  - `ctx.tools`: a STUBBED {@link ExternalToolRunner} that records every
 *    `cdk()` and `run()` invocation and returns configurable exit codes — the
 *    Jest `run()` returns exit 0 for a passing test and non-zero for a failing
 *    one (no real `cdk`/`jest` process is ever started).
 *  - `ctx.clients`: the real per-invocation {@link AwsClientFactory}, whose
 *    constructed {@link CloudFormationClient} is intercepted by
 *    `aws-sdk-client-mock` so `DescribeStacks` returns a controlled stack
 *    status (Req 22.4).
 *  - `ctx.formatter` / `ctx.reporter`: the real Output_Formatter and
 *    Error_Reporter writing to in-memory stdout/stderr sinks.
 *
 * The cases assert, against the acceptance criteria:
 *  - `--deploy` runs `cdk deploy` and then (when the stack is completed) the
 *    integration test (Req 19.1, 19.2);
 *  - `--test-only` skips the deploy (Req 19.9);
 *  - the not-completed-stack guard — a non-completed status OR an absent stack
 *    skips the test, reports *unavailable*, and exits non-zero (Req 19.4);
 *  - `--cleanup` runs `cdk destroy` regardless of whether the test passed or
 *    failed (Req 19.3, 19.7);
 *  - the exit code is zero on test pass and non-zero on test fail (Req 19.6);
 *  - `--deploy` + `--test-only` is a usage error reported before deploy/test
 *    (Req 19.10).
 */

import { mockClient } from 'aws-sdk-client-mock';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

import {
  runTerminationTest,
  type TerminationTestOptions,
} from '../../../../cli/commands/test/termination.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import { ResourceRegistry } from '../../../../cli/lib/resource-registry.js';
import { createAwsClientFactory } from '../../../../cli/lib/aws-clients.js';
import { createOutputFormatter } from '../../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../../cli/lib/error-reporter.js';
import type { GlobalOptions, IoContext, OutputSink, Scope } from '../../../../cli/lib/io-context.js';
import type {
  ExternalToolRunner,
  SpawnOpts,
  ToolResult,
} from '../../../../cli/lib/external-tool-runner.js';
import type { FleetRunner } from '../../../../cli/lib/fleet-runner.js';

// Intercept the CloudFormation client the factory constructs so DescribeStacks
// returns a controlled stack status with no network/credential resolution.
const cfnMock = mockClient(CloudFormationClient);

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A single recorded external-tool invocation. */
interface ToolCall {
  tool: 'cdk' | 'git' | 'aws' | 'run';
  cmd?: string;
  args: string[];
}

/** Build a benign {@link ToolResult} for a recorded invocation. */
function toolResult(command: string, exitCode: number, stdout = ''): ToolResult {
  return { command, exitCode, stdout, stderr: '', signal: null };
}

/**
 * Stubbed {@link ExternalToolRunner}. Records every `cdk`/`run` invocation in
 * call order (so deploy → test → destroy ordering can be asserted) and returns
 * the configured exit codes. Nothing is ever spawned.
 */
class StubToolRunner implements ExternalToolRunner {
  /** Every invocation, in the order the handler made them. */
  readonly calls: ToolCall[] = [];
  /** A compact, ordered trace of the meaningful steps (`cdk:deploy`, `run:jest`, ...). */
  readonly sequence: string[] = [];

  /** Exit code returned by `cdk deploy` (0 = reached a completed state). */
  deployExitCode = 0;
  /** Exit code returned by `cdk destroy` (cleanup). */
  destroyExitCode = 0;
  /** Exit code returned by the Jest `run()` — 0 = test pass, non-zero = test fail. */
  testExitCode = 0;
  /** Captured Jest stdout the handler mirrors to stderr. */
  testStdout = '';

  cdk(args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    this.calls.push({ tool: 'cdk', args });
    const action = args[0];
    this.sequence.push(`cdk:${action}`);
    const exitCode =
      action === 'destroy' ? this.destroyExitCode : action === 'deploy' ? this.deployExitCode : 0;
    return Promise.resolve(toolResult(`cdk ${args.join(' ')}`, exitCode));
  }

  git(args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    this.calls.push({ tool: 'git', args });
    return Promise.resolve(toolResult(`git ${args.join(' ')}`, 0));
  }

  aws(args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    this.calls.push({ tool: 'aws', args });
    return Promise.resolve(toolResult(`aws ${args.join(' ')}`, 0));
  }

  run(cmd: string, args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    this.calls.push({ tool: 'run', cmd, args });
    this.sequence.push(`run:${args[0] ?? cmd}`);
    return Promise.resolve(toolResult(`${cmd} ${args.join(' ')}`, this.testExitCode, this.testStdout));
  }

  render(cmd: string, args: string[], _opts: SpawnOpts = {}): string {
    return [cmd, ...args].join(' ');
  }

  // --- Convenience views over the recorded calls --------------------------

  get cdkDeployCalls(): ToolCall[] {
    return this.calls.filter((c) => c.tool === 'cdk' && c.args[0] === 'deploy');
  }

  get cdkDestroyCalls(): ToolCall[] {
    return this.calls.filter((c) => c.tool === 'cdk' && c.args[0] === 'destroy');
  }

  get jestRunCalls(): ToolCall[] {
    return this.calls.filter((c) => c.tool === 'run' && c.args[0] === 'jest');
  }
}

/** A FleetRunner that fails the test if the single-account handler ever uses it. */
const unusedFleetRunner: FleetRunner = {
  run: () => {
    throw new Error('FleetRunner must not be used by the single-account termination test command');
  },
  selfInvocation: () => {
    throw new Error('FleetRunner.selfInvocation must not be used');
  },
};

/** An in-memory {@link OutputSink} that captures everything written to it. */
function createCapturingSink(): OutputSink & { text(): string } {
  let buffer = '';
  return {
    write(text: string): void {
      buffer += text;
    },
    writeLine(line: string): void {
      buffer += `${line}\n`;
    },
    text(): string {
      return buffer;
    },
  };
}

/** Aggregated harness: the assembled IoContext plus handles to its doubles. */
interface Harness {
  ctx: IoContext;
  tools: StubToolRunner;
  stdout: ReturnType<typeof createCapturingSink>;
  stderr: ReturnType<typeof createCapturingSink>;
}

/** Build a resolved {@link GlobalOptions} for a single invocation. */
function makeGlobal(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    scope: { kind: 'ambient' } as Scope,
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

/** Assemble a fresh instrumented IoContext for one handler invocation. */
function makeHarness(global: GlobalOptions): Harness {
  const tools = new StubToolRunner();
  const stdout = createCapturingSink();
  const stderr = createCapturingSink();

  const ctx: IoContext = {
    stdout,
    stderr,
    env: {},
    cwd: '/workspace',
    clients: createAwsClientFactory(),
    tools,
    fleet: unusedFleetRunner,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };

  return { ctx, tools, stdout, stderr };
}

/** The registry-resolved termination feature-stack name (never hard-coded here). */
const TERMINATION_STACK_NAME = ResourceRegistry.featureStacks.find((name) =>
  name.includes('Termination'),
) as string;

/** Mock DescribeStacks to report a single stack in `status`. */
function mockStackStatus(status: string): void {
  cfnMock.on(DescribeStacksCommand).resolves({
    Stacks: [{ StackName: TERMINATION_STACK_NAME, StackStatus: status } as never],
  });
}

/** Mock DescribeStacks to report no such stack (absent). */
function mockStackAbsent(): void {
  cfnMock.on(DescribeStacksCommand).resolves({ Stacks: [] });
}

/** Invoke the handler with the given command options and a default global scope. */
function invoke(harness: Harness, options: TerminationTestOptions, global: GlobalOptions) {
  return runTerminationTest({ ...options, global }, harness.ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTerminationTest — bt test termination (Req 19.3, 19.4, 19.6, 19.7)', () => {
  beforeEach(() => {
    cfnMock.reset();
  });

  describe('deploy / test-only gating (Req 19.1, 19.2, 19.9)', () => {
    it('--deploy runs cdk deploy and then the integration test when the stack is completed', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      harness.tools.deployExitCode = 0;
      harness.tools.testExitCode = 0;
      mockStackStatus('CREATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { deploy: true }, global);

      // cdk deploy of the registry-resolved stack happened...
      expect(harness.tools.cdkDeployCalls).toHaveLength(1);
      expect(harness.tools.cdkDeployCalls[0].args).toContain(TERMINATION_STACK_NAME);
      // ...and the Jest integration test was launched against the deployed function.
      expect(harness.tools.jestRunCalls).toHaveLength(1);
      // Order: deploy precedes the test run.
      expect(harness.tools.sequence).toEqual(['cdk:deploy', 'run:jest']);

      expect(result.deployed).toBe(true);
      expect(result.deploySucceeded).toBe(true);
      expect(result.testRan).toBe(true);
      expect(result.outcome).toBe('passed');
      expect(exitCode).toBe(CliExitCode.Success);
    });

    it('--test-only skips the deploy and runs the integration test against the deployed stack', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      harness.tools.testExitCode = 0;
      mockStackStatus('UPDATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { testOnly: true }, global);

      // No deploy happened; only the test ran.
      expect(harness.tools.cdkDeployCalls).toHaveLength(0);
      expect(harness.tools.jestRunCalls).toHaveLength(1);
      expect(harness.tools.sequence).toEqual(['run:jest']);

      expect(result.deployed).toBe(false);
      expect(result.testRan).toBe(true);
      expect(result.outcome).toBe('passed');
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('not-completed-stack guard (Req 19.4)', () => {
    it('does NOT run the test, reports unavailable, and exits non-zero for a non-completed stack', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      mockStackStatus('UPDATE_ROLLBACK_IN_PROGRESS');

      const { result, exitCode } = await invoke(harness, { testOnly: true }, global);

      // The integration test was never launched.
      expect(harness.tools.jestRunCalls).toHaveLength(0);
      expect(result.testRan).toBe(false);
      expect(result.testPassed).toBeNull();
      expect(result.stackCompleted).toBe(false);
      expect(result.outcome).toBe('stack-unavailable');
      // Non-zero exit on the unavailable path.
      expect(exitCode).not.toBe(CliExitCode.Success);
      expect(exitCode).toBe(CliExitCode.GeneralError);
      // The Error_Reporter wrote the unavailable diagnostic to stderr only.
      expect(harness.stderr.text()).toMatch(/completed deployment state/i);
    });

    it('does NOT run the test, reports unavailable, and exits non-zero when the stack is absent', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      mockStackAbsent();

      const { result, exitCode } = await invoke(harness, { testOnly: true }, global);

      expect(harness.tools.jestRunCalls).toHaveLength(0);
      expect(result.testRan).toBe(false);
      expect(result.stackStatus).toBeUndefined();
      expect(result.stackCompleted).toBe(false);
      expect(result.outcome).toBe('stack-unavailable');
      expect(exitCode).toBe(CliExitCode.GeneralError);
      expect(harness.stderr.text()).toMatch(/was not found/i);
    });

    it('treats DELETE_COMPLETE as not deployed (stack-unavailable)', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      mockStackStatus('DELETE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { testOnly: true }, global);

      expect(harness.tools.jestRunCalls).toHaveLength(0);
      expect(result.outcome).toBe('stack-unavailable');
      expect(exitCode).toBe(CliExitCode.GeneralError);
    });
  });

  describe('--cleanup destroys the stack regardless of outcome (Req 19.3, 19.7)', () => {
    it('runs cdk destroy after a PASSING test run', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      harness.tools.testExitCode = 0; // test passes
      mockStackStatus('CREATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { testOnly: true, cleanup: true }, global);

      expect(result.testPassed).toBe(true);
      expect(result.outcome).toBe('passed');
      // Cleanup ran after the test (Req 19.3).
      expect(harness.tools.cdkDestroyCalls).toHaveLength(1);
      expect(harness.tools.cdkDestroyCalls[0].args).toContain(TERMINATION_STACK_NAME);
      expect(harness.tools.sequence).toEqual(['run:jest', 'cdk:destroy']);
      expect(result.cleaned).toBe(true);
      expect(result.cleanupSucceeded).toBe(true);
      // Still exits zero on a passing test, after cleanup (Req 19.6).
      expect(exitCode).toBe(CliExitCode.Success);
    });

    it('runs cdk destroy after a FAILING test run', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      harness.tools.testExitCode = 1; // test fails
      mockStackStatus('CREATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { testOnly: true, cleanup: true }, global);

      expect(result.testPassed).toBe(false);
      expect(result.outcome).toBe('failed');
      // Cleanup ran regardless of the failure (Req 19.7).
      expect(harness.tools.cdkDestroyCalls).toHaveLength(1);
      expect(harness.tools.sequence).toEqual(['run:jest', 'cdk:destroy']);
      expect(result.cleaned).toBe(true);
      // Still exits non-zero on a failing test, after cleanup (Req 19.7).
      expect(exitCode).toBe(CliExitCode.GeneralError);
    });

    it('does not attempt cleanup when the stack is unavailable (nothing was touched)', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      mockStackStatus('CREATE_IN_PROGRESS');

      const { result } = await invoke(harness, { testOnly: true, cleanup: true }, global);

      expect(result.outcome).toBe('stack-unavailable');
      expect(harness.tools.cdkDestroyCalls).toHaveLength(0);
      expect(result.cleaned).toBe(false);
    });
  });

  describe('exit code follows the test result (Req 19.6, 19.7)', () => {
    it('exits zero when the integration test passes', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      harness.tools.testExitCode = 0;
      mockStackStatus('CREATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { testOnly: true }, global);

      expect(result.testPassed).toBe(true);
      expect(exitCode).toBe(CliExitCode.Success);
    });

    it('exits non-zero when the integration test fails', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      harness.tools.testExitCode = 2;
      mockStackStatus('CREATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { testOnly: true }, global);

      expect(result.testPassed).toBe(false);
      expect(exitCode).not.toBe(CliExitCode.Success);
      expect(exitCode).toBe(CliExitCode.GeneralError);
    });
  });

  describe('option conflicts (Req 19.10)', () => {
    it('reports a usage error and neither deploys nor tests when --deploy and --test-only are both set', async () => {
      const global = makeGlobal();
      const harness = makeHarness(global);
      mockStackStatus('CREATE_COMPLETE');

      const { result, exitCode } = await invoke(harness, { deploy: true, testOnly: true }, global);

      expect(result.outcome).toBe('usage-error');
      // Nothing was deployed or tested before the usage error was raised.
      expect(harness.tools.cdkDeployCalls).toHaveLength(0);
      expect(harness.tools.jestRunCalls).toHaveLength(0);
      expect(exitCode).toBe(CliExitCode.Usage);
      expect(exitCode).not.toBe(CliExitCode.Success);
      // The conflict was reported to stderr.
      expect(harness.stderr.text()).toMatch(/mutually exclusive/i);
    });
  });
});
