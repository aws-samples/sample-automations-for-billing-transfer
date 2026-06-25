// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt transfers analyze` — billing-transfer analysis handler (single account and
 * `--all-profiles` fleet rollup).
 *
 * This is the pure, injectable {@link CommandHandler} behind `bt transfers
 * analyze`. In single-account scope it lists the billing transfers for one
 * account (the active/ambient profile, or `--profile <name>`) together with their
 * four associated Billing Conductor resources, and prints a per-resource analysis
 * summary. In `--all-profiles` scope it re-invokes this exact handler once per
 * profile through the {@link FleetRunner} and aggregates each child's emitted
 * typed JSON into a per-account rollup, so the fleet behavior cannot diverge from
 * what a single-account run produces (Req 9.1).
 *
 * Reuse, not re-derivation (Req 8.1, 22.2): all billing logic comes from the
 * shared Transfer Analysis Service and the typed Shared_Models. The handler
 * calls {@link analyzeTransfers} (or {@link analyzeAccountTransfers} when
 * `--account` is given) with `includeValidation` driven by `--validate`, applies
 * the `--type` filter via the model helper {@link filterByTransferType}, and
 * reads the present/absent state of each resource straight off the typed
 * {@link BillingTransferWithResourcesModel.resourcesFound} flags. Nothing is
 * scraped from text or recomputed from raw AWS output.
 *
 * Single-account behavior, mapped to the acceptance criteria:
 *  - Lists transfers through the Shared_Services (Req 8.1).
 *  - Defaults the Relationship_State to `ACCEPTED` when `--state` is absent and
 *    analyzes the supplied state otherwise (Req 8.2, 8.3).
 *  - Restricts analysis to a bill-source Account_Id with `--account` (Req 8.4).
 *  - Restricts the displayed/analyzed transfers to a Transfer_Type with `--type`,
 *    and shows both direct and indirect transfers when `--type` is absent
 *    (Req 8.5, 8.8).
 *  - Renders, for each transfer, four present/absent indicators — billing view,
 *    billing group, pricing plan, and CUR configuration (Req 8.6).
 *  - Adds consistency-validation (missing and orphaned resources) with
 *    `--validate` (Req 8.7).
 *  - Prints an analysis summary with the present and missing count per resource
 *    type (Req 8.9).
 *  - When no transfers match the analyzed state and any applied filters, prints a
 *    no-transfers message and exits zero (Req 8.10).
 *
 * Fleet rollup behavior (`--all-profiles`), mapped to the acceptance criteria:
 *  - Runs the analysis against every AWS_Profile resolved by the Profile_Loader
 *    (Req 9.1) through the Fleet_Runner child-process pool.
 *  - Renders a per-account row — total / direct / indirect counts, with-billing-
 *    group, missing-billing-group, and missing-CUR counts — for each successfully
 *    analyzed account, read from each child's typed {@link AnalysisSummaryModel}
 *    (Req 9.2).
 *  - With `--validate`, adds a per-account orphaned-resource count (orphaned
 *    billing views + groups) from the typed {@link ValidationResultModel} and
 *    marks validation as performed (Req 9.3).
 *  - Without `--validate`, shows the orphaned count as a not-computed sentinel
 *    that is observably distinct from a numeric zero (Req 9.4).
 *  - Displays fleet-wide totals aggregated over only the successfully analyzed
 *    accounts, plus success/failure account counts (Req 9.5).
 *  - Records a failed account with a failure indicator that is distinct from a
 *    zero count and from a successful row, and continues with the rest (Req 9.6).
 *  - Exits non-zero when any account failed (Req 9.7) and zero when all succeed
 *    (Req 9.8).
 *  - Degrades rather than fails when validation data is unavailable, indicating
 *    the limitation in the output (Req 9.9).
 *
 * Every `--state` / `--account` / `--type` value is checked by the
 * Input_Validator before any AWS call or child spawn; a rejection is reported to
 * stderr (and as a single JSON error document under `--json`) with a non-zero
 * exit and no AWS call made (Req 5, 8). AWS failures are classified and reported
 * by the Error_Reporter to stderr only (Req 6). Results are rendered through the
 * Output_Formatter, which keeps the machine-readable JSON document the sole thing
 * on stdout in `--json` mode (Req 7).
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 9.1, 9.2,
 * 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 22.2
 *
 * @module commands/transfers/analyze
 */

import * as os from 'os';
import * as path from 'path';

import type { CommandHandler, GlobalOptions, IoContext } from '../../lib/io-context.js';
import type { RenderableView, RenderableCell, RenderableBlock, Tone } from '../../lib/output-formatter.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { inputValidator } from '../../lib/input-validator.js';
import type { FailureClass, RemediationContext } from '../../lib/error-reporter.js';
import { profileLoader, ProfileListError } from '../../lib/profile-loader.js';
import type { AccountResult, FleetResult } from '../../lib/fleet-runner.js';

import {
  analyzeTransfers,
  analyzeAccountTransfers,
  type AnalysisResult,
} from '../../../lib/lambda/common/services/transfer-analysis-service.js';
import { RelationshipState, TransferType } from '../../../lib/lambda/common/models/billing-transfer.js';
import {
  AnalysisSummaryModel,
  filterByTransferType,
} from '../../../lib/lambda/common/models/analysis-summary.js';
import { BillingTransferWithResourcesModel } from '../../../lib/lambda/common/models/billing-transfer-resources.js';
import { ValidationResultModel } from '../../../lib/lambda/common/models/validation-result.js';
import { toError } from '../../../lib/lambda/common/utils/errors.js';

// ---------------------------------------------------------------------------
// Options and result types
// ---------------------------------------------------------------------------

/**
 * Command-specific options for `bt transfers analyze`, as parsed from the
 * command line. The `--state`, `--account`, and `--type` values arrive as raw
 * strings and are checked by the Input_Validator inside the handler (so the same
 * validation runs whether the handler is invoked by the router or directly by a
 * unit test). `global` (carrying the resolved scope and output flags) is merged
 * in by the {@link CommandHandler} contract.
 */
export interface AnalyzeOptions {
  /** Raw `--state` value; validated to a Relationship_State, defaulting to `ACCEPTED` (Req 8.2, 8.3). */
  state?: string;
  /** Raw `--account` value; validated to a 12-digit bill-source Account_Id (Req 8.4). */
  account?: string;
  /** Raw `--type` value; validated to a Transfer_Type (Req 8.5, 8.8). */
  type?: string;
  /** `--validate`: include consistency-validation results (Req 8.7). */
  validate?: boolean;
}

/**
 * The four present/absent resource indicators for a single transfer (Req 8.6),
 * each a boolean read directly from the typed `resourcesFound` flags.
 */
export interface ResourcePresence {
  /** Whether a billing view is associated with the transfer. */
  billingView: boolean;
  /** Whether a billing group is associated with the transfer. */
  billingGroup: boolean;
  /** Whether a pricing plan is associated with the transfer. */
  pricingPlan: boolean;
  /** Whether a CUR configuration is associated with the transfer. */
  curConfiguration: boolean;
}

/**
 * A friendly per-transfer view emitted in the result payload: the identifying
 * transfer fields plus the four present/absent indicators (Req 8.6). The
 * authoritative counts live on {@link AnalyzeResult.summary}; this list is the
 * convenient row-per-transfer projection.
 */
export interface AnalyzedTransferView {
  /** Transfer ID (e.g. `rt-...`). */
  id: string;
  /** Transfer name. */
  name: string;
  /** Transfer ARN. */
  arn: string;
  /** Direct or indirect. */
  transferType: TransferType;
  /** Relationship state of the transfer. */
  status: RelationshipState;
  /** Bill-source (customer) account id. */
  billSourceAccountId: string;
  /** Bill-transfer (payer) account id. */
  billTransferAccountId: string;
  /** The four present/absent resource indicators (Req 8.6). */
  present: ResourcePresence;
}

/**
 * Successful single-account analyze payload. This is the object emitted as the
 * single JSON document in `--json` mode and consumed by the fleet rollup
 * (task 10.2), which reads the typed {@link AnalysisSummaryModel} /
 * {@link ValidationResultModel} fields directly rather than scraping text.
 */
export interface AnalyzeResult {
  /** Discriminant distinguishing a successful analysis from a {@link AnalyzeFailure}. */
  kind: 'analysis';
  /** The Relationship_State analyzed (default `ACCEPTED`) (Req 8.2, 8.3). */
  relationshipState: RelationshipState;
  /** The bill-source Account_Id filter applied, if any (Req 8.4). */
  account?: string;
  /** The Transfer_Type filter applied; absent → both direct and indirect (Req 8.5, 8.8). */
  type?: TransferType;
  /** Whether `--validate` was requested (Req 8.7). */
  validate: boolean;
  /** True when no transfers matched the analyzed state and applied filters (Req 8.10). */
  noTransfersFound: boolean;
  /** Typed analysis summary with per-resource present/missing counts (Req 8.1, 8.9). */
  summary: AnalysisSummaryModel;
  /** Typed validation result, present only when `--validate` was requested (Req 8.7). */
  validation?: ValidationResultModel;
  /** Per-transfer four-indicator views (Req 8.6). */
  transfers: AnalyzedTransferView[];
}

/**
 * Structured failure payload returned (and emitted as the single JSON document
 * under `--json`) when analyze cannot complete: an Input_Validator rejection
 * (Req 5, 8) or a classified AWS failure (Req 6). The matching human-readable
 * message and remediation hint are always written to stderr, never stdout.
 */
export interface AnalyzeFailure {
  /** Discriminant distinguishing a failure from a successful {@link AnalyzeResult}. */
  kind: 'failure';
  /** `invalid-input` for an Input_Validator rejection; `aws-failure` for an AWS error. */
  reason: 'invalid-input' | 'aws-failure';
  /** Human-readable failure message (also written to stderr). */
  message: string;
  /** Remediation hint (also written to stderr). */
  remediation: string;
  /** For `invalid-input`: the offending option, its value, and the accepted values. */
  invalidInput?: { option: string; value: string; accepted: string[] };
  /** For `aws-failure`: the classified Error_Reporter failure class. */
  failureClass?: FailureClass;
}

// ---------------------------------------------------------------------------
// Fleet rollup types (Req 9)
// ---------------------------------------------------------------------------

/**
 * Sentinel rendered for the per-account orphaned-resource count when validation
 * was not computed: either `--validate` was not requested (Req 9.4) or it was
 * requested but the child could not include validation data (Req 9.9). It is a
 * string so it is observably distinct from a numeric count of zero in both the
 * JSON document and the human table.
 */
export const ORPHANED_NOT_COMPUTED = 'not-computed' as const;

/** The orphaned-resource cell type: a real count, or the not-computed sentinel (Req 9.4). */
export type OrphanedCount = number | typeof ORPHANED_NOT_COMPUTED;

/**
 * One per-account row of the fleet transfer-analysis rollup (Req 9.2–9.4, 9.6),
 * built entirely from the typed {@link AnalysisSummaryModel} /
 * {@link ValidationResultModel} fields a child emits — never from scraped text.
 *
 * The `status` discriminant is the per-account failure indicator (Req 9.6): a
 * `failed` row carries no counts (the count fields are absent, which is
 * observably distinct from a numeric zero) and instead carries a
 * {@link AnalyzeRollupRow.failureDetail}. An `ok` row carries every count.
 */
export interface AnalyzeRollupRow {
  /** AWS profile this row reports. */
  profile: string;
  /** Whether the account's analysis completed (`ok`) or failed (`failed`) (Req 9.6). */
  status: 'ok' | 'failed';
  /** Total transfers analyzed (present when `ok`) (Req 9.2). */
  total?: number;
  /** Direct transfer count (present when `ok`) (Req 9.2). */
  direct?: number;
  /** Indirect transfer count (present when `ok`) (Req 9.2). */
  indirect?: number;
  /** Count of transfers with a billing group (present when `ok`) (Req 9.2). */
  withBillingGroups?: number;
  /** Count of transfers missing a billing group (present when `ok`) (Req 9.2). */
  missingBillingGroups?: number;
  /** Count of transfers missing a CUR configuration (present when `ok`) (Req 9.2). */
  missingCurConfigurations?: number;
  /**
   * Orphaned-resource count for this account: the sum of orphaned billing views
   * and billing groups when `--validate` was provided and validation data was
   * available (Req 9.3); otherwise the {@link ORPHANED_NOT_COMPUTED} sentinel
   * (Req 9.4, 9.9). Present only on an `ok` row.
   */
  orphaned?: OrphanedCount;
  /** Cause of failure or a pointer to the per-account log (present when `failed`) (Req 9.6). */
  failureDetail?: string;
}

/** Fleet-wide totals aggregated over successfully analyzed accounts only (Req 9.5). */
export interface AnalyzeFleetTotals {
  /** Sum of analyzed transfers across successful accounts (Req 9.5). */
  transfers: number;
  /** Sum of transfers missing a billing group across successful accounts (Req 9.5). */
  missingBillingGroups: number;
  /** Sum of transfers missing a CUR configuration across successful accounts (Req 9.5). */
  missingCurConfigurations: number;
  /**
   * Sum of orphaned resources across successful accounts when `--validate` was
   * provided; the {@link ORPHANED_NOT_COMPUTED} sentinel otherwise (Req 9.4).
   */
  orphaned: OrphanedCount;
}

/**
 * Aggregated fleet transfer-analysis rollup (the `--json` shape for
 * `--all-profiles`). Built from each child's typed {@link AnalyzeResult}; the
 * fleet totals span only successfully analyzed accounts (Req 9.5), and the
 * success/failure counts come straight from the Fleet_Runner aggregation.
 */
export interface AnalyzeRollupResult {
  /** Discriminant distinguishing the fleet rollup from the other result shapes. */
  kind: 'fleet-rollup';
  /** The Relationship_State analyzed across the fleet (default `ACCEPTED`). */
  relationshipState: RelationshipState;
  /** The bill-source Account_Id filter forwarded to each child, if any (Req 8.4). */
  account?: string;
  /** The Transfer_Type filter forwarded to each child; absent → both (Req 8.5, 8.8). */
  type?: TransferType;
  /** Whether `--validate` was requested for the fleet run (Req 9.3, 9.4). */
  validate: boolean;
  /**
   * True when `--validate` was requested but at least one successfully analyzed
   * account could not include validation data, so the Command proceeded without
   * it rather than failing (Req 9.9).
   */
  validationDegraded: boolean;
  /** Per-account rows in profile-list order (Req 9.2, 9.6). */
  rows: AnalyzeRollupRow[];
  /** Fleet-wide totals over successfully analyzed accounts only (Req 9.5). */
  totals: AnalyzeFleetTotals;
  /** Count of accounts analyzed successfully (Req 9.5). */
  succeeded: number;
  /** Count of accounts whose analysis failed (Req 9.5, 9.6). */
  failed: number;
}

/** Union returned by the handler: a successful analysis, a fleet rollup, or a structured failure. */
export type AnalyzeCommandResult = AnalyzeResult | AnalyzeRollupResult | AnalyzeFailure;

/** The single-account command path re-invoked per profile by the Fleet_Runner. */
const FLEET_COMMAND = ['transfers', 'analyze'] as const;

/**
 * Default fleet concurrency for the read-only analyze rollup when `--parallel`
 * is absent. Analyze makes only a handful of cheap Organizations/Billing read
 * calls per account, so a read-friendly default (matching `bt fleet status`)
 * keeps the audit fast without overwhelming the APIs (Req 9.1).
 */
const DEFAULT_ANALYZE_PARALLEL = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the `--profile <name>` for remediation hints, if scope is a named profile. */
function profileOf(global: GlobalOptions): string | undefined {
  return global.scope.kind === 'profile' ? global.scope.profile : undefined;
}

/** Project a typed transfer-with-resources model into the friendly indicator view (Req 8.6). */
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
    // Read straight off the typed found-flags — no recomputation (Req 8.6, 22.2).
    present: {
      billingView: model.resourcesFound.billingView,
      billingGroup: model.resourcesFound.billingGroup,
      pricingPlan: model.resourcesFound.pricingPlan,
      curConfiguration: model.resourcesFound.curConfiguration,
    },
  };
}

/** Render a present/absent indicator as a colorized human cell (Req 8.6). */
function presenceCell(present: boolean): RenderableCell {
  return { value: present ? 'present' : 'absent', tone: present ? 'success' : 'failure' };
}

/** Describe the active Transfer_Type filter for human output (Req 8.5, 8.8). */
function describeTypeFilter(type?: TransferType): string {
  return type ?? 'direct, indirect';
}

// ---------------------------------------------------------------------------
// Human-readable views (Output_Formatter RenderableView)
// ---------------------------------------------------------------------------

/** Build the leading key/value context block shared by both views. */
function contextBlock(result: AnalyzeResult): RenderableBlock {
  const entries: Array<{ label: string; value: RenderableCell }> = [
    { label: 'Relationship state', value: result.relationshipState },
    { label: 'Type filter', value: describeTypeFilter(result.type) },
    { label: 'Validation', value: result.validate ? 'included' : 'not requested' },
  ];
  if (result.account) {
    entries.splice(1, 0, { label: 'Account filter', value: result.account });
  }
  return { kind: 'keyValue', entries };
}

/** Build the per-transfer table with the four present/absent indicators (Req 8.6). */
function transfersTable(result: AnalyzeResult): RenderableBlock {
  return {
    kind: 'table',
    title: `Transfers (${result.transfers.length})`,
    columns: [
      { header: '#', key: 'idx', align: 'right' },
      { header: 'Name', key: 'name' },
      { header: 'Type', key: 'type' },
      { header: 'Source Account', key: 'source' },
      { header: 'Billing View', key: 'billingView' },
      { header: 'Billing Group', key: 'billingGroup' },
      { header: 'Pricing Plan', key: 'pricingPlan' },
      { header: 'CUR Config', key: 'curConfiguration' },
    ],
    rows: result.transfers.map((t, index) => ({
      idx: index + 1,
      name: t.name,
      type: t.transferType,
      source: t.billSourceAccountId,
      billingView: presenceCell(t.present.billingView),
      billingGroup: presenceCell(t.present.billingGroup),
      pricingPlan: presenceCell(t.present.pricingPlan),
      curConfiguration: presenceCell(t.present.curConfiguration),
    })),
  };
}

/** Build the analysis-summary table: present and missing count per resource type (Req 8.9). */
function summaryTable(summary: AnalysisSummaryModel): RenderableBlock {
  const c = summary.resourceCounts;
  return {
    kind: 'table',
    title: 'Analysis summary (present / missing per resource)',
    columns: [
      { header: 'Resource', key: 'resource' },
      { header: 'Present', key: 'present', align: 'right' },
      { header: 'Missing', key: 'missing', align: 'right' },
    ],
    rows: [
      { resource: 'Billing View', present: c.withBillingViews, missing: c.missingBillingViews },
      { resource: 'Billing Group', present: c.withBillingGroups, missing: c.missingBillingGroups },
      { resource: 'Pricing Plan', present: c.withPricingPlans, missing: c.missingPricingPlans },
      { resource: 'CUR Configuration', present: c.withCURConfigurations, missing: c.missingCURConfigurations },
    ],
  };
}

/** Build the transfer-count key/value block (total / direct / indirect). */
function transferCountsBlock(summary: AnalysisSummaryModel): RenderableBlock {
  return {
    kind: 'keyValue',
    entries: [
      { label: 'Total transfers', value: summary.totalTransfers },
      { label: 'Direct transfers', value: summary.directTransferCount },
      { label: 'Indirect transfers', value: summary.indirectTransferCount },
    ],
  };
}

/** Build the consistency-validation blocks: missing and orphaned resources (Req 8.7). */
function validationBlocks(validation: ValidationResultModel): RenderableBlock[] {
  const issues = validation.issuesByType;
  return [
    { kind: 'heading', text: 'Consistency validation' },
    {
      kind: 'keyValue',
      entries: [
        {
          label: 'Status',
          value: validation.isValid
            ? { value: 'VALID', tone: 'success' }
            : { value: 'ISSUES FOUND', tone: 'failure' },
        },
        { label: 'Total issues', value: validation.totalIssues },
      ],
    },
    {
      kind: 'table',
      title: 'Missing resources',
      columns: [
        { header: 'Resource', key: 'resource' },
        { header: 'Count', key: 'count', align: 'right' },
      ],
      rows: [
        { resource: 'Billing Views (unexpected)', count: issues.missingBillingViews },
        { resource: 'Billing Groups (critical)', count: issues.missingBillingGroups },
        { resource: 'Pricing Plans', count: issues.missingPricingPlans },
        { resource: 'CUR Configurations', count: issues.missingCURConfigurations },
      ],
    },
    {
      kind: 'table',
      title: 'Orphaned resources',
      columns: [
        { header: 'Resource', key: 'resource' },
        { header: 'Count', key: 'count', align: 'right' },
      ],
      rows: [
        { resource: 'Billing Views', count: issues.orphanedBillingViews },
        { resource: 'Billing Groups', count: issues.orphanedBillingGroups },
      ],
    },
  ];
}

/** Assemble the full human view for a non-empty analysis (Req 8.6, 8.7, 8.9). */
function buildAnalysisView(result: AnalyzeResult): RenderableView {
  const blocks: RenderableBlock[] = [
    { kind: 'heading', text: 'Billing Transfer Analysis' },
    contextBlock(result),
    transfersTable(result),
    transferCountsBlock(result.summary),
    summaryTable(result.summary),
  ];
  if (result.validate && result.validation) {
    blocks.push(...validationBlocks(result.validation));
  }
  return { blocks };
}

/** Assemble the no-transfers view; the command still exits zero (Req 8.10). */
function buildNoTransfersView(result: AnalyzeResult): RenderableView {
  const filters: string[] = [`state ${result.relationshipState}`];
  if (result.account) {
    filters.push(`account ${result.account}`);
  }
  if (result.type) {
    filters.push(`type ${result.type}`);
  }
  return {
    blocks: [
      { kind: 'heading', text: 'Billing Transfer Analysis' },
      contextBlock(result),
      {
        kind: 'text',
        tone: 'warning',
        lines: [`No billing transfers found for ${filters.join(', ')}.`],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

/**
 * Report an Input_Validator rejection: write the invalid value and the complete
 * accepted-values list to stderr (and a single JSON error document under
 * `--json`), then return a non-zero exit. No AWS call has been made (Req 5.7, 8).
 */
function rejectInput(
  ctx: IoContext,
  global: GlobalOptions,
  option: string,
  value: string,
  accepted: string[],
): { result: AnalyzeFailure; exitCode: CliExitCode } {
  const message = `Invalid value '${value}' for --${option}.`;
  const remediation = `Accepted values: ${accepted.join(', ')}.`;
  // stderr only — never corrupt the stdout result stream (Req 5.7, 6.5, 7.3).
  ctx.stderr.writeLine(`Error: ${message}`);
  ctx.stderr.writeLine(`Hint: ${remediation}`);

  const failure: AnalyzeFailure = {
    kind: 'failure',
    reason: 'invalid-input',
    message,
    remediation,
    invalidInput: { option, value, accepted },
  };
  if (global.json) {
    // Exactly one JSON document on stdout, even on the failure path (Req 7.4).
    ctx.formatter.renderJson(failure, ctx);
  }
  return { result: failure, exitCode: CliExitCode.GeneralError };
}

/**
 * Report a failed AWS call: the Error_Reporter classifies it and writes the
 * message + remediation hint to stderr only (Req 6); under `--json` a single
 * structured error document is also written to stdout (Req 7.4).
 */
function reportAwsFailure(
  error: unknown,
  ctx: IoContext,
  global: GlobalOptions,
  hint: RemediationContext,
): { result: AnalyzeFailure; exitCode: CliExitCode } {
  const failureClass = ctx.reporter.report(error, ctx, hint);
  const failure: AnalyzeFailure = {
    kind: 'failure',
    reason: 'aws-failure',
    message: toError(error).message,
    remediation: ctx.reporter.remediation(failureClass, hint),
    failureClass,
  };
  if (global.json) {
    ctx.formatter.renderJson(failure, ctx);
  }
  return { result: failure, exitCode: CliExitCode.GeneralError };
}

// ---------------------------------------------------------------------------
// Fleet rollup (Req 9): build typed rows from each child's emitted AnalyzeResult
// ---------------------------------------------------------------------------

/**
 * Type guard: is the child's parsed stdout payload a successful single-account
 * {@link AnalyzeResult}? The Fleet_Runner hands back `data: unknown` (the parsed
 * JSON document), so we narrow on the discriminant before reading typed fields —
 * no text scraping, just a typed-shape check (Req 9.2, 22.2).
 */
function isAnalyzeResult(data: unknown): data is AnalyzeResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'analysis' &&
    typeof (data as { summary?: unknown }).summary === 'object' &&
    (data as { summary?: unknown }).summary !== null
  );
}

/**
 * Compute one account's orphaned-resource count from the child's typed
 * {@link ValidationResultModel} (Req 9.3): the sum of orphaned billing views and
 * orphaned billing groups. Returns {@link ORPHANED_NOT_COMPUTED} when validation
 * was not requested (Req 9.4) or could not be included by the child (Req 9.9).
 */
function orphanedFromChild(child: AnalyzeResult): OrphanedCount {
  if (!child.validate || !child.validation) {
    return ORPHANED_NOT_COMPUTED;
  }
  const issues = child.validation.issuesByType;
  return issues.orphanedBillingViews + issues.orphanedBillingGroups;
}

/**
 * Build one rollup row from a Fleet_Runner per-account outcome (Req 9.2, 9.6).
 *
 * A child that failed to spawn/exit/emit, or whose payload is not a recognizable
 * {@link AnalyzeResult}, becomes a `failed` row carrying only a failure detail —
 * no counts — so the failure indicator is observably distinct from a zero count
 * and from a successful row (Req 9.6).
 */
function toRollupRow(account: AccountResult): AnalyzeRollupRow {
  if (account.status === 'failed' || !isAnalyzeResult(account.data)) {
    return {
      profile: account.profile,
      status: 'failed',
      failureDetail:
        account.failureDetail ?? 'analysis did not emit a recognizable result document',
    };
  }

  const child = account.data;
  const counts = child.summary.resourceCounts;
  return {
    profile: account.profile,
    status: 'ok',
    total: child.summary.totalTransfers,
    direct: child.summary.directTransferCount,
    indirect: child.summary.indirectTransferCount,
    withBillingGroups: counts.withBillingGroups,
    missingBillingGroups: counts.missingBillingGroups,
    missingCurConfigurations: counts.missingCURConfigurations,
    orphaned: orphanedFromChild(child),
  };
}

/**
 * Aggregate fleet-wide totals over successfully analyzed accounts only (Req 9.5).
 *
 * The orphaned total is the sum of the numeric per-account orphaned counts; it
 * stays {@link ORPHANED_NOT_COMPUTED} unless `--validate` was requested, and
 * only the rows that actually computed a numeric orphaned count contribute
 * (degraded accounts contribute nothing rather than failing the run — Req 9.9).
 */
function aggregateTotals(rows: AnalyzeRollupRow[], validate: boolean): AnalyzeFleetTotals {
  let transfers = 0;
  let missingBillingGroups = 0;
  let missingCurConfigurations = 0;
  let orphaned = 0;

  for (const row of rows) {
    if (row.status !== 'ok') {
      continue; // successful accounts only (Req 9.5)
    }
    transfers += row.total ?? 0;
    missingBillingGroups += row.missingBillingGroups ?? 0;
    missingCurConfigurations += row.missingCurConfigurations ?? 0;
    if (typeof row.orphaned === 'number') {
      orphaned += row.orphaned;
    }
  }

  return {
    transfers,
    missingBillingGroups,
    missingCurConfigurations,
    // Distinct from a numeric zero when validation was not requested (Req 9.4).
    orphaned: validate ? orphaned : ORPHANED_NOT_COMPUTED,
  };
}

/** Render an orphaned-count cell so the not-computed sentinel is visually distinct (Req 9.4). */
function orphanedCell(value: OrphanedCount): RenderableCell {
  return value === ORPHANED_NOT_COMPUTED ? { value: '-', tone: 'muted' } : value;
}

/** Build the human-readable per-account rollup table (Req 9.2, 9.4, 9.6). */
function rollupTable(rollup: AnalyzeRollupResult): RenderableBlock {
  const rows = rollup.rows.map((row) => {
    if (row.status === 'failed') {
      // A failed row shows ERR rather than any number, so it is never confused
      // with a zero count (Req 9.6).
      const err = (): RenderableCell => ({ value: 'ERR', tone: 'failure' });
      return {
        profile: row.profile,
        total: err(),
        direct: err(),
        indirect: err(),
        withBillingGroups: err(),
        missingBillingGroups: err(),
        missingCurConfigurations: err(),
        orphaned: err(),
      };
    }
    return {
      profile: row.profile,
      total: row.total,
      direct: row.direct,
      indirect: row.indirect,
      withBillingGroups: row.withBillingGroups,
      missingBillingGroups:
        (row.missingBillingGroups ?? 0) > 0
          ? { value: row.missingBillingGroups, tone: 'warning' as Tone }
          : row.missingBillingGroups,
      missingCurConfigurations:
        (row.missingCurConfigurations ?? 0) > 0
          ? { value: row.missingCurConfigurations, tone: 'warning' as Tone }
          : row.missingCurConfigurations,
      orphaned: orphanedCell(row.orphaned ?? ORPHANED_NOT_COMPUTED),
    };
  });

  return {
    kind: 'table',
    columns: [
      { header: 'PROFILE', key: 'profile' },
      { header: 'TOTAL', key: 'total', align: 'right' },
      { header: 'DIRECT', key: 'direct', align: 'right' },
      { header: 'INDIRECT', key: 'indirect', align: 'right' },
      { header: 'W/BG', key: 'withBillingGroups', align: 'right' },
      { header: 'MISS_BG', key: 'missingBillingGroups', align: 'right' },
      { header: 'MISS_CUR', key: 'missingCurConfigurations', align: 'right' },
      { header: 'ORPHAN', key: 'orphaned', align: 'right' },
    ],
    rows,
    emptyText: 'No profiles to analyze.',
  };
}

/** Build the full human-readable rollup view (Req 9.2–9.6, 9.9). */
function buildRollupView(rollup: AnalyzeRollupResult): RenderableView {
  const blocks: RenderableBlock[] = [
    { kind: 'heading', text: `Fleet billing-transfer analysis (${rollup.rows.length} profiles)` },
    {
      kind: 'keyValue',
      entries: [
        { label: 'Relationship state', value: rollup.relationshipState },
        { label: 'Type filter', value: describeTypeFilter(rollup.type) },
        ...(rollup.account ? [{ label: 'Account filter', value: rollup.account as RenderableCell }] : []),
        { label: 'Validation', value: rollup.validate ? 'included' : 'not requested' },
      ],
    },
    rollupTable(rollup),
  ];

  // Fleet-wide totals over successfully analyzed accounts only (Req 9.5).
  blocks.push({
    kind: 'keyValue',
    entries: [
      { label: 'Accounts analyzed OK', value: { value: rollup.succeeded, tone: 'success' } },
      {
        label: 'Accounts failed',
        value: { value: rollup.failed, tone: rollup.failed > 0 ? 'failure' : 'muted' },
      },
      { label: 'Total transfers (fleet)', value: rollup.totals.transfers },
      {
        label: 'Missing billing groups (critical)',
        value: {
          value: rollup.totals.missingBillingGroups,
          tone: rollup.totals.missingBillingGroups > 0 ? 'warning' : 'muted',
        },
      },
      {
        label: 'Missing CUR configs (warning)',
        value: {
          value: rollup.totals.missingCurConfigurations,
          tone: rollup.totals.missingCurConfigurations > 0 ? 'warning' : 'muted',
        },
      },
      { label: 'Orphaned resources', value: orphanedCell(rollup.totals.orphaned) },
    ],
  });

  // Degrade-don't-fail notice when validation was requested but unavailable for
  // one or more accounts (Req 9.9).
  if (rollup.validationDegraded) {
    blocks.push({
      kind: 'text',
      tone: 'warning',
      lines: [
        'Validation data was unavailable for one or more accounts; their ORPHAN column shows',
        '"-" (not computed) and the run continued without failing.',
      ],
    });
  }

  // Tip mirroring the legacy rollup: orphan/accurate counts need --validate.
  if (!rollup.validate) {
    blocks.push({
      kind: 'text',
      tone: 'muted',
      lines: ['Tip: ORPHAN counts require --validate.'],
    });
  }

  return { blocks };
}

/** Resolve the bounded fleet concurrency from `--parallel` (Req 9.1). */
function resolveParallel(parallel: number | undefined): number {
  return typeof parallel === 'number' && parallel >= 1
    ? Math.floor(parallel)
    : DEFAULT_ANALYZE_PARALLEL;
}

/** Forward the validated single-account filters to each child verbatim (Req 9.1). */
function passthroughArgs(analyzed: AnalyzedOptions): string[] {
  const args: string[] = ['--state', analyzed.relationshipState];
  if (analyzed.account) {
    args.push('--account', analyzed.account);
  }
  if (analyzed.type) {
    args.push('--type', analyzed.type);
  }
  if (analyzed.validate) {
    args.push('--validate');
  }
  return args;
}

/** Per-account stderr log directory for a fleet analyze run (local-only, read op). */
function fleetLogDir(ctx: IoContext): string {
  const configured = ctx.env.ANALYZE_LOG_DIR;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    // nosemgrep: path-join-resolve-traversal -- os.tmpdir-based local log dir with a timestamp; no external input.
    : path.join(os.tmpdir(), 'bt-analyze-logs', String(ctx.now()));
}

/**
 * Emit a structured error (stdout JSON or stderr text) for a profile-list
 * failure and return a non-zero exit. Mirrors the other fleet commands so a
 * missing/empty/unreadable list halts before any child is spawned (Req 4.7–4.9).
 */
function emitProfileListError(
  error: ProfileListError,
  ctx: IoContext,
  global: GlobalOptions,
): { result: AnalyzeFailure; exitCode: CliExitCode } {
  ctx.stderr.writeLine(`Error: ${error.message}`);
  ctx.stderr.writeLine(`Hint: ${error.remediation}`);
  const failure: AnalyzeFailure = {
    kind: 'failure',
    reason: 'invalid-input',
    message: error.message,
    remediation: error.remediation,
  };
  if (global.json) {
    ctx.formatter.renderJson(failure, ctx);
  }
  return { result: failure, exitCode: CliExitCode.GeneralError };
}

/**
 * Fleet path (`--all-profiles`): resolve the profile list, re-invoke this same
 * single-account command per profile through the Fleet_Runner (bounded
 * `--parallel`, continue-on-failure — Req 9.1, 9.6), then build the rollup from
 * the typed {@link AnalyzeResult} each child emitted (Req 9.2–9.5). The run never
 * forwards `--execute`: analyze is read-only.
 */
async function runFleet(
  analyzed: AnalyzedOptions,
  ctx: IoContext,
  global: GlobalOptions,
): Promise<{ result: AnalyzeCommandResult; exitCode: CliExitCode }> {
  // Resolve the ordered profile list; a missing/empty/unreadable list halts the
  // fleet run before any account is processed (Req 4.7, 4.8, 4.9).
  let profiles: string[];
  try {
    profiles = profileLoader.load(global, ctx);
  } catch (error) {
    if (error instanceof ProfileListError) {
      return emitProfileListError(error, ctx, global);
    }
    return reportAwsFailure(error, ctx, global, { operation: 'profile-loader' });
  }

  // Re-invoke the single-account command per profile via the child-process pool,
  // forwarding the validated filters. Continue-on-failure and the fleet exit
  // code are handled by the Fleet_Runner (Req 9.1, 9.6, 9.7, 9.8).
  const fleetResult: FleetResult = await ctx.fleet.run(
    {
      command: [...FLEET_COMMAND],
      passthroughArgs: passthroughArgs(analyzed),
      profiles,
      parallel: resolveParallel(global.parallel),
      execute: false, // read-only: never forward --execute
      logDir: fleetLogDir(ctx),
    },
    ctx,
  );

  // Build per-account rows from each child's typed payload (Req 9.2, 9.6).
  const rows = fleetResult.accounts.map(toRollupRow);
  const totals = aggregateTotals(rows, analyzed.validate);

  // Degrade-don't-fail (Req 9.9): --validate requested but a successfully
  // analyzed account could not include validation data.
  const validationDegraded =
    analyzed.validate &&
    rows.some((row) => row.status === 'ok' && row.orphaned === ORPHANED_NOT_COMPUTED);

  const result: AnalyzeRollupResult = {
    kind: 'fleet-rollup',
    relationshipState: analyzed.relationshipState,
    account: analyzed.account,
    type: analyzed.type,
    validate: analyzed.validate,
    validationDegraded,
    rows,
    totals,
    succeeded: fleetResult.succeeded,
    failed: fleetResult.failed,
  };

  ctx.formatter.emit(result, buildRollupView(result), global, ctx);

  // Non-zero exactly when at least one account failed (Req 9.7); zero when every
  // account analyzed successfully (Req 9.8). The Fleet_Runner already encodes
  // this in its exit code.
  return { result, exitCode: fleetResult.exitCode };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The `bt transfers analyze` command handler.
 *
 * Pure and injectable: it touches the outside world only through the supplied
 * {@link IoContext}, so it can be unit-tested by direct call with mocked AWS
 * clients and in-memory sinks, and re-invoked per profile by the Fleet_Runner
 * for the `--all-profiles` rollup (task 10.2).
 */
export const analyzeHandler: CommandHandler<AnalyzeOptions, AnalyzeCommandResult> = async (
  options,
  ctx,
) => {
  const { global } = options;

  // 1. Validate every option before any AWS call or child spawn (Req 5, 8). On
  //    rejection the Error path reports the accepted values and exits non-zero
  //    with no AWS call — this runs identically for single-account and fleet so
  //    a malformed fleet invocation never spawns a child.
  let relationshipState: RelationshipState = 'ACCEPTED'; // default (Req 8.2)
  if (options.state !== undefined) {
    const checked = inputValidator.relationshipState(options.state); // case-sensitive (Req 8.3, 5.3)
    if (!checked.ok) {
      return rejectInput(ctx, global, 'state', checked.invalidValue, checked.accepted);
    }
    relationshipState = checked.value;
  }

  let account: string | undefined;
  if (options.account !== undefined) {
    const checked = inputValidator.accountId(options.account); // 12 digits (Req 8.4, 5.1)
    if (!checked.ok) {
      return rejectInput(ctx, global, 'account', checked.invalidValue, checked.accepted);
    }
    account = checked.value;
  }

  let type: TransferType | undefined;
  if (options.type !== undefined) {
    const checked = inputValidator.transferType(options.type); // 'direct' | 'indirect' (Req 8.5, 5.4)
    if (!checked.ok) {
      return rejectInput(ctx, global, 'type', checked.invalidValue, checked.accepted);
    }
    type = checked.value;
  }

  const validate = options.validate === true;
  const analyzed: AnalyzedOptions = { relationshipState, account, type, validate };

  // 2. Fleet scope (--all-profiles): re-invoke this same single-account command
  //    once per profile through the Fleet_Runner and aggregate the typed JSON
  //    each child emits (Req 9). Otherwise run the single account in-process.
  if (global.scope.kind === 'all-profiles') {
    return runFleet(analyzed, ctx, global);
  }

  const profile = profileOf(global);
  return runSingleAccount(analyzed, ctx, global, profile);
};

/** The validated, canonical analyze options shared by the single and fleet paths. */
interface AnalyzedOptions {
  relationshipState: RelationshipState;
  account?: string;
  type?: TransferType;
  validate: boolean;
}

/**
 * Single-account path (profile or ambient scope). Analyzes one account through
 * the Shared_Services and renders the full per-transfer view; this is also the
 * exact path each fleet child runs, so the fleet rollup cannot diverge from a
 * single-account run (Req 8, 9.1).
 */
async function runSingleAccount(
  analyzed: AnalyzedOptions,
  ctx: IoContext,
  global: GlobalOptions,
  profile: string | undefined,
): Promise<{ result: AnalyzeCommandResult; exitCode: CliExitCode }> {
  const { relationshipState, account, type, validate } = analyzed;

  // Analyze through the Shared_Services (Req 8.1, 22.2). When --account is set we
  //  use the account-scoped entry point, which also scopes validation to that
  //  account's transfers; otherwise we analyze the full fleet account.
  //  `includeValidation` bundles the ValidationResultModel when --validate is
  //  set, so we reuse one discovery pass rather than calling
  //  validateTransferResources separately.
  let analysis: AnalysisResult;
  try {
    analysis = account
      ? await analyzeAccountTransfers(account, { relationshipState, includeValidation: validate })
      : await analyzeTransfers({ relationshipState, includeValidation: validate });
  } catch (error) {
    return reportAwsFailure(error, ctx, global, { profile, operation: 'transfers analyze' });
  }

  // Apply the --type filter to the analyzed set; absent → both types
  //  (Req 8.5, 8.8). filterByTransferType recomputes the typed counts, so the
  //  summary stays consistent with the displayed transfers.
  const summary = type ? filterByTransferType(analysis.summary, type) : analysis.summary;
  const validation = analysis.validation;

  // Build the friendly per-transfer indicator views (Req 8.6) and detect the
  //  no-transfers case (Req 8.10).
  const transfers = summary.transfers.map(toTransferView);
  const noTransfersFound = summary.totalTransfers === 0;

  const result: AnalyzeResult = {
    kind: 'analysis',
    relationshipState,
    account,
    type,
    validate,
    noTransfersFound,
    summary,
    validation,
    transfers,
  };

  // Render: the no-transfers message or the full analysis. Both are success
  //  (exit 0) — finding nothing is not an error (Req 8.10).
  const view = noTransfersFound ? buildNoTransfersView(result) : buildAnalysisView(result);
  ctx.formatter.emit(result, view, global, ctx);

  return { result, exitCode: CliExitCode.Success };
}

export default analyzeHandler;
