// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt partner-central seed-params` — seed the Partner Central channel-role SSM
 * parameters into payer accounts (Requirement 18).
 *
 * The pipeline's Synth step reads two SSM parameters at build time to decide
 * whether to deploy the channel-roles stack and which roles to include. They are
 * the durable source of truth (a value in SSM survives pipeline self-mutation,
 * unlike CodeBuild env vars baked from a local `.env`). This handler ports
 * `scripts/seed-channel-role-params.sh` to a pure, injectable
 * {@link CommandHandler}:
 *
 *  - It writes the two parameters whose paths come from the Resource_Registry —
 *    `linked-account-id` and `enable-management-role` (Req 18.2).
 *  - It resolves both values with the fixed precedence command option →
 *    environment variable → repository-root `.env` file, taking the first
 *    non-empty source (Req 18.4); the pure {@link resolveValue} helper makes that
 *    precedence independently testable.
 *  - It normalizes `enable-management-role` to the string `'true'` only for an
 *    exact `'true'` input and `'false'` in every other case (Req 18.6); the pure
 *    {@link normalizeEnableManagementRole} helper makes that mapping independently
 *    testable.
 *  - It validates the resolved `linked-account-id` as exactly 12 digits *before*
 *    any write, refusing to write anything on a bad value (Req 18.3).
 *  - It is a Dry_Run by default (prints the planned writes, mutates nothing,
 *    exits zero) and writes only under `--execute` (Req 18.1, 18.2).
 *  - It targets a single account with `--profile`/ambient credentials in-process,
 *    or the whole fleet via the Fleet_Runner when neither is given (Req 18.5).
 *  - It reports per-account failure detail (which parameter write failed) and an
 *    aggregated success/failure summary with a CI exit code (Req 18.7, 18.8).
 *  - Every direct SSM call is wrapped with the Shared_Utilities
 *    retry-with-backoff helper via {@link sendWithRetry} (Req 24.2).
 *
 * Requirements: 18.1, 18.2, 18.4, 18.5, 18.6, 18.7, 18.8, 24.2
 *
 * @module commands/partner-central/seed-params
 */

import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { PutParameterCommand, ParameterType } from '@aws-sdk/client-ssm';

import type { CommandHandler, GlobalOptions, IoContext, RenderableView } from '../../lib/io-context.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import { sendWithRetry } from '../../lib/aws-clients.js';
import { inputValidator } from '../../lib/input-validator.js';
import { load as loadProfiles, ProfileListError } from '../../lib/profile-loader.js';
import type { FleetResult } from '../../lib/fleet-runner.js';

/**
 * Environment-variable names honored as the second precedence source, matching
 * the legacy `seed-channel-role-params.sh` and `.env.example` (Req 18.4).
 */
const ENV_LINKED_ACCOUNT_ID = 'PARTNER_CENTRAL_LINKED_ACCOUNT_ID';
const ENV_ENABLE_MANAGEMENT_ROLE = 'ENABLE_MANAGEMENT_ROLE';

/** Single-account command path the Fleet_Runner re-invokes per profile. */
const COMMAND_PATH = ['partner-central', 'seed-params'];

/** Per-account stderr log destination for fleet runs (Req 18.7 failure pointers). */
const FLEET_LOG_SUBDIR = path.join('.bt-logs', 'seed-params');

/**
 * Parsed options for `bt partner-central seed-params` (merged with `{ global }`
 * by the {@link CommandHandler} contract).
 */
export interface SeedParamsOptions {
  /** `--linked-account-id <id>`: highest-precedence linked-account-id source (Req 18.4). */
  linkedAccountId?: string;
  /** `--enable-management-role <value>`: highest-precedence flag source (Req 18.4). */
  enableManagementRole?: string;
}

/** Which precedence source supplied a resolved value (`none` when all were empty). */
export type ValueSource = 'option' | 'env' | 'dotenv' | 'none';

/** Outcome of resolving a single value across the precedence sources. */
export interface ResolvedValue {
  /** The selected value, or the empty string when no source provided one. */
  value: string;
  /** The source that provided the value, in precedence order. */
  source: ValueSource;
}

/** Per-account outcome reported in the aggregated summary (Req 18.7, 18.8). */
export interface SeedParamsAccountResult {
  /** Targeted AWS profile, or `undefined` for ambient single-account credentials. */
  profile?: string;
  /** `dry-run` when nothing was written, `ok`/`failed` in execute mode. */
  status: 'dry-run' | 'ok' | 'failed';
  /** SSM parameter paths written successfully for this account (execute mode). */
  written?: string[];
  /** The parameter path whose write failed, when `status === 'failed'` (Req 18.7). */
  failedParam?: string;
  /** Human-readable cause or per-account log pointer, when `status === 'failed'`. */
  failureDetail?: string;
}

/** The typed result payload emitted by the handler (the `--json` document). */
export interface SeedParamsResult {
  /** `dry-run` unless `--execute` was supplied (Req 18.1). */
  mode: 'dry-run' | 'execute';
  /** Resolved (and validated) linked-account-id written / planned for every account. */
  linkedAccountId: string;
  /** Normalized enable-management-role string (`'true'`/`'false'`) (Req 18.6). */
  enableManagementRole: string;
  /** The fixed SSM parameter paths from the Resource_Registry (the names are not secret). */
  parameterPaths: { linkedAccountId: string; enableManagementRole: string };
  /** Per-account outcomes, in target order. */
  accounts: SeedParamsAccountResult[];
  /** Count of accounts whose parameters were written successfully (or dry-run planned). */
  succeeded: number;
  /** Count of accounts that failed (always 0 in dry-run). */
  failed: number;
}

/**
 * Normalize a resolved `enable-management-role` value to the exact string the
 * parameter stores: `'true'` *only* when the input is exactly `'true'`, and
 * `'false'` in every other case — including an absent value (`undefined`) or any
 * other text (Req 18.6).
 *
 * Pure and total: exported so the normalization property test (Property 14) can
 * target it directly without invoking the handler.
 *
 * @param value - the resolved value (possibly `undefined` when no source set it).
 * @returns the literal `'true'` or `'false'` to write as the parameter value.
 */
export function normalizeEnableManagementRole(value: string | undefined): 'true' | 'false' {
  return value === 'true' ? 'true' : 'false';
}

/**
 * Resolve a value across the fixed precedence command option → environment
 * variable → repository-root `.env`, returning the first source that provides a
 * non-empty value (Req 18.4). A value "counts" only when it is a string of
 * non-zero length; `undefined` and the empty string are treated as not provided,
 * mirroring the legacy `[ -z "$VALUE" ]` checks. No trimming is performed, so an
 * intentionally whitespace-bearing value is still considered provided.
 *
 * Pure and total: exported so the value-source-precedence property test
 * (Property 15) can target it directly without invoking the handler.
 *
 * @param option - the command-option value (highest precedence).
 * @param env - the environment-variable value (second precedence).
 * @param dotenvValue - the repository-root `.env` value (lowest precedence).
 * @returns the selected {@link ResolvedValue}; `source` is `'none'` when all empty.
 */
export function resolveValue(
  option: string | undefined,
  env: string | undefined,
  dotenvValue: string | undefined,
): ResolvedValue {
  if (option !== undefined && option !== '') {
    return { value: option, source: 'option' };
  }
  if (env !== undefined && env !== '') {
    return { value: env, source: 'env' };
  }
  if (dotenvValue !== undefined && dotenvValue !== '') {
    return { value: dotenvValue, source: 'dotenv' };
  }
  return { value: '', source: 'none' };
}

/**
 * Read and parse the repository-root `.env` file (the lowest-precedence source)
 * without mutating `process.env`.
 *
 * The file is resolved relative to `ctx.cwd`, matching how `bin/app.ts` loads it
 * with `dotenv.config()` (which reads `<cwd>/.env`); the project's npm `bt`
 * script runs from the repository root. {@link dotenv.parse} is used instead of
 * {@link dotenv.config} precisely so the `.env` values stay a *separate*,
 * lowest-precedence source rather than being merged into the environment (which
 * would conflate the env and `.env` precedence tiers). A missing or unreadable
 * `.env` is treated as "no values", mirroring the legacy `if [ -f .env ]` guard.
 *
 * @returns a record of parsed `.env` keys, or an empty record when absent.
 */
function readDotenvValues(ctx: IoContext): Record<string, string> {
  // nosemgrep: path-join-resolve-traversal -- joins the hardcoded ".env" filename under cwd; no external input.
  const envPath = path.join(ctx.cwd, '.env');
  let contents: string;
  try {
    // nosemgrep: detect-non-literal-fs-filename -- reads the cwd-local ".env" file; path is not external input.
    contents = fs.readFileSync(envPath, 'utf8');
  } catch {
    // Absent or unreadable `.env` simply contributes no values (Req 18.4).
    return {};
  }
  return dotenv.parse(contents);
}

/**
 * Build the human-readable {@link RenderableView} for a completed run. Shows the
 * resolved values, the fixed parameter paths, the per-account table, and the
 * aggregated success/failure summary (Req 18.8). Diagnostics and errors are
 * written to stderr by the Error_Reporter, never here.
 */
function buildView(result: SeedParamsResult): RenderableView {
  const dryRun = result.mode === 'dry-run';
  return {
    blocks: [
      { kind: 'heading', text: 'Seed channel-roles SSM parameters' },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Mode', value: dryRun ? 'dry-run (no writes)' : 'execute' },
          { label: 'linked-account-id', value: result.linkedAccountId },
          { label: 'enable-management-role', value: result.enableManagementRole },
          { label: 'Parameter (id)', value: result.parameterPaths.linkedAccountId },
          { label: 'Parameter (role)', value: result.parameterPaths.enableManagementRole },
          { label: 'Accounts targeted', value: result.accounts.length },
        ],
      },
      {
        kind: 'table',
        title: 'Per-account results',
        columns: [
          { header: 'Account', key: 'account' },
          { header: 'Status', key: 'status' },
          { header: 'Detail', key: 'detail' },
        ],
        emptyText: 'No accounts targeted.',
        rows: result.accounts.map((account) => ({
          account: account.profile ?? '(ambient credentials)',
          status: {
            value: account.status,
            tone: account.status === 'failed' ? 'failure' : account.status === 'ok' ? 'success' : 'muted',
          },
          detail:
            account.status === 'failed'
              ? account.failureDetail ?? `failed writing ${account.failedParam ?? 'parameter'}`
              : account.status === 'dry-run'
                ? 'would write both parameters'
                : `wrote ${account.written?.length ?? 0} parameter(s)`,
        })),
      },
      {
        kind: 'text',
        tone: result.failed > 0 ? 'failure' : 'success',
        lines: [
          `Summary: ${result.succeeded} succeeded, ${result.failed} failed.`,
          ...(dryRun ? ['Dry-run: re-run with --execute to write the parameters.'] : []),
        ],
      },
    ],
  };
}

/**
 * Write both channel-role parameters for one account in execute mode, wrapping
 * each `PutParameter` call with the shared retry-with-backoff helper (Req 24.2).
 *
 * Mirrors the legacy `put_param A && put_param B` short-circuit: the
 * linked-account-id parameter is written first, and if it fails the
 * enable-management-role write is not attempted; the account is recorded as
 * failed with the specific parameter that failed (Req 18.7). The Error_Reporter
 * writes the classified message + remediation to stderr only.
 */
async function writeAccountParams(
  ctx: IoContext,
  profile: string | undefined,
  linkedAccountId: string,
  enableManagementRole: string,
): Promise<SeedParamsAccountResult> {
  const ssm = ctx.clients.ssm();
  const writes: Array<{ name: string; value: string }> = [
    { name: ResourceRegistry.ssmParams.linkedAccountId, value: linkedAccountId },
    { name: ResourceRegistry.ssmParams.enableManagementRole, value: enableManagementRole },
  ];

  const written: string[] = [];
  for (const { name, value } of writes) {
    try {
      await sendWithRetry(
        ssm,
        new PutParameterCommand({ Name: name, Value: value, Type: ParameterType.STRING, Overwrite: true }),
        { operation: 'ssm:PutParameter', parameter: name, profile },
      );
      written.push(name);
    } catch (error) {
      ctx.reporter.report(error, ctx, { profile, operation: `ssm:PutParameter ${name}` });
      return {
        profile,
        status: 'failed',
        written,
        failedParam: name,
        failureDetail: `failed writing ${name}`,
      };
    }
  }

  return { profile, status: 'ok', written };
}

/**
 * Run the single-account path (scope `profile` or `ambient`): a dry-run prints
 * the planned writes and exits zero (Req 18.1); execute writes both parameters
 * for the one account and reports a one-account aggregated summary (Req 18.8).
 */
async function runSingleAccount(
  ctx: IoContext,
  global: GlobalOptions,
  linkedAccountId: string,
  enableManagementRole: string,
): Promise<{ result: SeedParamsResult; exitCode: CliExitCode }> {
  const profile = global.scope.kind === 'profile' ? global.scope.profile : undefined;

  let account: SeedParamsAccountResult;
  if (!global.execute) {
    account = { profile, status: 'dry-run' };
  } else {
    account = await writeAccountParams(ctx, profile, linkedAccountId, enableManagementRole);
  }

  const failed = account.status === 'failed' ? 1 : 0;
  const result: SeedParamsResult = {
    mode: global.execute ? 'execute' : 'dry-run',
    linkedAccountId,
    enableManagementRole,
    parameterPaths: {
      linkedAccountId: ResourceRegistry.ssmParams.linkedAccountId,
      enableManagementRole: ResourceRegistry.ssmParams.enableManagementRole,
    },
    accounts: [account],
    succeeded: 1 - failed,
    failed,
  };

  ctx.formatter.emit(result, buildView(result), global, ctx);
  return { result, exitCode: failed > 0 ? CliExitCode.GeneralError : CliExitCode.Success };
}

/**
 * Run the fleet path (scope `all-profiles`): re-invoke the single-account
 * command once per profile via the Fleet_Runner, forwarding the already-resolved
 * (and validated/normalized) values as passthrough options so every child writes
 * the same parameters. The Fleet_Runner forwards `--execute` only when set, so a
 * dry-run fleet mutates nothing; it continues on failure and computes a CI exit
 * code (Req 18.5, 18.7, 18.8).
 */
async function runFleet(
  ctx: IoContext,
  global: GlobalOptions,
  linkedAccountId: string,
  enableManagementRole: string,
): Promise<{ result: SeedParamsResult; exitCode: CliExitCode }> {
  let profiles: string[];
  try {
    profiles = loadProfiles(global, ctx);
  } catch (error) {
    if (error instanceof ProfileListError) {
      ctx.stderr.writeLine(`Error: ${error.message}`);
      ctx.stderr.writeLine(`Hint: ${error.remediation}`);
    } else {
      ctx.reporter.report(error, ctx, { operation: 'profile-loader:load' });
    }
    const result: SeedParamsResult = {
      mode: global.execute ? 'execute' : 'dry-run',
      linkedAccountId,
      enableManagementRole,
      parameterPaths: {
        linkedAccountId: ResourceRegistry.ssmParams.linkedAccountId,
        enableManagementRole: ResourceRegistry.ssmParams.enableManagementRole,
      },
      accounts: [],
      succeeded: 0,
      failed: 0,
    };
    if (global.json) {
      ctx.formatter.emit(result, buildView(result), global, ctx);
    }
    return { result, exitCode: CliExitCode.GeneralError };
  }

  const fleetResult: FleetResult = await ctx.fleet.run(
    {
      command: COMMAND_PATH,
      // Forward the resolved values so each child writes identical parameters;
      // the Fleet_Runner adds `--profile`, `--json`, and (only when set) `--execute`.
      passthroughArgs: [
        '--linked-account-id',
        linkedAccountId,
        '--enable-management-role',
        enableManagementRole,
      ],
      profiles,
      parallel: global.parallel ?? 0,
      execute: global.execute,
      // nosemgrep: path-join-resolve-traversal -- joins a hardcoded local log subdir constant under cwd; no external input.
      logDir: path.join(ctx.cwd, FLEET_LOG_SUBDIR),
    },
    ctx,
  );

  const accounts: SeedParamsAccountResult[] = fleetResult.accounts.map((account) => ({
    profile: account.profile,
    status: account.status === 'ok' ? (global.execute ? 'ok' : 'dry-run') : 'failed',
    failureDetail: account.failureDetail,
  }));

  const result: SeedParamsResult = {
    mode: global.execute ? 'execute' : 'dry-run',
    linkedAccountId,
    enableManagementRole,
    parameterPaths: {
      linkedAccountId: ResourceRegistry.ssmParams.linkedAccountId,
      enableManagementRole: ResourceRegistry.ssmParams.enableManagementRole,
    },
    accounts,
    succeeded: fleetResult.succeeded,
    failed: fleetResult.failed,
  };

  ctx.formatter.emit(result, buildView(result), global, ctx);
  return { result, exitCode: fleetResult.exitCode };
}

/**
 * Handler for `bt partner-central seed-params`.
 *
 * Resolves the linked-account-id and enable-management-role with the fixed
 * option → env → `.env` precedence (Req 18.4), normalizes the management-role
 * flag (Req 18.6), validates the linked-account-id as exactly 12 digits before
 * any write (Req 18.3), then either targets the single `--profile`/ambient
 * account in-process or fans out across the fleet (Req 18.5). Dry-run by default
 * (Req 18.1); writes the two Resource_Registry parameter paths under `--execute`
 * (Req 18.2); reports per-account failure detail and an aggregated summary with a
 * CI exit code (Req 18.7, 18.8).
 */
export const seedParamsHandler: CommandHandler<SeedParamsOptions, SeedParamsResult> = async (options, ctx) => {
  const { global } = options;
  const dotenvValues = readDotenvValues(ctx);

  // Resolve both values with the fixed precedence option → env → .env (Req 18.4).
  const linked = resolveValue(
    options.linkedAccountId,
    ctx.env[ENV_LINKED_ACCOUNT_ID],
    dotenvValues[ENV_LINKED_ACCOUNT_ID],
  );
  const enable = resolveValue(
    options.enableManagementRole,
    ctx.env[ENV_ENABLE_MANAGEMENT_ROLE],
    dotenvValues[ENV_ENABLE_MANAGEMENT_ROLE],
  );

  // Normalize enable-management-role to 'true' only for an exact 'true' (Req 18.6).
  const enableManagementRole = normalizeEnableManagementRole(enable.source === 'none' ? undefined : enable.value);

  // Validate the linked-account-id BEFORE any write; reject without writing (Req 18.3).
  const validation = inputValidator.accountId(linked.value);
  if (!validation.ok) {
    const shown = validation.invalidValue === '' ? '<empty>' : validation.invalidValue;
    ctx.stderr.writeLine(`Error: Invalid linked-account-id '${shown}'; expected exactly 12 digits (0-9).`);
    ctx.stderr.writeLine(
      'Hint: Pass --linked-account-id <id>, set ' +
        `${ENV_LINKED_ACCOUNT_ID}, or add it to the repository-root .env file.`,
    );
    if (global.json) {
      ctx.formatter.renderJson(
        {
          error: 'invalid-linked-account-id',
          invalidValue: validation.invalidValue,
          accepted: validation.accepted,
        },
        ctx,
      );
    }
    return {
      result: {
        mode: global.execute ? 'execute' : 'dry-run',
        linkedAccountId: linked.value,
        enableManagementRole,
        parameterPaths: {
          linkedAccountId: ResourceRegistry.ssmParams.linkedAccountId,
          enableManagementRole: ResourceRegistry.ssmParams.enableManagementRole,
        },
        accounts: [],
        succeeded: 0,
        failed: 0,
      },
      exitCode: CliExitCode.GeneralError,
    };
  }

  const linkedAccountId = validation.value;

  // Single account (--profile or ambient) vs fleet (all-profiles) (Req 18.5).
  if (global.scope.kind === 'all-profiles') {
    return runFleet(ctx, global, linkedAccountId, enableManagementRole);
  }
  return runSingleAccount(ctx, global, linkedAccountId, enableManagementRole);
};
