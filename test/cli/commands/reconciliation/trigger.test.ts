// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
/**
 * Unit / example tests for the reconciliation-trigger handler
 * (`cli/commands/reconciliation/trigger.ts`), single-account scope.
 *
 * These exercise the already-implemented `triggerReconciliation` handler by
 * direct call (no `bt` spawning, per Req 22.3) with an in-memory
 * {@link IoContext}. The Lambda client is intercepted with
 * `aws-sdk-client-mock` (`mockClient(LambdaClient)`), so the asynchronous
 * `InvokeCommand` submissions are matched and answered in-process with no real
 * AWS call (Req 22.4). The factory on the context is a real
 * {@link createAwsClientFactory} (the same per-invocation seam the entrypoint
 * uses), so the mock patches every `LambdaClient` the handler constructs.
 *
 * Coverage, mapped to the design's acceptance criteria:
 *  - Invoke mapping per Reconciliation_Target: `bg` invokes only the
 *    billing-group function, `cur` only the CUR function, `both` (and the
 *    omitted/default) invoke both (Req 10.1, 10.2, 10.3, 10.7).
 *  - For `both`, the billing-group `InvokeCommand` is submitted BEFORE the CUR
 *    one — asserted via the mock's recorded call order (Req 10.3).
 *  - Accepted-vs-failed reporting in the emitted result: each invocation
 *    reports its targeted function and whether the async request was accepted
 *    (Req 10.5, 10.6).
 *  - Total failure (both fail) and partial failure (exactly one fails) both
 *    yield a non-zero exit code (Req 10.4, 10.5); a failed submit is reported on
 *    stderr only while the accepted invocation is still reported (Req 10.5).
 *
 * The handler treats the asynchronous invoke as accepted on an HTTP 2xx
 * (`StatusCode: 202`) and as failed on a non-2xx status or a thrown error; both
 * failure modes are covered.
 *
 * _Requirements: 10.4, 10.5, 10.6, 11.2, 11.3_
 */

import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';

import { triggerReconciliation } from '../../../../cli/commands/reconciliation/trigger.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import { ResourceRegistry } from '../../../../cli/lib/resource-registry.js';
import { createAwsClientFactory } from '../../../../cli/lib/aws-clients.js';
import { createOutputFormatter } from '../../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../../cli/lib/error-reporter.js';
import type {
  GlobalOptions,
  IoContext,
  OutputSink,
  Scope,
} from '../../../../cli/lib/io-context.js';
import type { ExternalToolRunner } from '../../../../cli/lib/external-tool-runner.js';
import type {
  FleetRunner,
  FleetRunnerOptions,
  FleetResult,
} from '../../../../cli/lib/fleet-runner.js';

// The handler constructs LambdaClient instances via the factory; mockClient
// patches the prototype so every instance is intercepted (no real AWS call).
const lambdaMock = mockClient(LambdaClient);

const BG_NAME = ResourceRegistry.functions.billingGroupReconciliation;
const CUR_NAME = ResourceRegistry.functions.curReconciliation;

// ---------------------------------------------------------------------------
// In-memory IoContext harness
// ---------------------------------------------------------------------------

/** An {@link OutputSink} that records every written line for assertions. */
function recordingSink(): OutputSink & { lines: string[]; text: () => string } {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
    writeLine: (line: string) => {
      lines.push(line);
    },
    text: () => lines.join('\n'),
  };
}

/**
 * ExternalToolRunner stub: single-account trigger never shells out, so any call
 * is a test-contract violation and fails loudly.
 */
const unusedTools: ExternalToolRunner = new Proxy({} as ExternalToolRunner, {
  get(_target, prop) {
    return () => {
      throw new Error(`ExternalToolRunner.${String(prop)} must not be called in single-account scope`);
    };
  },
});

/**
 * FleetRunner stub that records any `run()`/`selfInvocation()` call so the tests
 * can assert the single-account path never routes through the fleet pool.
 */
class RecordingFleetRunner implements FleetRunner {
  readonly runCalls: FleetRunnerOptions[] = [];
  readonly selfInvocationCalls: Array<{ command: string[]; profile: string }> = [];

  run<TData>(opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    this.runCalls.push(opts);
    return Promise.resolve({
      accounts: [],
      succeeded: 0,
      failed: 0,
      exitCode: CliExitCode.Success,
    });
  }

  selfInvocation(command: string[], profile: string): string[] {
    this.selfInvocationCalls.push({ command, profile });
    return ['node', 'bt.js', ...command, '--profile', profile, '--json'];
  }
}

interface Harness {
  ctx: IoContext;
  stdout: ReturnType<typeof recordingSink>;
  stderr: ReturnType<typeof recordingSink>;
  fleet: RecordingFleetRunner;
}

/** Build a single-account IoContext for one handler invocation. */
function makeHarness(overrides: Partial<GlobalOptions> = {}): { harness: Harness; global: GlobalOptions } {
  const scope: Scope = overrides.scope ?? { kind: 'ambient' };
  const global: GlobalOptions = {
    scope,
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };

  const stdout = recordingSink();
  const stderr = recordingSink();
  const fleet = new RecordingFleetRunner();

  const ctx: IoContext = {
    stdout,
    stderr,
    env: {},
    cwd: '/tmp',
    clients: createAwsClientFactory(),
    tools: unusedTools,
    fleet,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };

  return { harness: { ctx, stdout, stderr, fleet }, global };
}

/** FunctionName of each recorded InvokeCommand, in submission order. */
function invokedFunctionNames(): string[] {
  return lambdaMock
    .commandCalls(InvokeCommand)
    .map((call) => call.args[0].input.FunctionName as string);
}

beforeEach(() => {
  lambdaMock.reset();
  // Default: every async invoke is accepted (HTTP 202).
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
});

// ---------------------------------------------------------------------------
// Invoke mapping per target (Req 10.1, 10.2, 10.3, 10.7)
// ---------------------------------------------------------------------------

describe('triggerReconciliation — invoke mapping per target', () => {
  it('target bg invokes only the billing-group reconciliation function', async () => {
    const { harness, global } = makeHarness();

    const { result, exitCode } = await triggerReconciliation({ target: 'bg', global }, harness.ctx);

    expect(invokedFunctionNames()).toEqual([BG_NAME]);
    expect(exitCode).toBe(CliExitCode.Success);
    expect(result.kind).toBe('single-account');
    if (result.kind === 'single-account') {
      expect(result.target).toBe('bg');
      expect(result.invocations.map((inv) => inv.func)).toEqual(['bg']);
      expect(result.invocations[0].functionName).toBe(BG_NAME);
    }
    // No CUR invocation was submitted.
    expect(invokedFunctionNames()).not.toContain(CUR_NAME);
  });

  it('target cur invokes only the CUR reconciliation function', async () => {
    const { harness, global } = makeHarness();

    const { result, exitCode } = await triggerReconciliation({ target: 'cur', global }, harness.ctx);

    expect(invokedFunctionNames()).toEqual([CUR_NAME]);
    expect(exitCode).toBe(CliExitCode.Success);
    if (result.kind === 'single-account') {
      expect(result.target).toBe('cur');
      expect(result.invocations.map((inv) => inv.func)).toEqual(['cur']);
      expect(result.invocations[0].functionName).toBe(CUR_NAME);
    }
    expect(invokedFunctionNames()).not.toContain(BG_NAME);
  });

  it('target both invokes both functions', async () => {
    const { harness, global } = makeHarness();

    const { result, exitCode } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(invokedFunctionNames()).toEqual([BG_NAME, CUR_NAME]);
    expect(exitCode).toBe(CliExitCode.Success);
    if (result.kind === 'single-account') {
      expect(result.invocations.map((inv) => inv.func)).toEqual(['bg', 'cur']);
    }
  });

  it('defaults to both when no target is provided', async () => {
    const { harness, global } = makeHarness();

    const { result } = await triggerReconciliation({ global }, harness.ctx);

    expect(invokedFunctionNames()).toEqual([BG_NAME, CUR_NAME]);
    if (result.kind === 'single-account') {
      expect(result.target).toBe('both');
    }
  });

  it('submits every invocation asynchronously (InvocationType Event)', async () => {
    const { harness, global } = makeHarness();

    await triggerReconciliation({ target: 'both', global }, harness.ctx);

    for (const call of lambdaMock.commandCalls(InvokeCommand)) {
      expect(call.args[0].input.InvocationType).toBe(InvocationType.Event);
    }
  });

  it('resolves the function names from the Resource_Registry (Req 10.7)', async () => {
    const { harness, global } = makeHarness();

    await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(invokedFunctionNames()).toEqual([
      ResourceRegistry.functions.billingGroupReconciliation,
      ResourceRegistry.functions.curReconciliation,
    ]);
  });
});

// ---------------------------------------------------------------------------
// bg-before-cur ordering (Req 10.3)
// ---------------------------------------------------------------------------

describe('triggerReconciliation — bg-before-cur ordering for both', () => {
  it('submits the billing-group invocation before the CUR invocation', async () => {
    const { harness, global } = makeHarness();

    await triggerReconciliation({ target: 'both', global }, harness.ctx);

    const names = invokedFunctionNames();
    expect(names).toHaveLength(2);
    expect(names.indexOf(BG_NAME)).toBeLessThan(names.indexOf(CUR_NAME));
    expect(names).toEqual([BG_NAME, CUR_NAME]);
  });

  it('preserves bg-before-cur order even when the bg submit fails', async () => {
    const { harness, global } = makeHarness();
    // bg fails to submit, cur is accepted: order must still be bg then cur, and
    // both submits are attempted so a partial failure can be reported.
    lambdaMock.on(InvokeCommand, { FunctionName: BG_NAME }).rejects(new Error('bg submit failed'));
    lambdaMock.on(InvokeCommand, { FunctionName: CUR_NAME }).resolves({ StatusCode: 202 });

    const { result } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(invokedFunctionNames()).toEqual([BG_NAME, CUR_NAME]);
    if (result.kind === 'single-account') {
      expect(result.invocations.map((inv) => inv.func)).toEqual(['bg', 'cur']);
    }
  });
});

// ---------------------------------------------------------------------------
// Accepted / failed reporting (Req 10.5, 10.6)
// ---------------------------------------------------------------------------

describe('triggerReconciliation — accepted/failed reporting', () => {
  it('reports each function and that its async invocation was accepted (Req 10.6)', async () => {
    const { harness, global } = makeHarness();

    const { result } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    if (result.kind === 'single-account') {
      expect(result.submitted).toBe(2);
      expect(result.failedToSubmit).toBe(0);
      for (const inv of result.invocations) {
        expect(inv.accepted).toBe(true);
        expect(inv.statusCode).toBe(202);
        expect(inv.failureDetail).toBeUndefined();
      }
    }
  });

  it('partial failure: reports the failed function and still reports the accepted one (Req 10.5)', async () => {
    const { harness, global } = makeHarness();
    lambdaMock.on(InvokeCommand, { FunctionName: BG_NAME }).resolves({ StatusCode: 202 });
    lambdaMock.on(InvokeCommand, { FunctionName: CUR_NAME }).rejects(new Error('cur submit failed'));

    const { result, exitCode } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    // Non-zero exit on any submit failure (Req 10.5).
    expect(exitCode).toBe(CliExitCode.GeneralError);
    if (result.kind === 'single-account') {
      expect(result.submitted).toBe(1);
      expect(result.failedToSubmit).toBe(1);

      const bg = result.invocations.find((inv) => inv.func === 'bg');
      const cur = result.invocations.find((inv) => inv.func === 'cur');

      // The accepted invocation is still reported (Req 10.5).
      expect(bg?.accepted).toBe(true);
      expect(bg?.statusCode).toBe(202);

      // The failed invocation is reported with its cause (Req 10.5).
      expect(cur?.accepted).toBe(false);
      expect(cur?.failureDetail).toContain('cur submit failed');
    }

    // The failure was reported on stderr only; nothing leaked to stdout in human mode.
    expect(harness.stderr.text()).toContain('cur submit failed');
  });

  it('treats a non-2xx async status as a failed submit', async () => {
    const { harness, global } = makeHarness();
    lambdaMock.on(InvokeCommand, { FunctionName: BG_NAME }).resolves({ StatusCode: 500 });
    lambdaMock.on(InvokeCommand, { FunctionName: CUR_NAME }).resolves({ StatusCode: 202 });

    const { result, exitCode } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(exitCode).toBe(CliExitCode.GeneralError);
    if (result.kind === 'single-account') {
      const bg = result.invocations.find((inv) => inv.func === 'bg');
      expect(bg?.accepted).toBe(false);
      expect(bg?.statusCode).toBe(500);
      expect(bg?.failureDetail).toContain('500');
    }
    expect(harness.stderr.text()).toContain('billing-group reconciliation was not submitted');
  });

  it('emits exactly one JSON document on stdout in --json mode reporting accepted invocations', async () => {
    const { harness, global } = makeHarness({ json: true });

    const { result } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    // One JSON document on stdout (the result payload), nothing else.
    expect(harness.stdout.lines).toHaveLength(1);
    const parsed = JSON.parse(harness.stdout.lines[0]);
    expect(parsed.kind).toBe('single-account');
    expect(parsed.submitted).toBe(2);
    expect(parsed.invocations).toHaveLength(2);
    expect(result.kind).toBe('single-account');
  });
});

// ---------------------------------------------------------------------------
// Exit codes: total failure and success (Req 10.4, 10.5)
// ---------------------------------------------------------------------------

describe('triggerReconciliation — exit codes', () => {
  it('total failure: both functions fail to submit yields a non-zero exit (Req 10.4)', async () => {
    const { harness, global } = makeHarness();
    lambdaMock.on(InvokeCommand).rejects(new Error('lambda unavailable'));

    const { result, exitCode } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(exitCode).toBe(CliExitCode.GeneralError);
    expect(exitCode).not.toBe(CliExitCode.Success);
    if (result.kind === 'single-account') {
      expect(result.submitted).toBe(0);
      expect(result.failedToSubmit).toBe(2);
      // Both functions are reported as not submitted (Req 10.4).
      expect(result.invocations.map((inv) => inv.func)).toEqual(['bg', 'cur']);
      expect(result.invocations.every((inv) => inv.accepted === false)).toBe(true);
    }
    // Both submissions were attempted before reporting the total failure.
    expect(invokedFunctionNames()).toEqual([BG_NAME, CUR_NAME]);
  });

  it('single failed submit for a single-target command yields a non-zero exit', async () => {
    const { harness, global } = makeHarness();
    lambdaMock.on(InvokeCommand, { FunctionName: BG_NAME }).rejects(new Error('bg submit failed'));

    const { exitCode } = await triggerReconciliation({ target: 'bg', global }, harness.ctx);

    expect(exitCode).toBe(CliExitCode.GeneralError);
  });

  it('all accepted yields a zero exit code', async () => {
    const { harness, global } = makeHarness();

    const { exitCode } = await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(exitCode).toBe(CliExitCode.Success);
  });

  it('rejects an invalid --target before any AWS call with a non-zero exit', async () => {
    const { harness, global } = makeHarness();

    const { result, exitCode } = await triggerReconciliation({ target: 'nope', global }, harness.ctx);

    expect(exitCode).toBe(CliExitCode.GeneralError);
    expect(result.kind).toBe('error');
    // No invocation was submitted because validation runs first.
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Single-account scope never routes through the Fleet_Runner
// ---------------------------------------------------------------------------

describe('triggerReconciliation — single-account scope', () => {
  it('invokes in-process and never uses the Fleet_Runner (ambient scope)', async () => {
    const { harness, global } = makeHarness({ scope: { kind: 'ambient' } });

    await triggerReconciliation({ target: 'both', global }, harness.ctx);

    expect(harness.fleet.runCalls).toHaveLength(0);
    expect(harness.fleet.selfInvocationCalls).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
  });

  it('invokes in-process for an explicit --profile scope without the Fleet_Runner', async () => {
    const { harness, global } = makeHarness({ scope: { kind: 'profile', profile: 'payer-a' } });

    const { exitCode } = await triggerReconciliation({ target: 'bg', global }, harness.ctx);

    expect(exitCode).toBe(CliExitCode.Success);
    expect(harness.fleet.runCalls).toHaveLength(0);
    expect(invokedFunctionNames()).toEqual([BG_NAME]);
  });
});
