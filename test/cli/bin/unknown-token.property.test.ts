// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based test for the `bt` entrypoint's unknown-token rejection contract.
 *
 * Covers the design's Correctness Property 18 (Unknown command or option is
 * rejected on stderr with a non-zero exit): for ANY input token that is not a
 * recognized Command, Command_Group, or option, the CLI writes an error message
 * naming the unrecognized input to standard error, writes nothing to standard
 * output, and exits with a non-zero status code (Req 1.7).
 *
 * The implementation under test is `buildProgram` from `cli/bin/bt.ts`. The real
 * entrypoint calls `process.exit` and reads `process.argv`, so it must normally
 * be exercised as a child process — spawning it 100+ times would be far too slow.
 * Instead this test drives the SAME commander `Command` tree in-process: the
 * program is already wired with `exitOverride()` (it throws a `CommanderError`
 * instead of calling `process.exit`) and a `configureOutput` that mirrors the
 * production stream discipline (help/version → stdout, every error → stderr).
 * Each run captures `process.stdout.write` / `process.stderr.write`, parses the
 * generated tokens with `{ from: 'user' }`, and asserts the rejection semantics
 * WITHOUT spawning. The single `void main()` site in `bt.ts` is guarded by
 * `require.main === module`, so importing the module here does not trigger argv
 * parsing or the process-exit site.
 *
 * Generators produce tokens drawn from OUTSIDE the known command/option set:
 * unknown top-level commands, unknown long options (`--xxx`), unknown short
 * options (`-x`), and unknown sub-commands of a known group. The success-path
 * short-circuits (`--help`, `-h`, `--version`, `-v`, and the six real groups /
 * their real sub-commands) are filtered out so every generated case is a genuine
 * usage error.
 *
 * Validates: Requirements 1.7
 */

import { CommanderError } from 'commander';
import fc from 'fast-check';

import { buildProgram } from '../../../cli/bin/bt.js';

// ---------------------------------------------------------------------------
// The known token space (anything NOT in here is a candidate unknown token)
// ---------------------------------------------------------------------------

/** The six real Command_Groups registered on the root. */
const GROUPS = ['transfers', 'reconciliation', 'fleet', 'git', 'partner-central', 'test'] as const;

/** Real sub-commands per group (the only tokens a group accepts after its name). */
const SUBCOMMANDS: Record<(typeof GROUPS)[number], readonly string[]> = {
  transfers: ['analyze'],
  reconciliation: ['trigger', 'status'],
  fleet: ['deploy', 'status'],
  git: ['setup-remotes', 'push'],
  'partner-central': ['register-pma', 'seed-params'],
  test: ['termination'],
};

/** Known root-level commands: the six groups plus the hidden `help` topic. */
const KNOWN_ROOT_COMMANDS = new Set<string>([...GROUPS, 'help']);

/**
 * Known long-option names accepted on every command (global options) plus the
 * negation/positive color forms and the help/version forms. A generated
 * `--<word>` is only "unknown" when its word is not in this set.
 */
const KNOWN_LONG_OPTIONS = new Set<string>([
  'profile',
  'all-profiles',
  'profiles-file',
  'json',
  'no-color',
  'color',
  'execute',
  'parallel',
  'verbose',
  'help',
  'version',
]);

/** Known short-option letters: -p (profile), -h (help), -v (version). */
const KNOWN_SHORT_OPTIONS = new Set<string>(['p', 'h', 'v']);

// ---------------------------------------------------------------------------
// In-process CLI driver (captures the real stdout/stderr streams)
// ---------------------------------------------------------------------------

interface CliRun {
  /** Everything the CLI wrote to standard output during the parse. */
  stdout: string;
  /** Everything the CLI wrote to standard error during the parse. */
  stderr: string;
  /** The thrown error, if any (a `CommanderError` for usage errors). */
  error: unknown;
}

/**
 * Build a fresh program (commander mutates parse state, so each run gets its own
 * tree) and parse the supplied user tokens, capturing both process streams.
 * `process.stdout.write` / `process.stderr.write` are the exact sinks the
 * entrypoint's `configureOutput` targets, so capturing them observes the true
 * production stream discipline. They are always restored, even on throw.
 */
function runCli(tokens: string[]): CliRun {
  let stdout = '';
  let stderr = '';

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any): boolean => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any): boolean => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  let error: unknown;
  try {
    const program = buildProgram();
    // `from: 'user'` parses the tokens as already-split user args (no node/script
    // prefix), exactly the argv tail commander would otherwise receive.
    program.parse(tokens, { from: 'user' });
  } catch (err) {
    error = err;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { stdout, stderr, error };
}

// ---------------------------------------------------------------------------
// Generators for tokens OUTSIDE the known command/option set
// ---------------------------------------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ID_CHARS = [...LETTERS, ...'0123456789-'.split('')];

/**
 * An identifier-shaped word: starts with a letter, followed by letters, digits,
 * or dashes. Shaped this way so it can never be mistaken for an option (no
 * leading dash) and is a realistic command/sub-command token.
 */
const wordArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...LETTERS), fc.array(fc.constantFrom(...ID_CHARS), { maxLength: 14 }))
  .map(([head, rest]) => head + rest.join(''));

/** A generated usage-error case: the tokens to parse and the offending token. */
interface UnknownCase {
  tokens: string[];
  /** The token the error message must name on stderr. */
  unknownToken: string;
}

/** An unknown top-level command: a word that is not a group and not `help`. */
const unknownCommandArb: fc.Arbitrary<UnknownCase> = wordArb
  .filter((w) => !KNOWN_ROOT_COMMANDS.has(w))
  .map((w) => ({ tokens: [w], unknownToken: w }));

/** An unknown long option `--<word>` whose word is not a known global option. */
const unknownLongOptionArb: fc.Arbitrary<UnknownCase> = wordArb
  .filter((w) => !KNOWN_LONG_OPTIONS.has(w))
  .map((w) => ({ tokens: [`--${w}`], unknownToken: `--${w}` }));

/** An unknown short option `-<letter>` that is not -p, -h, or -v. */
const unknownShortOptionArb: fc.Arbitrary<UnknownCase> = fc
  .constantFrom(...LETTERS)
  .filter((c) => !KNOWN_SHORT_OPTIONS.has(c))
  .map((c) => ({ tokens: [`-${c}`], unknownToken: `-${c}` }));

/** An unknown sub-command of a real group: `<group> <word>` where word is not a real sub-command. */
const unknownGroupSubcommandArb: fc.Arbitrary<UnknownCase> = fc
  .constantFrom(...GROUPS)
  .chain((group) =>
    wordArb
      .filter((w) => !SUBCOMMANDS[group].includes(w))
      .map((w) => ({ tokens: [group, w], unknownToken: w })),
  );

/** The full unknown-token space exercised by the property. */
const unknownCaseArb: fc.Arbitrary<UnknownCase> = fc.oneof(
  unknownCommandArb,
  unknownLongOptionArb,
  unknownShortOptionArb,
  unknownGroupSubcommandArb,
);

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe('bt entrypoint — unknown-token rejection (Property 18)', () => {
  // Feature: billing-transfer-cli, Property 18: Unknown command or option is rejected on stderr with a non-zero exit
  it('rejects any token outside the known command/option set on stderr with a non-zero exit and nothing on stdout', () => {
    fc.assert(
      fc.property(unknownCaseArb, ({ tokens, unknownToken }) => {
        const { stdout, stderr, error } = runCli(tokens);

        // (1) The CLI rejects the input via commander's exitOverride: a
        //     CommanderError is thrown rather than a process exit (Req 1.7).
        expect(error).toBeInstanceOf(CommanderError);
        const commanderError = error as CommanderError;

        // (2) The rejection is NOT one of the success short-circuits (help shown
        //     or version requested), which the entrypoint maps to exit 0; every
        //     generated token is a genuine usage error.
        expect(commanderError.code).not.toBe('commander.helpDisplayed');
        expect(commanderError.code).not.toBe('commander.version');

        // (3) The exit status is a non-zero number — exactly what the single
        //     process.exit site in main() would translate this error into.
        expect(typeof commanderError.exitCode).toBe('number');
        expect(commanderError.exitCode).not.toBe(0);

        // (4) Nothing is written to standard output for the rejection: the result
        //     stream stays clean (Req 1.7 / Property 18).
        expect(stdout).toBe('');

        // (5) An error message naming the unrecognized input is written to
        //     standard error.
        expect(stderr.length).toBeGreaterThan(0);
        expect(stderr).toContain(unknownToken);
      }),
      { numRuns: 300 },
    );
  });
});
