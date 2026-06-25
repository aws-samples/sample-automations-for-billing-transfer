// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Feature: billing-transfer-cli, Property 8: Fleet rollup totals equal the sum over successfully analyzed accounts

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
/**
 * Property-based test for the `bt transfers analyze --all-profiles` fleet rollup
 * (task 10.3, design Correctness Property 8).
 *
 * Property 8: *For any* set of per-account analysis results, the fleet-wide
 * totals (transfers, transfers missing billing groups, transfers missing CUR
 * configurations, and — when `--validate` was requested — orphaned resources)
 * equal the component-wise SUM over only the accounts whose analysis completed
 * successfully (`ok`); accounts that failed contribute nothing (Req 9.5). The
 * reported success and failure counts equal the number of `ok` and `failed`
 * accounts respectively (Req 9.2, 9.5).
 *
 * The implementation under test is {@link analyzeHandler} from
 * `cli/commands/transfers/analyze.ts`, driven with `global.scope` set to
 * `all-profiles`. The handler resolves the profile list through the real
 * Profile_Loader (so a temp `payer-profiles.txt` is written per run and surfaced
 * via `PAYER_PROFILES_FILE`) and then delegates to `ctx.fleet`. Here `ctx.fleet`
 * is a STUB {@link FleetRunner} that ignores the actual command and returns a
 * canned {@link FleetResult}: each `ok` account carries an arbitrary, typed
 * {@link AnalyzeResult} payload (built from the real `createAnalysisSummary` /
 * `createValidationResult` models), and a random mix of accounts is marked
 * `failed`. No `bt` process is spawned and no AWS call is made (Req 22.3, 22.4).
 *
 * The assertion is checked against an INDEPENDENT oracle that re-derives the
 * expected totals/counts directly from the generated per-account specs (not from
 * the typed payloads the handler reads), so the handler's aggregation cannot
 * agree with the oracle by sharing the same summation.
 *
 * Validates: Requirements 9.2, 9.5
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import fc from 'fast-check';

import {
  analyzeHandler,
  ORPHANED_NOT_COMPUTED,
  type AnalyzeResult,
  type AnalyzeRollupResult,
  type AnalyzedTransferView,
} from '../../../../cli/commands/transfers/analyze.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import type {
  GlobalOptions,
  IoContext,
  OutputSink,
} from '../../../../cli/lib/io-context.js';
import type { OutputFormatter, RenderableView } from '../../../../cli/lib/output-formatter.js';
import type {
  ErrorReporter,
  FailureClass,
  RemediationContext,
} from '../../../../cli/lib/error-reporter.js';
import type {
  FleetRunner,
  FleetResult,
  AccountResult,
} from '../../../../cli/lib/fleet-runner.js';

import { createBillingTransferModel } from '../../../../lib/lambda/common/models/billing-transfer.js';
import {
  createAnalysisSummary,
  type AnalysisSummaryModel,
} from '../../../../lib/lambda/common/models/analysis-summary.js';
import {
  createBillingTransferWithResources,
  type BillingGroup,
  type BillingTransferWithResourcesModel,
  type CURConfiguration,
} from '../../../../lib/lambda/common/models/billing-transfer-resources.js';
import {
  createValidationResult,
  type ValidationResultModel,
} from '../../../../lib/lambda/common/models/validation-result.js';
import type { BillingView } from '../../../../lib/lambda/common/models/billing-view.js';

// ---------------------------------------------------------------------------
// Per-account specs (the generated input space) and an independent oracle
// ---------------------------------------------------------------------------

/** One transfer's shape: its type and whether it has a billing group / CUR config. */
interface TransferSpec {
  type: 'direct' | 'indirect';
  hasBillingGroup: boolean;
  hasCurConfiguration: boolean;
}

/** A successfully analyzed account: a set of transfers plus optional orphaned counts. */
interface OkSpec {
  kind: 'ok';
  transfers: TransferSpec[];
  orphanedBillingViews: number;
  orphanedBillingGroups: number;
  /** When false (and `--validate` is set) the child could not include validation data (Req 9.9 degrade). */
  validationAvailable: boolean;
}

/** A failed account: contributes nothing, even if it carries a recognizable payload. */
interface FailSpec {
  kind: 'failed';
  /** Attach a bogus-but-valid AnalyzeResult payload to prove a failed row is still ignored. */
  attachData: boolean;
  bogusTransfers: TransferSpec[];
  bogusOrphanedBillingViews: number;
  bogusOrphanedBillingGroups: number;
}

type AccountSpec = OkSpec | FailSpec;

/** Expected fleet-wide aggregate, derived independently from the specs. */
interface Oracle {
  transfers: number;
  missingBillingGroups: number;
  missingCurConfigurations: number;
  orphaned: number | typeof ORPHANED_NOT_COMPUTED;
  succeeded: number;
  failed: number;
}

/**
 * Independent oracle: sum the expected totals straight from the specs, counting
 * only `ok` accounts (Req 9.5). This deliberately re-derives the numbers from the
 * raw spec rather than from the typed AnalyzeResult payloads the handler reads.
 */
function computeOracle(specs: AccountSpec[], validate: boolean): Oracle {
  let transfers = 0;
  let missingBillingGroups = 0;
  let missingCurConfigurations = 0;
  let orphaned = 0;
  let succeeded = 0;
  let failed = 0;

  for (const spec of specs) {
    if (spec.kind === 'ok') {
      succeeded += 1;
      transfers += spec.transfers.length;
      missingBillingGroups += spec.transfers.filter((t) => !t.hasBillingGroup).length;
      missingCurConfigurations += spec.transfers.filter((t) => !t.hasCurConfiguration).length;
      // A degraded account (validation unavailable) contributes nothing to the
      // orphaned total even though it analyzed successfully (Req 9.9).
      if (validate && spec.validationAvailable) {
        orphaned += spec.orphanedBillingViews + spec.orphanedBillingGroups;
      }
    } else {
      failed += 1;
    }
  }

  return {
    transfers,
    missingBillingGroups,
    missingCurConfigurations,
    // Without --validate the rollup reports a not-computed sentinel, not 0 (Req 9.4).
    orphaned: validate ? orphaned : ORPHANED_NOT_COMPUTED,
    succeeded,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Typed-model fixtures (build valid child AnalyzeResult payloads)
// ---------------------------------------------------------------------------

const PAYER_ACCOUNT = '111122223333';
const SOURCE_ACCOUNT = '123456789012';

function makeBillingGroup(seed: string): BillingGroup {
  return {
    arn: `arn:aws:billingconductor::${PAYER_ACCOUNT}:billinggroup/${seed}`,
    name: `group-${seed}`,
    primaryAccountId: PAYER_ACCOUNT,
    pricingPlanArn: `arn:aws:billingconductor::${PAYER_ACCOUNT}:pricingplan/${seed}`,
  };
}

function makeCurConfiguration(seed: string): CURConfiguration {
  return {
    reportName: `cur-${seed}`,
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

function makeOrphanBillingView(seed: string): BillingView {
  return {
    arn: `arn:aws:billing::${PAYER_ACCOUNT}:billingview/orphan-${seed}`,
    name: `orphan-view-${seed}`,
    billingViewType: 'BILLING_TRANSFER',
    ownerAccountId: PAYER_ACCOUNT,
  };
}

/** Build one typed transfer-with-resources model honoring the spec's presence flags. */
function makeTransferModel(spec: TransferSpec, seed: string): BillingTransferWithResourcesModel {
  const transfer = createBillingTransferModel(
    {
      id: `rt-${seed}`,
      arn: `arn:aws:organizations::${PAYER_ACCOUNT}:transfer/rt-${seed}`,
      name: `transfer-${seed}`,
      billSourceAccountId: SOURCE_ACCOUNT,
      billTransferAccountId: PAYER_ACCOUNT,
      status: 'ACCEPTED',
      startTimestamp: 0,
    },
    spec.type,
  );

  return createBillingTransferWithResources(transfer, {
    billingGroup: spec.hasBillingGroup ? makeBillingGroup(seed) : undefined,
    curConfiguration: spec.hasCurConfiguration ? makeCurConfiguration(seed) : undefined,
  });
}

/** Project a typed model into the friendly per-transfer view a real child emits. */
function toTransferView(model: BillingTransferWithResourcesModel): AnalyzedTransferView {
  const t = model.transfer;
  return {
    id: t.id,
    name: t.name,
    arn: t.arn,
    transferType: t.transferType,
    status: t.status,
    billSourceAccountId: t.billSourceAccountId,
    billTransferAccountId: t.billTransferAccountId,
    present: {
      billingView: model.resourcesFound.billingView,
      billingGroup: model.resourcesFound.billingGroup,
      pricingPlan: model.resourcesFound.pricingPlan,
      curConfiguration: model.resourcesFound.curConfiguration,
    },
  };
}

/** Build a typed validation result carrying the spec's orphaned billing views / groups. */
function makeValidation(orphanViews: number, orphanGroups: number): ValidationResultModel {
  const billingViews: BillingView[] = Array.from({ length: orphanViews }, (_, i) =>
    makeOrphanBillingView(String(i)),
  );
  const billingGroups: BillingGroup[] = Array.from({ length: orphanGroups }, (_, i) =>
    makeBillingGroup(`orphan-${i}`),
  );
  return createValidationResult(
    'ACCEPTED',
    { billingViews: [], billingGroups: [], pricingPlans: [], curConfigurations: [] },
    { billingViews, billingGroups },
  );
}

/**
 * Build the typed {@link AnalyzeResult} a single-account child emits, exactly the
 * shape the fleet rollup parses. The summary is computed by the real
 * `createAnalysisSummary` so its resource counts are derived from the transfer
 * models (not hand-set), keeping the payload self-consistent and the oracle
 * genuinely independent.
 */
function buildChildResult(
  transfers: TransferSpec[],
  orphanViews: number,
  orphanGroups: number,
  validate: boolean,
  validationAvailable: boolean,
  accountSeed: string,
): AnalyzeResult {
  const models = transfers.map((spec, i) => makeTransferModel(spec, `${accountSeed}-${i}`));
  const summary: AnalysisSummaryModel = createAnalysisSummary(models, 'ACCEPTED', 1);
  const validation =
    validate && validationAvailable ? makeValidation(orphanViews, orphanGroups) : undefined;

  return {
    kind: 'analysis',
    relationshipState: 'ACCEPTED',
    validate,
    noTransfersFound: models.length === 0,
    summary,
    validation,
    transfers: models.map(toTransferView),
  };
}

/** Assemble the canned per-account FleetResult entries from the specs. */
function buildFleetResult(specs: AccountSpec[], profiles: string[], validate: boolean): FleetResult {
  const accounts: AccountResult[] = specs.map((spec, index) => {
    const profile = profiles[index];
    if (spec.kind === 'ok') {
      return {
        profile,
        status: 'ok',
        exitCode: 0,
        data: buildChildResult(
          spec.transfers,
          spec.orphanedBillingViews,
          spec.orphanedBillingGroups,
          validate,
          spec.validationAvailable,
          `ok-${index}`,
        ),
      };
    }
    // A failed account: optionally carries a recognizable payload that the rollup
    // must still ignore entirely (Req 9.5 — failed accounts contribute nothing).
    const data = spec.attachData
      ? buildChildResult(
          spec.bogusTransfers,
          spec.bogusOrphanedBillingViews,
          spec.bogusOrphanedBillingGroups,
          validate,
          true,
          `bogus-${index}`,
        )
      : undefined;
    return {
      profile,
      status: 'failed',
      exitCode: 1,
      data,
      failureDetail: `stubbed failure for ${profile}`,
    };
  });

  const failed = accounts.reduce((n, a) => (a.status === 'failed' ? n + 1 : n), 0);
  const succeeded = accounts.length - failed;
  return {
    accounts,
    succeeded,
    failed,
    exitCode: failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success,
  };
}

// ---------------------------------------------------------------------------
// In-memory IoContext: stub fleet, recording formatter, no-op reporter/sinks
// ---------------------------------------------------------------------------

/** Stub FleetRunner that ignores the command and returns the canned FleetResult. */
function makeStubFleet(fleetResult: FleetResult): FleetRunner {
  return {
    run: <TData>(): Promise<FleetResult<TData>> =>
      Promise.resolve(fleetResult as unknown as FleetResult<TData>),
    selfInvocation: (): string[] => [],
  };
}

/** Minimal recording Output_Formatter: it only needs to accept the rollup emit. */
class NoopFormatter implements OutputFormatter {
  renderHuman(_view: RenderableView, _ctx: IoContext): void {
    /* not asserted */
  }
  renderJson(_payload: unknown, _ctx: IoContext): void {
    /* not asserted */
  }
  emit(_payload: unknown, _view: RenderableView, _global: GlobalOptions, _ctx: IoContext): void {
    /* not asserted */
  }
}

/** No-op Error_Reporter: the fleet success path never reports an AWS error. */
class NoopReporter implements ErrorReporter {
  classify(_error: unknown): FailureClass {
    return 'unknown';
  }
  remediation(_cls: FailureClass, _ctx?: RemediationContext): string {
    return '';
  }
  report(_error: unknown, _ctx: IoContext, _hint?: RemediationContext): FailureClass {
    return 'unknown';
  }
  reportCredentials(_ctx: IoContext, _hint?: RemediationContext): void {
    /* unused */
  }
  reportUnavailableRegion(_ctx: IoContext, _hint?: RemediationContext): void {
    /* unused */
  }
}

/** Discarding sink so nothing reaches the real process streams. */
function makeSink(): OutputSink {
  return { write: () => undefined, writeLine: () => undefined };
}

function makeGlobal(profilesFile: string): GlobalOptions {
  return {
    scope: { kind: 'all-profiles' },
    profilesFile,
    json: false,
    color: false,
    execute: false,
    verbose: false,
  };
}

function makeContext(fleet: FleetRunner, cwd: string, profilesFile: string): IoContext {
  return {
    stdout: makeSink(),
    stderr: makeSink(),
    env: { PAYER_PROFILES_FILE: profilesFile },
    cwd,
    // The fleet analyze path never touches these; cast to satisfy the type.
    clients: {} as IoContext['clients'],
    tools: {} as IoContext['tools'],
    fleet,
    formatter: new NoopFormatter(),
    reporter: new NoopReporter(),
    now: () => 0,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const transferSpecArb: fc.Arbitrary<TransferSpec> = fc.record({
  type: fc.constantFrom<'direct' | 'indirect'>('direct', 'indirect'),
  hasBillingGroup: fc.boolean(),
  hasCurConfiguration: fc.boolean(),
});

const okSpecArb: fc.Arbitrary<OkSpec> = fc.record({
  kind: fc.constant<'ok'>('ok'),
  transfers: fc.array(transferSpecArb, { maxLength: 6 }),
  orphanedBillingViews: fc.integer({ min: 0, max: 5 }),
  orphanedBillingGroups: fc.integer({ min: 0, max: 5 }),
  validationAvailable: fc.boolean(),
});

const failSpecArb: fc.Arbitrary<FailSpec> = fc.record({
  kind: fc.constant<'failed'>('failed'),
  attachData: fc.boolean(),
  bogusTransfers: fc.array(transferSpecArb, { maxLength: 6 }),
  bogusOrphanedBillingViews: fc.integer({ min: 0, max: 5 }),
  bogusOrphanedBillingGroups: fc.integer({ min: 0, max: 5 }),
});

const accountSpecArb: fc.Arbitrary<AccountSpec> = fc.oneof(okSpecArb, failSpecArb);

const specsArb: fc.Arbitrary<AccountSpec[]> = fc.array(accountSpecArb, {
  minLength: 1,
  maxLength: 8,
});

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

describe('bt transfers analyze --all-profiles — fleet rollup totals (Property 8)', () => {
  let tmpDir: string;
  let profilesFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-rollup-totals-'));
    profilesFile = path.join(tmpDir, 'payer-profiles.txt');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Feature: billing-transfer-cli, Property 8: Fleet rollup totals equal the sum over successfully analyzed accounts
  it('fleet totals equal the component-wise sum over only the ok accounts; failed accounts contribute nothing', async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, fc.boolean(), async (specs, validate) => {
        // One profile per account; deterministic, parse-clean names. The real
        // Profile_Loader reads this file; the stub fleet ignores it and returns
        // the canned accounts.
        const profiles = specs.map((_, i) => `payer-${i}`);
        fs.writeFileSync(profilesFile, `${profiles.join('\n')}\n`, 'utf8');

        const fleetResult = buildFleetResult(specs, profiles, validate);
        const ctx = makeContext(makeStubFleet(fleetResult), tmpDir, profilesFile);
        const global = makeGlobal(profilesFile);

        const { result, exitCode } = await analyzeHandler(
          { validate, global },
          ctx,
        );

        expect(result.kind).toBe('fleet-rollup');
        const rollup = result as AnalyzeRollupResult;

        const oracle = computeOracle(specs, validate);

        // Req 9.5: fleet-wide totals are the sum over only the ok accounts.
        expect(rollup.totals.transfers).toBe(oracle.transfers);
        expect(rollup.totals.missingBillingGroups).toBe(oracle.missingBillingGroups);
        expect(rollup.totals.missingCurConfigurations).toBe(oracle.missingCurConfigurations);
        // Orphaned total only when --validate; degraded accounts contribute nothing.
        expect(rollup.totals.orphaned).toEqual(oracle.orphaned);

        // Req 9.2 / 9.5: success/failure counts match the ok/failed account counts.
        expect(rollup.succeeded).toBe(oracle.succeeded);
        expect(rollup.failed).toBe(oracle.failed);

        // One row per account, and the exit code follows the failure count.
        expect(rollup.rows).toHaveLength(specs.length);
        expect(exitCode).toBe(
          oracle.failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success,
        );
      }),
      { numRuns: 200 },
    );
  });
});
