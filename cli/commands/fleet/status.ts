// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt fleet status` — report deployment health across a fleet of payer accounts
 * (Requirement 16). Ports the legacy `scripts/fleet-status.sh` to a pure,
 * injectable {@link CommandHandler}.
 *
 * The command is a Read_Operation: it never mutates AWS state, though it MAY
 * write local per-account logs while a fleet run executes (Req 16.4). For each
 * account it reports four facts (Req 16.1):
 *
 *  - the CloudFormation status of the pipeline stack (or `NONE` when that stack
 *    does not exist),
 *  - the latest CodePipeline execution status (or `-` when it cannot be read),
 *  - the count of tracked feature stacks that are deployed, and
 *  - the total count of tracked feature stacks, taken from the Resource_Registry
 *    (Req 16.2).
 *
 * From those it derives a per-account classification (Req 16.3):
 *
 *  - **no-pipeline** — the pipeline stack does not exist;
 *  - **fully-deployed** — the pipeline stack is present *and* every tracked
 *    feature stack is deployed (deployed count === total count); and
 *  - **partially-deployed** — the pipeline stack is present *and* fewer than all
 *    tracked feature stacks are deployed (deployed count < total count).
 *
 * The handler runs in two modes, branching on the resolved {@link Scope}:
 *
 *  - **single-account** (`--profile` or ambient): gather one account's health
 *    using the per-context {@link AwsClientFactory} clients and emit it. This is
 *    also the path each fleet child runs, so its `--json` output is the typed
 *    payload the parent aggregates.
 *  - **fleet** (`--all-profiles`): resolve the profile list, route through the
 *    {@link FleetRunner} (which re-invokes this same command once per profile
 *    with bounded `--parallel` concurrency, continuing on per-account failure —
 *    Req 16.5, 16.6), then aggregate the children's typed results into the
 *    fully/partially/no-pipeline rollup.
 *
 * All direct AWS SDK calls go through {@link sendWithRetry} so transient-failure
 * handling matches the rest of the codebase (Req 24.2). Diagnostics and errors
 * are written to stderr via the Error_Reporter; results are rendered by the
 * Output_Formatter (a single JSON document under `--json`).
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
 *
 * @module commands/fleet/status
 */

import * as os from 'os';
import * as path from 'path';

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CodePipelineClient,
  ListPipelineExecutionsCommand,
} from '@aws-sdk/client-codepipeline';

import type {
  CommandHandler,
  GlobalOptions,
  IoContext,
  RenderableView,
  Scope,
} from '../../lib/io-context.js';
import type { Tone } from '../../lib/output-formatter.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { ResourceRegistry, FEATURE_STACK_COUNT } from '../../lib/resource-registry.js';
import { sendWithRetry } from '../../lib/aws-clients.js';
import { profileLoader, ProfileListError } from '../../lib/profile-loader.js';
import type { AccountResult, FleetResult } from '../../lib/fleet-runner.js';
import { getErrorCode, getErrorMessage, toError } from '../../../lib/lambda/common/utils/errors.js';

/**
 * Default fleet concurrency when `--parallel` is not supplied. The legacy
 * `fleet-status.sh` used 8 because each account makes only a few cheap read
 * calls; that read-friendly default is preserved here (Req 16.6).
 */
const DEFAULT_FLEET_STATUS_PARALLEL = 8;

/** Sentinel reported for the pipeline stack when it does not exist (Req 16.3). */
const PIPELINE_STATUS_NONE = 'NONE';

/** Reported for the latest pipeline execution when it cannot be determined. */
const EXECUTION_STATUS_UNKNOWN = '-';

/**
 * The mutually exclusive deployment-health classes for a single account
 * (Req 16.3).
 */
export type DeploymentClassification = 'fully-deployed' | 'partially-deployed' | 'no-pipeline';

/**
 * Typed deployment-health result for a single account.
 *
 * This is exactly what a fleet child emits as its `--json` document and what the
 * parent parses back when aggregating, so it intentionally carries every fact
 * Req 16.1 requires plus the derived {@link DeploymentClassification}.
 */
export interface AccountDeploymentHealth {
  /** AWS profile this report targeted; absent for an ambient single-account run. */
  profile?: string;
  /** CloudFormation status of the pipeline stack, or `NONE` when it does not exist. */
  pipelineStatus: string;
  /** Whether the pipeline stack exists (drives the no-pipeline classification). */
  pipelinePresent: boolean;
  /** Latest CodePipeline execution status, or `-` when unavailable. */
  executionStatus: string;
  /** Count of tracked feature stacks that are deployed. */
  deployedFeatureCount: number;
  /** Total count of tracked feature stacks, from the Resource_Registry (Req 16.2). */
  totalFeatureCount: number;
  /** Derived per-account deployment-health class (Req 16.3). */
  classification: DeploymentClassification;
}

/** One row of the fleet rollup, derived from a single child's outcome. */
export interface FleetStatusAccountRow {
  /** AWS profile for this account. */
  profile: string;
  /** Whether the child completed (`ok`) or its status determination failed. */
  status: 'ok' | 'failed';
  /** Pipeline stack status (present when `ok`). */
  pipelineStatus?: string;
  /** Latest pipeline execution status (present when `ok`). */
  executionStatus?: string;
  /** Deployed feature-stack count (present when `ok`). */
  deployedFeatureCount?: number;
  /** Total tracked feature-stack count (always the Resource_Registry total). */
  totalFeatureCount: number;
  /** Deployment classification (present when `ok`). */
  classification?: DeploymentClassification;
  /** Cause of failure or a pointer to the per-account log (present when `failed`). */
  failureDetail?: string;
}

/**
 * Aggregated fleet rollup payload (the `--json` shape for `--all-profiles`).
 *
 * The three deployment-health counts are exactly the figures Req 16.3 requires
 * the Output_Formatter to display; `failed` counts accounts whose status could
 * not be determined (Req 16.5).
 */
export interface FleetStatusRollup {
  /** Number of profiles resolved by the Profile_Loader. */
  totalProfiles: number;
  /** Count of fully deployed accounts (Req 16.3). */
  fullyDeployed: number;
  /** Count of partially deployed accounts (Req 16.3). */
  partiallyDeployed: number;
  /** Count of accounts with no pipeline (Req 16.3). */
  noPipeline: number;
  /** Count of accounts whose deployment-health status could not be determined (Req 16.5). */
  failed: number;
  /** Total tracked feature-stack count, from the Resource_Registry (Req 16.2). */
  totalFeatureCount: number;
  /** Per-account rows in profile-list order. */
  accounts: FleetStatusAccountRow[];
}

/** Structured error payload emitted to stdout on failure in `--json` mode (Req 7.4). */
export interface FleetStatusErrorPayload {
  /** Always `false`; marks this as the failure document. */
  ok: false;
  /** AWS profile in scope when the failure occurred, if any. */
  profile?: string;
  /** Classification and message of the failure. */
  error: { class: string; message: string };
}

/** Command-specific options for `bt fleet status` (none beyond the global flags). */
export type FleetStatusOptions = Record<never, never>;

/** Union of every payload this handler can produce. */
export type FleetStatusResult = AccountDeploymentHealth | FleetStatusRollup | FleetStatusErrorPayload;

// ---------------------------------------------------------------------------
// AWS read helpers (all read-only; wrapped with sendWithRetry — Req 16.4, 24.2)
// ---------------------------------------------------------------------------

/** Outcome of describing a single CloudFormation stack. */
interface StackStatusResult {
  /** Whether the stack currently exists. */
  exists: boolean;
  /** The CloudFormation `StackStatus`, when the stack exists. */
  status?: string;
}

/**
 * True when `error` indicates the stack simply does not exist (the only failure
 * Req 16.3 treats as the no-pipeline / not-deployed signal rather than an error).
 * CloudFormation surfaces this as a `ValidationError` whose message contains
 * "does not exist"; some paths use `StackNotFoundException`.
 */
function isStackNotFoundError(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);
  if (code === 'StackNotFoundException') {
    return true;
  }
  return code === 'ValidationError' && /does not exist/i.test(message);
}

/**
 * Describe one stack and return whether it exists plus its status. A
 * "does not exist" error resolves to `{ exists: false }`; any other error
 * (credentials, access-denied, throttling, …) propagates so the caller records
 * the account as failed (Req 16.5).
 */
async function describeStackStatus(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<StackStatusResult> {
  try {
    const out = await sendWithRetry(cfn, new DescribeStacksCommand({ StackName: stackName }), {
      operation: 'cloudformation:DescribeStacks',
      stackName,
    });
    return { exists: true, status: out.Stacks?.[0]?.StackStatus };
  } catch (error) {
    if (isStackNotFoundError(error)) {
      return { exists: false };
    }
    throw error;
  }
}

/** A CloudFormation stack counts as deployed when its status ends in `COMPLETE`. */
function isDeployedStatus(status: string | undefined): boolean {
  return typeof status === 'string' && status.endsWith('COMPLETE');
}

/**
 * Read the latest CodePipeline execution status. Informational only and not part
 * of the classification, so any failure degrades to {@link EXECUTION_STATUS_UNKNOWN}
 * (mirroring the legacy `|| echo "-"`) rather than failing the account.
 */
async function latestExecutionStatus(
  codePipeline: CodePipelineClient,
  pipelineName: string,
): Promise<string> {
  try {
    const out = await sendWithRetry(
      codePipeline,
      new ListPipelineExecutionsCommand({ pipelineName, maxResults: 1 }),
      { operation: 'codepipeline:ListPipelineExecutions', pipelineName },
    );
    return out.pipelineExecutionSummaries?.[0]?.status ?? EXECUTION_STATUS_UNKNOWN;
  } catch {
    return EXECUTION_STATUS_UNKNOWN;
  }
}

/** Count how many tracked feature stacks (Resource_Registry) are deployed. */
async function countDeployedFeatureStacks(cfn: CloudFormationClient): Promise<number> {
  let deployed = 0;
  for (const stackName of ResourceRegistry.featureStacks) {
    const result = await describeStackStatus(cfn, stackName);
    if (result.exists && isDeployedStatus(result.status)) {
      deployed += 1;
    }
  }
  return deployed;
}

/**
 * Gather one account's deployment health (Req 16.1, 16.3). Uses the per-context
 * AWS clients, which the router constructs for the in-scope profile.
 */
async function gatherAccountHealth(
  profile: string | undefined,
  ctx: IoContext,
): Promise<AccountDeploymentHealth> {
  const cfn = ctx.clients.cloudFormation();
  const pipeline = await describeStackStatus(cfn, ResourceRegistry.pipelineStackName);

  // No pipeline stack → no-pipeline; nothing further to read (Req 16.3).
  if (!pipeline.exists) {
    return {
      profile,
      pipelineStatus: PIPELINE_STATUS_NONE,
      pipelinePresent: false,
      executionStatus: EXECUTION_STATUS_UNKNOWN,
      deployedFeatureCount: 0,
      totalFeatureCount: FEATURE_STACK_COUNT,
      classification: 'no-pipeline',
    };
  }

  const codePipeline = ctx.clients.codePipeline();
  const executionStatus = await latestExecutionStatus(codePipeline, ResourceRegistry.pipelineName);
  const deployedFeatureCount = await countDeployedFeatureStacks(cfn);

  // Pipeline present: fully deployed iff every tracked feature stack is deployed (Req 16.3).
  const classification: DeploymentClassification =
    deployedFeatureCount === FEATURE_STACK_COUNT ? 'fully-deployed' : 'partially-deployed';

  return {
    profile,
    pipelineStatus: pipeline.status ?? 'UNKNOWN',
    pipelinePresent: true,
    executionStatus,
    deployedFeatureCount,
    totalFeatureCount: FEATURE_STACK_COUNT,
    classification,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Short uppercase label for a classification, used in human tables. */
function classificationLabel(classification: DeploymentClassification): string {
  switch (classification) {
    case 'fully-deployed':
      return 'FULLY';
    case 'partially-deployed':
      return 'PARTIAL';
    case 'no-pipeline':
      return 'NO-PIPELINE';
  }
}

/** Semantic tone for a classification (ignored in JSON / no-color modes). */
function classificationTone(classification: DeploymentClassification): Tone {
  switch (classification) {
    case 'fully-deployed':
      return 'success';
    case 'partially-deployed':
      return 'warning';
    case 'no-pipeline':
      return 'muted';
  }
}

/** Build the human-readable view for a single account. */
function buildAccountView(health: AccountDeploymentHealth): RenderableView {
  return {
    blocks: [
      {
        kind: 'heading',
        text: `Deployment health${health.profile ? ` — ${health.profile}` : ''}`,
      },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Pipeline', value: health.pipelineStatus },
          { label: 'Execution', value: health.executionStatus },
          {
            label: 'Features',
            value: `${health.deployedFeatureCount}/${health.totalFeatureCount}`,
          },
          {
            label: 'Status',
            value: {
              value: classificationLabel(health.classification),
              tone: classificationTone(health.classification),
            },
          },
        ],
      },
    ],
  };
}

/** Build the human-readable rollup view for a fleet run. */
function buildRollupView(rollup: FleetStatusRollup): RenderableView {
  const rows = rollup.accounts.map((account) => {
    if (account.status === 'failed') {
      return {
        profile: account.profile,
        pipeline: 'ERROR',
        exec: EXECUTION_STATUS_UNKNOWN,
        features: EXECUTION_STATUS_UNKNOWN,
        status: { value: 'FAILED', tone: 'failure' as Tone },
      };
    }
    return {
      profile: account.profile,
      pipeline: account.pipelineStatus ?? PIPELINE_STATUS_NONE,
      exec: account.executionStatus ?? EXECUTION_STATUS_UNKNOWN,
      features: `${account.deployedFeatureCount ?? 0}/${account.totalFeatureCount}`,
      status: {
        value: classificationLabel(account.classification as DeploymentClassification),
        tone: classificationTone(account.classification as DeploymentClassification),
      },
    };
  });

  return {
    blocks: [
      { kind: 'heading', text: `Fleet status (${rollup.totalProfiles} profiles)` },
      {
        kind: 'table',
        columns: [
          { header: 'PROFILE', key: 'profile' },
          { header: 'PIPELINE', key: 'pipeline' },
          { header: 'EXEC', key: 'exec' },
          { header: 'FEATURES', key: 'features' },
          { header: 'STATUS', key: 'status' },
        ],
        rows,
        emptyText: 'No profiles to report.',
      },
      {
        kind: 'keyValue',
        entries: [
          {
            label: `Fully deployed (${rollup.totalFeatureCount}/${rollup.totalFeatureCount} features)`,
            value: { value: rollup.fullyDeployed, tone: 'success' },
          },
          {
            label: 'Partially deployed',
            value: { value: rollup.partiallyDeployed, tone: 'warning' },
          },
          { label: 'No pipeline', value: { value: rollup.noPipeline, tone: 'muted' } },
          {
            label: 'Failed',
            value: { value: rollup.failed, tone: rollup.failed > 0 ? 'failure' : 'muted' },
          },
        ],
      },
      {
        kind: 'text',
        tone: 'muted',
        lines: [
          `Legend: EXEC=Failed with FEATURES=0/${rollup.totalFeatureCount} usually means the repo is empty`,
          '        (push source with `bt git push --execute`).',
        ],
      },
    ],
  };
}

/** Aggregate the children's typed outcomes into the fleet rollup (Req 16.3, 16.5). */
function buildRollup(
  profiles: string[],
  fleetResult: FleetResult<AccountDeploymentHealth>,
): FleetStatusRollup {
  let fullyDeployed = 0;
  let partiallyDeployed = 0;
  let noPipeline = 0;
  let failed = 0;
  const accounts: FleetStatusAccountRow[] = [];

  for (const account of fleetResult.accounts as AccountResult<AccountDeploymentHealth>[]) {
    const health = account.data;

    // A failed child, or an `ok` child that produced no usable status payload,
    // is recorded as failed so it never masks an undeployed account (Req 16.5).
    if (account.status === 'failed' || !health || !health.classification) {
      failed += 1;
      accounts.push({
        profile: account.profile,
        status: 'failed',
        totalFeatureCount: FEATURE_STACK_COUNT,
        failureDetail: account.failureDetail ?? 'no deployment-health status payload returned',
      });
      continue;
    }

    switch (health.classification) {
      case 'fully-deployed':
        fullyDeployed += 1;
        break;
      case 'partially-deployed':
        partiallyDeployed += 1;
        break;
      case 'no-pipeline':
        noPipeline += 1;
        break;
    }

    accounts.push({
      profile: account.profile,
      status: 'ok',
      pipelineStatus: health.pipelineStatus,
      executionStatus: health.executionStatus,
      deployedFeatureCount: health.deployedFeatureCount,
      totalFeatureCount: health.totalFeatureCount,
      classification: health.classification,
    });
  }

  return {
    totalProfiles: profiles.length,
    fullyDeployed,
    partiallyDeployed,
    noPipeline,
    failed,
    totalFeatureCount: FEATURE_STACK_COUNT,
    accounts,
  };
}

/** Resolve the bounded fleet concurrency from `--parallel` (Req 16.6). */
function resolveParallel(parallel: number | undefined): number {
  return typeof parallel === 'number' && parallel >= 1
    ? Math.floor(parallel)
    : DEFAULT_FLEET_STATUS_PARALLEL;
}

/** Per-account stderr log directory for a fleet run (local-only; Req 16.4). */
function fleetLogDir(ctx: IoContext): string {
  // nosemgrep: path-join-resolve-traversal -- os.tmpdir-based local log dir with a timestamp; no external input.
  return path.join(os.tmpdir(), 'bt-fleet-status-logs', String(ctx.now()));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Run a single account's deployment-health report and emit it. On a determination
 * failure the error is reported to stderr and, in `--json` mode, a structured
 * error document is the single thing written to stdout (Req 16.5, 7.4).
 */
async function runSingleAccount(
  profile: string | undefined,
  options: FleetStatusOptions & { global: GlobalOptions },
  ctx: IoContext,
): Promise<{ result: FleetStatusResult; exitCode: CliExitCode }> {
  try {
    const health = await gatherAccountHealth(profile, ctx);
    ctx.formatter.emit(health, buildAccountView(health), options.global, ctx);
    return { result: health, exitCode: CliExitCode.Success };
  } catch (error) {
    const failureClass = ctx.reporter.report(error, ctx, {
      profile,
      operation: 'cloudformation:DescribeStacks',
    });
    const errorPayload: FleetStatusErrorPayload = {
      ok: false,
      profile,
      error: { class: failureClass, message: toError(error).message },
    };
    if (options.global.json) {
      ctx.formatter.renderJson(errorPayload, ctx);
    }
    return { result: errorPayload, exitCode: CliExitCode.GeneralError };
  }
}

/**
 * Run the fleet rollup: resolve the profile list, route through the Fleet_Runner
 * (bounded `--parallel`, continue-on-failure — Req 16.5, 16.6), aggregate, emit.
 */
async function runFleet(
  options: FleetStatusOptions & { global: GlobalOptions },
  ctx: IoContext,
): Promise<{ result: FleetStatusResult; exitCode: CliExitCode }> {
  let profiles: string[];
  try {
    profiles = profileLoader.load(options.global, ctx);
  } catch (error) {
    // A missing/empty/unreadable profile list halts before any account (Req 4.7-4.9).
    if (error instanceof ProfileListError) {
      ctx.stderr.writeLine(`Error: ${error.message}`);
      ctx.stderr.writeLine(`Hint: ${error.remediation}`);
      const errorPayload: FleetStatusErrorPayload = {
        ok: false,
        error: { class: 'profile-list', message: error.message },
      };
      if (options.global.json) {
        ctx.formatter.renderJson(errorPayload, ctx);
      }
      return { result: errorPayload, exitCode: CliExitCode.GeneralError };
    }
    throw error;
  }

  const fleetResult = await ctx.fleet.run<AccountDeploymentHealth>(
    {
      command: ['fleet', 'status'],
      passthroughArgs: [],
      profiles,
      parallel: resolveParallel(options.global.parallel),
      execute: false, // Read_Operation: never forward --execute (Req 16.4).
      logDir: fleetLogDir(ctx),
    },
    ctx,
  );

  const rollup = buildRollup(profiles, fleetResult);
  ctx.formatter.emit(rollup, buildRollupView(rollup), options.global, ctx);

  // Non-zero exactly when at least one account failed (Req 16.5).
  return {
    result: rollup,
    exitCode: rollup.failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success,
  };
}

/**
 * `bt fleet status` handler. Branches on the resolved {@link Scope}: a fleet
 * rollup for `--all-profiles`, otherwise a single-account report (also the path
 * each fleet child runs).
 */
export const fleetStatusHandler: CommandHandler<FleetStatusOptions, FleetStatusResult> = (
  options,
  ctx,
) => {
  const scope: Scope = options.global.scope;
  if (scope.kind === 'all-profiles') {
    return runFleet(options, ctx);
  }
  const profile = scope.kind === 'profile' ? scope.profile : undefined;
  return runSingleAccount(profile, options, ctx);
};
