// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt test termination` — the termination-handler integration-test command
 * (Requirement 19).
 *
 * This is a pure, injectable {@link CommandHandler}: it touches the outside world
 * only through the injected {@link IoContext} (AWS clients, the external-tool
 * runner, the output formatter, and the error reporter), so it can be unit-tested
 * by direct call with stubs and mocks (Req 22.3, 22.4) without spawning `bt`.
 *
 * Behavior, mapped to the acceptance criteria:
 *
 *  - `--deploy` brings the termination stack to a completed deployment state via
 *    `cdk deploy` before testing (Req 19.1). `--deploy` and `--test-only` are
 *    mutually exclusive (Req 19.10).
 *  - The integration test runs only WHILE the termination stack is in a completed
 *    deployment state (Req 19.2); the stack status is read from CloudFormation and
 *    a non-completed (or absent) stack is reported via the Error_Reporter as
 *    *unavailable*, the test is skipped, and the CLI exits non-zero (Req 19.4).
 *  - The termination stack name and termination function name come from the
 *    Resource_Registry — never hard-coded here (Req 19.5).
 *  - `--cleanup` destroys the stack after the test completes, regardless of
 *    whether the test passed or failed (Req 19.3, 19.7).
 *  - The command always resolves to a definitive pass/fail with the matching exit
 *    code — zero on pass, non-zero on fail — and never leaves the result
 *    indeterminate (Req 19.6, 19.7, 19.8).
 *
 * The deployed function is exercised by the existing Jest integration suite under
 * `test/integration/` (the termination-handler integration test), which invokes
 * the deployed Lambda and asserts the termination-notification path.
 * That suite is excluded from the default `jest` run, so this handler selects it
 * explicitly and overrides `--testPathIgnorePatterns`. The registry-resolved
 * stack/function names are threaded to it through the `TERMINATION_STACK_NAME` /
 * `TERMINATION_LAMBDA_NAME` environment variables it reads.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8
 *
 * @module commands/test/termination
 */

import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

import type { CommandHandler, IoContext } from '../../lib/io-context.js';
import type { RenderableView } from '../../lib/output-formatter.js';
import type { WritableLike } from '../../lib/external-tool-runner.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import { sendWithRetry } from '../../lib/aws-clients.js';
import { getErrorMessage } from '../../../lib/lambda/common/utils/errors.js';

/**
 * Jest test-path regex that uniquely selects the termination integration suite
 * under `test/integration/`. Deliberately expressed as a pattern (not the test's
 * file path) so this source file never embeds a Resource_Registry name as a
 * substring (the integration filename contains the termination function name).
 */
const TERMINATION_TEST_PATTERN = 'integration/.*termination.*integration';

/** Command-specific options for `bt test termination`. */
export interface TerminationTestOptions {
  /** `--deploy`: deploy the termination stack to a completed state before testing (Req 19.1). */
  deploy?: boolean;
  /** `--test-only`: test the already-deployed stack without deploying first (Req 19.9). */
  testOnly?: boolean;
  /** `--cleanup`: destroy the stack after the test, regardless of outcome (Req 19.3, 19.7). */
  cleanup?: boolean;
}

/** The terminal outcome of the command, mirrored into the `--json` payload. */
export type TerminationTestOutcome =
  | 'passed' //            integration test passed (Req 19.6)
  | 'failed' //            integration test failed or could not be launched (Req 19.7, 19.8)
  | 'stack-unavailable' // stack not in a completed deployment state (Req 19.4)
  | 'deploy-failed' //     `cdk deploy` did not reach a completed state (Req 19.1)
  | 'usage-error'; //      conflicting/unsupported options (Req 19.10)

/** Structured result payload returned by the handler and rendered to stdout. */
export interface TerminationTestResult {
  /** Termination stack name resolved from the Resource_Registry (Req 19.5). */
  stackName: string;
  /** Termination function name resolved from the Resource_Registry (Req 19.5). */
  functionName: string;
  /** Whether `--deploy` was requested. */
  deploy: boolean;
  /** Whether `--test-only` was requested. */
  testOnly: boolean;
  /** Whether `--cleanup` was requested. */
  cleanup: boolean;
  /** True once a deploy was attempted. */
  deployed: boolean;
  /** Deploy result, when a deploy was attempted. */
  deploySucceeded?: boolean;
  /** Observed CloudFormation stack status (absent when the stack was not found). */
  stackStatus?: string;
  /** Whether the stack was in a completed deployment state (Req 19.2, 19.4). */
  stackCompleted: boolean;
  /** Whether the integration test was launched (Req 19.2). */
  testRan: boolean;
  /** Definitive pass/fail; `null` only when the test never ran (Req 19.8). */
  testPassed: boolean | null;
  /** Whether a cleanup destroy was attempted (Req 19.3, 19.7). */
  cleaned: boolean;
  /** Cleanup result, when a cleanup was attempted. */
  cleanupSucceeded?: boolean;
  /** The terminal outcome of the command. */
  outcome: TerminationTestOutcome;
}

/**
 * Resolve the termination feature-stack name from the Resource_Registry without
 * hard-coding the literal name in this module (Req 19.5, 21.6).
 */
function resolveTerminationStackName(): string {
  const stackName = ResourceRegistry.featureStacks.find((name) => name.includes('Termination'));
  if (!stackName) {
    throw new Error('Resource_Registry does not define a termination feature stack.');
  }
  return stackName;
}

/**
 * A CloudFormation stack is considered to be in a completed deployment state
 * when its status ends with `_COMPLETE` — but a deleted stack (`DELETE_COMPLETE`)
 * is treated as not deployed (Req 19.4).
 */
function isCompletedStatus(status: string | undefined): boolean {
  if (!status) {
    return false;
  }
  if (status === 'DELETE_COMPLETE') {
    return false;
  }
  return status.endsWith('_COMPLETE');
}

/**
 * Read the termination stack's CloudFormation status. Returns `undefined` when
 * the stack does not exist (so callers treat it as unavailable). Re-throws any
 * other error (e.g. credentials/access) so the caller can classify and report it.
 */
async function resolveStackStatus(ctx: IoContext, stackName: string): Promise<string | undefined> {
  const cloudFormation = ctx.clients.cloudFormation();
  try {
    const output = await sendWithRetry(
      cloudFormation,
      new DescribeStacksCommand({ StackName: stackName }),
      { operation: 'cloudformation:DescribeStacks', stackName },
    );
    return output.Stacks?.[0]?.StackStatus;
  } catch (error) {
    // A not-yet-deployed stack surfaces as a ValidationError ("... does not
    // exist"); that is the unavailable case (Req 19.4), not a hard failure.
    if (/does not exist/i.test(getErrorMessage(error))) {
      return undefined;
    }
    throw error;
  }
}

/** Build the human-readable summary view for the command's result. */
function buildView(result: TerminationTestResult): RenderableView {
  const outcomeTone =
    result.outcome === 'passed' ? 'success' : result.outcome === 'usage-error' ? 'warning' : 'failure';

  return {
    blocks: [
      { kind: 'heading', text: 'Termination-handler integration test' },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Stack', value: result.stackName },
          { label: 'Function', value: result.functionName },
          { label: 'Stack status', value: result.stackStatus ?? '(not found)' },
          {
            label: 'Test',
            value:
              result.testPassed === null
                ? { value: 'not run', tone: 'muted' }
                : result.testPassed
                  ? { value: 'PASS', tone: 'success' }
                  : { value: 'FAIL', tone: 'failure' },
          },
          ...(result.cleaned
            ? [
                {
                  label: 'Cleanup',
                  value: result.cleanupSucceeded
                    ? ({ value: 'destroyed', tone: 'success' } as const)
                    : ({ value: 'destroy failed', tone: 'failure' } as const),
                },
              ]
            : []),
          { label: 'Outcome', value: { value: result.outcome, tone: outcomeTone } },
        ],
      },
    ],
  };
}

/**
 * `bt test termination` handler.
 *
 * Orchestrates the optional deploy, the completed-state guard, the Jest
 * integration test, and the optional cleanup, then emits exactly one result
 * document and returns the matching {@link CliExitCode}.
 */
export const runTerminationTest: CommandHandler<TerminationTestOptions, TerminationTestResult> = async (
  options,
  ctx,
) => {
  const { global } = options;
  const deploy = options.deploy === true;
  const testOnly = options.testOnly === true;
  const cleanup = options.cleanup === true;

  const stackName = resolveTerminationStackName();
  const functionName = ResourceRegistry.functions.terminationHandler;

  const result: TerminationTestResult = {
    stackName,
    functionName,
    deploy,
    testOnly,
    cleanup,
    deployed: false,
    stackStatus: undefined,
    stackCompleted: false,
    testRan: false,
    testPassed: null,
    cleaned: false,
    outcome: 'failed',
  };

  /** Emit the single result document (json or human) and return the exit code. */
  const finish = (exitCode: CliExitCode): { result: TerminationTestResult; exitCode: CliExitCode } => {
    ctx.formatter.emit(result, buildView(result), global, ctx);
    return { result, exitCode };
  };

  // --deploy and --test-only are mutually exclusive (Req 19.10): report and exit
  // before deploying or testing.
  if (deploy && testOnly) {
    result.outcome = 'usage-error';
    ctx.reporter.report(
      new Error("Options '--deploy' and '--test-only' are mutually exclusive; choose one."),
      ctx,
      { operation: 'test termination' },
    );
    return finish(CliExitCode.Usage);
  }

  // The integration test targets a single account; --all-profiles is unsupported.
  if (global.scope.kind === 'all-profiles') {
    result.outcome = 'usage-error';
    ctx.reporter.report(
      new Error("'test termination' runs against a single account and does not support --all-profiles."),
      ctx,
      { operation: 'test termination' },
    );
    return finish(CliExitCode.Usage);
  }

  const profile = global.scope.kind === 'profile' ? global.scope.profile : undefined;

  // Mirror the spawned tools' stderr (and rendered command lines) to the CLI's
  // own stderr so progress is visible without ever touching stdout.
  const logStream: WritableLike = {
    write: (chunk) => {
      ctx.stderr.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  };

  // Set true once the stack has been (attempted to be) deployed or confirmed
  // present, which is what makes a requested cleanup meaningful.
  let stackTouched = false;
  let cleanupDone = false;

  /** Destroy the stack when `--cleanup` was requested and a stack exists (Req 19.3, 19.7). */
  const maybeCleanup = async (): Promise<void> => {
    if (cleanupDone || !cleanup || !stackTouched) {
      return;
    }
    cleanupDone = true;
    result.cleaned = true;
    ctx.stderr.writeLine(`Cleaning up: destroying termination stack '${stackName}'...`);
    try {
      const destroyResult = await ctx.tools.cdk(['destroy', stackName, '--force'], {
        profile,
        cwd: ctx.cwd,
        logStream,
      });
      result.cleanupSucceeded = destroyResult.exitCode === 0;
      if (!result.cleanupSucceeded) {
        ctx.stderr.writeLine(`Warning: cleanup (cdk destroy) exited with code ${destroyResult.exitCode}.`);
      }
    } catch (error) {
      result.cleanupSucceeded = false;
      ctx.reporter.report(error, ctx, { profile, operation: 'cdk destroy' });
    }
  };

  // 1. Deploy the termination stack to a completed state (Req 19.1).
  if (deploy) {
    result.deployed = true;
    stackTouched = true;
    ctx.stderr.writeLine(`Deploying termination stack '${stackName}'...`);
    try {
      const deployResult = await ctx.tools.cdk(['deploy', stackName], { profile, cwd: ctx.cwd, logStream });
      result.deploySucceeded = deployResult.exitCode === 0;
    } catch (error) {
      result.deploySucceeded = false;
      result.outcome = 'deploy-failed';
      ctx.reporter.report(error, ctx, { profile, operation: 'cdk deploy' });
      await maybeCleanup();
      return finish(CliExitCode.GeneralError);
    }
    if (!result.deploySucceeded) {
      result.outcome = 'deploy-failed';
      ctx.reporter.report(
        new Error(`cdk deploy of '${stackName}' did not reach a completed deployment state.`),
        ctx,
        { profile, operation: 'cdk deploy' },
      );
      await maybeCleanup();
      return finish(CliExitCode.GeneralError);
    }
  }

  // 2. Guard: the test runs only while the stack is in a completed state (Req 19.4).
  let status: string | undefined;
  try {
    status = await resolveStackStatus(ctx, stackName);
  } catch (error) {
    result.outcome = 'stack-unavailable';
    ctx.reporter.report(error, ctx, { profile, operation: 'cloudformation:DescribeStacks' });
    await maybeCleanup();
    return finish(CliExitCode.GeneralError);
  }
  result.stackStatus = status;
  result.stackCompleted = isCompletedStatus(status);

  if (!result.stackCompleted) {
    result.outcome = 'stack-unavailable';
    const detail = status ? `is in state '${status}'` : 'was not found';
    ctx.reporter.report(
      new Error(
        `Termination stack '${stackName}' ${detail}; it must be in a completed deployment state ` +
          'before the integration test can run.',
      ),
      ctx,
      { profile, operation: 'test termination' },
    );
    await maybeCleanup();
    return finish(CliExitCode.GeneralError);
  }

  // Stack is confirmed present and completed; a requested cleanup now applies.
  stackTouched = true;

  // 3. Run the Jest integration test against the deployed function (Req 19.2).
  // Thread the registry-resolved names to the test through the env vars it reads.
  ctx.env.TERMINATION_LAMBDA_NAME = functionName;
  ctx.env.TERMINATION_STACK_NAME = stackName;

  ctx.stderr.writeLine(`Running termination integration test against '${functionName}'...`);
  result.testRan = true;
  let testResult;
  try {
    // Select only the termination integration suite and override the default
    // ignore list (which excludes test/integration/).
    testResult = await ctx.tools.run(
      'npx',
      ['jest', TERMINATION_TEST_PATTERN, '--runInBand', '--testPathIgnorePatterns', '/node_modules/'],
      { profile, cwd: ctx.cwd, logStream },
    );
  } catch (error) {
    // The test could not be launched at all — a definitive failure, not an
    // indeterminate result (Req 19.8).
    result.testPassed = false;
    result.outcome = 'failed';
    ctx.reporter.report(error, ctx, { operation: 'jest (termination integration test)' });
    await maybeCleanup();
    return finish(CliExitCode.GeneralError);
  }

  // Surface the captured Jest summary on stderr, keeping stdout clean for the
  // single result document.
  if (testResult.stdout.trim().length > 0) {
    ctx.stderr.write(testResult.stdout);
  }

  // Definitive pass/fail from the test's exit code (Req 19.6, 19.7, 19.8).
  result.testPassed = testResult.exitCode === 0;
  result.outcome = result.testPassed ? 'passed' : 'failed';

  // Cleanup runs after the test completes, regardless of pass/fail (Req 19.3, 19.7).
  await maybeCleanup();

  return finish(result.testPassed ? CliExitCode.Success : CliExitCode.GeneralError);
};
