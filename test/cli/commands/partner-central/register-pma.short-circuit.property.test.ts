// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
/**
 * Property-based test for {@link registerPmaHandler} — the
 * `bt partner-central register-pma` command handler (Task 14.2).
 *
 * Covers the design's Correctness Property 16: *for any* choice of which of the
 * three ordered PMA steps fails first (register → create handshake → accept),
 * no step after the failing step is invoked and the command exits non-zero; and
 * when all three succeed they are invoked in order, the command reports the PMA
 * identifier, and it exits zero.
 *
 * Validates: Requirements 17.1, 17.8, 17.9, 17.10
 *
 * The property is parametrized over the index of the first failing step
 * (1 = register, 2 = create-handshake, 3 = accept, or `none`). A recording fake
 * {@link PartnerCentralClient} is injected through the
 * `RegisterPmaOptions.partnerCentral` seam and records, in order, which of its
 * three methods are called; the configured step's method rejects. The handler
 * is driven through an in-memory {@link IoContext} (capturing sinks plus stub
 * formatter/reporter), so no real AWS call or process spawn occurs. Options are
 * generated to always pass pre-flight validation (a valid program, a 12-digit
 * Account_Id, and a non-empty central profile) so the three steps actually run.
 */

import fc from 'fast-check';
import {
  registerPmaHandler,
  type RegisterPmaOptions,
  type RegisterPmaResult,
} from '../../../../cli/commands/partner-central/register-pma.js';
import type { PartnerCentralClient } from '../../../../cli/lib/partner-central-client.js';
import type {
  GlobalOptions,
  IoContext,
  OutputSink,
  RenderableView,
} from '../../../../cli/lib/io-context.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';

// ---------------------------------------------------------------------------
// Canned identifiers returned by the successful steps
// ---------------------------------------------------------------------------

const PMA_ID = 'pma-0123456789abcdef';
const HANDSHAKE_ID = 'handshake-fedcba9876543210';
const ACCEPTED_STATUS = 'ACCEPTED';

/** The three steps, in the order the handler must invoke them (Req 17.1). */
const STEP_ORDER = ['register', 'create-handshake', 'accept'] as const;
type StepName = (typeof STEP_ORDER)[number];

// ---------------------------------------------------------------------------
// Recording fake PartnerCentralClient
// ---------------------------------------------------------------------------

/**
 * A {@link PartnerCentralClient} that records, in order, which of its three
 * methods are called, and rejects on the configured first-failing step. No
 * network call is ever made.
 */
class RecordingPartnerCentralClient implements PartnerCentralClient {
  /** The methods invoked, in call order. */
  readonly calls: StepName[] = [];

  /** `null` means no step fails (the fully successful flow). */
  constructor(private readonly failAtStep: 1 | 2 | 3 | null) {}

  async createProgramManagementAccount(): Promise<{ pmaId: string }> {
    this.calls.push('register');
    if (this.failAtStep === 1) {
      throw new Error('register step failed (injected)');
    }
    return { pmaId: PMA_ID };
  }

  async createChannelHandshake(): Promise<{ handshakeId: string }> {
    this.calls.push('create-handshake');
    if (this.failAtStep === 2) {
      throw new Error('create-handshake step failed (injected)');
    }
    return { handshakeId: HANDSHAKE_ID };
  }

  async acceptChannelHandshake(): Promise<{ status: string }> {
    this.calls.push('accept');
    if (this.failAtStep === 3) {
      throw new Error('accept step failed (injected)');
    }
    return { status: ACCEPTED_STATUS };
  }
}

// ---------------------------------------------------------------------------
// In-memory IoContext (capturing sinks + stub formatter/reporter)
// ---------------------------------------------------------------------------

/** An {@link OutputSink} that captures everything written to it. */
class CapturingSink implements OutputSink {
  readonly lines: string[] = [];
  write(text: string): void {
    this.lines.push(text);
  }
  writeLine(line: string): void {
    this.lines.push(line);
  }
}

interface TestContext {
  ctx: IoContext;
  /** Payloads handed to `formatter.emit`, in order. */
  emitted: unknown[];
  /** Count of `reporter.report` invocations. */
  reportCalls: number;
  stdout: CapturingSink;
  stderr: CapturingSink;
}

/**
 * Build an in-memory {@link IoContext}. Only the seams the handler touches —
 * the stdout/stderr sinks, the Output_Formatter `emit`, and the Error_Reporter
 * `report` — carry behavior; the rest are stubbed and unused. No AWS clients,
 * tools, or fleet runner are wired, and the injected client makes them
 * unnecessary.
 */
function makeContext(): TestContext {
  const stdout = new CapturingSink();
  const stderr = new CapturingSink();
  const emitted: unknown[] = [];
  const state = { reportCalls: 0 };

  const formatter = {
    emit(payload: unknown, _view: RenderableView, _global: GlobalOptions, _ctx: IoContext): void {
      emitted.push(payload);
    },
    renderHuman(): void {},
    renderJson(): void {},
  };

  const reporter = {
    classify: () => 'unknown' as const,
    remediation: () => '',
    report: () => {
      state.reportCalls += 1;
      return 'unknown' as const;
    },
    reportCredentials: () => {},
    reportUnavailableRegion: () => {},
  };

  const ctx = {
    stdout,
    stderr,
    env: {},
    cwd: '/tmp',
    formatter,
    reporter,
    now: () => 0,
  } as unknown as IoContext;

  return {
    ctx,
    emitted,
    get reportCalls() {
      return state.reportCalls;
    },
    stdout,
    stderr,
  };
}

/** Minimal global options sufficient to run the handler in human mode. */
const GLOBAL: GlobalOptions = {
  scope: { kind: 'ambient' },
  json: false,
  color: false,
  execute: false,
  verbose: false,
};

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A valid 12-digit Account_Id (digits only, leading zeros preserved). */
const accountIdArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

/** A valid program identifier (friendly forms and SDK enum forms). */
const programArb: fc.Arbitrary<string> = fc.constantFrom(
  'DP',
  'SPP',
  'DS',
  'DISTRIBUTION',
  'SOLUTION_PROVIDER',
  'DISTRIBUTION_SELLER',
);

/** A non-empty central profile (always survives the required-profile check). */
const centralProfileArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 8 })
  .map((s) => `central-${s.replace(/\s/g, '')}`);

/**
 * The first-failing-step index: 1, 2, 3, or `0` for "no step fails". Mapped to
 * the fake's `failAtStep` (`null` when 0).
 */
const firstFailingStepArb: fc.Arbitrary<0 | 1 | 2 | 3> = fc.constantFrom(0, 1, 2, 3);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('registerPmaHandler — short-circuit on first failing step (property)', () => {
  // Feature: billing-transfer-cli, Property 16: PMA registration short-circuits on the first failing step
  it('invokes steps in order, never invokes a step after the first failure, and exits non-zero on failure / zero on full success', async () => {
    await fc.assert(
      fc.asyncProperty(
        firstFailingStepArb,
        accountIdArb,
        programArb,
        centralProfileArb,
        async (firstFailingStep, accountId, program, centralProfile) => {
          const failAtStep = firstFailingStep === 0 ? null : firstFailingStep;
          const client = new RecordingPartnerCentralClient(failAtStep);
          const test = makeContext();

          const options: RegisterPmaOptions & { global: GlobalOptions } = {
            global: GLOBAL,
            accountId,
            program,
            centralProfile,
            partnerCentral: client,
          };

          const { result, exitCode } = await registerPmaHandler(options, test.ctx);

          // The handler's structured result is the single payload emitted by the
          // Output_Formatter.
          expect(test.emitted).toHaveLength(1);
          expect(test.emitted[0]).toBe(result);

          if (firstFailingStep === 0) {
            // No step fails: all three run, in order; the PMA id is reported and
            // the command exits zero (Req 17.1, 17.8).
            expect(client.calls).toEqual([...STEP_ORDER]);
            expect(exitCode).toBe(CliExitCode.Success);
            expect(result.outcome).toBe('success');
            expect(result.succeeded).toBe(true);
            expect(result.pmaId).toBe(PMA_ID);
            expect(result.handshakeId).toBe(HANDSHAKE_ID);
            expect(result.status).toBe(ACCEPTED_STATUS);
            expect(test.reportCalls).toBe(0);
            return;
          }

          // A step failed: the steps actually invoked are exactly the prefix up
          // to and including the failing step — no later step ran (Req 17.9, 17.10).
          const expectedCalls = STEP_ORDER.slice(0, firstFailingStep);
          expect(client.calls).toEqual([...expectedCalls]);

          // No step strictly after the failing one was ever invoked.
          const calledAfterFailure = client.calls.slice(firstFailingStep);
          expect(calledAfterFailure).toEqual([]);

          // Every failure exits non-zero and reports the failure via the
          // Error_Reporter (Req 17.8, 17.9, 17.10).
          expect(exitCode).not.toBe(CliExitCode.Success);
          expect(result.succeeded).toBe(false);
          expect(test.reportCalls).toBeGreaterThanOrEqual(1);

          if (firstFailingStep === 1) {
            // Register failed: no handshake created or accepted (Req 17.9).
            expect(client.calls).toEqual(['register']);
            expect(result.outcome).toBe('register-failed');
            expect(result.failedStep).toBe('register');
          } else if (firstFailingStep === 2) {
            // Create-handshake failed: not accepted; the PMA id from step 1 is
            // still known (Req 17.10).
            expect(client.calls).toEqual(['register', 'create-handshake']);
            expect(result.outcome).toBe('create-handshake-failed');
            expect(result.failedStep).toBe('create-handshake');
            expect(result.pmaId).toBe(PMA_ID);
          } else {
            // Accept failed: all three ran; the result still reports the PMA id
            // and that the handshake remains pending (Req 17.6, 17.10).
            expect(client.calls).toEqual(['register', 'create-handshake', 'accept']);
            expect(result.outcome).toBe('accept-failed');
            expect(result.failedStep).toBe('accept');
            expect(result.pmaId).toBe(PMA_ID);
            expect(result.handshakeId).toBe(HANDSHAKE_ID);
            expect(result.handshakePending).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: billing-transfer-cli, Property 16: PMA registration short-circuits on the first failing step
  it('covers each first-failing-step index across the run (example anchors for each branch)', async () => {
    const indices: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
    const results: RegisterPmaResult['outcome'][] = [];

    for (const idx of indices) {
      const client = new RecordingPartnerCentralClient(idx === 0 ? null : idx);
      const test = makeContext();
      const { result } = await registerPmaHandler(
        {
          global: GLOBAL,
          accountId: '123456789012',
          program: 'DP',
          centralProfile: 'central-account',
          partnerCentral: client,
        },
        test.ctx,
      );
      results.push(result.outcome);
    }

    expect(results).toEqual([
      'success',
      'register-failed',
      'create-handshake-failed',
      'accept-failed',
    ]);
  });
});
