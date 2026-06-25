// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
/**
 * Unit / example tests for {@link registerPmaHandler} — the
 * `bt partner-central register-pma` command handler (Task 14.4).
 *
 * These complement the two property tests for this command (the first-failing-step
 * short-circuit property and the default display-name derivation property) by
 * pinning down three concrete, requirement-anchored examples with a STUBBED
 * {@link PartnerCentralClient} injected through the `RegisterPmaOptions.partnerCentral`
 * seam and an in-memory {@link IoContext}. No real AWS call or process spawn occurs.
 *
 * Covered acceptance criteria:
 *
 * - **17.5 — central profile required.** When the central-account profile is
 *   absent (or whitespace-only), the Error_Reporter reports that the central
 *   profile is required, the handler exits non-zero, and — critically — it does
 *   so BEFORE any AWS call (the stubbed client's three methods are never invoked).
 * - **17.6 — accept-failure still reports the PMA id.** When register and
 *   create-handshake succeed but accepting the handshake from the payer fails,
 *   the result reports the PMA id produced by the register step, states the
 *   handshake remains pending, and the handler exits non-zero.
 * - **17.8 — full success.** When all three steps succeed the handler reports the
 *   PMA id and exits zero.
 *
 * Validates: Requirements 17.5, 17.6, 17.8
 */

import {
  registerPmaHandler,
  type RegisterPmaOptions,
} from '../../../../cli/commands/partner-central/register-pma.js';
import type {
  PartnerCentralClient,
  CreatePmaInput,
  CreateHandshakeInput,
  AcceptHandshakeInput,
} from '../../../../cli/lib/partner-central-client.js';
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
// Stub PartnerCentralClient
// ---------------------------------------------------------------------------

/**
 * Behavior knobs for the stub client. By default every step succeeds; set
 * `failAccept` to reject the accept step (Req 17.6 scenario).
 */
interface StubBehavior {
  /** When true, the accept step rejects with {@link StubPartnerCentralClient.acceptError}. */
  failAccept?: boolean;
}

/**
 * A {@link PartnerCentralClient} stub that records, in order, which of its three
 * methods are called and the inputs they received, returning canned identifiers.
 * It never performs any network call. Used to assert both that the right steps
 * run (and in the right order) and — for the central-profile-required case —
 * that NO step runs at all.
 */
class StubPartnerCentralClient implements PartnerCentralClient {
  /** The steps invoked, in call order. */
  readonly calls: StepName[] = [];
  /** The inputs handed to each step, captured for assertions. */
  readonly inputs: {
    register?: CreatePmaInput;
    createHandshake?: CreateHandshakeInput;
    accept?: AcceptHandshakeInput;
  } = {};
  /** The error the accept step rejects with when `failAccept` is set. */
  readonly acceptError = new Error('AccessDeniedException: payer cannot accept handshake (injected)');

  constructor(private readonly behavior: StubBehavior = {}) {}

  async createProgramManagementAccount(input: CreatePmaInput): Promise<{ pmaId: string }> {
    this.calls.push('register');
    this.inputs.register = input;
    return { pmaId: PMA_ID };
  }

  async createChannelHandshake(input: CreateHandshakeInput): Promise<{ handshakeId: string }> {
    this.calls.push('create-handshake');
    this.inputs.createHandshake = input;
    return { handshakeId: HANDSHAKE_ID };
  }

  async acceptChannelHandshake(input: AcceptHandshakeInput): Promise<{ status: string }> {
    this.calls.push('accept');
    this.inputs.accept = input;
    if (this.behavior.failAccept) {
      throw this.acceptError;
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
 * Build an in-memory {@link IoContext}. Only the seams the handler touches — the
 * stdout/stderr sinks, the Output_Formatter `emit`, and the Error_Reporter
 * `report` — carry behavior; the rest are stubbed and unused. No AWS clients,
 * tools, or fleet runner are wired; the injected client makes them unnecessary.
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

/** Valid base options that pass every pre-flight check (valid program + 12-digit id). */
const VALID_ACCOUNT_ID = '123456789012';
const VALID_PROGRAM = 'DP';
const CENTRAL_PROFILE = 'central-111122223333';

/** Concatenate every line written to a sink, for substring assertions. */
function joined(sink: CapturingSink): string {
  return sink.lines.join('\n');
}

// ---------------------------------------------------------------------------
// 17.5 — the central-account profile is required, checked before any AWS call
// ---------------------------------------------------------------------------

describe('registerPmaHandler — central profile required (Req 17.5)', () => {
  it.each([
    ['omitted', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])(
    'reports the requirement, exits non-zero, and makes no AWS call when the central profile is %s',
    async (_label, centralProfile) => {
      const client = new StubPartnerCentralClient();
      const test = makeContext();

      const options: RegisterPmaOptions & { global: GlobalOptions } = {
        global: GLOBAL,
        accountId: VALID_ACCOUNT_ID,
        program: VALID_PROGRAM,
        centralProfile: centralProfile as string | undefined,
        partnerCentral: client,
      };

      const { result, exitCode } = await registerPmaHandler(options, test.ctx);

      // Reported as the central-profile-required outcome and exits non-zero (Req 17.5).
      expect(result.outcome).toBe('central-profile-required');
      expect(result.succeeded).toBe(false);
      expect(exitCode).toBe(CliExitCode.GeneralError);
      expect(exitCode).not.toBe(CliExitCode.Success);

      // The requirement is reported to the operator on stderr (Req 17.5).
      expect(joined(test.stderr)).toContain('central-account profile is required');

      // The single structured payload emitted is the handler's result.
      expect(test.emitted).toEqual([result]);

      // Critically: NO AWS call was initiated — the stubbed client was untouched.
      expect(client.calls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 17.6 — accept-failure still reports the PMA id and leaves the handshake pending
// ---------------------------------------------------------------------------

describe('registerPmaHandler — accept-handshake failure (Req 17.6)', () => {
  it('reports the PMA id, states the handshake remains pending, and exits non-zero when the payer accept fails', async () => {
    const client = new StubPartnerCentralClient({ failAccept: true });
    const test = makeContext();

    const options: RegisterPmaOptions & { global: GlobalOptions } = {
      global: GLOBAL,
      accountId: VALID_ACCOUNT_ID,
      program: VALID_PROGRAM,
      centralProfile: CENTRAL_PROFILE,
      partnerCentral: client,
    };

    const { result, exitCode } = await registerPmaHandler(options, test.ctx);

    // Register and create-handshake ran, then accept ran and failed — all three
    // steps were invoked, in order (Req 17.1).
    expect(client.calls).toEqual([...STEP_ORDER]);

    // The accept failure is the terminal outcome and exits non-zero (Req 17.6).
    expect(result.outcome).toBe('accept-failed');
    expect(result.failedStep).toBe('accept');
    expect(result.succeeded).toBe(false);
    expect(exitCode).toBe(CliExitCode.GeneralError);
    expect(exitCode).not.toBe(CliExitCode.Success);

    // The Output_Formatter still reports the PMA id produced by the register step,
    // and the result records that the handshake remains pending (Req 17.6).
    expect(result.pmaId).toBe(PMA_ID);
    expect(result.handshakeId).toBe(HANDSHAKE_ID);
    expect(result.handshakePending).toBe(true);

    // The Error_Reporter reported the failure, and the operator is told the
    // handshake stays PENDING and can be accepted later (Req 17.6).
    expect(test.reportCalls).toBeGreaterThanOrEqual(1);
    const stderr = joined(test.stderr);
    expect(stderr).toContain(HANDSHAKE_ID);
    expect(stderr).toContain('PENDING');

    // The accept step targeted the payer profile, which defaults to the account
    // id when no payer profile is supplied (Req 17.1).
    expect(client.inputs.accept?.profile).toBe(VALID_ACCOUNT_ID);
  });
});

// ---------------------------------------------------------------------------
// 17.8 — full success reports the PMA id and exits zero
// ---------------------------------------------------------------------------

describe('registerPmaHandler — full success (Req 17.8)', () => {
  it('reports the PMA id and exits zero when all three steps succeed', async () => {
    const client = new StubPartnerCentralClient();
    const test = makeContext();

    const options: RegisterPmaOptions & { global: GlobalOptions } = {
      global: GLOBAL,
      accountId: VALID_ACCOUNT_ID,
      program: VALID_PROGRAM,
      centralProfile: CENTRAL_PROFILE,
      partnerCentral: client,
    };

    const { result, exitCode } = await registerPmaHandler(options, test.ctx);

    // All three steps ran, in order (Req 17.1).
    expect(client.calls).toEqual([...STEP_ORDER]);

    // Success reports the PMA id and exits zero (Req 17.8).
    expect(result.outcome).toBe('success');
    expect(result.succeeded).toBe(true);
    expect(result.pmaId).toBe(PMA_ID);
    expect(result.handshakeId).toBe(HANDSHAKE_ID);
    expect(result.status).toBe(ACCEPTED_STATUS);
    expect(exitCode).toBe(CliExitCode.Success);

    // A successful run reports no error.
    expect(test.reportCalls).toBe(0);

    // Steps 1 and 2 used the central profile; the result echoes the PMA id back
    // through the structured payload the Output_Formatter emits (Req 17.8).
    expect(client.inputs.register?.profile).toBe(CENTRAL_PROFILE);
    expect(client.inputs.createHandshake?.profile).toBe(CENTRAL_PROFILE);
    expect(test.emitted).toEqual([result]);
  });
});
