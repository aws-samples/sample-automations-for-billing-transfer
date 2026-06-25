// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect } from '@jest/globals';
/**
 * Unit / example tests for the two `bt git` command handlers (Task 13.4):
 *  - `createSetupRemotesHandler` / `setupRemotesHandler` (cli/commands/git/setup-remotes.ts)
 *  - `createGitPushHandler`      / `gitPushHandler`       (cli/commands/git/push.ts)
 *
 * These are example-based companions to the property test
 * `remote-name.property.test.ts` (deliberately a distinct filename): rather than
 * exercising the shared remote-name derivation across many inputs, they drive
 * each handler directly through an in-memory {@link IoContext} with a STUBBED
 * {@link ExternalToolRunner} that records every `git()` invocation. The stub
 * makes `git remote get-url` return exit 0 when a remote already exists and a
 * non-zero exit when it does not, so the handlers take their real add-vs-replace
 * and skip-on-missing-remote branches.
 *
 * Coverage by requirement:
 *  - setup-remotes:
 *      14.3/14.4 → add (`git remote add`) when no remote exists vs replace
 *                  (`git remote set-url`) when one already does.
 *      14.5      → an account whose pipeline stack exposes no repository name is
 *                  skipped, and the remaining accounts are still processed.
 *      14.6      → an account whose remote configuration fails is recorded as
 *                  failed (continue-on-failure), and the run continues.
 *      14.7      → the reported added / updated / skipped / failed counts.
 *  - git push:
 *      15.1      → dry-run by default performs no `git push` and exits zero.
 *      15.5      → an account whose derived remote does not exist is skipped.
 *      15.6      → the reported pushed / skipped / failed counts.
 *      15.7      → a push failure in execute mode is recorded distinctly from a
 *                  skip, and the run continues.
 *
 * Every handler is invoked directly (no `bt` spawn, per Req 22.3): setup-remotes
 * receives an injected {@link SetupRemotesDeps} (stub Profile_Loader + stub
 * per-profile CloudFormation client), and git push receives an injected
 * in-memory {@link ProfileLoader}.
 */

import {
  createSetupRemotesHandler,
  type SetupRemotesDeps,
  type SetupRemotesResult,
} from '../../../../cli/commands/git/setup-remotes.js';
import {
  createGitPushHandler,
  type GitPushResult,
} from '../../../../cli/commands/git/push.js';
import { deriveRemoteName } from '../../../../cli/commands/git/remote-name.js';
import { CliExitCode } from '../../../../cli/lib/exit-codes.js';
import type { GlobalOptions, IoContext, OutputSink } from '../../../../cli/lib/io-context.js';
import type {
  ExternalToolRunner,
  SpawnOpts,
  ToolResult,
} from '../../../../cli/lib/external-tool-runner.js';
import type { ProfileLoader } from '../../../../cli/lib/profile-loader.js';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';

// ---------------------------------------------------------------------------
// In-memory output sink
// ---------------------------------------------------------------------------

/** An {@link OutputSink} that captures everything written to it. */
class CapturingSink implements OutputSink {
  readonly lines: string[] = [];
  write(text: string): void {
    this.lines.push(text);
  }
  writeLine(line: string): void {
    this.lines.push(line);
  }
}

// ---------------------------------------------------------------------------
// Stubbed ExternalToolRunner that records every git() invocation
// ---------------------------------------------------------------------------

interface StubGitConfig {
  /** Remote names for which `git remote get-url` returns exit 0 (i.e. they exist). */
  existingRemotes?: Iterable<string>;
  /** Remote names for which `git remote add` / `set-url` fails (non-zero exit). */
  failConfigureRemotes?: Iterable<string>;
  /** Remote names for which `git push <remote>` fails (non-zero exit). */
  failPushRemotes?: Iterable<string>;
  /** Branch reported by `git rev-parse --abbrev-ref HEAD`. */
  headBranch?: string;
}

/**
 * A recording {@link ExternalToolRunner}. Only `git` carries behavior; the other
 * tools are unused by these two handlers. `git` interprets the relevant
 * subcommands so the handlers take their real branches:
 *  - `remote get-url <name>` → exit 0 iff `<name>` is in `existingRemotes`.
 *  - `remote add|set-url <name> <url>` → non-zero iff `<name>` is in
 *    `failConfigureRemotes`, else exit 0.
 *  - `push <remote> <refspec>` → non-zero iff `<remote>` is in
 *    `failPushRemotes`, else exit 0.
 *  - `rev-parse --abbrev-ref HEAD` → `headBranch` on stdout, exit 0.
 */
class StubGitRunner implements ExternalToolRunner {
  /** Every `git` argument vector, in invocation order. */
  readonly gitCalls: string[][] = [];

  private readonly existingRemotes: Set<string>;
  private readonly failConfigureRemotes: Set<string>;
  private readonly failPushRemotes: Set<string>;
  private readonly headBranch: string;

  constructor(config: StubGitConfig = {}) {
    this.existingRemotes = new Set(config.existingRemotes ?? []);
    this.failConfigureRemotes = new Set(config.failConfigureRemotes ?? []);
    this.failPushRemotes = new Set(config.failPushRemotes ?? []);
    this.headBranch = config.headBranch ?? 'main';
  }

  /** All recorded git push remotes (args[1]) for assertions on what was pushed. */
  pushedRemotes(): string[] {
    return this.gitCalls.filter((a) => a[0] === 'push').map((a) => a[1]);
  }

  /** True iff any `git push` was executed at all (used by the dry-run assertion). */
  anyPushExecuted(): boolean {
    return this.gitCalls.some((a) => a[0] === 'push');
  }

  git(args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    this.gitCalls.push([...args]);

    if (args[0] === 'remote' && args[1] === 'get-url') {
      const remote = args[2];
      return this.result(this.existingRemotes.has(remote) ? 0 : 2, {
        stderr: this.existingRemotes.has(remote) ? '' : `error: No such remote '${remote}'`,
      });
    }

    if (args[0] === 'remote' && (args[1] === 'add' || args[1] === 'set-url')) {
      const remote = args[2];
      const fails = this.failConfigureRemotes.has(remote);
      return this.result(fails ? 1 : 0, {
        stderr: fails ? `fatal: could not ${args[1]} remote '${remote}'` : '',
      });
    }

    if (args[0] === 'rev-parse') {
      return this.result(0, { stdout: this.headBranch });
    }

    if (args[0] === 'push') {
      const remote = args[1];
      const fails = this.failPushRemotes.has(remote);
      return this.result(fails ? 1 : 0, {
        stderr: fails ? `error: failed to push to '${remote}'` : '',
      });
    }

    return this.result(0, {});
  }

  // The remaining tools are not exercised by these handlers.
  cdk(args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.result(0, { command: ['cdk', ...args].join(' ') });
  }

  aws(args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.result(0, { command: ['aws', ...args].join(' ') });
  }

  run(cmd: string, args: string[], _opts: SpawnOpts = {}): Promise<ToolResult> {
    return this.result(0, { command: [cmd, ...args].join(' ') });
  }

  render(cmd: string, args: string[], _opts: SpawnOpts = {}): string {
    return [cmd, ...args].join(' ');
  }

  private result(exitCode: number, partial: Partial<ToolResult>): Promise<ToolResult> {
    return Promise.resolve({
      command: partial.command ?? 'git',
      exitCode,
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      signal: null,
    });
  }
}

// ---------------------------------------------------------------------------
// In-memory IoContext
// ---------------------------------------------------------------------------

interface TestContext {
  ctx: IoContext;
  tools: StubGitRunner;
  stdout: CapturingSink;
  stderr: CapturingSink;
  /** Payloads handed to `formatter.emit`, in order. */
  emitted: unknown[];
}

/**
 * Build an in-memory {@link IoContext}. Only the seams the two git handlers touch
 * carry behavior — the stdout/stderr sinks, the stubbed {@link ExternalToolRunner}
 * (`ctx.tools`), and the Output_Formatter `emit` — the rest are stubbed and
 * unused. No real AWS client, fleet runner, or process spawn is wired.
 */
function makeContext(tools: StubGitRunner): TestContext {
  const stdout = new CapturingSink();
  const stderr = new CapturingSink();
  const emitted: unknown[] = [];

  const formatter = {
    emit(payload: unknown): void {
      emitted.push(payload);
    },
    renderHuman(): void {},
    renderJson(): void {},
  };

  const reporter = {
    classify: () => 'unknown' as const,
    remediation: () => '',
    report: () => 'unknown' as const,
    reportCredentials: () => {},
    reportUnavailableRegion: () => {},
  };

  const ctx = {
    stdout,
    stderr,
    env: {},
    cwd: '/tmp',
    tools,
    formatter,
    reporter,
    now: () => 0,
  } as unknown as IoContext;

  return { ctx, tools, stdout, stderr, emitted };
}

/** Minimal global options: fleet scope (so the injected loadProfiles is used), human mode. */
function makeGlobal(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    scope: { kind: 'all-profiles' },
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// setup-remotes deps: stub Profile_Loader + per-profile CloudFormation client
// ---------------------------------------------------------------------------

/**
 * Build a {@link SetupRemotesDeps} whose Profile_Loader returns `profiles` and
 * whose per-profile CloudFormation client resolves a `DescribeStacks` response
 * carrying a `RepositoryName` output for the profiles present in `repoByProfile`
 * (and no such output for the rest, which exercises the skip path of Req 14.5).
 */
function makeSetupDeps(profiles: string[], repoByProfile: Record<string, string>): SetupRemotesDeps {
  return {
    loadProfiles: () => profiles,
    cloudFormationFor: (profile: string): CloudFormationClient => {
      const repo = repoByProfile[profile];
      const Outputs = repo ? [{ OutputKey: 'RepositoryName', OutputValue: repo }] : [];
      // `sendWithRetry` invokes `client.send(command)`; only that is needed.
      return {
        send: async () => ({ Stacks: [{ Outputs }] }),
      } as unknown as CloudFormationClient;
    },
  };
}

// ===========================================================================
// setup-remotes
// ===========================================================================

describe('bt git setup-remotes (createSetupRemotesHandler) — example/unit', () => {
  it('adds when no remote exists, replaces when it does, skips no-repo accounts, records failures, and reports counts', async () => {
    // Four accounts exercising each disposition.
    const profiles = ['payer-add', 'payer-replace', 'payer-skip', 'payer-fail'];
    const repoByProfile = {
      'payer-add': 'RepoAdd',
      'payer-replace': 'RepoReplace',
      // 'payer-skip' deliberately has no repository output → skipped (Req 14.5).
      'payer-fail': 'RepoFail',
    };

    const remoteReplace = deriveRemoteName('payer-replace'); // already exists → set-url
    const remoteFail = deriveRemoteName('payer-fail'); // configuring fails → failed

    const tools = new StubGitRunner({
      existingRemotes: [remoteReplace],
      failConfigureRemotes: [remoteFail],
    });
    const test = makeContext(tools);
    const handler = createSetupRemotesHandler(makeSetupDeps(profiles, repoByProfile));

    const { result, exitCode } = await handler({ global: makeGlobal() }, test.ctx);
    const r = result as SetupRemotesResult;

    // Req 14.7: aggregated counts.
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(1);

    // Per-account dispositions.
    const byProfile = Object.fromEntries(r.outcomes.map((o) => [o.profile, o]));
    expect(byProfile['payer-add'].status).toBe('added');
    expect(byProfile['payer-replace'].status).toBe('updated');
    expect(byProfile['payer-skip'].status).toBe('skipped');
    expect(byProfile['payer-fail'].status).toBe('failed');

    // Req 14.3: add uses the profile-based git-remote-codecommit URL.
    expect(byProfile['payer-add'].url).toBe('codecommit://payer-add@RepoAdd');
    expect(byProfile['payer-replace'].url).toBe('codecommit://payer-replace@RepoReplace');

    // Req 14.3 vs 14.4: the stubbed git runner saw `remote add` for the account
    // with no pre-existing remote, and `remote set-url` for the one that had it.
    const remoteAdd = deriveRemoteName('payer-add');
    expect(tools.gitCalls).toContainEqual(['remote', 'add', remoteAdd, 'codecommit://payer-add@RepoAdd']);
    expect(tools.gitCalls).toContainEqual([
      'remote',
      'set-url',
      remoteReplace,
      'codecommit://payer-replace@RepoReplace',
    ]);
    // Never the other way around.
    expect(tools.gitCalls).not.toContainEqual(['remote', 'set-url', remoteAdd, 'codecommit://payer-add@RepoAdd']);
    expect(tools.gitCalls).not.toContainEqual([
      'remote',
      'add',
      remoteReplace,
      'codecommit://payer-replace@RepoReplace',
    ]);

    // Req 14.5: the skipped account never reached a git remote mutation.
    const remoteSkip = deriveRemoteName('payer-skip');
    expect(tools.gitCalls.some((a) => a[0] === 'remote' && (a[1] === 'add' || a[1] === 'set-url') && a[2] === remoteSkip)).toBe(false);

    // Req 14.6: a configuration failure is recorded with a reason, not thrown.
    expect(byProfile['payer-fail'].detail).toBeTruthy();

    // failed > 0 → fleet partial-failure exit code.
    expect(exitCode).toBe(CliExitCode.FleetPartialFailure);

    // The structured result is the single payload emitted to the Output_Formatter.
    expect(test.emitted).toEqual([result]);
  });

  it('exits Success and reports only added/updated when every account configures cleanly', async () => {
    const profiles = ['acct-1', 'acct-2'];
    const repoByProfile = { 'acct-1': 'Repo1', 'acct-2': 'Repo2' };

    // acct-2's remote already exists → replace; acct-1's does not → add.
    const tools = new StubGitRunner({ existingRemotes: [deriveRemoteName('acct-2')] });
    const test = makeContext(tools);
    const handler = createSetupRemotesHandler(makeSetupDeps(profiles, repoByProfile));

    const { result, exitCode } = await handler({ global: makeGlobal() }, test.ctx);
    const r = result as SetupRemotesResult;

    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(exitCode).toBe(CliExitCode.Success);
  });
});

// ===========================================================================
// git push
// ===========================================================================

/** Build a git push handler wired to an in-memory profile list. */
function makePushHandler(profiles: string[]) {
  const loader: ProfileLoader = {
    load: () => profiles,
    parseProfiles: () => profiles,
    resolvePath: () => '/tmp/payer-profiles.txt',
  };
  return createGitPushHandler({ profileLoader: loader });
}

describe('bt git push (createGitPushHandler) — example/unit', () => {
  it('dry-run by default: pushes nothing, skips missing remotes, defaults ref/branch to main, and exits zero (Req 15.1, 15.5)', async () => {
    const profiles = ['payer-a', 'payer-b', 'payer-missing'];
    // payer-a and payer-b have remotes; payer-missing does not (→ skipped).
    const tools = new StubGitRunner({
      existingRemotes: [deriveRemoteName('payer-a'), deriveRemoteName('payer-b')],
      headBranch: 'main',
    });
    const test = makeContext(tools);
    const handler = makePushHandler(profiles);

    const { result, exitCode } = await handler({ global: makeGlobal({ execute: false }) }, test.ctx);
    const r = result as GitPushResult;

    // Req 15.1: no `git push` was ever executed in dry-run.
    expect(tools.anyPushExecuted()).toBe(false);
    // Dry-run still plans the two reachable accounts and skips the missing one.
    expect(r.pushed).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.execute).toBe(false);
    // Req 15.3 / 15.4: default remote branch and local ref are both `main`.
    expect(r.branch).toBe('main');
    expect(r.ref).toBe('main');

    // Each planned push is flagged as a dry-run, and the missing remote is skipped.
    const byProfile = Object.fromEntries(r.accounts.map((a) => [a.profile, a]));
    expect(byProfile['payer-a'].status).toBe('pushed');
    expect(byProfile['payer-a'].dryRun).toBe(true);
    expect(byProfile['payer-missing'].status).toBe('skipped');

    // Req 15.1: dry-run exits zero.
    expect(exitCode).toBe(CliExitCode.Success);
    expect(test.emitted).toEqual([result]);
  });

  it('execute mode: pushes existing remotes, skips missing ones, records a push failure distinctly, and reports counts (Req 15.5, 15.6, 15.7)', async () => {
    const profiles = ['payer-ok', 'payer-missing', 'payer-failpush'];
    const remoteOk = deriveRemoteName('payer-ok');
    const remoteFail = deriveRemoteName('payer-failpush');

    const tools = new StubGitRunner({
      existingRemotes: [remoteOk, remoteFail], // payer-missing absent → skipped
      failPushRemotes: [remoteFail], // its push returns non-zero → failed
      headBranch: 'main',
    });
    const test = makeContext(tools);
    const handler = makePushHandler(profiles);

    const { result, exitCode } = await handler(
      { global: makeGlobal({ execute: true }) },
      test.ctx,
    );
    const r = result as GitPushResult;

    // Req 15.6: reported counts across the three dispositions.
    expect(r.pushed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.execute).toBe(true);

    const byProfile = Object.fromEntries(r.accounts.map((a) => [a.profile, a]));
    // Req 15.2: a reachable remote is actually pushed (no dry-run flag in execute mode).
    expect(byProfile['payer-ok'].status).toBe('pushed');
    expect(byProfile['payer-ok'].dryRun).toBeUndefined();
    // Req 15.5: the missing remote is skipped, distinct from a failure.
    expect(byProfile['payer-missing'].status).toBe('skipped');
    // Req 15.7: the failing push is recorded as failed (distinct from skipped) with a reason.
    expect(byProfile['payer-failpush'].status).toBe('failed');
    expect(byProfile['payer-failpush'].detail).toBeTruthy();

    // Only the two existing remotes were pushed; the missing one never was (continue-on-failure).
    expect(tools.pushedRemotes().sort()).toEqual([remoteFail, remoteOk].sort());
    expect(tools.pushedRemotes()).not.toContain(deriveRemoteName('payer-missing'));

    // Req 15.8: a push failure in execute mode exits non-zero (fleet partial failure).
    expect(exitCode).toBe(CliExitCode.FleetPartialFailure);
    expect(test.emitted).toEqual([result]);
  });

  it('execute mode with all remotes reachable and pushing: exits Success and reports every account pushed', async () => {
    const profiles = ['p1', 'p2'];
    const tools = new StubGitRunner({
      existingRemotes: [deriveRemoteName('p1'), deriveRemoteName('p2')],
      headBranch: 'feature-x',
    });
    const test = makeContext(tools);
    const handler = makePushHandler(profiles);

    const { result, exitCode } = await handler(
      { global: makeGlobal({ execute: true }), branch: 'release', ref: 'feature-x' },
      test.ctx,
    );
    const r = result as GitPushResult;

    expect(r.pushed).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    // Explicit --ref / --branch are honored in the refspec that was pushed.
    expect(r.ref).toBe('feature-x');
    expect(r.branch).toBe('release');
    expect(tools.gitCalls).toContainEqual(['push', deriveRemoteName('p1'), 'feature-x:release']);
    expect(exitCode).toBe(CliExitCode.Success);
  });
});
