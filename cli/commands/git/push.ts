// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt git push` — push local source to every payer account's CodeCommit remote
 * to activate (or roll an update out to) each account's pipeline (Requirement 15).
 *
 * This is the CLI port of `scripts/push-all-profiles.sh`. Unlike the other fleet
 * commands it does **not** spawn a child `bt` per profile through the
 * Fleet_Runner: a CodeCommit remote is a *local* git remote whose AWS profile is
 * baked into its `codecommit://<profile>@<repo>` URL, so the push is ordinary
 * local git work that needs no per-account `AWS_PROFILE` child isolation. The
 * handler therefore iterates the Profile_Loader's list in-process and shells out
 * to `git` through the injected {@link ExternalToolRunner}, exactly as the legacy
 * script looped over profiles.
 *
 * Behavior (all per Requirement 15):
 *  - **Dry-run by default** (no `--execute`): print the push that *would* run for
 *    each account, mutate nothing, and exit `0` (Req 15.1). Remote existence is
 *    still probed (a read-only `git remote get-url`) so the dry-run faithfully
 *    reports which accounts would be skipped.
 *  - **Execute** (`--execute`): push the selected ref to each account's derived
 *    remote branch (Req 15.2). The remote name is derived by the shared
 *    {@link deriveRemoteName} helper — the very same function `bt git
 *    setup-remotes` uses — so push targets exactly the remote setup created
 *    (design Property 7 parity).
 *  - `--branch` defaults to `main` (Req 15.3); `--ref` defaults to the current
 *    local HEAD branch (Req 15.4).
 *  - An account whose derived remote does not exist is **skipped** and reported
 *    distinctly, and the run continues (Req 15.5).
 *  - A push that fails in execute mode is recorded as **failed** — distinct from
 *    skipped — and the run continues with the remaining accounts (Req 15.7).
 *  - The result reports the pushed / skipped / failed counts (Req 15.6).
 *  - Exit code: `0` in dry-run and when every account pushed or skipped without a
 *    push failure; non-zero ({@link CliExitCode.FleetPartialFailure}) when one or
 *    more pushes fail in execute mode (Req 15.8).
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8
 *
 * @module git/push
 */

import { CliExitCode } from '../../lib/exit-codes.js';
import type { CommandHandler, GlobalOptions, IoContext, RenderableView } from '../../lib/io-context.js';
import type { ProfileLoader } from '../../lib/profile-loader.js';
import { profileLoader as defaultProfileLoader, ProfileListError } from '../../lib/profile-loader.js';
import { deriveRemoteName } from './remote-name.js';

/** Default remote branch pushed to when `--branch` is omitted (Req 15.3). */
const DEFAULT_BRANCH = 'main';

/** Fallback local ref when `--ref` is omitted and HEAD cannot be resolved (mirrors the legacy script). */
const FALLBACK_REF = 'main';

/** Command-specific options for `bt git push`. */
export interface GitPushOptions {
  /** Remote branch to push to; defaults to `main` (Req 15.3). */
  branch?: string;
  /** Local ref/branch to push; defaults to the current HEAD branch (Req 15.4). */
  ref?: string;
}

/** Per-account disposition of the push. */
export type GitPushStatus = 'pushed' | 'skipped' | 'failed';

/** Outcome of attempting the push for a single account/profile. */
export interface GitPushAccountOutcome {
  /** The AWS profile this account corresponds to. */
  profile: string;
  /** The derived CodeCommit remote name (shared with `bt git setup-remotes`). */
  remote: string;
  /** Whether the account was pushed (or would be, in dry-run), skipped, or failed. */
  status: GitPushStatus;
  /** True when `status === 'pushed'` was only a dry-run plan (nothing was pushed). */
  dryRun?: boolean;
  /** The `git push` command line that ran (execute) or would run (dry-run). */
  command?: string;
  /** Skip reason or failure cause; absent on a successful push. */
  detail?: string;
}

/** Typed result payload for `bt git push` (the `--json` shape). */
export interface GitPushResult {
  /** Whether the command ran in execute mode (`true`) or dry-run (`false`). */
  execute: boolean;
  /** The resolved local ref that was (or would be) pushed. */
  ref: string;
  /** The resolved remote branch that was (or would be) pushed to. */
  branch: string;
  /** Count of accounts pushed (in dry-run, the count that would be pushed). */
  pushed: number;
  /** Count of accounts skipped because their derived remote does not exist. */
  skipped: number;
  /** Count of accounts whose push failed in execute mode. */
  failed: number;
  /** Per-account outcomes, in profile-list order. */
  accounts: GitPushAccountOutcome[];
}

/** Injectable dependencies for the handler; each defaults to the real implementation. */
export interface GitPushDeps {
  /** Profile_Loader used to resolve the fleet's profile list; injectable for tests. */
  profileLoader?: ProfileLoader;
}

/**
 * Resolve the local ref to push. When `--ref` is provided it wins; otherwise the
 * current HEAD branch is resolved with a read-only `git rev-parse`, falling back
 * to `main` when HEAD cannot be resolved (e.g. a detached/empty repo), matching
 * the legacy script's `git rev-parse --abbrev-ref HEAD || echo main` (Req 15.4).
 */
async function resolveRef(option: string | undefined, ctx: IoContext): Promise<string> {
  if (typeof option === 'string' && option.trim() !== '') {
    return option.trim();
  }
  try {
    const result = await ctx.tools.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = result.stdout.trim();
    if (result.exitCode === 0 && head !== '' && head !== 'HEAD') {
      return head;
    }
  } catch {
    // Fall through to the default below; git itself is exercised again per
    // account, where a spawn failure is reported as a per-account failure.
  }
  return FALLBACK_REF;
}

/**
 * Probe whether a local git remote with `remote` exists using the read-only
 * `git remote get-url`. Returns `true` when the remote resolves (exit 0). A spawn
 * failure propagates so the caller can record the account as failed.
 */
async function remoteExists(remote: string, ctx: IoContext): Promise<boolean> {
  const result = await ctx.tools.git(['remote', 'get-url', remote]);
  return result.exitCode === 0;
}

/**
 * Process a single account: derive its remote, skip when the remote is missing,
 * and either plan (dry-run) or perform (execute) the push. Never throws — a spawn
 * failure is captured as a `failed` outcome so the run continues (Req 15.5, 15.7).
 */
async function pushAccount(
  profile: string,
  refspec: string,
  global: GlobalOptions,
  ctx: IoContext,
): Promise<GitPushAccountOutcome> {
  const remote = deriveRemoteName(profile);
  const args = ['push', remote, refspec];
  const command = ctx.tools.render('git', args);

  try {
    if (!(await remoteExists(remote, ctx))) {
      // Req 15.5: derived remote does not exist — skip distinctly and continue.
      return {
        profile,
        remote,
        status: 'skipped',
        detail: `remote '${remote}' not found (run 'bt git setup-remotes' first)`,
      };
    }

    if (!global.execute) {
      // Req 15.1: dry-run prints the planned push and mutates nothing.
      ctx.stderr.writeLine(`[dry-run] ${profile}: ${command}`);
      return { profile, remote, status: 'pushed', dryRun: true, command };
    }

    // Req 15.2: execute mode performs the push to the derived remote branch.
    ctx.stderr.writeLine(`${profile}: ${command}`);
    const result = await ctx.tools.git(args, { logStream: ctx.stderr });
    if (result.exitCode === 0) {
      return { profile, remote, status: 'pushed', command };
    }
    // Req 15.7: push failure is recorded distinctly from a skip.
    return {
      profile,
      remote,
      status: 'failed',
      command,
      detail: `git push exited with code ${result.exitCode}`,
    };
  } catch (error) {
    // A spawn failure (e.g. git not on PATH) is a per-account failure (Req 15.7).
    const message = error instanceof Error ? error.message : String(error);
    return { profile, remote, status: 'failed', command, detail: `git push could not run: ${message}` };
  }
}

/** Tone helper for the per-account status cell in human output. */
function statusTone(status: GitPushStatus): 'success' | 'warning' | 'failure' {
  switch (status) {
    case 'pushed':
      return 'success';
    case 'skipped':
      return 'warning';
    case 'failed':
      return 'failure';
  }
}

/** Build the human-readable view for a completed push run. */
function buildView(result: GitPushResult): RenderableView {
  const header = result.execute ? 'Push source to payer pipelines' : 'Push source to payer pipelines (dry-run)';
  const intro = [
    `Accounts:    ${result.accounts.length}`,
    `Local ref:   ${result.ref}`,
    `Remote ref:  ${result.branch}`,
  ];
  if (!result.execute) {
    intro.push('DRY-RUN: nothing was pushed. Re-run with --execute to push.');
  }

  return {
    blocks: [
      { kind: 'heading', text: header },
      { kind: 'text', lines: intro },
      {
        kind: 'table',
        title: 'Per-account results',
        columns: [
          { header: 'Profile', key: 'profile' },
          { header: 'Remote', key: 'remote' },
          { header: 'Status', key: 'status' },
          { header: 'Detail', key: 'detail' },
        ],
        rows: result.accounts.map((a) => ({
          profile: a.profile,
          remote: a.remote,
          status: { value: a.dryRun ? `${a.status} (dry-run)` : a.status, tone: statusTone(a.status) },
          detail: a.detail ?? '',
        })),
        emptyText: 'No profiles resolved.',
      },
      {
        kind: 'keyValue',
        entries: [
          { label: 'Pushed', value: { value: result.pushed, tone: 'success' } },
          { label: 'Skipped', value: { value: result.skipped, tone: result.skipped > 0 ? 'warning' : 'default' } },
          { label: 'Failed', value: { value: result.failed, tone: result.failed > 0 ? 'failure' : 'default' } },
        ],
      },
    ],
  };
}

/**
 * Construct the `bt git push` handler. `deps.profileLoader` is injectable so
 * tests can supply an in-memory profile list without touching the filesystem;
 * production uses the shared {@link defaultProfileLoader} singleton.
 */
export function createGitPushHandler(deps: GitPushDeps = {}): CommandHandler<GitPushOptions, GitPushResult> {
  const loader = deps.profileLoader ?? defaultProfileLoader;

  return async (options, ctx) => {
    const { global } = options;
    const branch = options.branch?.trim() ? options.branch.trim() : DEFAULT_BRANCH;

    // Resolve the fleet's profile list; a missing/empty/unreadable list halts the
    // run before any push with a non-zero exit (Req 15.2 relies on the loader).
    let profiles: string[];
    try {
      profiles = loader.load(global, ctx);
    } catch (error) {
      if (error instanceof ProfileListError) {
        ctx.stderr.writeLine(`Error: ${error.message}`);
        ctx.stderr.writeLine(`Hint: ${error.remediation}`);
        if (global.json) {
          ctx.formatter.renderJson(
            { error: { kind: 'profile-list', reason: error.reason, message: error.message, path: error.path } },
            ctx,
          );
        }
        return {
          result: { execute: global.execute, ref: FALLBACK_REF, branch, pushed: 0, skipped: 0, failed: 0, accounts: [] },
          exitCode: CliExitCode.GeneralError,
        };
      }
      throw error;
    }

    const ref = await resolveRef(options.ref, ctx);
    const refspec = `${ref}:${branch}`;

    // Sequential, continue-on-failure loop (matches the legacy script and keeps
    // independent remotes from interleaving). Each account always yields an
    // outcome, never halting the run (Req 15.5, 15.7).
    const accounts: GitPushAccountOutcome[] = [];
    for (const profile of profiles) {
      accounts.push(await pushAccount(profile, refspec, global, ctx));
    }

    const pushed = accounts.filter((a) => a.status === 'pushed').length;
    const skipped = accounts.filter((a) => a.status === 'skipped').length;
    const failed = accounts.filter((a) => a.status === 'failed').length;

    const result: GitPushResult = { execute: global.execute, ref, branch, pushed, skipped, failed, accounts };

    ctx.formatter.emit(result, buildView(result), global, ctx);

    // Req 15.1 / 15.8: dry-run always exits 0; execute exits non-zero iff a push
    // failed. (Skips alone never fail the run.)
    const exitCode = failed > 0 ? CliExitCode.FleetPartialFailure : CliExitCode.Success;
    return { result, exitCode };
  };
}

/**
 * Default `bt git push` handler wired to the shared Profile_Loader. The command
 * router invokes this; tests typically use {@link createGitPushHandler} with an
 * injected profile loader.
 */
export const gitPushHandler: CommandHandler<GitPushOptions, GitPushResult> = createGitPushHandler();
