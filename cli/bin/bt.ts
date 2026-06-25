#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt` — the Billing Transfer CLI executable entrypoint (Requirements 1, 2, 3.1, 22.1).
 *
 * This module is the single place that parses the command line, resolves the
 * uniform {@link Scope} and {@link GlobalOptions}, builds the per-invocation
 * {@link IoContext}, routes to one of the twelve already-implemented command
 * handlers, and translates the handler's returned {@link CliExitCode} into a
 * process exit. Everything below it (handlers, services, runners, formatter,
 * reporter) is reused as-is; nothing is re-implemented here.
 *
 * Responsibilities:
 *  - **Silent-by-default diagnostics.** {@link configureCliLogging} is invoked at
 *    startup so the reused Shared_Services/Shared_Utilities never write a
 *    diagnostic line to stdout; under `--verbose` diagnostics go to stderr only
 *    (Req 24, wired here at startup).
 *  - **Global options** parsed with `commander`: `--profile`, `--all-profiles`,
 *    `--profiles-file`, `--json`, `--no-color`, `--execute`, `--parallel`,
 *    `--verbose`, `-h/--help`, and `-v/--version` (version read from
 *    `package.json`). Global options are accepted both before and after the
 *    command path, because the Fleet_Runner re-invokes children as
 *    `bt <command> --profile <p> --json` (Req 1.6, 3.1).
 *  - **Scope resolution.** `--profile` → `{ kind: 'profile' }`, `--all-profiles`
 *    → `{ kind: 'all-profiles' }`, neither → `{ kind: 'ambient' }`; the
 *    conflicting `--profile` + `--all-profiles` combination is rejected to stderr
 *    with a non-zero exit before any handler runs (Req 12.9, applied uniformly).
 *  - **Six command groups / twelve commands** registered with per-command help
 *    text and at least one usage example each (Req 1.5, 2.1-2.6), a hidden
 *    `bt help profiles` topic explaining the profile list file (Req 2 / 4), and a
 *    root/group listing that shows exactly the six groups (Req 1.2, 2.7, 2.8).
 *  - **Stream discipline.** Help and version go to stdout with exit 0
 *    (Req 1.3-1.6); unknown commands/options and other usage errors go to stderr
 *    with a non-zero exit (Req 1.7). `commander` is wired with `exitOverride` +
 *    `configureOutput` so it never calls `process.exit` itself and never writes
 *    errors to stdout.
 *  - **Single exit site.** Handlers return `{ result, exitCode }`; this module
 *    awaits the handler and records the code. The one and only `process.exit`
 *    call lives at the bottom of {@link main} and translates that
 *    {@link CliExitCode} (help/version → 0).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6,
 * 2.7, 2.8, 3.1, 22.1
 *
 * @module bin/bt
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { Command, CommanderError } from 'commander';

import { CliExitCode } from '../lib/exit-codes.js';
import { configureCliLogging } from '../lib/logging.js';
import { createAwsClientFactory } from '../lib/aws-clients.js';
import { createExternalToolRunner } from '../lib/external-tool-runner.js';
import { createFleetRunner } from '../lib/fleet-runner.js';
import { createOutputFormatter } from '../lib/output-formatter.js';
import { createErrorReporter } from '../lib/error-reporter.js';
import type { GlobalOptions, IoContext, OutputSink, Scope } from '../lib/io-context.js';
import { toError } from '../../lib/lambda/common/utils/errors.js';

// The twelve command handlers (pure, injectable functions) — reused as-is.
import { analyzeHandler } from '../commands/transfers/analyze.js';
import { triggerReconciliation } from '../commands/reconciliation/trigger.js';
import { reconciliationStatusHandler } from '../commands/reconciliation/status.js';
import { fleetDeploy } from '../commands/fleet/deploy.js';
import { fleetStatusHandler } from '../commands/fleet/status.js';
import { setupRemotesHandler } from '../commands/git/setup-remotes.js';
import { gitPushHandler } from '../commands/git/push.js';
import { registerPmaHandler } from '../commands/partner-central/register-pma.js';
import { seedParamsHandler } from '../commands/partner-central/seed-params.js';
import { runTerminationTest } from '../commands/test/termination.js';

// ---------------------------------------------------------------------------
// Exit-code state (translated at the single process.exit site in main())
// ---------------------------------------------------------------------------

/**
 * The exit code a handler resolved for this invocation. Starts at
 * {@link CliExitCode.Success} so help/listing actions (which print and return
 * without running a handler) exit 0. Set by {@link runHandler} for leaf
 * commands; read once by {@link main}.
 */
let resolvedExitCode: CliExitCode = CliExitCode.Success;

// ---------------------------------------------------------------------------
// Loose handler type for the wiring layer
//
// Handlers are individually strongly typed (CommandHandler<TOptions, TResult>);
// at the router boundary we accept them through a single loose shape so a generic
// dispatcher can invoke any of them without fighting option-type variance. Each
// per-command option mapper below remains locally type-checked.
// ---------------------------------------------------------------------------

/** The minimal shape every command handler satisfies, used by {@link runHandler}. */
type LooseHandler = (
  options: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx: IoContext,
) => Promise<{ result: unknown; exitCode: CliExitCode }>;

/** Builds a handler's command-specific options from the parsed leaf options. */
type OptionMapper = (raw: Record<string, unknown>, global: GlobalOptions) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// Process stream sinks (stdout reserved for results; stderr for diagnostics)
// ---------------------------------------------------------------------------

/** stdout sink: the result stream (human output or the single `--json` document). */
const stdoutSink: OutputSink = {
  write: (text: string): void => {
    process.stdout.write(text);
  },
  writeLine: (line: string): void => {
    process.stdout.write(`${line}\n`);
  },
};

/** stderr sink: diagnostics, progress, and error/remediation text — never results. */
const stderrSink: OutputSink = {
  write: (text: string): void => {
    process.stderr.write(text);
  },
  writeLine: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
};

// ---------------------------------------------------------------------------
// Version (read from package.json, Req 1.6)
// ---------------------------------------------------------------------------

/**
 * Read the tool version from `package.json` (Req 1.6). The entry runs from
 * `cli/bin/bt.ts` under `tsx` (repo root is `../../`) and from the compiled
 * `dist/cli/bin/bt.js` (repo root is `../../../`), so both candidate paths are
 * tried; the first readable `package.json` with a `version` wins.
 */
function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../package.json'), // dev (tsx): cli/bin -> repo root
    path.resolve(here, '../../../package.json'), // compiled: dist/cli/bin -> repo root
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// Global-option resolution (accepted before or after the command path)
// ---------------------------------------------------------------------------

/**
 * Attach the global options to a command. They are registered on every command
 * (root, groups, and leaves) so they parse whether they appear before the
 * command path (`bt --profile p transfers analyze`) or after it
 * (`bt transfers analyze --profile p --json`, as the Fleet_Runner re-invokes
 * children). {@link cliValue} then resolves the effective value from wherever it
 * was actually supplied.
 */
function addGlobalOptions(command: Command): Command {
  return command
    .option('-p, --profile <name>', "Target a single named AWS profile for this command's AWS calls.")
    .option('--all-profiles', 'Run across every profile in the profile list (fleet).')
    .option('--profiles-file <path>', 'Profile list file path (overrides $PAYER_PROFILES_FILE and the default).')
    .option('--json', 'Emit a single machine-readable JSON document on stdout.')
    .option('--no-color', 'Disable ANSI color in human-readable output.')
    .option('--execute', 'Perform mutating operations (mutating fleet commands are dry-run without it).')
    .option('--parallel [n]', 'Bounded fleet concurrency (defaults to 5 when given without a value).')
    .option('--verbose', 'Route diagnostic logs to stderr (silent by default).');
}

/**
 * Resolve a global option's value from wherever it was supplied on the command
 * line: walk from the leaf up through its ancestors and return the first command
 * where the option's source is `'cli'` (i.e. the user actually passed it).
 * Returns `undefined` when the option was never supplied (so defaults apply).
 */
function cliValue<T = unknown>(command: Command, key: string): T | undefined {
  for (let current: Command | null = command; current; current = current.parent) {
    if (current.getOptionValueSource(key) === 'cli') {
      return current.getOptionValue(key) as T;
    }
  }
  return undefined;
}

/**
 * Resolve the uniform {@link Scope} from the supplied selectors. The conflicting
 * `--profile` + `--all-profiles` case is rejected earlier (in {@link runHandler})
 * before this is reached.
 */
function resolveScope(profile: string | undefined, allProfiles: boolean): Scope {
  if (profile !== undefined) {
    return { kind: 'profile', profile };
  }
  if (allProfiles) {
    return { kind: 'all-profiles' };
  }
  return { kind: 'ambient' };
}

/**
 * Build the {@link GlobalOptions} for this invocation from the parsed command
 * tree. Reads every global flag via {@link cliValue} so position is irrelevant,
 * normalizes `--parallel`, and resolves the color preference (off when
 * `--no-color`, when not writing to a TTY, or in `--json` mode).
 */
function resolveGlobalOptions(command: Command): GlobalOptions {
  const profile = cliValue<string>(command, 'profile');
  const allProfiles = cliValue<boolean>(command, 'allProfiles') === true;
  const profilesFile = cliValue<string>(command, 'profilesFile');
  const json = cliValue<boolean>(command, 'json') === true;
  const execute = cliValue<boolean>(command, 'execute') === true;
  const verbose = cliValue<boolean>(command, 'verbose') === true;

  // `--no-color` sets the `color` attribute to false (source 'cli'); colorize
  // only when the user did not opt out, stdout is a TTY, and we are not emitting
  // a machine-readable JSON document.
  const noColorRequested = cliValue<boolean>(command, 'color') === false;
  const color = !noColorRequested && Boolean(process.stdout.isTTY) && !json;

  // `--parallel [n]`: present without a value -> true (default 5); present with a
  // value -> integer (>= 1, else default 5); absent -> undefined (sequential /
  // per-command default).
  const rawParallel = cliValue<string | boolean>(command, 'parallel');
  let parallel: number | undefined;
  if (rawParallel === true) {
    parallel = 5;
  } else if (typeof rawParallel === 'string') {
    const parsed = Number.parseInt(rawParallel, 10);
    parallel = Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
  }

  return {
    scope: resolveScope(profile, allProfiles),
    profilesFile,
    json,
    color,
    execute,
    parallel,
    verbose,
  };
}

/**
 * Construct the per-invocation {@link IoContext} that injects the result/diagnostic
 * sinks, environment, working directory, AWS client factory (bound to the resolved
 * profile and region), external-tool runner, fleet runner, output formatter, and
 * error reporter into the handler. Built fresh per command so tests can inject
 * mocks against the same contract.
 */
function buildIoContext(global: GlobalOptions): IoContext {
  const profile = global.scope.kind === 'profile' ? global.scope.profile : undefined;
  // Regional_Service clients prefer the active-profile region from the ambient
  // environment, falling back to the Default_Region inside the factory (Req 21.5).
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  return {
    stdout: stdoutSink,
    stderr: stderrSink,
    env: process.env,
    cwd: process.cwd(),
    clients: createAwsClientFactory({ profile, region }),
    tools: createExternalToolRunner(),
    fleet: createFleetRunner(),
    formatter: createOutputFormatter(global),
    reporter: createErrorReporter(),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Handler dispatch (the single bridge from commander actions to handlers)
// ---------------------------------------------------------------------------

/**
 * Invoke a command handler for a leaf command. Resolves global options and the
 * scope, rejects the conflicting `--profile` + `--all-profiles` combination to
 * stderr with a non-zero exit, builds the IoContext, then awaits the handler and
 * records its {@link CliExitCode} for the single exit site. Handler exceptions
 * are classified and reported to stderr by the Error_Reporter, then mapped to a
 * non-zero exit.
 *
 * @param leaf - the commander leaf command being executed.
 * @param handler - the reused command handler to run.
 * @param mapOptions - maps the leaf's parsed options into the handler's TOptions.
 */
async function runHandler(
  leaf: Command,
  handler: LooseHandler,
  mapOptions: OptionMapper,
): Promise<void> {
  // Conflicting scope selectors are rejected before any work (Req 1.7-style usage
  // error; mirrors the per-command rule in Req 12.9), to stderr, non-zero.
  const profileSupplied = cliValue<string>(leaf, 'profile') !== undefined;
  const allProfilesSupplied = cliValue<boolean>(leaf, 'allProfiles') === true;
  if (profileSupplied && allProfilesSupplied) {
    stderrSink.writeLine('Error: Options --profile and --all-profiles are mutually exclusive; choose one.');
    resolvedExitCode = CliExitCode.Usage;
    return;
  }

  const global = resolveGlobalOptions(leaf);

  // (Re)configure diagnostic logging now that we know --verbose; silent by
  // default, stderr-only under --verbose. Never touches stdout (Req 24).
  configureCliLogging(global);

  const ctx = buildIoContext(global);
  const handlerOptions = { ...mapOptions(leaf.opts(), global), global };

  try {
    const { exitCode } = await handler(handlerOptions, ctx);
    resolvedExitCode = exitCode;
  } catch (error) {
    // Classify + report to stderr only (Req 6.5); a thrown handler error always
    // exits non-zero (Req 6.4).
    ctx.reporter.report(error, ctx, {
      profile: global.scope.kind === 'profile' ? global.scope.profile : undefined,
    });
    if (global.json) {
      // Keep the --json contract: exactly one structured error document on stdout.
      ctx.formatter.renderJson({ kind: 'error', message: toError(error).message }, ctx);
    }
    resolvedExitCode = CliExitCode.GeneralError;
  }
}

// ---------------------------------------------------------------------------
// Command-group / command registration
// ---------------------------------------------------------------------------

/** Usage-error exit code passed to `commander` errors so the single exit site can translate it. */
const USAGE_EXIT_CODE = CliExitCode.Usage;

/**
 * Configure a command (root, group, or leaf) with the shared non-interactive
 * wiring: throw on exit instead of calling `process.exit`, suppress the
 * auto-generated `help` subcommand (we provide an explicit `help` topic on the
 * root), route help to stdout / errors to stderr, name unknown input, and accept
 * the global options in any position.
 */
function configureCommand(command: Command, isLeaf: boolean): Command {
  command.exitOverride();
  command.helpCommand(false);
  command.showSuggestionAfterError(true);
  addGlobalOptions(command);

  command.configureOutput({
    // Help and the version string are the only things written to stdout here
    // (Req 1.3-1.6); everything else (errors) goes to stderr (Req 1.7).
    writeOut: (str: string): void => {
      process.stdout.write(str);
    },
    writeErr: (str: string): void => {
      process.stderr.write(str);
    },
    // Error messages always go to stderr, never stdout (Req 1.7).
    outputError: (str: string): void => {
      process.stderr.write(str);
    },
  });

  // Groups (and the root) accept a trailing token so we can name an unknown
  // sub-command ourselves rather than emit commander's generic message; leaves
  // keep strict excess-argument checking.
  if (!isLeaf) {
    command.allowExcessArguments(true);
  }

  return command;
}

/**
 * Register a leaf command under a group: wire its help/exit behavior, declared
 * options, a usage example (Req 1.5), and the action that dispatches to the
 * reused handler.
 */
function registerLeaf(
  group: Command,
  name: string,
  config: {
    description: string;
    example: string;
    options?: Array<[flags: string, description: string]>;
    handler: LooseHandler;
    mapOptions: OptionMapper;
  },
): Command {
  const leaf = group.command(name);
  configureCommand(leaf, true);
  leaf.description(config.description);
  for (const [flags, description] of config.options ?? []) {
    leaf.option(flags, description);
  }
  // At least one usage example per command (Req 1.5).
  leaf.addHelpText('after', `\nExample:\n  $ ${config.example}\n`);
  leaf.action(async () => {
    await runHandler(leaf, config.handler, config.mapOptions);
  });
  return leaf;
}

/**
 * Create a command group and give it a no-subcommand action that prints the
 * group help to stdout and exits 0 (Req 1.4), while naming an unknown
 * sub-command to stderr with a non-zero exit (Req 1.7).
 */
function registerGroup(program: Command, name: string, description: string): Command {
  const group = program.command(name);
  configureCommand(group, false);
  group.description(description);
  group.action(() => {
    const extra = group.args;
    if (extra.length > 0) {
      // Unknown sub-command: name it on stderr, non-zero (Req 1.7).
      group.error(`unknown command '${name} ${extra[0]}'`, {
        code: 'bt.unknownCommand',
        exitCode: USAGE_EXIT_CODE,
      });
    }
    // No sub-command: list this group's commands on stdout, exit 0 (Req 1.4).
    group.outputHelp();
  });
  return group;
}

/** Coerce a parsed string-ish option to a trimmed string, or undefined when absent. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Coerce a parsed boolean-ish option to a real boolean. */
function asBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Build the full `bt` command tree: the root, the six command groups, and the
 * twelve leaf commands, each wired to its reused handler with the correct
 * option-to-TOptions mapping.
 *
 * Exported so the wiring can be exercised in-process by tests (e.g. the
 * unknown-token rejection property) without spawning a child process. The
 * returned program is already configured with `exitOverride` (it throws a
 * {@link CommanderError} instead of calling `process.exit`), so callers can drive
 * `parse`/`parseAsync` and observe the usage-error semantics directly.
 */
export function buildProgram(): Command {
  const program = new Command();
  configureCommand(program, false);
  program
    .name('bt')
    .description('Billing Transfer CLI — partner-friendly operations over the Billing Transfer automation.')
    .version(readVersion(), '-v, --version', 'Output the bt version and exit.');

  // Root with no command: print the group listing on stdout and exit 0 (Req 1.2);
  // name an unknown top-level command on stderr with a non-zero exit (Req 1.7).
  program.action(() => {
    const extra = program.args;
    if (extra.length > 0) {
      program.error(`unknown command '${extra[0]}'`, {
        code: 'bt.unknownCommand',
        exitCode: USAGE_EXIT_CODE,
      });
    }
    program.outputHelp();
  });

  // --- transfers (Read_Operation) ------------------------------------------
  const transfers = registerGroup(program, 'transfers', 'Analyze billing transfers and their associated resources.');
  registerLeaf(transfers, 'analyze', {
    description: 'List billing transfers for an account (or the fleet) with their billing view, billing group, pricing plan, and CUR indicators.',
    example: 'bt transfers analyze --state ACCEPTED --validate',
    options: [
      ['--state <state>', 'Relationship state to analyze (default: ACCEPTED).'],
      ['--account <id>', 'Restrict analysis to this 12-digit bill-source account id.'],
      ['--type <type>', 'Restrict to a transfer type: direct or indirect.'],
      ['--validate', 'Include consistency-validation (missing and orphaned resources).'],
    ],
    handler: analyzeHandler as LooseHandler,
    mapOptions: (raw) => ({
      state: asString(raw.state),
      account: asString(raw.account),
      type: asString(raw.type),
      validate: asBoolean(raw.validate),
    }),
  });

  // --- reconciliation ------------------------------------------------------
  const reconciliation = registerGroup(
    program,
    'reconciliation',
    'Trigger reconciliation functions and check reconciliation status.',
  );
  registerLeaf(reconciliation, 'trigger', {
    description: 'Submit an asynchronous reconciliation invocation (billing-group, CUR, or both).',
    example: 'bt reconciliation trigger --target both --all-profiles --execute',
    options: [['--target <target>', 'Reconciliation target: bg, cur, or both (default: both).']],
    handler: triggerReconciliation as LooseHandler,
    mapOptions: (raw) => ({ target: asString(raw.target) }),
  });
  registerLeaf(reconciliation, 'status', {
    description: 'Report whether the most recent reconciliation run(s) succeeded within a lookback window.',
    example: 'bt reconciliation status --target both --lookback 120',
    options: [
      ['--target <target>', 'Reconciliation target: bg, cur, or both (default: both).'],
      ['--lookback <minutes>', 'Lookback window in minutes, 1-10080 (default: 120).'],
    ],
    handler: reconciliationStatusHandler as LooseHandler,
    mapOptions: (raw, global) => ({
      target: asString(raw.target),
      lookback: asString(raw.lookback),
      // Raw scope selectors are forwarded so the handler can detect the
      // conflicting-options case independently (Req 12.9).
      profile: global.scope.kind === 'profile' ? global.scope.profile : undefined,
      allProfiles: global.scope.kind === 'all-profiles',
    }),
  });

  // --- fleet ---------------------------------------------------------------
  const fleet = registerGroup(program, 'fleet', 'Deploy the pipeline stack to payer accounts and report deployment health.');
  registerLeaf(fleet, 'deploy', {
    description: 'Deploy the CDK Pipeline stack to one account or the fleet (dry-run by default; --execute to deploy).',
    example: 'bt fleet deploy --all-profiles --parallel 5 --execute',
    options: [['--skip-bootstrap', 'Skip the cdk bootstrap step for each account.']],
    handler: fleetDeploy as LooseHandler,
    mapOptions: (raw) => ({ skipBootstrap: asBoolean(raw.skipBootstrap) }),
  });
  registerLeaf(fleet, 'status', {
    description: 'Report pipeline-stack status, latest pipeline execution, and deployed feature-stack counts across the fleet.',
    example: 'bt fleet status --all-profiles',
    handler: fleetStatusHandler as LooseHandler,
    mapOptions: () => ({}),
  });

  // --- git -----------------------------------------------------------------
  const git = registerGroup(program, 'git', 'Configure CodeCommit remotes and push source to trigger pipelines.');
  registerLeaf(git, 'setup-remotes', {
    description: 'Add or update a CodeCommit git remote per payer account from the pipeline stack outputs.',
    example: 'bt git setup-remotes --all-profiles',
    handler: setupRemotesHandler as LooseHandler,
    mapOptions: () => ({}),
  });
  registerLeaf(git, 'push', {
    description: 'Push local source to each payer account\u2019s CodeCommit remote (dry-run by default; --execute to push).',
    example: 'bt git push --ref HEAD --branch main --all-profiles --execute',
    options: [
      ['--ref <ref>', 'Local ref/branch to push (default: current HEAD branch).'],
      ['--branch <branch>', 'Remote branch to push to (default: main).'],
    ],
    handler: gitPushHandler as LooseHandler,
    mapOptions: (raw) => ({ ref: asString(raw.ref), branch: asString(raw.branch) }),
  });

  // --- partner-central -----------------------------------------------------
  const partnerCentral = registerGroup(
    program,
    'partner-central',
    'Register a Partner Central PMA and seed channel-role SSM parameters.',
  );
  registerLeaf(partnerCentral, 'register-pma', {
    description: 'Register and confirm a Partner Central Channel Program Management Account (register \u2192 create handshake \u2192 accept).',
    example: 'bt partner-central register-pma --account-id 123456789012 --program DP --central-profile central-999999999999',
    options: [
      ['--account-id <id>', 'The 12-digit payer account id to register as a PMA.'],
      ['--program <program>', 'PMA program: DP, SPP, or DS (or the SDK enum form).'],
      ['--display-name <name>', 'Display name (default: PMA-<TYPE>-<last4>).'],
      ['--central-profile <profile>', 'REQUIRED central-account profile used to register and create the handshake.'],
      ['--payer-profile <profile>', 'Payer-account profile used to accept the handshake (default: the account id).'],
      ['--catalog <catalog>', 'Partner Central catalog (default: AWS).'],
    ],
    handler: registerPmaHandler as LooseHandler,
    mapOptions: (raw) => ({
      accountId: asString(raw.accountId) ?? '',
      program: asString(raw.program) ?? '',
      displayName: asString(raw.displayName),
      centralProfile: asString(raw.centralProfile),
      payerProfile: asString(raw.payerProfile),
      catalog: asString(raw.catalog),
    }),
  });
  registerLeaf(partnerCentral, 'seed-params', {
    description: 'Seed the channel-role SSM parameters (linked-account-id, enable-management-role) into payer accounts (dry-run by default).',
    example: 'bt partner-central seed-params --linked-account-id 123456789012 --enable-management-role true --execute',
    options: [
      ['--linked-account-id <id>', 'Linked (central) account id; overrides env and .env.'],
      ['--enable-management-role <value>', "Set the management-role flag ('true' enables it; anything else disables)."],
    ],
    handler: seedParamsHandler as LooseHandler,
    mapOptions: (raw) => ({
      linkedAccountId: asString(raw.linkedAccountId),
      enableManagementRole: asString(raw.enableManagementRole),
    }),
  });

  // --- test ----------------------------------------------------------------
  const test = registerGroup(program, 'test', 'Run the termination-handler integration test.');
  registerLeaf(test, 'termination', {
    description: 'Run the termination-handler integration test against the deployed function (optionally deploy/cleanup the stack).',
    example: 'bt test termination --deploy --cleanup',
    options: [
      ['--deploy', 'Deploy the termination stack to a completed state before testing.'],
      ['--test-only', 'Test the already-deployed stack without deploying first.'],
      ['--cleanup', 'Destroy the stack after the test, regardless of pass/fail.'],
    ],
    handler: runTerminationTest as LooseHandler,
    mapOptions: (raw) => ({
      deploy: asBoolean(raw.deploy),
      testOnly: asBoolean(raw.testOnly),
      cleanup: asBoolean(raw.cleanup),
    }),
  });

  // --- help topics ---------------------------------------------------------
  // `bt help profiles` explains the profile-list file (Req 2 / Req 4). Kept as a
  // dedicated, hidden command so it is invocable but does not clutter the
  // six-group listing (Req 2.7, 2.8).
  registerHelpTopic(program);

  return program;
}

/**
 * Register the `bt help [topic]` command. With no topic it prints the root help
 * (the six-group listing) to stdout; with the `profiles` topic it explains how
 * the Profile_List_File is resolved and parsed. Hidden so it never appears as a
 * seventh entry in the command-group listing (Req 2.7, 2.8).
 */
function registerHelpTopic(program: Command): void {
  const help = program.command('help [topic]', { hidden: true });
  configureCommand(help, true);
  help.description('Show help for bt, or a help topic (e.g. `bt help profiles`).');
  help.action((topic: string | undefined) => {
    if (topic === 'profiles') {
      stdoutSink.write(PROFILES_HELP_TOPIC);
      return;
    }
    if (topic !== undefined) {
      help.error(`unknown help topic '${topic}'`, { code: 'bt.unknownHelpTopic', exitCode: USAGE_EXIT_CODE });
    }
    program.outputHelp();
  });
}

/** Body of the `bt help profiles` topic (Req 2 / Req 4 profile loading). */
const PROFILES_HELP_TOPIC = `Profile list file (fleet operations)

Fleet commands (--all-profiles) read the AWS profile names to operate on from a
profile list file. The file is resolved in this order:

  1. --profiles-file <path>            (highest precedence)
  2. $PAYER_PROFILES_FILE              (when set to a non-empty value)
  3. ./payer-profiles.txt              (relative to the current working directory)

Format:
  - One AWS profile name per line, in the order you want them processed.
  - Blank lines and lines whose first non-whitespace character is '#' are ignored.
  - Inline '# comments' are stripped; surrounding whitespace is trimmed.

Example payer-profiles.txt:
  # Production payer accounts
  payer-111111111111
  payer-222222222222   # west region
  payer-333333333333

Errors:
  - The file not existing, being unreadable, or yielding zero profiles each halts
    the fleet operation with a non-zero exit before any account is processed.

Scope model (applies to every command):
  --profile <name>   target a single named profile
  --all-profiles     run across every profile in the list (fleet)
  (neither)          use the ambient/active AWS credentials
`;

// ---------------------------------------------------------------------------
// Entrypoint (the single process.exit site)
// ---------------------------------------------------------------------------

/**
 * Parse argv, run the selected command, and exit exactly once with the resolved
 * {@link CliExitCode}. This is the sole `process.exit` site in the CLI: handlers
 * only ever return a code (recorded in {@link resolvedExitCode}); help/version
 * and other commander short-circuits are caught here and translated (help and
 * version → 0, usage/unknown-input → the error's non-zero code).
 */
async function main(): Promise<void> {
  // Configure logging up front from a quick `--verbose` scan so even argv parsing
  // diagnostics never leak to stdout; runHandler reconfigures once options are
  // fully parsed. (Cheap and idempotent.)
  configureCliLogging({ verbose: process.argv.includes('--verbose') });

  const program = buildProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help displayed and version requested are successful, stdout-only exits
      // (Req 1.3-1.6). Every other commander error (unknown command/option,
      // missing argument, …) already wrote its message to stderr and carries a
      // non-zero exit code (Req 1.7).
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        resolvedExitCode = CliExitCode.Success;
      } else {
        resolvedExitCode =
          typeof error.exitCode === 'number' && error.exitCode !== 0
            ? error.exitCode
            : CliExitCode.Usage;
      }
    } else {
      // An unexpected (non-commander) error during parsing/dispatch: report to
      // stderr and exit non-zero (Req 6.4).
      stderrSink.writeLine(`Error: ${toError(error).message}`);
      resolvedExitCode = CliExitCode.GeneralError;
    }
  }

  process.exit(resolvedExitCode);
}

// Run only when invoked as the executable entrypoint, not when imported by a
// test (which exercises `buildProgram` in-process). Guarding the single
// `void main()` call keeps the runtime behavior identical for the real `bt`
// binary while letting tests import this module without triggering argv parsing
// or the `process.exit` site. ESM has no `require.main`; compare this module's
// URL against the process entry script instead.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  void main();
}
