// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect, beforeEach, beforeAll, jest } from '@jest/globals';
/**
 * Unit/example tests for the single-account `bt transfers analyze` handler
 * (task 10.4).
 *
 * The handler under test is {@link analyzeHandler} from
 * `cli/commands/transfers/analyze.ts`. It is invoked directly (no `bt`
 * spawning, per Req 22.3) with an in-memory {@link IoContext} whose
 * Output_Formatter and Error_Reporter are recording stubs, so the test can
 * assert both the typed result the handler returns and the payload/view it
 * emits.
 *
 * The shared Transfer Analysis Service is mocked with `jest.mock` so
 * {@link analyzeTransfers} / {@link analyzeAccountTransfers} return canned,
 * typed {@link AnalysisResult} fixtures (an {@link AnalysisSummaryModel} built
 * from real transfer-with-resources models, plus a {@link ValidationResultModel}
 * for `--validate`). No AWS call is made. The real `filterByTransferType` model
 * helper is left unmocked so the `--type` filtering behavior is exercised end to
 * end.
 *
 * Coverage (Requirements 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.10):
 *  - 8.2 default Relationship_State `ACCEPTED` when `--state` is absent.
 *  - 8.3 the supplied Relationship_State when `--state` is provided.
 *  - 8.4 `--account` routes to `analyzeAccountTransfers` with the 12-digit id.
 *  - 8.5 `--type` restricts the displayed transfers to that Transfer_Type.
 *  - 8.6 four present/absent indicators per transfer.
 *  - 8.7 `--validate` includes missing + orphaned consistency-validation output.
 *  - 8.8 both direct and indirect transfers shown when `--type` is absent.
 *  - 8.10 the no-transfers case emits a message and exits zero.
 */

import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import type { AnalyzeResult } from '../../../../cli/commands/transfers/analyze.js';
import type {
  GlobalOptions,
  IoContext,
  OutputSink,
  Scope,
} from '../../../../cli/lib/io-context.js';
import type { OutputFormatter, RenderableView } from '../../../../cli/lib/output-formatter.js';
import type {
  ErrorReporter,
  FailureClass,
  RemediationContext,
} from '../../../../cli/lib/error-reporter.js';

import type {
  analyzeTransfers as analyzeTransfersType,
  analyzeAccountTransfers as analyzeAccountTransfersType,
} from '../../../../lib/lambda/common/services/transfer-analysis-service.js';

import { RelationshipState, TransferType, createBillingTransferModel } from '../../../../lib/lambda/common/models/billing-transfer.js';
import {
  AnalysisSummaryModel,
  createAnalysisSummary,
  createEmptyAnalysisSummary,
} from '../../../../lib/lambda/common/models/analysis-summary.js';
import {
  BillingTransferWithResourcesModel,
  BillingGroup,
  PricingPlan,
  CURConfiguration,
  createBillingTransferWithResources,
} from '../../../../lib/lambda/common/models/billing-transfer-resources.js';
import {
  ValidationResultModel,
  createValidationResult,
} from '../../../../lib/lambda/common/models/validation-result.js';
import { BillingView } from '../../../../lib/lambda/common/models/billing-view.js';

// ---------------------------------------------------------------------------
// Mock the shared Transfer Analysis Service: the handler's only AWS-touching
// dependency. The canned implementations are installed per test. The real
// `analysis-summary` helpers (filterByTransferType, createAnalysisSummary, …)
// stay unmocked so `--type` filtering and count recomputation run for real.
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../../../lib/lambda/common/services/transfer-analysis-service.js', () => ({
  __esModule: true,
  analyzeTransfers: jest.fn(),
  analyzeAccountTransfers: jest.fn(),
}));

let analyzeHandler: typeof import('../../../../cli/commands/transfers/analyze.js').analyzeHandler;
let mockAnalyzeTransfers: jest.MockedFunction<typeof analyzeTransfersType>;
let mockAnalyzeAccountTransfers: jest.MockedFunction<typeof analyzeAccountTransfersType>;

beforeAll(async () => {
  ({ analyzeHandler } = await import('../../../../cli/commands/transfers/analyze.js'));
  const svc = await import('../../../../lib/lambda/common/services/transfer-analysis-service.js');
  mockAnalyzeTransfers = svc.analyzeTransfers as jest.MockedFunction<typeof analyzeTransfersType>;
  mockAnalyzeAccountTransfers = svc.analyzeAccountTransfers as jest.MockedFunction<
    typeof analyzeAccountTransfersType
  >;
});

// ---------------------------------------------------------------------------
// Fixtures — typed billing-transfer-with-resources models
// ---------------------------------------------------------------------------

const PAYER_ACCOUNT = '111122223333';
const SOURCE_ACCOUNT = '123456789012';

function makeBillingView(): BillingView {
  return {
    arn: 'arn:aws:billing::111122223333:billingview/transfer',
    name: 'transfer-view',
    billingViewType: 'BILLING_TRANSFER',
    ownerAccountId: PAYER_ACCOUNT,
    sourceAccountId: SOURCE_ACCOUNT,
  };
}

function makeBillingGroup(): BillingGroup {
  return {
    arn: 'arn:aws:billingconductor::111122223333:billinggroup/group',
    name: 'transfer-group',
    primaryAccountId: PAYER_ACCOUNT,
    pricingPlanArn: 'arn:aws:billingconductor::111122223333:pricingplan/plan',
  };
}

function makePricingPlan(): PricingPlan {
  return {
    arn: 'arn:aws:billingconductor::111122223333:pricingplan/plan',
    name: 'BasicPricingPlan',
  };
}

function makeCurConfiguration(): CURConfiguration {
  return {
    reportName: 'transfer-cur',
    s3Bucket: 'cur-bucket',
    s3Region: 'us-east-1',
    timeUnit: 'DAILY',
    format: 'Parquet',
    compression: 'Parquet',
    additionalSchemaElements: [],
    additionalArtifacts: [],
    refreshClosedReports: true,
    reportVersioning: 'OVERWRITE_REPORT',
  };
}

/**
 * Build one transfer-with-resources model. When `present` is true all four
 * associated resources are attached (so every `resourcesFound` flag is true);
 * when false none are, so every flag is false — driving the present/absent
 * indicators (Req 8.6).
 */
function makeTransfer(opts: {
  id: string;
  transferType: TransferType;
  present: boolean;
  source?: string;
  status?: RelationshipState;
}): BillingTransferWithResourcesModel {
  const transfer = createBillingTransferModel(
    {
      id: opts.id,
      arn: `arn:aws:organizations::111122223333:transfer/${opts.id}`,
      name: `transfer-${opts.id}`,
      billSourceAccountId: opts.source ?? SOURCE_ACCOUNT,
      billTransferAccountId: PAYER_ACCOUNT,
      status: opts.status ?? 'ACCEPTED',
      startTimestamp: 0,
    },
    opts.transferType,
  );

  return createBillingTransferWithResources(
    transfer,
    opts.present
      ? {
          billingView: makeBillingView(),
          billingGroup: makeBillingGroup(),
          pricingPlan: makePricingPlan(),
          curConfiguration: makeCurConfiguration(),
        }
      : {},
  );
}

/** Build a typed analysis summary from the supplied transfers (Req 8.1, 8.9). */
function makeSummary(
  transfers: BillingTransferWithResourcesModel[],
  state: RelationshipState = 'ACCEPTED',
): AnalysisSummaryModel {
  return createAnalysisSummary(transfers, state, 5);
}

/**
 * A validation result with one missing billing group (critical) and one
 * orphaned billing group, so `--validate` output carries both a missing and an
 * orphaned finding (Req 8.7).
 */
function makeValidation(
  missingTransfer: BillingTransferWithResourcesModel,
  state: RelationshipState = 'ACCEPTED',
): ValidationResultModel {
  return createValidationResult(
    state,
    {
      billingViews: [],
      billingGroups: [missingTransfer],
      pricingPlans: [],
      curConfigurations: [],
    },
    {
      billingViews: [],
      billingGroups: [makeBillingGroup()],
    },
  );
}

// ---------------------------------------------------------------------------
// In-memory IoContext: recording formatter + reporter, capturing sinks
// ---------------------------------------------------------------------------

/** A captured `emit` invocation so the test can inspect the emitted payload/view. */
interface EmitCall {
  payload: unknown;
  view: RenderableView;
}

/** Recording Output_Formatter: captures every emitted payload and view (Req 7). */
class RecordingFormatter implements OutputFormatter {
  readonly emitCalls: EmitCall[] = [];
  readonly jsonCalls: unknown[] = [];

  renderHuman(_view: RenderableView, _ctx: IoContext): void {
    /* not exercised by these single-account success/no-transfer cases */
  }

  renderJson(payload: unknown, _ctx: IoContext): void {
    this.jsonCalls.push(payload);
  }

  emit(payload: unknown, view: RenderableView, _global: GlobalOptions, _ctx: IoContext): void {
    this.emitCalls.push({ payload, view });
  }
}

/** Recording Error_Reporter: records report calls; never used on the success paths. */
class RecordingReporter implements ErrorReporter {
  readonly reported: unknown[] = [];

  classify(_error: unknown): FailureClass {
    return 'unknown';
  }

  remediation(_cls: FailureClass, _ctx?: RemediationContext): string {
    return 'remediation';
  }

  report(error: unknown, _ctx: IoContext, _hint?: RemediationContext): FailureClass {
    this.reported.push(error);
    return 'unknown';
  }

  reportCredentials(_ctx: IoContext, _hint?: RemediationContext): void {
    /* unused */
  }

  reportUnavailableRegion(_ctx: IoContext, _hint?: RemediationContext): void {
    /* unused */
  }
}

/** In-memory sink capturing every line written. */
function makeSink(lines: string[]): OutputSink {
  return {
    write: (text: string) => lines.push(text),
    writeLine: (line: string) => lines.push(line),
  };
}

interface Harness {
  ctx: IoContext;
  formatter: RecordingFormatter;
  reporter: RecordingReporter;
  stdout: string[];
  stderr: string[];
}

function makeGlobal(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  const scope: Scope = overrides.scope ?? { kind: 'ambient' };
  return {
    scope,
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

function makeHarness(): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const formatter = new RecordingFormatter();
  const reporter = new RecordingReporter();
  const ctx: IoContext = {
    stdout: makeSink(stdout),
    stderr: makeSink(stderr),
    env: {},
    cwd: '/tmp',
    // The single-account path never touches these; cast to satisfy the type.
    clients: {} as IoContext['clients'],
    tools: {} as IoContext['tools'],
    fleet: {} as IoContext['fleet'],
    formatter,
    reporter,
    now: () => 0,
  };
  return { ctx, formatter, reporter, stdout, stderr };
}

/** Collect the flattened text of every TextBlock line in a view. */
function viewText(view: RenderableView): string {
  return view.blocks
    .flatMap((block) => (block.kind === 'text' ? block.lines : []))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bt transfers analyze — single-account handler (task 10.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Safe default: an empty summary so any unconfigured call resolves cleanly.
    mockAnalyzeTransfers.mockResolvedValue({ summary: createEmptyAnalysisSummary('ACCEPTED') });
    mockAnalyzeAccountTransfers.mockResolvedValue({
      summary: createEmptyAnalysisSummary('ACCEPTED'),
    });
  });

  it('defaults the Relationship_State to ACCEPTED when --state is absent (Req 8.2)', async () => {
    const transfers = [makeTransfer({ id: 'rt-1', transferType: 'direct', present: true })];
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers, 'ACCEPTED') });

    const { ctx, formatter } = makeHarness();
    const { result, exitCode } = await analyzeHandler({ global: makeGlobal() }, ctx);

    // Service queried with the ACCEPTED default, not the account-scoped entry.
    expect(mockAnalyzeTransfers).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeTransfers).toHaveBeenCalledWith({
      relationshipState: 'ACCEPTED',
      includeValidation: false,
    });
    expect(mockAnalyzeAccountTransfers).not.toHaveBeenCalled();

    const analysis = result as AnalyzeResult;
    expect(analysis.kind).toBe('analysis');
    expect(analysis.relationshipState).toBe('ACCEPTED');
    expect(exitCode).toBe(CliExitCode.Success);

    // The same result payload is emitted through the Output_Formatter.
    expect(formatter.emitCalls).toHaveLength(1);
    expect(formatter.emitCalls[0].payload).toBe(result);
  });

  it('analyzes the supplied Relationship_State when --state is provided (Req 8.3)', async () => {
    const transfers = [makeTransfer({ id: 'rt-1', transferType: 'direct', present: true, status: 'PENDING' })];
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers, 'PENDING') });

    const { ctx } = makeHarness();
    const { result } = await analyzeHandler({ state: 'PENDING', global: makeGlobal() }, ctx);

    expect(mockAnalyzeTransfers).toHaveBeenCalledWith({
      relationshipState: 'PENDING',
      includeValidation: false,
    });
    expect((result as AnalyzeResult).relationshipState).toBe('PENDING');
  });

  it('routes --account to analyzeAccountTransfers with the 12-digit id (Req 8.4)', async () => {
    const transfers = [
      makeTransfer({ id: 'rt-1', transferType: 'direct', present: true, source: SOURCE_ACCOUNT }),
    ];
    mockAnalyzeAccountTransfers.mockResolvedValue({ summary: makeSummary(transfers) });

    const { ctx } = makeHarness();
    const { result, exitCode } = await analyzeHandler(
      { account: SOURCE_ACCOUNT, global: makeGlobal() },
      ctx,
    );

    // Account-scoped entry point is used; the unscoped one is not.
    expect(mockAnalyzeAccountTransfers).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeAccountTransfers).toHaveBeenCalledWith(SOURCE_ACCOUNT, {
      relationshipState: 'ACCEPTED',
      includeValidation: false,
    });
    expect(mockAnalyzeTransfers).not.toHaveBeenCalled();

    const analysis = result as AnalyzeResult;
    expect(analysis.account).toBe(SOURCE_ACCOUNT);
    expect(exitCode).toBe(CliExitCode.Success);
  });

  it('restricts displayed transfers to the --type Transfer_Type (Req 8.5)', async () => {
    const transfers = [
      makeTransfer({ id: 'rt-direct', transferType: 'direct', present: true }),
      makeTransfer({ id: 'rt-indirect', transferType: 'indirect', present: true }),
    ];
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers) });

    const { ctx } = makeHarness();
    const { result } = await analyzeHandler({ type: 'direct', global: makeGlobal() }, ctx);

    const analysis = result as AnalyzeResult;
    expect(analysis.type).toBe('direct');
    // Only the direct transfer survives the filter; counts are recomputed.
    expect(analysis.transfers).toHaveLength(1);
    expect(analysis.transfers[0].transferType).toBe('direct');
    expect(analysis.summary.totalTransfers).toBe(1);
    expect(analysis.summary.directTransferCount).toBe(1);
    expect(analysis.summary.indirectTransferCount).toBe(0);
  });

  it('shows both direct and indirect transfers when --type is absent (Req 8.8)', async () => {
    const transfers = [
      makeTransfer({ id: 'rt-direct', transferType: 'direct', present: true }),
      makeTransfer({ id: 'rt-indirect', transferType: 'indirect', present: false }),
    ];
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers) });

    const { ctx } = makeHarness();
    const { result } = await analyzeHandler({ global: makeGlobal() }, ctx);

    const analysis = result as AnalyzeResult;
    expect(analysis.type).toBeUndefined();
    expect(analysis.transfers).toHaveLength(2);
    const types = analysis.transfers.map((t) => t.transferType).sort();
    expect(types).toEqual(['direct', 'indirect']);
    expect(analysis.summary.directTransferCount).toBe(1);
    expect(analysis.summary.indirectTransferCount).toBe(1);
  });

  it('renders four present/absent indicators per transfer (Req 8.6)', async () => {
    const transfers = [
      makeTransfer({ id: 'rt-present', transferType: 'direct', present: true }),
      makeTransfer({ id: 'rt-absent', transferType: 'indirect', present: false }),
    ];
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers) });

    const { ctx } = makeHarness();
    const { result } = await analyzeHandler({ global: makeGlobal() }, ctx);

    const analysis = result as AnalyzeResult;
    const present = analysis.transfers.find((t) => t.id === 'rt-present')!;
    const absent = analysis.transfers.find((t) => t.id === 'rt-absent')!;

    // Each transfer carries exactly the four indicators, each a boolean (Req 8.6).
    expect(Object.keys(present.present).sort()).toEqual([
      'billingGroup',
      'billingView',
      'curConfiguration',
      'pricingPlan',
    ]);
    expect(present.present).toEqual({
      billingView: true,
      billingGroup: true,
      pricingPlan: true,
      curConfiguration: true,
    });
    expect(absent.present).toEqual({
      billingView: false,
      billingGroup: false,
      pricingPlan: false,
      curConfiguration: false,
    });
  });

  it('includes missing + orphaned consistency-validation output with --validate (Req 8.7)', async () => {
    const transfers = [
      makeTransfer({ id: 'rt-1', transferType: 'direct', present: true }),
      makeTransfer({ id: 'rt-missing-bg', transferType: 'indirect', present: false }),
    ];
    const validation = makeValidation(transfers[1]);
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers), validation });

    const { ctx } = makeHarness();
    const { result } = await analyzeHandler({ validate: true, global: makeGlobal() }, ctx);

    // includeValidation forwarded to the service so one discovery pass is reused.
    expect(mockAnalyzeTransfers).toHaveBeenCalledWith({
      relationshipState: 'ACCEPTED',
      includeValidation: true,
    });

    const analysis = result as AnalyzeResult;
    expect(analysis.validate).toBe(true);
    expect(analysis.validation).toBeDefined();
    // A missing resource (billing group) and an orphaned resource are reported.
    expect(analysis.validation!.issuesByType.missingBillingGroups).toBe(1);
    expect(analysis.validation!.issuesByType.orphanedBillingGroups).toBe(1);
    expect(analysis.validation!.isValid).toBe(false);
    expect(analysis.validation!.totalIssues).toBe(2);
  });

  it('omits validation output when --validate is not provided (Req 8.7)', async () => {
    const transfers = [makeTransfer({ id: 'rt-1', transferType: 'direct', present: true })];
    mockAnalyzeTransfers.mockResolvedValue({ summary: makeSummary(transfers) });

    const { ctx } = makeHarness();
    const { result } = await analyzeHandler({ global: makeGlobal() }, ctx);

    const analysis = result as AnalyzeResult;
    expect(analysis.validate).toBe(false);
    expect(analysis.validation).toBeUndefined();
  });

  it('emits a no-transfers message and exits zero when nothing matches (Req 8.10)', async () => {
    mockAnalyzeTransfers.mockResolvedValue({ summary: createEmptyAnalysisSummary('ACCEPTED') });

    const { ctx, formatter } = makeHarness();
    const { result, exitCode } = await analyzeHandler(
      { state: 'TERMINATED', global: makeGlobal() },
      ctx,
    );

    const analysis = result as AnalyzeResult;
    expect(analysis.noTransfersFound).toBe(true);
    expect(analysis.transfers).toHaveLength(0);
    // Finding nothing is success, not an error (Req 8.10).
    expect(exitCode).toBe(CliExitCode.Success);

    // A human-readable "no transfers" message is part of the emitted view.
    expect(formatter.emitCalls).toHaveLength(1);
    expect(viewText(formatter.emitCalls[0].view)).toContain('No billing transfers found');
  });
});
