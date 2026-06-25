// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt reconciliation status` — report whether the most recent reconciliation
 * run(s) succeeded, so an operator has a concrete go/no-go before triggering a
 * dependent step (Requirement 12).
 *
 * Because `bt reconciliation trigger` submits the Lambdas asynchronously (it
 * confirms submission, not completion), this command inspects the *outcome*
 * after the fact. For each evaluated reconciliation function it reads, within a
 * lookback window:
 *
 *  - the CloudWatch Logs **completion** and **failure** markers — the single
 *    source of truth {@link RECON_MARKERS} that the Lambda handlers emit and
 *    this command reads, so emitter and reader cannot drift; and
 *  - the function's dead-letter-queue **visible-message depth** (async
 *    delivery/retries exhausted).
 *
 * Per-item error counts come from parsing the *typed* summary shapes embedded in
 * the completion log line — {@link ReconciliationSummary} for billing-group
 * reconciliation and {@link CURReconciliationSummary} (via the
 * `execCompleted` line) for CUR reconciliation — rather than scraping text with
 * `jq` (design "Reuse points": reconciliation status parsing).
 *
 * The four-way status truth table (Req 12.1–12.3) is implemented by the pure,
 * exported {@link deriveFunctionStatus}; the per-account rollup is the
 * least-healthy evaluated function status from the pure, exported
 * {@link leastHealthyStatus} (Req 12.8, 12.10). The command exits non-zero when
 * any checked function is not `DONE` (Req 12.11).
 *
 * Scope is uniform (Req 12.6–12.9): neither flag checks a single account using
 * the ambient credentials; `--profile <name>` checks that one account;
 * `--all-profiles` fans out across the Profile_Loader's profiles via the
 * Fleet_Runner. Conflicting `--profile` + `--all-profiles`, an invalid
 * `--target`, and an out-of-range `--lookback` are all rejected before any AWS
 * call (Req 12.5, 12.9). Direct CloudWatch Logs / SQS calls are wrapped with the
 * Shared_Utilities retry-with-backoff helper via {@link sendWithRetry}
 * (Req 24.2).
 *
 * Requirements: 12.1, 12.2, 12.3, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 24.2
 *
 * @module commands/reconciliation/status
 */

import * as os from 'os';
import * as path from 'path';

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  ResourceNotFoundException,
  type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  QueueDoesNotExist,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type { CommandHandler, GlobalOptions, IoContext } from '../../lib/io-context.js';
import type { RenderableBlock, RenderableView, Tone } from '../../lib/output-formatter.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import { sendWithRetry } from '../../lib/aws-clients.js';
import { inputValidator, type ReconciliationTarget } from '../../lib/input-validator.js';
import { profileLoader, ProfileListError } from '../../lib/profile-loader.js';
import { RECON_MARKERS } from '../../../lib/lambda/common/log-markers.js';
import { toError } from '../../../lib/lambda/common/utils/errors.js';
import type { ReconciliationSummary } from '../../../lib/lambda/billing-group-reconciliation/reconciliation-service.js';
import type { CURReconciliationSummary } from '../../../lib/lambda/cur-reconciliation/models/reconciliation.js';

// ---------------------------------------------------------------------------
// Status model (Req 12)
// ---------------------------------------------------------------------------

/**
 * Reconciliation status assigned to a single evaluated function (Req 12.1).
 *
 * - `DONE`: completion marker present, no failure marker, zero item errors, DLQ depth 0.
 * - `ATTENTION`: completion marker present, no failure marker, but item errors > 0 or DLQ depth > 0.
 * - `FAILED`: a failure marker is present (regardless of completion marker or DLQ depth).
 * - `PENDING`: neither a completion nor a failure marker present in the window.
 */
export type ReconStatus = 'DONE' | 'ATTENTION' | 'FAILED' | 'PENDING';

/** The two reconciliation functions this command can evaluate. */
export type ReconFunc = 'bg' | 'cur';

/** Per-evaluated-function status detail (design "New CLI-only types"). */
export interface ReconFunctionStatus {
  /** Which reconciliation function this row describes. */
  func: ReconFunc;
  /** The derived status (Req 12.1–12.3). */
  status: ReconStatus;
  /** Reported item-error count parsed from the completion summary (0 when unknown). */
  itemErrors: number;
  /** Dead-letter-queue visible-message depth. */
  dlqDepth: number;
  /** Human-readable one-line detail (counts / reason). */
  detail: string;
}

/**
 * The signals that drive the status truth table for one function, within the
 * lookback window. Kept as a plain record so {@link deriveFunctionStatus} is a
 * pure function over its inputs (property-testable in isolation, Req 12.1–12.3).
 */
export interface ReconStatusSignals {
  /** Whether a completion marker was found in the lookback window. */
  completionPresent: boolean;
  /** Whether a failure marker was found in the lookback window. */
  failurePresent: boolean;
  /** Reported per-item error count from the completion summary. */
  itemErrors: number;
  /** Dead-letter-queue visible-message depth. */
  dlqDepth: number;
}

/**
 * Derive a single evaluated function's status from its window signals, exactly
 * per the Req 12.1–12.3 truth table. Total by construction — every input maps to
 * exactly one {@link ReconStatus} — which is what the status-derivation property
 * (design Property 12) asserts:
 *
 *  1. a failure marker ⇒ `FAILED` (regardless of completion marker or DLQ);
 *  2. otherwise, no completion marker ⇒ `PENDING`;
 *  3. otherwise, item errors > 0 or DLQ depth > 0 ⇒ `ATTENTION`;
 *  4. otherwise ⇒ `DONE`.
 */
export function deriveFunctionStatus(signals: ReconStatusSignals): ReconStatus {
  if (signals.failurePresent) {
    return 'FAILED';
  }
  if (!signals.completionPresent) {
    return 'PENDING';
  }
  if (signals.itemErrors > 0 || signals.dlqDepth > 0) {
    return 'ATTENTION';
  }
  return 'DONE';
}

/**
 * Health ranking from least- to most-healthy: `FAILED` < `PENDING` <
 * `ATTENTION` < `DONE` (Req 12.10). Lower number == less healthy.
 */
export const STATUS_RANK: Readonly<Record<ReconStatus, number>> = {
  FAILED: 0,
  PENDING: 1,
  ATTENTION: 2,
  DONE: 3,
};

/**
 * The least-healthy member of a non-empty set of evaluated function statuses —
 * the account's rolled-up status (Req 12.8, 12.10; design Property 13). Defaults
 * to `PENDING` for an empty input so the function is total.
 */
export function leastHealthyStatus(statuses: readonly ReconStatus[]): ReconStatus {
  if (statuses.length === 0) {
    return 'PENDING';
  }
  return statuses.reduce((worst, s) => (STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst));
}

// ---------------------------------------------------------------------------
// Result shapes (single-account child payload + fleet rollup)
// ---------------------------------------------------------------------------

/**
 * Single-account result. This is exactly the JSON document a fleet child emits
 * (`bt reconciliation status --profile <p> --json`), so the parent can parse it
 * back into a typed payload.
 */
export interface SingleAccountStatusResult {
  scope: 'single';
  /** Named profile when `--profile`; omitted under ambient credentials. */
  profile?: string;
  /** Lookback window applied, in minutes. */
  lookbackMinutes: number;
  /** Reconciliation_Target evaluated. */
  target: ReconciliationTarget;
  /** Least-healthy evaluated function status (Req 12.8). */
  accountStatus: ReconStatus;
  /** Per-evaluated-function detail. */
  functions: ReconFunctionStatus[];
}

/** One account row in the fleet rollup. */
export interface FleetAccountStatusRow {
  profile: string;
  /** Whether the child completed cleanly (exit 0) or not (non-DONE / error). */
  status: 'ok' | 'failed';
  /** Rolled-up account status when the child emitted parseable data (clean accounts). */
  accountStatus?: ReconStatus;
  /** Per-function detail when available. */
  functions?: ReconFunctionStatus[];
  /** Cause / log pointer for a non-clean account (Req 20.4). */
  failureDetail?: string;
}

/**
 * Fleet (all-profiles) rollup.
 *
 * Note on granularity: a single-account check exits non-zero when any function
 * is not `DONE` (Req 12.11, design Property 13), and the Fleet_Runner only parses
 * a child's JSON on a zero exit. Consequently the parent has full per-function
 * detail for clean (`DONE`) accounts and groups every not-`DONE`/errored account
 * under `notDone`, listing each with its detail. The fine-grained
 * `ATTENTION`/`FAILED`/`PENDING` breakdown is always available from the
 * single-account view.
 */
export interface FleetStatusResult {
  scope: 'fleet';
  lookbackMinutes: number;
  target: ReconciliationTarget;
  accounts: FleetAccountStatusRow[];
  /** Count of accounts whose rolled-up status is `DONE`. */
  done: number;
  /** Count of accounts that were not cleanly `DONE` (not-DONE status or an error). */
  notDone: number;
  /** Total accounts checked. */
  total: number;
}

/** Failure result (validation, conflicting options, profile-list, or AWS error). */
export interface StatusErrorResult {
  scope: 'error';
  error: {
    /** Stable machine-readable failure kind. */
    kind: 'scope-conflict' | 'invalid-option' | 'profile-list' | 'aws';
    /** Human-readable message. */
    message: string;
    /** Accepted values, present for an invalid-option rejection (Req 5.7). */
    accepted?: string[];
  };
}

/** Union returned by the handler. */
export type ReconciliationStatusResult =
  | SingleAccountStatusResult
  | FleetStatusResult
  | StatusErrorResult;

/**
 * Command-specific options for `bt reconciliation status`.
 *
 * `target` and `lookback` are the raw, unvalidated CLI strings; the handler
 * validates them before any AWS call (Req 12.5). `profile` / `allProfiles` are
 * the raw scope selectors, consulted only to detect the conflicting-options case
 * (Req 12.9) that the already-resolved {@link GlobalOptions.scope} cannot
 * represent; routing itself uses `global.scope`.
 */
export interface ReconciliationStatusOptions {
  /** Raw `--target` value (`bg` | `cur` | `both`); defaults to `both` when absent (Req 12.1). */
  target?: string;
  /** Raw `--lookback` value in minutes; defaults to 120 when absent (Req 12.4). */
  lookback?: string;
  /** Raw `--profile` selector, for conflict detection only (Req 12.9). */
  profile?: string;
  /** Raw `--all-profiles` selector, for conflict detection only (Req 12.9). */
  allProfiles?: boolean;
}

/** Default lookback window when `--lookback` is not provided (Req 12.4). */
export const DEFAULT_LOOKBACK_MINUTES = 120;

// ---------------------------------------------------------------------------
// Per-function metadata (names from the Resource_Registry, markers from log-markers)
// ---------------------------------------------------------------------------

/** CloudWatch Logs group for a reconciliation function (mirrors `lambda_log_group`). */
function logGroupFor(func: ReconFunc): string {
  const fn =
    func === 'bg'
      ? ResourceRegistry.functions.billingGroupReconciliation
      : ResourceRegistry.functions.curReconciliation;
  return `/aws/lambda/${fn}`;
}

/** Dead-letter-queue name for a reconciliation function (Req 21.1). */
function dlqFor(func: ReconFunc): string {
  return func === 'bg'
    ? ResourceRegistry.dlqs.billingGroupReconciliation
    : ResourceRegistry.dlqs.curReconciliation;
}

// ---------------------------------------------------------------------------
// Parsing helpers (typed summary shapes — no jq / no text scraping)
// ---------------------------------------------------------------------------

/** Parse a CloudWatch log line (a Powertools JSON document) into an object. */
function parseLogMessage(message: string | undefined): Record<string, unknown> | undefined {
  if (!message) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(message);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A non-JSON line is treated as no parseable summary (best effort).
    return undefined;
  }
}

/** Coerce an unknown field to a non-negative integer count (0 when absent/invalid). */
function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Pick the latest (max-timestamp) event whose message contains `marker`. */
function latestMessage(events: FilteredLogEvent[], marker: string): string | undefined {
  let latest: FilteredLogEvent | undefined;
  for (const event of events) {
    if (event.message && event.message.includes(marker)) {
      if (!latest || (event.timestamp ?? 0) >= (latest.timestamp ?? 0)) {
        latest = event;
      }
    }
  }
  return latest?.message;
}

// ---------------------------------------------------------------------------
// AWS reads (each wrapped with the shared retry helper — Req 24.2)
// ---------------------------------------------------------------------------

/**
 * Fetch the events matching a marker within the lookback window. A missing log
 * group (the function has never run / been deployed) is treated as zero events
 * rather than an error, mirroring the legacy best-effort behavior.
 */
async function filterEvents(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  marker: string,
  startTime: number,
): Promise<FilteredLogEvent[]> {
  try {
    const output = await sendWithRetry(
      logs,
      // Quote the marker so the CloudWatch filter matches the exact phrase.
      new FilterLogEventsCommand({ logGroupName, startTime, filterPattern: `"${marker}"` }),
      { operation: 'logs:FilterLogEvents', logGroupName },
    );
    return output.events ?? [];
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return [];
    }
    throw err;
  }
}

/**
 * Read the dead-letter-queue visible-message depth. A queue that does not exist
 * (older deploys) is reported as depth 0 rather than an error (best effort).
 */
async function getDlqDepth(sqs: SQSClient, queueName: string): Promise<number> {
  try {
    const { QueueUrl } = await sendWithRetry(sqs, new GetQueueUrlCommand({ QueueName: queueName }), {
      operation: 'sqs:GetQueueUrl',
      queueName,
    });
    if (!QueueUrl) {
      return 0;
    }
    const { Attributes } = await sendWithRetry(
      sqs,
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [QueueAttributeName.ApproximateNumberOfMessages],
      }),
      { operation: 'sqs:GetQueueAttributes', queueName },
    );
    return toCount(Attributes?.[QueueAttributeName.ApproximateNumberOfMessages]);
  } catch (err) {
    if (err instanceof QueueDoesNotExist) {
      return 0;
    }
    throw err;
  }
}

/**
 * Evaluate one reconciliation function for the active account: read its
 * completion/failure markers and DLQ depth, parse the typed summary for item
 * errors, and derive the {@link ReconStatus} (Req 12.1–12.3, 24.2).
 */
async function checkFunction(
  func: ReconFunc,
  ctx: IoContext,
  startTime: number,
  lookbackMinutes: number,
): Promise<ReconFunctionStatus> {
  const logs = ctx.clients.cloudWatchLogs();
  const sqs = ctx.clients.sqs();
  const logGroupName = logGroupFor(func);
  const markers = RECON_MARKERS[func];

  // Completion markers, failure markers, and DLQ depth are independent reads.
  const [okEvents, failEvents, dlqDepth] = await Promise.all([
    filterEvents(logs, logGroupName, markers.ok, startTime),
    filterEvents(logs, logGroupName, markers.fail, startTime),
    getDlqDepth(sqs, dlqFor(func)),
  ]);

  const completionPresent = okEvents.length > 0;
  const failurePresent = failEvents.length > 0;

  // Item-error counts come from the typed summary embedded in the completion
  // line; only parsed when a completion marker exists (matches the legacy flow).
  let itemErrors = 0;
  let cleanDetail = `dlq=${dlqDepth}`;
  if (completionPresent) {
    if (func === 'bg') {
      const summary = parseLogMessage(latestMessage(okEvents, markers.ok))?.summary as
        | Partial<ReconciliationSummary>
        | undefined;
      const created = toCount(summary?.billingGroupsCreated);
      const existed = toCount(summary?.billingGroupsExisted);
      itemErrors = Array.isArray(summary?.errors) ? summary!.errors.length : 0;
      cleanDetail = `created=${created} existed=${existed} errors=${itemErrors} dlq=${dlqDepth}`;
    } else {
      // The CUR completion line carries no counts; the execution-completed line
      // does. Type the parsed fields against the CUR summary shape.
      const execMarker = RECON_MARKERS.cur.execCompleted;
      const execEvents = await filterEvents(logs, logGroupName, execMarker, startTime);
      const exec = parseLogMessage(latestMessage(execEvents, execMarker)) as
        | (Partial<Pick<CURReconciliationSummary, 'myViewReportsFailed' | 'showbackViewReportsFailed'>> & {
            failedTransfersCount?: number;
          })
        | undefined;
      const myViewFailed = toCount(exec?.myViewReportsFailed);
      const showbackFailed = toCount(exec?.showbackViewReportsFailed);
      const failedTransfers = toCount(exec?.failedTransfersCount);
      itemErrors = myViewFailed + showbackFailed + failedTransfers;
      cleanDetail = `failedReports=${myViewFailed + showbackFailed} failedTransfers=${failedTransfers} dlq=${dlqDepth}`;
    }
  }

  const status = deriveFunctionStatus({ completionPresent, failurePresent, itemErrors, dlqDepth });
  let detail: string;
  switch (status) {
    case 'FAILED':
      detail = `failureLogged=${failEvents.length} dlq=${dlqDepth}`;
      break;
    case 'PENDING':
      detail = `no completion in last ${lookbackMinutes}m dlq=${dlqDepth}`;
      break;
    default:
      detail = cleanDetail;
      break;
  }

  return { func, status, itemErrors, dlqDepth, detail };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Map a status to a human-output tone (color only; never affects JSON). */
function toneFor(status: ReconStatus): Tone {
  switch (status) {
    case 'DONE':
      return 'success';
    case 'ATTENTION':
    case 'PENDING':
      return 'warning';
    case 'FAILED':
      return 'failure';
  }
}

/** Build the human view for a single-account result. */
function buildSingleView(result: SingleAccountStatusResult): RenderableView {
  return {
    blocks: [
      {
        kind: 'heading',
        text: `Reconciliation status (target: ${result.target}, lookback: ${result.lookbackMinutes}m)`,
      },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Account', value: result.profile ?? '(ambient credentials)' },
          { label: 'Status', value: { value: result.accountStatus, tone: toneFor(result.accountStatus) } },
        ],
      },
      {
        kind: 'table',
        columns: [
          { header: 'FUNC', key: 'func' },
          { header: 'STATUS', key: 'status' },
          { header: 'ITEM ERRORS', key: 'itemErrors', align: 'right' },
          { header: 'DLQ', key: 'dlqDepth', align: 'right' },
          { header: 'DETAIL', key: 'detail' },
        ],
        rows: result.functions.map((fn) => ({
          func: fn.func,
          status: { value: fn.status, tone: toneFor(fn.status) },
          itemErrors: fn.itemErrors,
          dlqDepth: fn.dlqDepth,
          detail: fn.detail,
        })),
      },
    ],
  };
}

/** Build the human view for a fleet rollup. */
function buildFleetView(result: FleetStatusResult): RenderableView {
  const blocks: RenderableBlock[] = [
    {
      kind: 'heading',
      text: `Reconciliation status — fleet (target: ${result.target}, lookback: ${result.lookbackMinutes}m)`,
    },
    {
      kind: 'table',
      columns: [
        { header: 'ACCOUNT', key: 'profile' },
        { header: 'ACCOUNT STATUS', key: 'accountStatus' },
        { header: 'DETAIL', key: 'detail' },
      ],
      rows: result.accounts.map((account) => ({
        profile: account.profile,
        accountStatus: account.accountStatus
          ? { value: account.accountStatus, tone: toneFor(account.accountStatus) }
          : { value: 'NOT DONE', tone: 'failure' as Tone },
        detail: account.accountStatus
          ? (account.functions ?? []).map((fn) => `${fn.func}:${fn.status}`).join(' ')
          : account.failureDetail ?? '',
      })),
      emptyText: 'No accounts checked.',
    },
    {
      kind: 'keyValue',
      entries: [
        { label: 'DONE', value: { value: result.done, tone: 'success' } },
        { label: 'NOT DONE', value: { value: result.notDone, tone: result.notDone > 0 ? 'failure' : 'default' } },
        { label: 'Total', value: result.total },
      ],
    },
  ];
  return { blocks };
}

// ---------------------------------------------------------------------------
// Failure helpers (stderr for human; single JSON document for --json)
// ---------------------------------------------------------------------------

/**
 * Emit a non-AWS failure (validation / conflict / profile-list). Human mode
 * writes the message (and any accepted values) to stderr only (Req 6.5); JSON
 * mode writes exactly one structured error document to stdout (Req 7.4).
 */
function failWithMessage(
  ctx: IoContext,
  global: GlobalOptions,
  error: StatusErrorResult['error'],
): { result: StatusErrorResult; exitCode: CliExitCode } {
  const result: StatusErrorResult = { scope: 'error', error };
  if (global.json) {
    ctx.formatter.renderJson(result, ctx);
  } else {
    ctx.stderr.writeLine(`Error: ${error.message}`);
    if (error.accepted && error.accepted.length > 0) {
      ctx.stderr.writeLine(`Accepted values: ${error.accepted.join(', ')}`);
    }
  }
  return { result, exitCode: CliExitCode.GeneralError };
}

// ---------------------------------------------------------------------------
// Single-account and fleet execution paths
// ---------------------------------------------------------------------------

/** Functions selected by a Reconciliation_Target. */
function functionsFor(target: ReconciliationTarget): ReconFunc[] {
  return target === 'both' ? ['bg', 'cur'] : [target];
}

/** Run the single-account (profile / ambient) check (Req 12.6, 12.7). */
async function runSingle(
  ctx: IoContext,
  global: GlobalOptions,
  target: ReconciliationTarget,
  lookbackMinutes: number,
): Promise<{ result: ReconciliationStatusResult; exitCode: CliExitCode }> {
  const profile = global.scope.kind === 'profile' ? global.scope.profile : undefined;
  const startTime = ctx.now() - lookbackMinutes * 60_000;

  try {
    const functions = await Promise.all(
      functionsFor(target).map((func) => checkFunction(func, ctx, startTime, lookbackMinutes)),
    );
    const accountStatus = leastHealthyStatus(functions.map((fn) => fn.status));
    const allDone = functions.every((fn) => fn.status === 'DONE');

    const result: SingleAccountStatusResult = {
      scope: 'single',
      profile,
      lookbackMinutes,
      target,
      accountStatus,
      functions,
    };

    ctx.formatter.emit(result, buildSingleView(result), global, ctx);
    // Non-zero unless every evaluated function is DONE (Req 12.11, Property 13).
    return { result, exitCode: allDone ? CliExitCode.Success : CliExitCode.GeneralError };
  } catch (err) {
    // Operational/AWS failure: classify + report to stderr (Req 6); in JSON mode
    // also write a single structured error document to stdout (Req 7.4).
    ctx.reporter.report(err, ctx, { profile, operation: 'reconciliation status' });
    const result: StatusErrorResult = {
      scope: 'error',
      error: { kind: 'aws', message: toError(err).message },
    };
    if (global.json) {
      ctx.formatter.renderJson(result, ctx);
    }
    return { result, exitCode: CliExitCode.GeneralError };
  }
}

/** Run the all-profiles fleet check via the Fleet_Runner (Req 12.8). */
async function runFleet(
  ctx: IoContext,
  global: GlobalOptions,
  target: ReconciliationTarget,
  lookbackMinutes: number,
): Promise<{ result: ReconciliationStatusResult; exitCode: CliExitCode }> {
  let profiles: string[];
  try {
    profiles = profileLoader.load(global, ctx);
  } catch (err) {
    if (err instanceof ProfileListError) {
      ctx.stderr.writeLine(`Hint: ${err.remediation}`);
      return failWithMessage(ctx, global, { kind: 'profile-list', message: err.message });
    }
    throw err;
  }

  // nosemgrep: path-join-resolve-traversal -- os.tmpdir-based local log dir with a timestamp; no external input.
  const logDir = path.join(os.tmpdir(), `bt-reconciliation-status-${ctx.now()}`);
  const fleetResult = await ctx.fleet.run<SingleAccountStatusResult>(
    {
      command: ['reconciliation', 'status'],
      passthroughArgs: ['--target', target, '--lookback', String(lookbackMinutes)],
      profiles,
      parallel: global.parallel ?? 0,
      execute: false,
      logDir,
    },
    ctx,
  );

  const accounts: FleetAccountStatusRow[] = fleetResult.accounts.map((account) => ({
    profile: account.profile,
    status: account.status,
    accountStatus: account.status === 'ok' ? account.data?.accountStatus : undefined,
    functions: account.status === 'ok' ? account.data?.functions : undefined,
    failureDetail: account.failureDetail,
  }));

  // Clean accounts (child exit 0) carry a parsed DONE status; every other account
  // is grouped as not-DONE (see FleetStatusResult docs for the rationale).
  const done = accounts.filter((account) => account.accountStatus === 'DONE').length;
  const notDone = accounts.length - done;

  const result: FleetStatusResult = {
    scope: 'fleet',
    lookbackMinutes,
    target,
    accounts,
    done,
    notDone,
    total: accounts.length,
  };

  ctx.formatter.emit(result, buildFleetView(result), global, ctx);
  // Fleet exit code is non-zero iff any account was not cleanly DONE (Req 12.11).
  return { result, exitCode: fleetResult.exitCode };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * `bt reconciliation status` handler. A pure, injectable {@link CommandHandler}:
 * it touches the outside world only through the injected {@link IoContext}, so
 * it is unit-testable by direct call with mocked AWS clients, an in-memory
 * Fleet_Runner, and in-memory output sinks (Req 22.3, 22.4).
 *
 * Order of operations guarantees no AWS call on a rejected invocation
 * (Req 12.5, 12.9): conflicting scope → `--target` → `--lookback` are all
 * validated first, then the command routes by the resolved scope.
 */
export const reconciliationStatusHandler: CommandHandler<
  ReconciliationStatusOptions,
  ReconciliationStatusResult
> = async (options, ctx) => {
  const { global } = options;

  // 1. Conflicting scope selectors — rejected before any AWS call (Req 12.9).
  if (options.profile !== undefined && options.allProfiles === true) {
    return failWithMessage(ctx, global, {
      kind: 'scope-conflict',
      message: 'Options --profile and --all-profiles are mutually exclusive; choose one.',
    });
  }

  // 2. Reconciliation_Target — defaults to both when absent (Req 12.1); validated
  //    by the Input_Validator before any AWS call (Req 5.5).
  let target: ReconciliationTarget = 'both';
  if (options.target !== undefined) {
    const validated = inputValidator.reconciliationTarget(options.target);
    if (!validated.ok) {
      return failWithMessage(ctx, global, {
        kind: 'invalid-option',
        message: `Invalid --target value '${validated.invalidValue}'.`,
        accepted: validated.accepted,
      });
    }
    target = validated.value;
  }

  // 3. Lookback — defaults to 120 minutes (Req 12.4); validated to an integer in
  //    [1, 10080] before any AWS call (Req 12.5).
  let lookbackMinutes = DEFAULT_LOOKBACK_MINUTES;
  if (options.lookback !== undefined) {
    const validated = inputValidator.lookbackMinutes(options.lookback);
    if (!validated.ok) {
      return failWithMessage(ctx, global, {
        kind: 'invalid-option',
        message: `Invalid --lookback value '${validated.invalidValue}'.`,
        accepted: validated.accepted,
      });
    }
    lookbackMinutes = validated.value;
  }

  // 4. Route by resolved scope (uniform scope model, Req 12.6–12.8).
  if (global.scope.kind === 'all-profiles') {
    return runFleet(ctx, global, target, lookbackMinutes);
  }
  return runSingle(ctx, global, target, lookbackMinutes);
};

export default reconciliationStatusHandler;
