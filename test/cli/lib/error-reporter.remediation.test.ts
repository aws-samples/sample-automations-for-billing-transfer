// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
/**
 * Unit tests for the Error_Reporter remediation hints and stream discipline
 * (Task 5.3, Requirements 6.4, 6.5).
 *
 * Two concerns are covered:
 *  - `remediation()` returns an appropriate, class-specific hint for each
 *    {@link FailureClass} — naming the targeted profile (credentials) and the
 *    failed operation (access-denied), advising retry-after-delay (throttling),
 *    and stating a concrete next step (unknown).
 *  - `report()`, `reportCredentials()`, and `reportUnavailableRegion()` write the
 *    error message and remediation hint to the IoContext **stderr** sink only and
 *    write NOTHING to the **stdout** sink (Req 6.5), so the machine-readable
 *    result stream in `--json` mode can never be corrupted.
 *
 * The reporter is exercised through an in-memory {@link IoContext} whose stdout
 * and stderr {@link OutputSink}s capture everything written to them.
 */

import {
  DefaultErrorReporter,
  errorReporter,
  type FailureClass,
} from '../../../cli/lib/error-reporter.js';
import type { IoContext, OutputSink } from '../../../cli/lib/io-context.js';
import { ResourceRegistry } from '../../../cli/lib/resource-registry.js';

/** An {@link OutputSink} that records everything written to it for assertions. */
class CapturingSink implements OutputSink {
  /** Raw fragments passed to `write` (no implicit newline). */
  readonly raw: string[] = [];
  /** Lines passed to `writeLine`. */
  readonly lines: string[] = [];

  write(text: string): void {
    this.raw.push(text);
  }

  writeLine(line: string): void {
    this.lines.push(line);
  }

  /** Everything that reached this stream, concatenated (writeLine adds a newline). */
  text(): string {
    return this.raw.join('') + this.lines.map((l) => `${l}\n`).join('');
  }

  /** True when nothing at all was written to this stream. */
  isEmpty(): boolean {
    return this.raw.length === 0 && this.lines.length === 0;
  }
}

/**
 * Build a minimal in-memory {@link IoContext} exposing only the stdout/stderr
 * sinks the Error_Reporter touches. The remaining dependencies are irrelevant to
 * these tests, so the object is cast to {@link IoContext}.
 */
function makeIo(): { ctx: IoContext; stdout: CapturingSink; stderr: CapturingSink } {
  const stdout = new CapturingSink();
  const stderr = new CapturingSink();
  const ctx = { stdout, stderr } as unknown as IoContext;
  return { ctx, stdout, stderr };
}

describe('DefaultErrorReporter.remediation — class-specific hints (Req 6.4 supporting 6.1-6.3, 6.6)', () => {
  const reporter = new DefaultErrorReporter();

  describe('credentials', () => {
    it('names the targeted profile and advises verifying its credentials', () => {
      const hint = reporter.remediation('credentials', { profile: 'payer-prod-1' });
      expect(hint).toMatch(/credential/i);
      expect(hint).toContain('payer-prod-1');
      // The hint should suggest a concrete verification action for that profile.
      expect(hint).toContain('--profile payer-prod-1');
    });

    it('falls back to a generic credentials hint when no profile is given', () => {
      const hint = reporter.remediation('credentials');
      expect(hint).toMatch(/credential/i);
      expect(hint.length).toBeGreaterThan(0);
      // No phantom profile naming when none was provided.
      expect(hint).not.toMatch(/profile '/);
    });
  });

  describe('access-denied', () => {
    it('names the failed operation and points at the required permission', () => {
      const hint = reporter.remediation('access-denied', {
        operation: 'organizations:ListAccounts',
        profile: 'payer-prod-1',
      });
      expect(hint).toContain('organizations:ListAccounts');
      expect(hint).toMatch(/permission/i);
    });

    it('still produces a permission hint when the operation is unknown', () => {
      const hint = reporter.remediation('access-denied');
      expect(hint).toMatch(/permission/i);
      expect(hint).toMatch(/this operation/i);
    });
  });

  describe('throttling', () => {
    it('advises retrying after a delay', () => {
      const hint = reporter.remediation('throttling');
      expect(hint).toMatch(/retry/i);
      expect(hint).toMatch(/delay/i);
    });
  });

  describe('unknown', () => {
    it('states a concrete next step the user can take', () => {
      const hint = reporter.remediation('unknown');
      expect(hint.length).toBeGreaterThan(0);
      // A concrete, actionable next step (diagnostics / logs).
      expect(hint).toMatch(/--verbose|--json|log/i);
    });
  });

  it('returns a non-empty hint for every FailureClass', () => {
    const classes: FailureClass[] = ['credentials', 'access-denied', 'throttling', 'unknown'];
    for (const cls of classes) {
      expect(reporter.remediation(cls).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('DefaultErrorReporter.report — stream discipline (Req 6.5)', () => {
  const reporter = new DefaultErrorReporter();

  // Each case is an error that classifies into the named FailureClass and the
  // remediation substring that proves the right hint reached stderr.
  const cases: Array<{
    name: FailureClass;
    error: unknown;
    expectedMessage: string;
    hintMatcher: RegExp;
    ctx?: { profile?: string; operation?: string };
  }> = [
    {
      name: 'credentials',
      error: { name: 'CredentialsProviderError', message: 'Unable to locate credentials' },
      expectedMessage: 'Unable to locate credentials',
      hintMatcher: /credential/i,
      ctx: { profile: 'payer-prod-1' },
    },
    {
      name: 'access-denied',
      error: {
        name: 'AccessDeniedException',
        message: 'User is not authorized to perform organizations:ListAccounts',
      },
      expectedMessage: 'not authorized',
      hintMatcher: /permission/i,
      ctx: { operation: 'organizations:ListAccounts' },
    },
    {
      name: 'throttling',
      error: { name: 'ThrottlingException', message: 'Rate exceeded' },
      expectedMessage: 'Rate exceeded',
      hintMatcher: /retry/i,
    },
    {
      name: 'unknown',
      error: { name: 'ValidationException', message: 'Some unexpected failure' },
      expectedMessage: 'Some unexpected failure',
      hintMatcher: /--verbose|log/i,
    },
  ];

  it.each(cases)(
    'writes the message + remediation for a $name failure to stderr ONLY',
    ({ name, error, expectedMessage, hintMatcher, ctx: hint }) => {
      const { ctx, stdout, stderr } = makeIo();

      const cls = reporter.report(error, ctx, hint);

      // Classified into the expected class.
      expect(cls).toBe(name);

      // Nothing reached stdout (Req 6.5).
      expect(stdout.isEmpty()).toBe(true);

      // Both the error message and a remediation hint reached stderr.
      const err = stderr.text();
      expect(err).toContain(expectedMessage);
      expect(err).toMatch(/error:/i);
      expect(err).toMatch(/hint:/i);
      expect(err).toMatch(hintMatcher);
    },
  );

  it('names the targeted profile in the credentials hint on stderr', () => {
    const { ctx, stdout, stderr } = makeIo();
    reporter.report(
      { name: 'CredentialsProviderError', message: 'Unable to locate credentials' },
      ctx,
      { profile: 'payer-prod-1' },
    );
    expect(stdout.isEmpty()).toBe(true);
    expect(stderr.text()).toContain('payer-prod-1');
  });

  it('names the failed operation in the access-denied hint on stderr', () => {
    const { ctx, stdout, stderr } = makeIo();
    reporter.report(
      { name: 'AccessDeniedException', message: 'not authorized' },
      ctx,
      { operation: 'lambda:InvokeFunction' },
    );
    expect(stdout.isEmpty()).toBe(true);
    expect(stderr.text()).toContain('lambda:InvokeFunction');
  });

  it('emits a transient-retry hint for an unknown-but-retryable failure, still stderr-only', () => {
    const { ctx, stdout, stderr } = makeIo();
    // ServiceUnavailableException is retryable but not credentials/access-denied/throttling.
    const cls = reporter.report(
      { name: 'ServiceUnavailableException', message: 'Service is unavailable' },
      ctx,
    );
    expect(cls).toBe('unknown');
    expect(stdout.isEmpty()).toBe(true);
    expect(stderr.text()).toMatch(/transient/i);
  });
});

describe('DefaultErrorReporter.reportCredentials — stderr only (Req 6.5)', () => {
  const reporter = new DefaultErrorReporter();

  it('writes the credentials error and hint to stderr and nothing to stdout', () => {
    const { ctx, stdout, stderr } = makeIo();
    reporter.reportCredentials(ctx, { profile: 'payer-prod-1' });

    expect(stdout.isEmpty()).toBe(true);
    const err = stderr.text();
    expect(err).toMatch(/error:/i);
    expect(err).toMatch(/hint:/i);
    expect(err).toMatch(/credential/i);
    expect(err).toContain('payer-prod-1');
  });

  it('reports against the active credential chain when no profile is given, stderr only', () => {
    const { ctx, stdout, stderr } = makeIo();
    reporter.reportCredentials(ctx);

    expect(stdout.isEmpty()).toBe(true);
    expect(stderr.text()).toMatch(/credential/i);
  });
});

describe('DefaultErrorReporter.reportUnavailableRegion — stderr only (Req 6.5)', () => {
  const reporter = new DefaultErrorReporter();

  it('writes the unavailable-region error and hint to stderr and nothing to stdout', () => {
    const { ctx, stdout, stderr } = makeIo();
    reporter.reportUnavailableRegion(ctx, { region: 'us-west-2', profile: 'payer-prod-1' });

    expect(stdout.isEmpty()).toBe(true);
    const err = stderr.text();
    expect(err).toMatch(/error:/i);
    expect(err).toMatch(/hint:/i);
    expect(err).toContain('us-west-2');
    expect(err).toContain('payer-prod-1');
  });

  it('defaults to the Resource_Registry Default_Region when no region is given', () => {
    const { ctx, stdout, stderr } = makeIo();
    reporter.reportUnavailableRegion(ctx);

    expect(stdout.isEmpty()).toBe(true);
    expect(stderr.text()).toContain(ResourceRegistry.defaultRegion);
  });
});

describe('shared errorReporter singleton', () => {
  it('exposes the same stderr-only report contract', () => {
    const { ctx, stdout, stderr } = makeIo();
    const cls = errorReporter.report({ name: 'ThrottlingException', message: 'Rate exceeded' }, ctx);

    expect(cls).toBe('throttling');
    expect(stdout.isEmpty()).toBe(true);
    expect(stderr.text()).toMatch(/hint:/i);
  });
});
