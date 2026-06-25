// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt fleet deploy` — deploy the CDK Pipeline stack to payer accounts
 * (Requirement 13).
 *
 * The project ships as a self-mutating CDK Pipeline: deploying the
 * {@link ResourceRegistry.pipelineStackName} stack to a payer account
 * provisions the pipeline, which then builds and deploys the feature stacks.
 * This handler ports `scripts/deploy-all-profiles.sh` to a pure, injectable
 * {@link CommandHandler} that runs in two modes resolved from the global scope:
 *
 *  - **Single account** (`--profile <name>` or ambient credentials): resolve the
 *    target account identifier and region, then run `cdk bootstrap` (unless
 *    `--skip-bootstrap`) followed by `cdk deploy` of the pipeline stack under
 *    that profile, synthesizing into an isolated `cdk.out.<profile>` output
 *    directory so concurrent fleet synths cannot collide (Req 13.2, 13.3, 13.6,
 *    13.10). This is also the form the Fleet_Runner re-invokes per profile.
 *  - **Fleet** (`--all-profiles`): load the profile list and route the
 *    single-account form through the {@link IoContext.fleet} Fleet_Runner, which
 *    spawns one child per profile with bounded concurrency, writes per-account
 *    logs (Req 13.5), continues on per-account failure, and aggregates a typed
 *    summary with a CI exit code (Req 13.4, 13.7, 13.8, 13.9).
 *
 * Mutating actions only run with `--execute`; without it the command is a
 * Dry_Run that prints the bootstrap/deploy actions it *would* take per account
 * and changes nothing (Req 13.1). Concurrency follows `--parallel [N]`: absent
 * means sequential (one account at a time, Req 13.9); present without a value
 * means 5 (Req 13.8); present with N means at most N concurrent (Req 13.4).
 *
 * All result output goes through the Output_Formatter (a single JSON document in
 * `--json` mode, human tables otherwise); all diagnostics and account-resolution
 * failures are reported through the Error_Reporter to stderr only.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10
 *
 * @module commands/fleet/deploy
 */

import * as os from 'os';
import * as path from 'path';

import { CliExitCode } from '../../lib/exit-codes.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import { profileLoader, ProfileListError } from '../../lib/profile-loader.js';
import type { CommandHandler, GlobalOptions, IoContext } from '../../lib/io-context.js';
import type { AccountResult } from '../../lib/fleet-runner.js';
import type { RenderableBlock, RenderableView, Tone } from '../../lib/output-formatter.js';

/** Default fleet concurrency when `--parallel` is given without a value (Req 13.8). */
const DEFAULT_PARALLEL = 5;

/** What happened to the `cdk bootstrap` step for one account. */
export type BootstrapState =
  | 'skipped' //  --skip-bootstrap was set
  | 'planned' //  dry-run: would run
  | 'run' //      execute: bootstrap was attempted
  | 'not-run'; // never reached (e.g. account resolution failed)

/** What happened to the `cdk deploy` step for one account. */
export type DeployState =
  | 'planned' //   dry-run: would run
  | 'succeeded' // execute: deploy exited 0
  | 'failed' //    execute: deploy exited non-zero
  | 'not-run'; //  never reached (e.g. account resolution failed)

/** Overall per-account status used for the summary and exit-code contract. */
export type AccountDeployStatus =
  | 'planned' //  dry-run: actions printed, nothing performed
  | 'deployed' // execute: pipeline stack deployed
  | 'failed'; //  resolution or deploy failed

/** Outcome of the deploy for a single payer account. */
export interface AccountDeployOutcome {
  /** AWS profile targeted; absent for an ambient single-account deploy. */
  profile?: string;
  /** Resolved 12-digit account identifier, when resolution succeeded. */
  account?: string;
  /** Resolved region (active-profile region, or the Default_Region fallback). */
  region?: string;
  /** Isolated `cdk --output` directory for this account's synth (Req 13.10). */
  outputDir: string;
  /** Disposition of the bootstrap step. */
  bootstrap: BootstrapState;
  /** Disposition of the deploy step. */
  deploy: DeployState;
  /** Overall status for this account. */
  status: AccountDeployStatus;
  /** Rendered command lines that would run (dry-run only). */
  plannedActions?: string[];
  /** Failure cause or a pointer to the per-account log (when `status === 'failed'`). */
  failureDetail?: string;
}

/** Typed result payload emitted by the fleet-deploy handler. */
export interface FleetDeployResult {
  /** Discriminator for `--json` consumers. */
  command: 'fleet-deploy';
  /** `single` for one account/child, `fleet` for the `--all-profiles` rollup. */
  scope: 'single' | 'fleet';
  /** `dry-run` unless `--execute` was provided. */
  mode: 'dry-run' | 'execute';
  /** Concurrency cap used for the fleet run (omitted on the single-account path). */
  parallel?: number;
  /** Per-account log directory for the fleet run (omitted on the single-account path). */
  logDir?: string;
  /** Per-account outcomes, in profile-list order. */
  accounts: AccountDeployOutcome[];
  /** Count of accounts that were deployed or planned without failure. */
  succeeded: number;
  /** Count of accounts that failed (resolution or deploy). */
  failed: number;
}

/** Command-specific options for `bt fleet deploy` (global options arrive under `global`). */
export interface FleetDeployOptions {
  /** `--skip-bootstrap`: omit `cdk bootstrap` for each account (Req 13.3). */
  skipBootstrap: boolean;
}

/**
 * `bt fleet deploy` handler.
 *
 * Dispatches to the fleet path for `--all-profiles` and to the single-account
 * path otherwise (named profile or ambient credentials). The single-account
 * path is also what the Fleet_Runner re-invokes per profile.
 */
export const fleetDeploy: CommandHandler<FleetDeployOptions, FleetDeployResult> = async (
  options,
  ctx,
) => {
  if (options.global.scope.kind === 'all-profiles') {
    return runFleet(options, ctx);
  }
  return runSingleAccount(options, ctx);
};

// ---------------------------------------------------------------------------
// Single-account path (also the child form re-invoked by the Fleet_Runner)
// ---------------------------------------------------------------------------

/**
 * Deploy the pipeline stack to one account: resolve identifier/region, then
 * bootstrap (unless skipped) and deploy under the active profile into an
 * isolated output directory. In dry-run, print the planned actions and change
 * nothing (Req 13.1).
 */
async function runSingleAccount(
  options: FleetDeployOptions & { global: GlobalOptions },
  ctx: IoContext,
): Promise<{ result: FleetDeployResult; exitCode: CliExitCode }> {
  const { global, skipBootstrap } = options;
  const profile = global.scope.kind === 'profile' ? global.scope.profile : undefined;
  const execute = global.execute;
  // nosemgrep: path-join-resolve-traversal -- per-profile cdk.out dir name built from a sanitized profile id under cwd; not external input.
  const outputDir = path.resolve(ctx.cwd, `cdk.out.${profile ?? 'ambient'}`);

  // Resolve the target account identifier. A resolution failure is recorded as a
  // failed account and the command does not perform any deploy (Req 13.7).
  const account = await resolveAccountId(ctx, profile);
  if (account === '') {
    ctx.reporter.reportCredentials(ctx, { profile, operation: 'sts:GetCallerIdentity' });
    const outcome: AccountDeployOutcome = {
      profile,
      outputDir,
      bootstrap: skipBootstrap ? 'skipped' : 'not-run',
      deploy: 'not-run',
      status: 'failed',
      failureDetail: `Could not resolve the account identifier for ${
        profile ? `profile '${profile}'` : 'the active credentials'
      }; check credentials.`,
    };
    return finishSingle(outcome, options, ctx);
  }

  const region = await resolveRegion(ctx, profile);
  const bootstrapArgs = ['bootstrap', `aws://${account}/${region}`];
  const deployArgs = ['deploy', ResourceRegistry.pipelineStackName];
  const spawnOpts = { profile, outputDir };

  // Dry-run (default): print the actions that would be taken, perform nothing.
  if (!execute) {
    const plannedActions: string[] = [];
    if (!skipBootstrap) {
      plannedActions.push(ctx.tools.render('cdk', bootstrapArgs, spawnOpts));
    }
    plannedActions.push(ctx.tools.render('cdk', deployArgs, spawnOpts));

    const outcome: AccountDeployOutcome = {
      profile,
      account,
      region,
      outputDir,
      bootstrap: skipBootstrap ? 'skipped' : 'planned',
      deploy: 'planned',
      status: 'planned',
      plannedActions,
    };
    return finishSingle(outcome, options, ctx);
  }

  // Execute: bootstrap (best-effort, mirrors the legacy `|| true`) then deploy.
  let bootstrap: BootstrapState = 'skipped';
  if (!skipBootstrap) {
    bootstrap = 'run';
    const bootstrapResult = await ctx.tools.cdk(bootstrapArgs, spawnOpts);
    if (bootstrapResult.exitCode !== 0) {
      ctx.stderr.writeLine(
        `Warning: cdk bootstrap exited with code ${bootstrapResult.exitCode} for ${
          profile ? `profile '${profile}'` : 'the active credentials'
        }; continuing to deploy.`,
      );
    }
  }

  const deployResult = await ctx.tools.cdk(deployArgs, spawnOpts);
  const outcome: AccountDeployOutcome =
    deployResult.exitCode === 0
      ? { profile, account, region, outputDir, bootstrap, deploy: 'succeeded', status: 'deployed' }
      : {
          profile,
          account,
          region,
          outputDir,
          bootstrap,
          deploy: 'failed',
          status: 'failed',
          failureDetail: `cdk deploy exited with code ${deployResult.exitCode}.`,
        };

  return finishSingle(outcome, options, ctx);
}

/** Build, emit, and exit-code a single-account result from one outcome. */
function finishSingle(
  outcome: AccountDeployOutcome,
  options: FleetDeployOptions & { global: GlobalOptions },
  ctx: IoContext,
): { result: FleetDeployResult; exitCode: CliExitCode } {
  const failed = outcome.status === 'failed' ? 1 : 0;
  const result: FleetDeployResult = {
    command: 'fleet-deploy',
    scope: 'single',
    mode: options.global.execute ? 'execute' : 'dry-run',
    accounts: [outcome],
    succeeded: 1 - failed,
    failed,
  };
  emitResult(result, options.global, ctx);
  return { result, exitCode: failed > 0 ? CliExitCode.GeneralError : CliExitCode.Success };
}

// ---------------------------------------------------------------------------
// Fleet path (--all-profiles): route the single-account form through Fleet_Runner
// ---------------------------------------------------------------------------

/**
 * Deploy to every profile in the profile list via the Fleet_Runner. Loads the
 * list, picks the concurrency, forwards `--skip-bootstrap`, then aggregates the
 * per-account child results into a single rollup with a CI exit code.
 */
async function runFleet(
  options: FleetDeployOptions & { global: GlobalOptions },
  ctx: IoContext,
): Promise<{ result: FleetDeployResult; exitCode: CliExitCode }> {
  const { global, skipBootstrap } = options;
  const mode = global.execute ? 'execute' : 'dry-run';

  // Resolve the profile list; halt the whole fleet operation if it cannot be
  // loaded (missing/unreadable/empty), reporting to stderr only.
  let profiles: string[];
  try {
    profiles = profileLoader.load(global, ctx);
  } catch (error) {
    if (error instanceof ProfileListError) {
      ctx.stderr.writeLine(`Error: ${error.message}`);
      ctx.stderr.writeLine(`Hint: ${error.remediation}`);
    } else {
      ctx.reporter.report(error, ctx, { operation: 'fleet deploy' });
    }
    const result: FleetDeployResult = {
      command: 'fleet-deploy',
      scope: 'fleet',
      mode,
      accounts: [],
      succeeded: 0,
      failed: 0,
    };
    // Emit exactly one JSON document on the json path; human diagnostics already
    // went to stderr above.
    if (global.json) {
      ctx.formatter.renderJson(result, ctx);
    }
    return { result, exitCode: CliExitCode.GeneralError };
  }

  // Concurrency: absent → sequential (1 at a time, Req 13.9); present without a
  // value → 5 (Req 13.8); present with N → at most N (Req 13.4).
  const parallel = global.parallel ?? 1;
  const logDir =
    ctx.env.DEPLOY_LOG_DIR ?? path.join(os.tmpdir(), `bt-fleet-deploy-${ctx.now()}`); // nosemgrep: path-join-resolve-traversal -- env-supplied or os.tmpdir-based local log dir; not external input.
  const passthroughArgs = skipBootstrap ? ['--skip-bootstrap'] : [];

  const fleetResult = await ctx.fleet.run<FleetDeployResult>(
    {
      command: ['fleet', 'deploy'],
      passthroughArgs,
      profiles,
      parallel,
      execute: global.execute,
      logDir,
    },
    ctx,
  );

  const accounts = fleetResult.accounts.map((account) => toAccountOutcome(account, ctx));
  const result: FleetDeployResult = {
    command: 'fleet-deploy',
    scope: 'fleet',
    mode,
    parallel: parallel < 1 ? DEFAULT_PARALLEL : parallel,
    logDir,
    accounts,
    succeeded: fleetResult.succeeded,
    failed: fleetResult.failed,
  };

  emitResult(result, global, ctx);
  return { result, exitCode: fleetResult.exitCode };
}

/**
 * Convert a Fleet_Runner {@link AccountResult} into an {@link AccountDeployOutcome}.
 * A successful child carries its own single-account result as `data`; a failed
 * child (spawn error, non-zero exit, unparseable output) is rendered as a failed
 * account with the runner's failure detail (Req 13.7).
 */
function toAccountOutcome(
  account: AccountResult<FleetDeployResult>,
  ctx: IoContext,
): AccountDeployOutcome {
  if (account.status === 'ok' && account.data && account.data.accounts.length > 0) {
    return { ...account.data.accounts[0], profile: account.profile };
  }
  return {
    profile: account.profile,
    // nosemgrep: path-join-resolve-traversal -- per-profile cdk.out dir name built from a sanitized profile id under cwd; not external input.
    outputDir: path.resolve(ctx.cwd, `cdk.out.${account.profile}`),
    bootstrap: 'not-run',
    deploy: 'not-run',
    status: 'failed',
    failureDetail: account.failureDetail ?? `child process exited with code ${account.exitCode}.`,
  };
}

// ---------------------------------------------------------------------------
// Account / region resolution (read-only; safe in dry-run)
// ---------------------------------------------------------------------------

/**
 * Resolve the account identifier for a profile via `aws sts get-caller-identity`,
 * mirroring `resolve_account_id` in `scripts/lib/common.sh`. Returns the empty
 * string when resolution fails (non-zero exit or empty output) so the caller can
 * record the account as failed and continue.
 */
async function resolveAccountId(ctx: IoContext, profile?: string): Promise<string> {
  const result = await ctx.tools.aws(
    ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
    { profile },
  );
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

/**
 * Resolve the region for a profile via `aws configure get region`, falling back
 * to the Resource_Registry Default_Region when none is configured (mirrors
 * `resolve_region` in `scripts/lib/common.sh`).
 */
async function resolveRegion(ctx: IoContext, profile?: string): Promise<string> {
  const result = await ctx.tools.aws(['configure', 'get', 'region'], { profile });
  const region = result.exitCode === 0 ? result.stdout.trim() : '';
  return region !== '' ? region : ResourceRegistry.defaultRegion;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Map a per-account status to the human-output tone. */
function statusTone(status: AccountDeployStatus): Tone {
  switch (status) {
    case 'deployed':
      return 'success';
    case 'failed':
      return 'failure';
    case 'planned':
      return 'info';
  }
}

/** Build the human-readable view and emit through the Output_Formatter. */
function emitResult(result: FleetDeployResult, global: GlobalOptions, ctx: IoContext): void {
  ctx.formatter.emit(result, buildView(result), global, ctx);
}

/** Assemble the ordered human-output blocks for a fleet-deploy result. */
function buildView(result: FleetDeployResult): RenderableView {
  const blocks: RenderableBlock[] = [];
  const modeLabel = result.mode === 'dry-run' ? 'DRY-RUN' : 'EXECUTE';
  blocks.push({ kind: 'heading', text: `Pipeline deployment — ${modeLabel} (${result.scope})` });

  if (result.mode === 'dry-run') {
    blocks.push({
      kind: 'text',
      tone: 'warning',
      lines: ['Dry-run: no changes were made. Re-run with --execute to deploy.'],
    });
  }

  blocks.push({
    kind: 'table',
    title: 'Accounts',
    columns: [
      { header: 'Profile', key: 'profile' },
      { header: 'Account', key: 'account' },
      { header: 'Region', key: 'region' },
      { header: 'Bootstrap', key: 'bootstrap' },
      { header: 'Deploy', key: 'deploy' },
      { header: 'Status', key: 'status' },
    ],
    rows: result.accounts.map((account) => ({
      profile: account.profile ?? '(ambient)',
      account: account.account ?? '-',
      region: account.region ?? '-',
      bootstrap: account.bootstrap,
      deploy: account.deploy,
      status: { value: account.status, tone: statusTone(account.status) },
    })),
    emptyText: 'No accounts were processed.',
  });

  // Dry-run: list the rendered commands that would run, per account.
  const planned = result.accounts.filter(
    (account) => account.plannedActions && account.plannedActions.length > 0,
  );
  if (planned.length > 0) {
    const lines: string[] = [];
    for (const account of planned) {
      lines.push(`${account.profile ?? '(ambient)'}:`);
      for (const command of account.plannedActions ?? []) {
        lines.push(`  ${command}`);
      }
    }
    blocks.push({ kind: 'heading', text: 'Planned actions' });
    blocks.push({ kind: 'text', tone: 'muted', lines });
  }

  // Per-account failure detail.
  const failures = result.accounts.filter(
    (account) => account.status === 'failed' && account.failureDetail,
  );
  if (failures.length > 0) {
    blocks.push({ kind: 'heading', text: 'Failures' });
    blocks.push({
      kind: 'text',
      tone: 'failure',
      lines: failures.map(
        (account) => `${account.profile ?? '(ambient)'}: ${account.failureDetail}`,
      ),
    });
  }

  const summaryEntries: Array<{ label: string; value: { value: string | number; tone?: Tone } }> = [
    { label: 'Succeeded', value: { value: result.succeeded, tone: 'success' } },
    {
      label: 'Failed',
      value: { value: result.failed, tone: result.failed > 0 ? 'failure' : 'default' },
    },
  ];
  if (result.parallel !== undefined) {
    summaryEntries.push({ label: 'Concurrency', value: { value: result.parallel } });
  }
  if (result.logDir) {
    summaryEntries.push({ label: 'Logs', value: { value: result.logDir } });
  }
  blocks.push({ kind: 'keyValue', entries: summaryEntries });

  return { blocks };
}
