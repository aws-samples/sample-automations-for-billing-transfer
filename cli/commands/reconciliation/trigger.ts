// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt reconciliation trigger` — submit the reconciliation Lambdas on demand so
 * an operator can force a reconciliation pass without waiting for the daily
 * schedule (Requirements 10, 11).
 *
 * The command submits **asynchronous** Lambda invocations (`InvocationType:
 * Event`): each `send` returns as soon as Lambda accepts the request (HTTP 202)
 * and the reconciliation work then runs in the background — the CLI never waits
 * for the reconciliation itself to complete (Req 10.1, 10.2, 10.3). The two
 * function names come from the Resource_Registry (Req 10.7), and every invoke is
 * wrapped with the Shared_Utilities retry-with-backoff helper (Req 24.2).
 *
 * Scope is uniform with the rest of the CLI:
 *  - `--profile <name>` / ambient credentials → a single account invoked
 *    in-process through {@link IoContext.clients} (Req 3.2, 3.3).
 *  - `--all-profiles` → the fleet, routed through the {@link FleetRunner}
 *    child-process pool. Fleet reconciliation is a Mutating_Operation and is
 *    therefore **dry-run by default**; it submits nothing and exits zero unless
 *    `--execute` is supplied (Req 11.2, 20.1).
 *
 * Target selection (`--target bg|cur|both`, default `both`) is validated up
 * front by the Input_Validator before any AWS call (Req 5.5). For `both` the
 * billing-group invocation is submitted before the CUR invocation (Req 10.3);
 * because CUR reconciliation depends on the billing groups existing, the order
 * is preserved, while both submits are still attempted so a partial failure can
 * be reported accurately (Req 10.4, 10.5, 10.6). Any submit failure yields a
 * non-zero exit code (Req 10.4, 10.5, 11.7).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 11.1, 11.2, 11.3,
 * 11.4, 11.6, 11.7, 20.1, 24.2
 *
 * @module commands/reconciliation/trigger
 */

import * as os from 'os';
import * as path from 'path';

import { InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';

import { CliExitCode } from '../../lib/exit-codes.js';
import type { CommandHandler, GlobalOptions, IoContext, RenderableView } from '../../lib/io-context.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import { inputValidator, type ReconciliationTarget } from '../../lib/input-validator.js';
import { sendWithRetry } from '../../lib/aws-clients.js';
import { profileLoader, ProfileListError } from '../../lib/profile-loader.js';
import { toError } from '../../../lib/lambda/common/utils/errors.js';

/**
 * Parsed options accepted by the reconciliation-trigger handler. The resolved
 * {@link GlobalOptions} (scope, `--execute`, `--parallel`, `--json`, …) arrive
 * under `global` per the {@link CommandHandler} contract.
 */
export interface TriggerReconciliationOptions {
  /** Raw `--target` value (`bg` | `cur` | `both`); defaults to `both` when omitted (Req 10.3, 11.1). */
  target?: string;
}

/** Which reconciliation function a single invocation targeted. */
export type ReconciliationFunction = 'bg' | 'cur';

/**
 * Outcome of submitting one asynchronous reconciliation invocation.
 *
 * `accepted` is true when Lambda returned a 2xx status for the async request
 * (HTTP 202); `failureDetail` carries the cause otherwise (Req 10.6).
 */
export interface ReconciliationInvocation {
  /** Reconciliation function selector. */
  func: ReconciliationFunction;
  /** Resolved Lambda function name from the Resource_Registry (Req 10.7). */
  functionName: string;
  /** Whether the asynchronous invocation request was accepted (Req 10.6). */
  accepted: boolean;
  /** HTTP status code returned by the invoke API, when available (202 = accepted). */
  statusCode?: number;
  /** Cause of the submit failure when `accepted` is false. */
  failureDetail?: string;
}

/** Single-account trigger result (profile or ambient scope). */
export interface SingleAccountTriggerResult {
  kind: 'single-account';
  /** The validated Reconciliation_Target. */
  target: ReconciliationTarget;
  /** Per-function submit outcomes, in submission order (bg before cur for `both`). */
  invocations: ReconciliationInvocation[];
  /** Count of invocations accepted. */
  submitted: number;
  /** Count of invocations that failed to submit. */
  failedToSubmit: number;
}

/** Fleet dry-run result: the per-account plan, with nothing submitted (Req 11.2). */
export interface FleetDryRunTriggerResult {
  kind: 'fleet-dry-run';
  /** The validated Reconciliation_Target. */
  target: ReconciliationTarget;
  /** Functions that would be invoked per account. */
  plannedFunctions: ReconciliationFunction[];
  /** Ordered accounts that would be submitted. */
  accounts: Array<{ profile: string; plannedFunctions: ReconciliationFunction[] }>;
}

/** Fleet execute result: per-account submit status and the aggregated rollup (Req 11.3, 11.7). */
export interface FleetExecuteTriggerResult {
  kind: 'fleet-execute';
  /** The validated Reconciliation_Target. */
  target: ReconciliationTarget;
  /** Per-account submit outcomes in profile-list order. */
  accounts: Array<{ profile: string; status: 'ok' | 'failed'; failureDetail?: string }>;
  /** Count of accounts whose submit succeeded. */
  succeeded: number;
  /** Count of accounts whose submit failed. */
  failed: number;
}

/** Error result emitted on validation failure or an unresolved profile list. */
export interface TriggerErrorResult {
  kind: 'error';
  /** The validated target, when validation succeeded before the failure. */
  target?: ReconciliationTarget;
  /** Structured error for the `--json` consumer. */
  error: { message: string; remediation?: string };
}

/** Discriminated union of every shape the handler can return. */
export type TriggerReconciliationResult =
  | SingleAccountTriggerResult
  | FleetDryRunTriggerResult
  | FleetExecuteTriggerResult
  | TriggerErrorResult;

/** The single-account command path re-invoked per profile by the Fleet_Runner. */
const FLEET_COMMAND = ['reconciliation', 'trigger'] as const;

/** Fleet concurrency when `--parallel` is absent: sequential, one account at a time (Req 11.5). */
const SEQUENTIAL_PARALLELISM = 1;

/**
 * Async invocation payload, mirroring the scheduled event the reconciliation
 * Lambdas already handle (preserved from `trigger-reconciliation.sh`). The
 * Event invocation discards any response body, so the payload only needs to be
 * a shape the handlers recognize.
 */
const RECONCILIATION_PAYLOAD = new TextEncoder().encode(
  JSON.stringify({ source: 'scheduler', action: 'reconcile-all' }),
);

/** Map a Reconciliation_Target to the ordered functions it selects (bg before cur). */
function selectFunctions(target: ReconciliationTarget): ReconciliationFunction[] {
  switch (target) {
    case 'bg':
      return ['bg'];
    case 'cur':
      return ['cur'];
    case 'both':
      return ['bg', 'cur'];
  }
}

/** Resolve a reconciliation function's Lambda name from the Resource_Registry (Req 10.7). */
function resolveFunctionName(func: ReconciliationFunction): string {
  return func === 'bg'
    ? ResourceRegistry.functions.billingGroupReconciliation
    : ResourceRegistry.functions.curReconciliation;
}

/** Human label for a reconciliation function. */
function functionLabel(func: ReconciliationFunction): string {
  return func === 'bg' ? 'billing-group' : 'cur';
}

/**
 * Submit one asynchronous reconciliation invocation and resolve a typed
 * {@link ReconciliationInvocation}. Never rejects: a thrown error or a non-2xx
 * status is captured as `accepted: false` so the caller can attempt the other
 * function and report a partial failure (Req 10.4, 10.5).
 */
async function submitInvocation(
  func: ReconciliationFunction,
  ctx: IoContext,
  profile: string | undefined,
): Promise<ReconciliationInvocation> {
  const functionName = resolveFunctionName(func);
  const command = new InvokeCommand({
    FunctionName: functionName,
    // Asynchronous (fire-and-forget): returns HTTP 202 on acceptance and does
    // not wait for the reconciliation to complete (Req 10.1, 10.2, 10.3).
    InvocationType: InvocationType.Event,
    Payload: RECONCILIATION_PAYLOAD,
  });

  try {
    // Wrap the direct SDK call with the shared retry-with-backoff helper (Req 24.2).
    const response = await sendWithRetry(ctx.clients.lambda(), command, {
      operation: 'lambda:Invoke',
      functionName,
      target: func,
      ...(profile ? { profile } : {}),
    });
    const statusCode = response.StatusCode;
    const accepted = statusCode !== undefined && statusCode >= 200 && statusCode < 300;
    if (accepted) {
      return { func, functionName, accepted: true, statusCode };
    }
    const failureDetail = `Lambda returned an unexpected status code ${statusCode ?? 'unknown'} for an async invocation.`;
    ctx.stderr.writeLine(`Error: ${functionLabel(func)} reconciliation was not submitted: ${failureDetail}`);
    return { func, functionName, accepted: false, statusCode, failureDetail };
  } catch (error) {
    // Report the failure to stderr only (Req 6.5) and capture the cause so the
    // Output_Formatter can still report the accepted invocation (Req 10.5).
    ctx.reporter.report(error, ctx, { operation: `lambda:Invoke ${functionName}`, profile });
    return { func, functionName, accepted: false, failureDetail: toError(error).message };
  }
}

/** Emit a structured error (stdout JSON or stderr text via the formatter) and return a code. */
function emitError(
  message: string,
  remediation: string | undefined,
  ctx: IoContext,
  global: GlobalOptions,
  target?: ReconciliationTarget,
): { result: TriggerErrorResult; exitCode: CliExitCode } {
  const result: TriggerErrorResult = { kind: 'error', target, error: { message, remediation } };
  const view: RenderableView = {
    blocks: [
      { kind: 'text', tone: 'failure', lines: [`Error: ${message}`] },
      ...(remediation ? [{ kind: 'text' as const, tone: 'info' as const, lines: [`Hint: ${remediation}`] }] : []),
    ],
  };
  // In JSON mode the formatter writes exactly one error document to stdout; in
  // human mode the message is rendered to stdout while diagnostics already went
  // to stderr (Req 6.5, 7.4).
  ctx.formatter.emit(result, view, global, ctx);
  return { result, exitCode: CliExitCode.GeneralError };
}

/**
 * Reconciliation-trigger command handler. Pure and injectable: it touches the
 * outside world only through the supplied {@link IoContext}, so it can be unit-
 * tested by direct call with mocked Lambda clients and an in-memory output sink
 * (Req 22.3, 22.4).
 */
export const triggerReconciliation: CommandHandler<TriggerReconciliationOptions, TriggerReconciliationResult> = async (
  options,
  ctx,
) => {
  const { global } = options;

  // 1. Validate the Reconciliation_Target before any AWS call (Req 5.5, 5.7).
  const rawTarget = options.target ?? 'both';
  const targetResult = inputValidator.reconciliationTarget(rawTarget);
  if (!targetResult.ok) {
    return emitError(
      `Invalid --target value '${targetResult.invalidValue}'.`,
      `Accepted values: ${targetResult.accepted.join(', ')}.`,
      ctx,
      global,
    );
  }
  const target = targetResult.value;

  // 2. Fleet scope (--all-profiles): dry-run by default, --execute to submit.
  if (global.scope.kind === 'all-profiles') {
    return runFleet(target, ctx, global);
  }

  // 3. Single-account scope (profile or ambient). The client factory on the
  //    context is already bound to the resolved scope by the entrypoint.
  const profile = global.scope.kind === 'profile' ? global.scope.profile : undefined;
  return runSingleAccount(target, ctx, global, profile);
};

/** Single-account path: submit the selected functions in order and report per-function status. */
async function runSingleAccount(
  target: ReconciliationTarget,
  ctx: IoContext,
  global: GlobalOptions,
  profile: string | undefined,
): Promise<{ result: SingleAccountTriggerResult; exitCode: CliExitCode }> {
  const functions = selectFunctions(target);

  // Submit sequentially so bg is submitted before cur for `both` (Req 10.3),
  // while still attempting every function so a partial failure is reported.
  const invocations: ReconciliationInvocation[] = [];
  for (const func of functions) {
    invocations.push(await submitInvocation(func, ctx, profile));
  }

  const submitted = invocations.filter((inv) => inv.accepted).length;
  const failedToSubmit = invocations.length - submitted;

  const result: SingleAccountTriggerResult = {
    kind: 'single-account',
    target,
    invocations,
    submitted,
    failedToSubmit,
  };

  const view: RenderableView = {
    blocks: [
      { kind: 'heading', text: `Reconciliation trigger (async, target: ${target})` },
      {
        kind: 'table',
        columns: [
          { header: 'Function', key: 'func' },
          { header: 'Lambda', key: 'name' },
          { header: 'Async submit', key: 'status' },
        ],
        rows: invocations.map((inv) => ({
          func: functionLabel(inv.func),
          name: inv.functionName,
          status: {
            value: inv.accepted ? `accepted (HTTP ${inv.statusCode ?? 202})` : 'FAILED',
            tone: inv.accepted ? 'success' : 'failure',
          },
        })),
      },
      {
        kind: 'text',
        tone: failedToSubmit > 0 ? 'warning' : 'success',
        lines:
          failedToSubmit > 0
            ? [`${submitted} accepted, ${failedToSubmit} failed to submit. See diagnostics above for the failed function(s).`]
            : ['Submitted. Reconciliation runs in the background; check CloudWatch logs / the DLQ for results.'],
      },
    ],
  };

  ctx.formatter.emit(result, view, global, ctx);

  // Any failed submit is a non-zero exit; total/partial failure both map to
  // GeneralError for a single account (Req 10.4, 10.5).
  return {
    result,
    exitCode: failedToSubmit > 0 ? CliExitCode.GeneralError : CliExitCode.Success,
  };
}

/** Fleet path: dry-run by default; with --execute, route per profile through the Fleet_Runner. */
async function runFleet(
  target: ReconciliationTarget,
  ctx: IoContext,
  global: GlobalOptions,
): Promise<{ result: TriggerReconciliationResult; exitCode: CliExitCode }> {
  // Resolve the ordered profile list; a missing/empty/unreadable list halts the
  // fleet operation before any account is processed (Req 4.7, 4.8, 4.9).
  let profiles: string[];
  try {
    profiles = profileLoader.load(global, ctx);
  } catch (error) {
    if (error instanceof ProfileListError) {
      ctx.stderr.writeLine(`Error: ${error.message}`);
      ctx.stderr.writeLine(`Hint: ${error.remediation}`);
      return emitError(error.message, error.remediation, ctx, global, target);
    }
    ctx.reporter.report(error, ctx, { operation: 'profile-loader' });
    return emitError(toError(error).message, undefined, ctx, global, target);
  }

  const plannedFunctions = selectFunctions(target);

  // Dry-run (default): print the per-account plan, submit nothing, exit zero
  // (Req 11.2, 20.1).
  if (!global.execute) {
    ctx.stderr.writeLine('DRY-RUN. Re-run with --execute to submit the reconciliation invocations.');
    const result: FleetDryRunTriggerResult = {
      kind: 'fleet-dry-run',
      target,
      plannedFunctions,
      accounts: profiles.map((profile) => ({ profile, plannedFunctions })),
    };
    const view: RenderableView = {
      blocks: [
        { kind: 'heading', text: `Fleet reconciliation trigger — DRY-RUN (target: ${target})` },
        {
          kind: 'table',
          title: `${profiles.length} account(s) would be submitted (async)`,
          columns: [
            { header: 'Profile', key: 'profile' },
            { header: 'Would invoke', key: 'functions' },
          ],
          rows: result.accounts.map((account) => ({
            profile: account.profile,
            functions: account.plannedFunctions.map(functionLabel).join(', '),
          })),
        },
      ],
    };
    ctx.formatter.emit(result, view, global, ctx);
    return { result, exitCode: CliExitCode.Success };
  }

  // Execute: re-invoke the single-account command per profile via the
  // child-process pool. No --parallel ⇒ sequential, one account at a time
  // (Req 11.4, 11.5, 11.6).
  const parallel =
    typeof global.parallel === 'number' && global.parallel >= 1
      ? Math.floor(global.parallel)
      : SEQUENTIAL_PARALLELISM;
  // nosemgrep: path-join-resolve-traversal -- env-supplied or os.tmpdir-based local log dir; not external input.
  const logDir = (ctx.env.RECON_LOG_DIR as string | undefined) ?? path.join(os.tmpdir(), `bt-reconciliation-${ctx.now()}`);

  const fleetResult = await ctx.fleet.run<SingleAccountTriggerResult>(
    {
      command: [...FLEET_COMMAND],
      passthroughArgs: ['--target', target],
      profiles,
      parallel,
      execute: true,
      logDir,
    },
    ctx,
  );

  const accounts = fleetResult.accounts.map((account) => ({
    profile: account.profile,
    status: account.status,
    failureDetail: account.failureDetail,
  }));

  const result: FleetExecuteTriggerResult = {
    kind: 'fleet-execute',
    target,
    accounts,
    succeeded: fleetResult.succeeded,
    failed: fleetResult.failed,
  };

  const view: RenderableView = {
    blocks: [
      { kind: 'heading', text: `Fleet reconciliation trigger (async, target: ${target})` },
      {
        kind: 'table',
        columns: [
          { header: 'Profile', key: 'profile' },
          { header: 'Submit', key: 'status' },
          { header: 'Detail', key: 'detail' },
        ],
        rows: accounts.map((account) => ({
          profile: account.profile,
          status: {
            value: account.status === 'ok' ? 'submitted' : 'FAILED',
            tone: account.status === 'ok' ? 'success' : 'failure',
          },
          detail: account.failureDetail ?? '',
        })),
      },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Submitted', value: { value: result.succeeded, tone: 'success' } },
          { label: 'Failed', value: { value: result.failed, tone: result.failed > 0 ? 'failure' : 'muted' } },
        ],
      },
    ],
  };

  ctx.formatter.emit(result, view, global, ctx);

  // Any account failing to submit yields a non-zero fleet exit code; all
  // accepted yields zero (Req 11.6, 11.7, 20.4, 20.5).
  return { result, exitCode: fleetResult.exitCode };
}
