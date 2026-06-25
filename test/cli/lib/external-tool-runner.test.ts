// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';
import {
  createExternalToolRunner,
  NodeExternalToolRunner,
  type SpawnFn,
} from '../../../cli/lib/external-tool-runner.js';

/**
 * Unit tests for the ExternalToolRunner in-memory fake seam and `render`
 * (Requirement 7.5).
 *
 * These example-based assertions pin down three contracts of
 * {@link NodeExternalToolRunner} / {@link createExternalToolRunner}, all proven
 * with an injected in-memory spawn function so no real `cdk`/`git`/`aws` process
 * is ever started:
 *
 *  1. The injected fake SpawnFn records each invocation (command, args, env, and
 *     cwd) and returns a fake ChildProcess whose canned stdout/stderr/exit are
 *     surfaced verbatim in the resolved {@link ToolResult} — i.e. the runner
 *     spawns through the seam and never touches a real process.
 *  2. Non-interactive defaults are applied per tool: `aws` gets `--no-cli-pager`
 *     and `AWS_PAGER=''`, `cdk deploy` gets `--require-approval never`, `cdk`
 *     gets `--output <dir>` when an outputDir is set, and `git` gets
 *     `GIT_TERMINAL_PROMPT=0`.
 *  3. `render(cmd, args, opts)` returns the exact planned command line (including
 *     the injected non-interactive flags and the `AWS_PROFILE=` prefix when a
 *     profile is set) WITHOUT invoking the spawn fn at all.
 */

/** A single recorded call to the injected spawn function. */
interface RecordedInvocation {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** Canned output the fake child process replays once listeners are attached. */
interface CannedOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * Minimal fake of a Node {@link ChildProcess}: an EventEmitter with `stdout` and
 * `stderr` EventEmitter streams, matching exactly the surface the runner uses
 * (`stdout.on('data')`, `stderr.on('data')`, `on('error')`, `on('close')`).
 */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

/**
 * Build an in-memory SpawnFn that records every invocation and returns a fake
 * ChildProcess which, after the runner attaches its listeners, emits the canned
 * stdout/stderr then a `close` with the canned exit code/signal. No OS process
 * is ever created.
 */
function makeFakeSpawn(canned: CannedOutput = {}): {
  spawnFn: SpawnFn;
  invocations: RecordedInvocation[];
} {
  const invocations: RecordedInvocation[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    invocations.push({ command, args: [...args], options });
    const child = new FakeChildProcess();
    // Defer emission so the runner's listeners (attached synchronously after
    // spawn returns) are in place before data/close fire.
    setImmediate(() => {
      if (canned.stdout !== undefined) {
        child.stdout.emit('data', Buffer.from(canned.stdout));
      }
      if (canned.stderr !== undefined) {
        child.stderr.emit('data', Buffer.from(canned.stderr));
      }
      child.emit('close', canned.exitCode ?? 0, canned.signal ?? null);
    });
    return child as unknown as ChildProcess;
  };
  return { spawnFn, invocations };
}

describe('ExternalToolRunner in-memory fake and render (Req 7.5)', () => {
  describe('injected fake records invocations and surfaces canned output (no real spawn)', () => {
    it('records command, args, env, and cwd, and surfaces canned stdout/stderr/exit in the ToolResult', async () => {
      const { spawnFn, invocations } = makeFakeSpawn({
        stdout: 'remote url\n',
        stderr: 'a diagnostic line\n',
        exitCode: 0,
      });
      const runner = createExternalToolRunner(spawnFn);

      const result = await runner.git(['remote', 'get-url', 'codecommit-payer-a'], {
        profile: 'payer-a',
        cwd: '/work/repo',
      });

      // Exactly one invocation was recorded through the seam (no real process).
      expect(invocations).toHaveLength(1);
      const [call] = invocations;
      expect(call.command).toBe('git');
      expect(call.args).toEqual(['remote', 'get-url', 'codecommit-payer-a']);
      // env and cwd are recorded on the spawn options.
      expect(call.options.cwd).toBe('/work/repo');
      expect(call.options.env).toMatchObject({
        AWS_PROFILE: 'payer-a',
        GIT_TERMINAL_PROMPT: '0',
      });

      // The fake child's canned streams/exit are surfaced verbatim.
      expect(result.stdout).toBe('remote url\n');
      expect(result.stderr).toBe('a diagnostic line\n');
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      // The returned command line matches what render would produce.
      expect(result.command).toBe('AWS_PROFILE=payer-a git remote get-url codecommit-payer-a');
    });

    it('surfaces a non-zero exit code as data rather than throwing', async () => {
      const { spawnFn } = makeFakeSpawn({ stdout: '', stderr: 'denied\n', exitCode: 2 });
      const runner = createExternalToolRunner(spawnFn);

      const result = await runner.run('git', ['push', 'origin', 'main']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('denied\n');
    });

    it('mirrors the command line and child stderr to the per-account log stream', async () => {
      const { spawnFn } = makeFakeSpawn({ stderr: 'progress...\n', exitCode: 0 });
      const runner = createExternalToolRunner(spawnFn);
      const written: string[] = [];
      const logStream = { write: (chunk: string | Uint8Array) => written.push(chunk.toString()) };

      await runner.aws(['sts', 'get-caller-identity'], { profile: 'payer-a', logStream });

      // First the rendered command line, then the mirrored stderr.
      expect(written[0]).toBe('$ AWS_PROFILE=payer-a aws sts get-caller-identity --no-cli-pager\n');
      expect(written).toContain('progress...\n');
    });
  });

  describe('non-interactive defaults are applied per tool', () => {
    it('aws: appends --no-cli-pager and clears AWS_PAGER', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.aws(['organizations', 'list-accounts']);

      const [call] = invocations;
      expect(call.args).toEqual(['organizations', 'list-accounts', '--no-cli-pager']);
      expect(call.options.env).toMatchObject({ AWS_PAGER: '' });
    });

    it('aws: does not duplicate --no-cli-pager when already present', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.aws(['s3', 'ls', '--no-cli-pager']);

      expect(invocations[0].args.filter((a) => a === '--no-cli-pager')).toHaveLength(1);
    });

    it('cdk deploy: appends --require-approval never', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.cdk(['deploy', 'MyStack']);

      expect(invocations[0].args).toEqual(['deploy', 'MyStack', '--require-approval', 'never']);
    });

    it('cdk deploy: does not override an explicit --require-approval', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.cdk(['deploy', 'MyStack', '--require-approval', 'broadening']);

      expect(invocations[0].args).toEqual([
        'deploy',
        'MyStack',
        '--require-approval',
        'broadening',
      ]);
    });

    it('cdk: appends --output <dir> when outputDir is set and not already provided', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.cdk(['deploy', 'MyStack'], { outputDir: 'cdk.out.payer-a' });

      expect(invocations[0].args).toEqual([
        'deploy',
        'MyStack',
        '--require-approval',
        'never',
        '--output',
        'cdk.out.payer-a',
      ]);
    });

    it('cdk: does not add --output when one is already provided', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.cdk(['synth', '--output', 'custom.out'], { outputDir: 'cdk.out.payer-a' });

      expect(invocations[0].args).toEqual(['synth', '--output', 'custom.out']);
    });

    it('git: sets GIT_TERMINAL_PROMPT=0', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.git(['push', 'codecommit-payer-a', 'main']);

      expect(invocations[0].options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
    });

    it('exports AWS_PROFILE to the child when a profile is supplied', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.run('aws', ['sts', 'get-caller-identity'], { profile: 'payer-b' });

      expect(invocations[0].options.env).toMatchObject({ AWS_PROFILE: 'payer-b' });
    });

    it('nonInteractive:false runs the tool exactly as given (no injected flags)', async () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      await runner.aws(['s3', 'ls'], { nonInteractive: false });

      // No non-interactive flag is appended to the args...
      expect(invocations[0].args).toEqual(['s3', 'ls']);
      // ...and the rendered command line carries no injected flag either.
      expect(runner.render('aws', ['s3', 'ls'], { nonInteractive: false })).toBe('aws s3 ls');
    });
  });

  describe('render returns the exact planned command line WITHOUT spawning', () => {
    it('does not invoke the spawn fn at all', () => {
      const { spawnFn, invocations } = makeFakeSpawn();
      const runner = createExternalToolRunner(spawnFn);

      runner.render('git', ['push', 'codecommit-payer-a', 'main'], { profile: 'payer-a' });

      expect(invocations).toHaveLength(0);
    });

    it('renders aws with the injected --no-cli-pager flag and AWS_PROFILE= prefix', () => {
      const runner = new NodeExternalToolRunner();

      const line = runner.render('aws', ['organizations', 'list-accounts'], { profile: 'payer-a' });

      expect(line).toBe('AWS_PROFILE=payer-a aws organizations list-accounts --no-cli-pager');
    });

    it('renders cdk deploy with --require-approval never and --output from outputDir', () => {
      const runner = new NodeExternalToolRunner();

      const line = runner.render('cdk', ['deploy', 'MyStack'], {
        profile: 'payer-a',
        outputDir: 'cdk.out.payer-a',
      });

      expect(line).toBe(
        'AWS_PROFILE=payer-a cdk deploy MyStack --require-approval never --output cdk.out.payer-a',
      );
    });

    it('omits the AWS_PROFILE= prefix when no profile is set', () => {
      const runner = new NodeExternalToolRunner();

      const line = runner.render('git', ['status']);

      expect(line).toBe('git status');
    });

    it('shell-quotes arguments that contain unsafe characters (exact command line)', () => {
      const runner = new NodeExternalToolRunner();

      const line = runner.render('git', ['commit', '-m', 'a message'], { nonInteractive: false });

      expect(line).toBe("git commit -m 'a message'");
    });

    it('render matches the command surfaced by a real (faked) run', async () => {
      const { spawnFn, invocations } = makeFakeSpawn({ exitCode: 0 });
      const runner = createExternalToolRunner(spawnFn);
      const opts = { profile: 'payer-a', outputDir: 'cdk.out.payer-a' };

      const rendered = runner.render('cdk', ['deploy', 'MyStack'], opts);
      // render alone spawns nothing.
      expect(invocations).toHaveLength(0);

      const result = await runner.cdk(['deploy', 'MyStack'], opts);
      // Now exactly one spawn occurred, and its command line equals render's.
      expect(invocations).toHaveLength(1);
      expect(result.command).toBe(rendered);
    });
  });
});
