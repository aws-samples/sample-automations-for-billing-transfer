// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
/**
 * Unit/example tests for {@link seedParamsHandler} — the single-account behavior
 * of `bt partner-central seed-params` (Requirement 18).
 *
 * These complement the pure-helper property tests (`seed-params.normalize` /
 * `seed-params.precedence`) by exercising the handler end-to-end on the
 * single-account (`--profile`/ambient) path with a mocked SSM client, asserting
 * the four behaviors called out by the task:
 *
 *  - **Dry-run by default (18.1):** without `--execute` the handler writes *no*
 *    parameter (zero `PutParameterCommand` sends) and reports a `dry-run`
 *    status, exiting zero.
 *  - **Execute writes both parameters (18.2):** with `--execute` it writes the
 *    linked-account-id and enable-management-role parameters at their fixed
 *    Resource_Registry paths.
 *  - **Validation before any write (18.3):** an invalid resolved
 *    linked-account-id (not exactly 12 digits) is rejected *before* any SSM
 *    call — the handler reports the invalid value + expected format, sends zero
 *    `PutParameterCommand`s, and exits non-zero, even in execute mode.
 *  - **Aggregated success/failure summary (18.7, 18.8):** a successful execute
 *    run reports `succeeded: 1, failed: 0` and exits zero; a failing parameter
 *    write reports which parameter failed, `succeeded: 0, failed: 1`, and exits
 *    non-zero.
 *
 * The handler is invoked directly (no `bt` spawning, per Req 22.3) with an
 * in-memory {@link IoContext}. The SSM client is intercepted with
 * `aws-sdk-client-mock`: because {@link createAwsClientFactory} constructs the
 * real {@link SSMClient} per invocation, `mockClient(SSMClient)` patches every
 * instance the handler builds, so no real AWS call is ever made (Req 22.4).
 * linked-account-id and enable-management-role are supplied via options (the
 * highest-precedence source) so value resolution is deterministic regardless of
 * the ambient environment or any `.env`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, PutParameterCommand, ParameterType } from '@aws-sdk/client-ssm';

import { seedParamsHandler } from '../../../../cli/commands/partner-central/seed-params.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import { ResourceRegistry } from '../../../../cli/lib/resource-registry.js';
import { createAwsClientFactory } from '../../../../cli/lib/aws-clients.js';
import { createOutputFormatter } from '../../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../../cli/lib/error-reporter.js';
import type { GlobalOptions, IoContext, OutputSink, Scope } from '../../../../cli/lib/io-context.js';
import type { FleetRunner, FleetRunnerOptions, FleetResult } from '../../../../cli/lib/fleet-runner.js';

// Intercept the SSM client the factory constructs; every PutParameter the
// handler issues is captured here, and no real AWS call is made (Req 22.4).
const ssmMock = mockClient(SSMClient);

// The two fixed parameter paths the handler writes (Req 18.2).
const LINKED_ACCOUNT_ID_PATH = ResourceRegistry.ssmParams.linkedAccountId;
const ENABLE_MANAGEMENT_ROLE_PATH = ResourceRegistry.ssmParams.enableManagementRole;

/** A valid 12-digit linked-account-id (clears the Input_Validator). */
const VALID_ACCOUNT_ID = '123456789012';

// ---------------------------------------------------------------------------
// In-memory IoContext helpers
// ---------------------------------------------------------------------------

/** Captures everything written to a stream so the test can assert on it. */
function createCapturingSink(): OutputSink & { lines: string[]; text: () => string } {
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
 * A Fleet_Runner that fails the test if it is ever invoked: these examples all
 * exercise the single-account path, which must never fan out to the fleet.
 */
const singleAccountFleetGuard: FleetRunner = {
  run<TData>(_opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    throw new Error('Fleet_Runner must not be invoked on the single-account path');
  },
  selfInvocation(): string[] {
    throw new Error('Fleet_Runner must not be invoked on the single-account path');
  },
};

interface Harness {
  ctx: IoContext;
  stdout: ReturnType<typeof createCapturingSink>;
  stderr: ReturnType<typeof createCapturingSink>;
}

/** Build a fresh in-memory IoContext for one handler invocation. */
function makeHarness(global: GlobalOptions, cwd: string): Harness {
  const stdout = createCapturingSink();
  const stderr = createCapturingSink();

  const ctx: IoContext = {
    stdout,
    stderr,
    env: {}, // no env-var values; options take precedence regardless
    cwd, // a directory with no `.env`, so `.env` contributes nothing
    clients: createAwsClientFactory(),
    // tools are unused on the single-account seed path; a guard would never fire.
    tools: undefined as unknown as IoContext['tools'],
    fleet: singleAccountFleetGuard,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => 0,
  };

  return { ctx, stdout, stderr };
}

/** Resolved global options for a single-account run (ambient scope by default). */
function makeGlobal(execute: boolean, scope: Scope = { kind: 'ambient' }): GlobalOptions {
  return { scope, json: false, color: false, execute, verbose: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('seedParamsHandler — single-account behavior (Requirement 18)', () => {
  let tmpDir: string;

  beforeAll(() => {
    // A clean cwd with no `.env`, so value resolution is fully deterministic.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-seed-params-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    ssmMock.reset();
  });

  describe('dry-run by default (Req 18.1)', () => {
    it('writes no parameter and reports a dry-run status, exiting zero', async () => {
      const global = makeGlobal(false);
      const { ctx } = makeHarness(global, tmpDir);

      const { result, exitCode } = await seedParamsHandler(
        { linkedAccountId: VALID_ACCOUNT_ID, enableManagementRole: 'true', global },
        ctx,
      );

      // No write was issued — the whole point of dry-run (Req 18.1).
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);

      // The result is a dry-run plan: one account, marked dry-run, exit zero.
      expect(result.mode).toBe('dry-run');
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].status).toBe('dry-run');
      expect(result.accounts[0].written).toBeUndefined();
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(exitCode).toBe(CliExitCode.Success);
    });

    it('still resolves and reports the fixed parameter paths in the dry-run plan', async () => {
      const global = makeGlobal(false);
      const { ctx } = makeHarness(global, tmpDir);

      const { result } = await seedParamsHandler(
        { linkedAccountId: VALID_ACCOUNT_ID, enableManagementRole: 'true', global },
        ctx,
      );

      expect(result.parameterPaths).toEqual({
        linkedAccountId: LINKED_ACCOUNT_ID_PATH,
        enableManagementRole: ENABLE_MANAGEMENT_ROLE_PATH,
      });
      expect(result.linkedAccountId).toBe(VALID_ACCOUNT_ID);
      // 'true' normalizes to the literal 'true' (Req 18.6).
      expect(result.enableManagementRole).toBe('true');
    });
  });

  describe('execute writes both parameters (Req 18.2)', () => {
    it('writes linked-account-id and enable-management-role at their fixed paths', async () => {
      ssmMock.on(PutParameterCommand).resolves({ Version: 1 });

      const global = makeGlobal(true);
      const { ctx } = makeHarness(global, tmpDir);

      const { result, exitCode } = await seedParamsHandler(
        // A non-exact 'true' value normalizes to 'false' (Req 18.6).
        { linkedAccountId: VALID_ACCOUNT_ID, enableManagementRole: 'TRUE', global },
        ctx,
      );

      const calls = ssmMock.commandCalls(PutParameterCommand);
      expect(calls).toHaveLength(2);

      // First write is the linked-account-id parameter, then enable-management-role.
      expect(calls[0].args[0].input).toMatchObject({
        Name: LINKED_ACCOUNT_ID_PATH,
        Value: VALID_ACCOUNT_ID,
        Type: ParameterType.STRING,
        Overwrite: true,
      });
      expect(calls[1].args[0].input).toMatchObject({
        Name: ENABLE_MANAGEMENT_ROLE_PATH,
        Value: 'false', // 'TRUE' is not the exact 'true', so normalizes to 'false'
        Type: ParameterType.STRING,
        Overwrite: true,
      });

      expect(result.mode).toBe('execute');
      expect(result.accounts[0].status).toBe('ok');
      expect(result.accounts[0].written).toEqual([
        LINKED_ACCOUNT_ID_PATH,
        ENABLE_MANAGEMENT_ROLE_PATH,
      ]);
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('linked-account-id validation runs before any write (Req 18.3)', () => {
    it('rejects an invalid id with a non-zero exit and no SSM write, even in execute mode', async () => {
      ssmMock.on(PutParameterCommand).resolves({ Version: 1 });

      // Execute mode proves the guard runs *before* any write would be attempted.
      const global = makeGlobal(true);
      const { ctx, stderr } = makeHarness(global, tmpDir);

      const { result, exitCode } = await seedParamsHandler(
        { linkedAccountId: '12345', enableManagementRole: 'true', global }, // not 12 digits
        ctx,
      );

      // No parameter was written because validation failed first (Req 18.3).
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);

      // Non-zero exit, no accounts targeted, nothing counted.
      expect(exitCode).toBe(CliExitCode.GeneralError);
      expect(result.accounts).toHaveLength(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);

      // The Error_Reporter surfaced the invalid value and the expected format.
      const stderrText = stderr.text();
      expect(stderrText).toContain("Invalid linked-account-id '12345'");
      expect(stderrText).toContain('exactly 12 digits');
    });

    it('reports <empty> and writes nothing when the resolved id is empty', async () => {
      ssmMock.on(PutParameterCommand).resolves({ Version: 1 });

      const global = makeGlobal(true);
      const { ctx, stderr } = makeHarness(global, tmpDir);

      const { exitCode } = await seedParamsHandler(
        { linkedAccountId: '', enableManagementRole: 'true', global },
        ctx,
      );

      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
      expect(exitCode).toBe(CliExitCode.GeneralError);
      expect(stderr.text()).toContain("Invalid linked-account-id '<empty>'");
    });
  });

  describe('aggregated success/failure summary (Req 18.7, 18.8)', () => {
    it('reports succeeded: 1, failed: 0 and exits zero when all writes succeed', async () => {
      ssmMock.on(PutParameterCommand).resolves({ Version: 1 });

      const global = makeGlobal(true);
      const { ctx, stdout } = makeHarness(global, tmpDir);

      const { result, exitCode } = await seedParamsHandler(
        { linkedAccountId: VALID_ACCOUNT_ID, enableManagementRole: 'true', global },
        ctx,
      );

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(exitCode).toBe(CliExitCode.Success);
      // The human summary reports the aggregated counts (Req 18.8).
      expect(stdout.text()).toContain('Summary: 1 succeeded, 0 failed.');
    });

    it('records the failed parameter, reports failed: 1, and exits non-zero on a write failure', async () => {
      // Fail the first (linked-account-id) write with a non-retryable error so
      // retry-with-backoff surfaces it immediately (no real delay).
      ssmMock
        .on(PutParameterCommand, { Name: LINKED_ACCOUNT_ID_PATH })
        .rejects(new Error('AccessDenied: not authorized to perform ssm:PutParameter'));
      ssmMock.on(PutParameterCommand, { Name: ENABLE_MANAGEMENT_ROLE_PATH }).resolves({ Version: 1 });

      const global = makeGlobal(true);
      const { ctx, stdout } = makeHarness(global, tmpDir);

      const { result, exitCode } = await seedParamsHandler(
        { linkedAccountId: VALID_ACCOUNT_ID, enableManagementRole: 'true', global },
        ctx,
      );

      // The failed write short-circuits, so the second parameter is not attempted.
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].status).toBe('failed');
      // Reports WHICH parameter write failed (Req 18.7).
      expect(result.accounts[0].failedParam).toBe(LINKED_ACCOUNT_ID_PATH);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(exitCode).toBe(CliExitCode.GeneralError);
      // The aggregated summary reflects the failure (Req 18.8).
      expect(stdout.text()).toContain('Summary: 0 succeeded, 1 failed.');
    });
  });
});
