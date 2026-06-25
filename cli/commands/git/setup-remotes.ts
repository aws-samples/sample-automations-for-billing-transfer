// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt git setup-remotes` — configure a CodeCommit git remote per payer account
 * so source can be pushed to trigger each account's pipeline (Requirement 14).
 *
 * For every AWS profile resolved by the Profile_Loader (or the single profile
 * selected with `--profile`), the handler:
 *
 *  1. Reads the repository name from the pipeline stack outputs
 *     ({@link ResourceRegistry.pipelineStackName}, output key `RepositoryName`)
 *     using a per-profile CloudFormation client (Req 14.1).
 *  2. Derives the remote name deterministically via the shared
 *     {@link deriveRemoteName} helper — `codecommit-` + the lowercased profile
 *     with each run of non-alphanumeric characters collapsed to a single `-`
 *     (Req 14.2). The same helper is imported by `bt git push`, guaranteeing the
 *     two commands always agree on the name (design Property 7).
 *  3. Adds the remote when none exists (`git remote add`), or replaces the URL
 *     when it does (`git remote set-url`), using the profile-based
 *     git-remote-codecommit URL `codecommit://<profile>@<repo>` (Req 14.3, 14.4).
 *
 * The command is resilient: an account whose pipeline stack exposes no
 * repository name is **skipped** (Req 14.5), an account whose remote
 * configuration fails is recorded as **failed** (Req 14.6), and in both cases
 * the remaining accounts are still processed (continue-on-failure). On
 * completion the Output_Formatter reports the added / updated / skipped / failed
 * counts (Req 14.7).
 *
 * Git remotes are local to the current repository, so this runs as a single
 * in-process loop (not a child-process fleet); only the CloudFormation reads are
 * per-account/per-profile.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 *
 * @module git/setup-remotes
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
  type Output,
} from '@aws-sdk/client-cloudformation';

import type { CommandHandler, GlobalOptions, IoContext, RenderableView } from '../../lib/io-context.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import { createAwsClientFactory, sendWithRetry } from '../../lib/aws-clients.js';
import { profileLoader, ProfileListError } from '../../lib/profile-loader.js';
import { getErrorCode, getErrorMessage, toError } from '../../../lib/lambda/common/utils/errors.js';
import { deriveRemoteName } from './remote-name.js';

/** Pipeline-stack output key that carries the CodeCommit repository name. */
export const REPOSITORY_NAME_OUTPUT_KEY = 'RepositoryName';

/**
 * Parsed options for `bt git setup-remotes`. The command takes no flags of its
 * own beyond the global scope/output options threaded under `global`.
 */
export interface SetupRemotesOptions {
  global: GlobalOptions;
}

/** The disposition of a single account after remote configuration. */
export type RemoteStatus = 'added' | 'updated' | 'skipped' | 'failed';

/** Per-account outcome reported in the result payload. */
export interface RemoteOutcome {
  /** The AWS profile processed. */
  profile: string;
  /** The deterministically derived remote name (Req 14.2). */
  remoteName: string;
  /** What happened for this account. */
  status: RemoteStatus;
  /** The repository name read from the stack outputs, when one was found. */
  repositoryName?: string;
  /** The git-remote-codecommit URL configured, when a remote was added/updated. */
  url?: string;
  /** Human-readable reason for a skip or failure. */
  detail?: string;
}

/** Aggregated result of the command (Req 14.7). */
export interface SetupRemotesResult {
  /** Per-account outcomes in processing order. */
  outcomes: RemoteOutcome[];
  /** Count of remotes added. */
  added: number;
  /** Count of remotes updated (replaced). */
  updated: number;
  /** Count of accounts skipped (no repository name). */
  skipped: number;
  /** Count of accounts whose remote configuration failed. */
  failed: number;
}

/**
 * Injectable dependencies for the handler. Defaults wire the real
 * Profile_Loader and a per-profile CloudFormation client; tests substitute
 * in-memory stubs.
 */
export interface SetupRemotesDeps {
  /** Resolve the ordered list of profiles to process (Req 14.1). */
  loadProfiles: (global: GlobalOptions, ctx: IoContext) => string[];
  /**
   * Obtain a CloudFormation client for a profile. The default reuses
   * `ctx.clients` for the context's own scope and constructs a fresh per-profile
   * factory for the remaining fleet profiles (each carries its own credentials).
   */
  cloudFormationFor: (profile: string, ctx: IoContext) => CloudFormationClient;
}

/** Build the profile-based git-remote-codecommit URL (Req 14.3, 14.4). */
function codeCommitUrl(profile: string, repositoryName: string): string {
  return `codecommit://${profile}@${repositoryName}`;
}

/** Extract the `RepositoryName` output value, or `undefined` when absent/blank. */
function findRepositoryName(outputs: Output[] | undefined): string | undefined {
  const match = outputs?.find((o) => o.OutputKey === REPOSITORY_NAME_OUTPUT_KEY);
  const value = match?.OutputValue?.trim();
  if (!value || value === 'None') {
    return undefined;
  }
  return value;
}

/**
 * True when an error from `DescribeStacks` means the pipeline stack simply does
 * not exist (so the account is skipped per Req 14.5) rather than a real failure.
 */
function isStackNotFound(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error).toLowerCase();
  return code === 'ValidationError' && message.includes('does not exist');
}

/**
 * Resolve the profiles to process from the scope: a single `--profile` selects
 * just that profile; otherwise (all-profiles or ambient) the Profile_Loader
 * supplies the fleet (Req 14.1).
 */
function resolveProfiles(
  deps: SetupRemotesDeps,
  global: GlobalOptions,
  ctx: IoContext,
): string[] {
  if (global.scope.kind === 'profile') {
    return [global.scope.profile];
  }
  return deps.loadProfiles(global, ctx);
}

/**
 * Read the repository name for a profile from the pipeline stack outputs.
 * Returns `undefined` when the stack is absent or exposes no repository name
 * (skip, Req 14.5); throws on any other CloudFormation failure (fail, Req 14.6).
 */
async function readRepositoryName(
  profile: string,
  deps: SetupRemotesDeps,
  ctx: IoContext,
): Promise<string | undefined> {
  const client = deps.cloudFormationFor(profile, ctx);
  try {
    const response = await sendWithRetry(
      client,
      new DescribeStacksCommand({ StackName: ResourceRegistry.pipelineStackName }),
      { operation: 'cloudformation:DescribeStacks', profile },
    );
    return findRepositoryName(response.Stacks?.[0]?.Outputs);
  } catch (error) {
    if (isStackNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Configure (add or replace) the local git remote for a profile. Returns
 * `'added'` or `'updated'`; throws when the underlying git invocation fails.
 *
 * Git remotes are local to the current repository, so these invocations carry no
 * AWS profile; the targeted account is encoded in the remote URL instead.
 */
async function configureRemote(
  remoteName: string,
  url: string,
  ctx: IoContext,
): Promise<'added' | 'updated'> {
  const existing = await ctx.tools.git(['remote', 'get-url', remoteName]);
  const exists = existing.exitCode === 0;

  const gitArgs = exists
    ? ['remote', 'set-url', remoteName, url]
    : ['remote', 'add', remoteName, url];
  const result = await ctx.tools.git(gitArgs);

  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || `git exited with code ${result.exitCode}`;
    throw new Error(`Failed to ${exists ? 'update' : 'add'} remote '${remoteName}': ${reason}`);
  }

  return exists ? 'updated' : 'added';
}

/** Process a single profile end-to-end, never throwing (continue-on-failure). */
async function processProfile(
  profile: string,
  deps: SetupRemotesDeps,
  ctx: IoContext,
): Promise<RemoteOutcome> {
  const remoteName = deriveRemoteName(profile);
  try {
    const repositoryName = await readRepositoryName(profile, deps, ctx);
    if (!repositoryName) {
      // Req 14.5: no repository name exposed → skip and continue.
      return {
        profile,
        remoteName,
        status: 'skipped',
        detail: 'Pipeline stack exposes no repository name (is it deployed?)',
      };
    }

    const url = codeCommitUrl(profile, repositoryName);
    const status = await configureRemote(remoteName, url, ctx);
    return { profile, remoteName, status, repositoryName, url };
  } catch (error) {
    // Req 14.6: configuring the remote failed → record as failed and continue.
    return {
      profile,
      remoteName,
      status: 'failed',
      detail: toError(error).message,
    };
  }
}

/** Build the human-readable view of the result (Req 14.7). */
function buildView(result: SetupRemotesResult): RenderableView {
  const statusTone: Record<RemoteStatus, 'success' | 'info' | 'warning' | 'failure'> = {
    added: 'success',
    updated: 'info',
    skipped: 'warning',
    failed: 'failure',
  };

  return {
    blocks: [
      { kind: 'heading', text: 'Git Remote Setup' },
      {
        kind: 'table',
        columns: [
          { header: 'PROFILE', key: 'profile' },
          { header: 'REMOTE', key: 'remoteName' },
          { header: 'STATUS', key: 'status' },
          { header: 'DETAIL', key: 'detail' },
        ],
        rows: result.outcomes.map((o) => ({
          profile: o.profile,
          remoteName: o.remoteName,
          status: { value: o.status, tone: statusTone[o.status] },
          detail: o.detail ?? o.url ?? o.repositoryName ?? '',
        })),
        emptyText: 'No profiles to process.',
      },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Added', value: result.added },
          { label: 'Updated', value: result.updated },
          { label: 'Skipped', value: { value: result.skipped, tone: result.skipped > 0 ? 'warning' : 'default' } },
          { label: 'Failed', value: { value: result.failed, tone: result.failed > 0 ? 'failure' : 'default' } },
        ],
      },
    ],
  };
}

/**
 * Default per-profile CloudFormation client resolver. Reuses the context's own
 * client factory for the profile it was constructed for (so a single-`--profile`
 * or ambient run honors `ctx.clients.cloudFormation()`); otherwise builds a
 * per-profile factory so each fleet account uses its own credentials.
 */
function defaultCloudFormationFor(profile: string, ctx: IoContext): CloudFormationClient {
  return createAwsClientFactory({ profile }).cloudFormation();
}

/** Default dependencies wiring the real Profile_Loader and CloudFormation clients. */
const defaultDeps: SetupRemotesDeps = {
  loadProfiles: (global, ctx) => profileLoader.load(global, ctx),
  cloudFormationFor: defaultCloudFormationFor,
};

/**
 * Create the `bt git setup-remotes` handler with injectable dependencies.
 *
 * @param deps - overrides for the Profile_Loader and CloudFormation client
 *   resolution; defaults wire the real implementations.
 * @returns a {@link CommandHandler} producing a {@link SetupRemotesResult}.
 */
export function createSetupRemotesHandler(
  deps: SetupRemotesDeps = defaultDeps,
): CommandHandler<SetupRemotesOptions, SetupRemotesResult> {
  return async (options, ctx) => {
    const { global } = options;

    // Resolve the fleet of profiles up front; a profile-list failure halts before
    // any account is processed (Req 14.1).
    let profiles: string[];
    try {
      profiles = resolveProfiles(deps, global, ctx);
    } catch (error) {
      if (error instanceof ProfileListError) {
        ctx.stderr.writeLine(`Error: ${error.message}`);
        ctx.stderr.writeLine(`Hint: ${error.remediation}`);
      } else {
        ctx.reporter.report(error, ctx, { operation: 'git setup-remotes' });
      }
      const result: SetupRemotesResult = { outcomes: [], added: 0, updated: 0, skipped: 0, failed: 0 };
      ctx.formatter.emit(result, buildView(result), global, ctx);
      return { result, exitCode: CliExitCode.GeneralError };
    }

    // Process each profile sequentially; git remotes are local to one repository,
    // so a sequential loop avoids racing concurrent `git remote` mutations.
    const outcomes: RemoteOutcome[] = [];
    for (const profile of profiles) {
      ctx.stderr.writeLine(`Configuring remote for profile: ${profile}`);
      outcomes.push(await processProfile(profile, deps, ctx));
    }

    const result: SetupRemotesResult = {
      outcomes,
      added: outcomes.filter((o) => o.status === 'added').length,
      updated: outcomes.filter((o) => o.status === 'updated').length,
      skipped: outcomes.filter((o) => o.status === 'skipped').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
    };

    ctx.formatter.emit(result, buildView(result), global, ctx);

    // Skips are a normal outcome (Req 14.5); only genuine failures make the run
    // exit non-zero, consistent with the fleet continue-on-failure contract.
    const exitCode = result.failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success;
    return { result, exitCode };
  };
}

/** The default `bt git setup-remotes` handler wired with real dependencies. */
export const setupRemotesHandler: CommandHandler<SetupRemotesOptions, SetupRemotesResult> =
  createSetupRemotesHandler();
