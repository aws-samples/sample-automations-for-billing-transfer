// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
/**
 * Unit/example tests for `bt reconciliation status` scope routing and lookback
 * (Task 11.6).
 *
 * These exercise the *plumbing* of the already-implemented
 * `reconciliationStatusHandler` — the parts the pure status-derivation property
 * tests (`status.derivation.property.test.ts`,
 * `status.least-healthy.property.test.ts`) deliberately do not touch:
 *
 *  - ambient scope (neither `--profile` nor `--all-profiles`) checks a single
 *    account using the active credentials (Req 12.6);
 *  - `--profile <name>` checks that one named account (Req 12.7);
 *  - `--all-profiles` routes through the Fleet_Runner (Req 12.8) rather than
 *    issuing in-process AWS calls;
 *  - conflicting `--profile` + `--all-profiles` is rejected BEFORE any AWS call
 *    (Req 12.9) — the mocked Logs/SQS clients and the Fleet_Runner see nothing
 *    and the exit code is non-zero;
 *  - the default 120-minute lookback window is applied when `--lookback` is
 *    absent (Req 12.4), asserted via the deterministic injected `ctx.now`;
 *  - the exit code is non-zero unless every evaluated function is `DONE`
 *    (Req 12.11), and zero when all are `DONE`.
 *
 * The handler is invoked directly with an in-memory {@link IoContext} (no `bt`
 * spawning, per Req 22.3). CloudWatch Logs and SQS are intercepted with
 * `aws-sdk-client-mock` so no real AWS call is made (Req 22.4); the Fleet_Runner
 * is an in-memory recording stub; and `ctx.now` is a fixed clock so the lookback
 * start time is deterministic.
 *
 * Requirements: 12.6, 12.7, 12.9, 12.10, 12.11
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

import {
  reconciliationStatusHandler,
  type SingleAccountStatusResult,
  type FleetStatusResult,
  type StatusErrorResult,
} from '../../../../cli/commands/reconciliation/status.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import type { GlobalOptions, IoContext, OutputSink, Scope } from '../../../../cli/lib/io-context.js';
import type {
  FleetRunner,
  FleetRunnerOptions,
  FleetResult,
} from '../../../../cli/lib/fleet-runner.js';
import type { ExternalToolRunner } from '../../../../cli/lib/external-tool-runner.js';
import { createAwsClientFactory } from '../../../../cli/lib/aws-clients.js';
import { createOutputFormatter } from '../../../../cli/lib/output-formatter.js';
import { createErrorReporter } from '../../../../cli/lib/error-reporter.js';
import { RECON_MARKERS } from '../../../../lib/lambda/common/log-markers.js';

// ---------------------------------------------------------------------------
// AWS client mocks — every constructed Logs/SQS client is intercepted, so no
// real AWS call is ever made (Req 22.4).
// ---------------------------------------------------------------------------

const cwLogsMock = mockClient(CloudWatchLogsClient);
const sqsMock = mockClient(SQSClient);

/** Fixed clock so the lookback start time is deterministic (Req 12.4). */
const NOW = 1_700_000_000_000;
const MINUTE_MS = 60_000;
const DEFAULT_LOOKBACK_MINUTES = 120;

// ---------------------------------------------------------------------------
// Mock canned-data helpers
// ---------------------------------------------------------------------------

/**
 * Make FilterLogEvents report a clean completion for both reconciliation
 * functions: the completion marker is present, no failure marker, and the
 * billing-group summary reports zero item errors. Combined with a zero DLQ depth
 * this yields `DONE` for every evaluated function.
 */
function stubCleanCompletion(): void {
  cwLogsMock.on(FilterLogEventsCommand).callsFake((input: { filterPattern?: string }) => {
    const pattern = input.filterPattern ?? '';
    // Billing-group completion line carries a typed summary with zero errors.
    if (pattern.includes(RECON_MARKERS.bg.ok)) {
      return {
        events: [
          {
            timestamp: NOW - 1000,
            message: JSON.stringify({
              message: RECON_MARKERS.bg.ok,
              summary: { billingGroupsCreated: 1, billingGroupsExisted: 2, errors: [] },
            }),
          },
        ],
      };
    }
    // CUR completion marker present (its counts come from the exec line, which
    // we leave empty → zero item errors).
    if (pattern.includes(RECON_MARKERS.cur.ok)) {
      return { events: [{ timestamp: NOW - 1000, message: JSON.stringify({ message: RECON_MARKERS.cur.ok }) }] };
    }
    // No failure markers, no exec-completed line.
    return { events: [] };
  });
}

/** Make the dead-letter queues resolve with the given visible-message depth. */
function stubDlqDepth(depth: number): void {
  sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq' });
  sqsMock
    .on(GetQueueAttributesCommand)
    .resolves({ Attributes: { ApproximateNumberOfMessages: String(depth) } });
}

// ---------------------------------------------------------------------------
// In-memory IoContext harness
// ---------------------------------------------------------------------------

/** In-memory {@link OutputSink} that records every line written to it. */
class RecordingSink implements OutputSink {
  readonly lines: string[] = [];
  write(text: string): void {
    this.lines.push(text);
  }
  writeLine(line: string): void {
    this.lines.push(line);
  }
  text(): string {
    return this.lines.join('\n');
  }
}

/** Records every Fleet_Runner.run() call and returns a canned all-DONE result. */
class RecordingFleetRunner implements FleetRunner {
  readonly runCalls: FleetRunnerOptions[] = [];

  run<TData>(opts: FleetRunnerOptions, _ctx: IoContext): Promise<FleetResult<TData>> {
    this.runCalls.push(opts);
    const accounts = opts.profiles.map((profile) => ({
      profile,
      status: 'ok' as const,
      exitCode: 0,
      // Each child reports a DONE single-account payload.
      data: { scope: 'single', accountStatus: 'DONE', functions: [] } as unknown as TData,
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

/**
 * ExternalToolRunner stub. The status handler never shells out, so any use is a
 * test bug — every method throws to make that loud.
 */
const failingToolRunner: ExternalToolRunner = {
  cdk: () => Promise.reject(new Error('status must not invoke cdk')),
  git: () => Promise.reject(new Error('status must not invoke git')),
  aws: () => Promise.reject(new Error('status must not invoke aws')),
  run: () => Promise.reject(new Error('status must not invoke external tools')),
  render: () => {
    throw new Error('status must not render external commands');
  },
};

interface Harness {
  ctx: IoContext;
  stdout: RecordingSink;
  stderr: RecordingSink;
  fleet: RecordingFleetRunner;
}

/** Build a default {@link GlobalOptions} for a resolved scope. */
function makeGlobal(scope: Scope, overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    scope,
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

/** Assemble an in-memory IoContext wired to the AWS mocks and the fleet stub. */
function makeHarness(global: GlobalOptions, env: NodeJS.ProcessEnv = {}, cwd = process.cwd()): Harness {
  const stdout = new RecordingSink();
  const stderr = new RecordingSink();
  const fleet = new RecordingFleetRunner();

  const ctx: IoContext = {
    stdout,
    stderr,
    env,
    cwd,
    // Real factory: it constructs real SDK clients, which the mocks intercept.
    clients: createAwsClientFactory(),
    tools: failingToolRunner,
    fleet,
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => NOW,
  };

  return { ctx, stdout, stderr, fleet };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bt reconciliation status — scope routing and lookback (Task 11.6)', () => {
  beforeEach(() => {
    cwLogsMock.reset();
    sqsMock.reset();
  });

  describe('ambient scope — neither --profile nor --all-profiles (Req 12.6)', () => {
    it('checks a single account using ambient credentials and does not route through the Fleet_Runner', async () => {
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'ambient' });
      const { ctx, fleet } = makeHarness(global);

      // Neither raw scope selector is set in the ambient case.
      const { result, exitCode } = await reconciliationStatusHandler({ global }, ctx);

      expect(result.scope).toBe('single');
      const single = result as SingleAccountStatusResult;
      // Ambient credentials → no named profile on the result (Req 12.6).
      expect(single.profile).toBeUndefined();
      // Single-account path: the Fleet_Runner is never invoked.
      expect(fleet.runCalls).toHaveLength(0);
      // The single account was actually checked (in-process AWS reads happened).
      expect(cwLogsMock.commandCalls(FilterLogEventsCommand).length).toBeGreaterThan(0);
      // All functions DONE → success exit.
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('--profile <name> scope (Req 12.7)', () => {
    it('checks only that one named account on the single-account path', async () => {
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'profile', profile: 'payer-alpha' });
      const { ctx, fleet } = makeHarness(global);

      // The raw `--profile` selector is present; `--all-profiles` is not.
      const { result, exitCode } = await reconciliationStatusHandler(
        { profile: 'payer-alpha', global },
        ctx,
      );

      expect(result.scope).toBe('single');
      expect((result as SingleAccountStatusResult).profile).toBe('payer-alpha');
      // Named single account → no fleet fan-out.
      expect(fleet.runCalls).toHaveLength(0);
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('--all-profiles scope (Req 12.8)', () => {
    let tmpDir: string;
    let profilesFile: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-status-scope-'));
      profilesFile = path.join(tmpDir, 'payer-profiles.txt');
      fs.writeFileSync(profilesFile, 'payer-one\npayer-two\n', 'utf8');
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('routes through the Fleet_Runner and issues no in-process AWS calls in the parent', async () => {
      // If the parent erroneously took the single path, these mocks would fire.
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'all-profiles' });
      const { ctx, fleet } = makeHarness(global, { PAYER_PROFILES_FILE: profilesFile });

      const { result, exitCode } = await reconciliationStatusHandler({ allProfiles: true, global }, ctx);

      expect(result.scope).toBe('fleet');
      // The Fleet_Runner was invoked exactly once, for the resolved profile list.
      expect(fleet.runCalls).toHaveLength(1);
      expect(fleet.runCalls[0].command).toEqual(['reconciliation', 'status']);
      expect(fleet.runCalls[0].profiles).toEqual(['payer-one', 'payer-two']);
      // Fan-out happens in the children, so the parent makes no Logs/SQS calls.
      expect(cwLogsMock.calls()).toHaveLength(0);
      expect(sqsMock.calls()).toHaveLength(0);
      // Both stub children DONE → success.
      const fleetResult = result as FleetStatusResult;
      expect(fleetResult.total).toBe(2);
      expect(exitCode).toBe(CliExitCode.Success);
    });
  });

  describe('conflicting --profile + --all-profiles (Req 12.9)', () => {
    it('is rejected before any AWS call, the Fleet_Runner is untouched, and the exit is non-zero', async () => {
      // Arrange canned data so a (wrongly) issued AWS call would succeed; we then
      // assert that none was issued at all.
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'profile', profile: 'payer-alpha' });
      const { ctx, fleet, stderr, stdout } = makeHarness(global);

      const { result, exitCode } = await reconciliationStatusHandler(
        { profile: 'payer-alpha', allProfiles: true, global },
        ctx,
      );

      // Rejected as a scope conflict before any AWS interaction.
      expect(result.scope).toBe('error');
      expect((result as StatusErrorResult).error.kind).toBe('scope-conflict');
      expect(exitCode).not.toBe(CliExitCode.Success);

      // No AWS call of any kind reached the mocked clients (Req 12.9).
      expect(cwLogsMock.calls()).toHaveLength(0);
      expect(sqsMock.calls()).toHaveLength(0);
      // And no fleet fan-out occurred either.
      expect(fleet.runCalls).toHaveLength(0);

      // The conflict message is on stderr (human mode), not stdout (Req 6.5).
      expect(stderr.text()).toMatch(/mutually exclusive/i);
      expect(stdout.lines).toHaveLength(0);
    });

    it('emits a single structured JSON error to stdout in --json mode and still makes no AWS call', async () => {
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'all-profiles' }, { json: true });
      const { ctx, fleet, stdout } = makeHarness(global);

      const { exitCode } = await reconciliationStatusHandler(
        { profile: 'payer-alpha', allProfiles: true, global },
        ctx,
      );

      expect(exitCode).not.toBe(CliExitCode.Success);
      expect(cwLogsMock.calls()).toHaveLength(0);
      expect(sqsMock.calls()).toHaveLength(0);
      expect(fleet.runCalls).toHaveLength(0);

      // Exactly one valid JSON document on stdout describing the error.
      const parsed = JSON.parse(stdout.text()) as StatusErrorResult;
      expect(parsed.scope).toBe('error');
      expect(parsed.error.kind).toBe('scope-conflict');
    });
  });

  describe('default 120-minute lookback (Req 12.4)', () => {
    it('uses now - 120 minutes as the FilterLogEvents startTime when --lookback is absent', async () => {
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'ambient' });
      const { ctx } = makeHarness(global);

      const { result } = await reconciliationStatusHandler({ global }, ctx);

      expect((result as SingleAccountStatusResult).lookbackMinutes).toBe(DEFAULT_LOOKBACK_MINUTES);

      const expectedStart = NOW - DEFAULT_LOOKBACK_MINUTES * MINUTE_MS;
      const calls = cwLogsMock.commandCalls(FilterLogEventsCommand);
      expect(calls.length).toBeGreaterThan(0);
      // Every Logs read uses the default lookback window ending at ctx.now().
      for (const call of calls) {
        expect(call.args[0].input.startTime).toBe(expectedStart);
      }
    });

    it('honors an explicit --lookback over the 120-minute default', async () => {
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'ambient' });
      const { ctx } = makeHarness(global);

      const { result } = await reconciliationStatusHandler({ lookback: '30', global }, ctx);

      expect((result as SingleAccountStatusResult).lookbackMinutes).toBe(30);
      const expectedStart = NOW - 30 * MINUTE_MS;
      for (const call of cwLogsMock.commandCalls(FilterLogEventsCommand)) {
        expect(call.args[0].input.startTime).toBe(expectedStart);
      }
    });
  });

  describe('exit code reflects least-healthy status (Req 12.10, 12.11)', () => {
    it('exits zero only when every evaluated function is DONE', async () => {
      stubCleanCompletion();
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'ambient' });
      const { ctx } = makeHarness(global);

      const { result, exitCode } = await reconciliationStatusHandler({ target: 'both', global }, ctx);

      const single = result as SingleAccountStatusResult;
      expect(single.functions.every((fn) => fn.status === 'DONE')).toBe(true);
      expect(single.accountStatus).toBe('DONE');
      expect(exitCode).toBe(CliExitCode.Success);
    });

    it('exits non-zero when a DLQ has visible messages (ATTENTION, not DONE)', async () => {
      stubCleanCompletion();
      // A non-empty DLQ downgrades an otherwise-clean completion to ATTENTION.
      stubDlqDepth(3);

      const global = makeGlobal({ kind: 'ambient' });
      const { ctx } = makeHarness(global);

      const { result, exitCode } = await reconciliationStatusHandler({ target: 'bg', global }, ctx);

      const single = result as SingleAccountStatusResult;
      expect(single.accountStatus).toBe('ATTENTION');
      // Least-healthy is not DONE → non-zero exit (Req 12.11).
      expect(exitCode).not.toBe(CliExitCode.Success);
    });

    it('exits non-zero when a failure marker is present (FAILED dominates)', async () => {
      // Completion AND failure markers present → FAILED regardless of DLQ.
      cwLogsMock.on(FilterLogEventsCommand).callsFake((input: { filterPattern?: string }) => {
        const pattern = input.filterPattern ?? '';
        if (pattern.includes(RECON_MARKERS.bg.ok)) {
          return {
            events: [
              {
                timestamp: NOW - 2000,
                message: JSON.stringify({ message: RECON_MARKERS.bg.ok, summary: { errors: [] } }),
              },
            ],
          };
        }
        if (pattern.includes(RECON_MARKERS.bg.fail)) {
          return { events: [{ timestamp: NOW - 1000, message: RECON_MARKERS.bg.fail }] };
        }
        return { events: [] };
      });
      stubDlqDepth(0);

      const global = makeGlobal({ kind: 'ambient' });
      const { ctx } = makeHarness(global);

      const { result, exitCode } = await reconciliationStatusHandler({ target: 'bg', global }, ctx);

      const single = result as SingleAccountStatusResult;
      expect(single.accountStatus).toBe('FAILED');
      expect(exitCode).not.toBe(CliExitCode.Success);
    });
  });
});
