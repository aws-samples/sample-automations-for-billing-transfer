// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Feature: billing-transfer-cli, Property 5: AWS error classification is total and follows the fixed precedence

import { describe, it, expect } from '@jest/globals';
/**
 * Property-based tests for {@link DefaultErrorReporter.classify} (the `errorReporter`
 * exported from `cli/lib/error-reporter.ts`).
 *
 * Property 5: AWS error classification is total and follows the fixed precedence.
 * Validates: Requirements 6.1, 6.2, 6.3, 6.6, 6.7
 *
 * Two facets are exercised:
 *   1. Totality — every conceivable input (arbitrary JS values, strings, nulls,
 *      Error instances, and AWS-SDK-shaped errors with `name`/`code`/`$metadata`)
 *      maps to exactly one of the four FailureClass values. Because `classify`
 *      returns a single value, membership in the value set proves "exactly one".
 *   2. Fixed precedence — when an input matches multiple recognized signals, the
 *      higher-precedence class wins, in the order
 *      credentials > access-denied > throttling > unknown (Req 6.7).
 *
 * Each property runs at least 100 fast-check iterations.
 */

import fc from 'fast-check';
import { errorReporter, type FailureClass } from '../../../cli/lib/error-reporter.js';

const VALID_CLASSES: readonly FailureClass[] = [
  'credentials',
  'access-denied',
  'throttling',
  'unknown',
];

// ---------------------------------------------------------------------------
// Trigger vocabulary
//
// Representative subsets of the real detection vocabulary in error-reporter.ts.
// The three message-pattern pools are mutually non-overlapping (no pool's string
// contains a trigger substring belonging to another class), so concatenating a
// selection of them in one message activates exactly the intended set of classes
// and nothing else. Likewise, none of the per-class codes is matched by another
// class's code/critical sets, so a code activates exactly its own class.
// ---------------------------------------------------------------------------

const CREDENTIAL_CODES = [
  'CredentialsProviderError',
  'InvalidClientTokenId',
  'ExpiredTokenException',
  'UnrecognizedClientException',
  'InvalidAccessKeyId',
] as const;
const CREDENTIAL_MSGS = [
  'credentials are missing',
  'unable to locate credentials',
  'the security token is invalid',
  'expired token detected',
] as const;

const ACCESS_CODES = [
  'AccessDeniedException',
  'UnauthorizedException',
  'AccessDenied',
  'AuthorizationError',
  'Forbidden',
] as const;
const ACCESS_MSGS = [
  'access denied',
  'not authorized',
  'is not authorized to perform',
  'forbidden',
] as const;

const THROTTLE_CODES = [
  'ThrottlingException',
  'TooManyRequestsException',
  'Throttling',
  'RequestThrottled',
  'SlowDown',
] as const;
const THROTTLE_MSGS = [
  'throttling detected',
  'rate exceeded',
  'rate limit reached',
  'too many requests',
] as const;

// A filler that contains NO trigger substring of any class, used to exercise the
// `unknown` path and to pad messages without changing classification.
const SAFE_FILLER = 'op=ListAccounts id=12345';

type Channel = 'none' | 'code' | 'message' | 'status';

function expectedClass(active: ReadonlySet<FailureClass>): FailureClass {
  if (active.has('credentials')) return 'credentials';
  if (active.has('access-denied')) return 'access-denied';
  if (active.has('throttling')) return 'throttling';
  return 'unknown';
}

describe('Error_Reporter classify — Property 5: total and fixed precedence', () => {
  // -------------------------------------------------------------------------
  // Property 5a: Totality — every input maps to exactly one FailureClass.
  // -------------------------------------------------------------------------
  it('is total: any value classifies to exactly one FailureClass (Req 6.1, 6.2, 6.3, 6.6)', () => {
    // SDK-shaped errors carrying name/code/$metadata, plus arbitrary junk values.
    const sdkShapedError = fc
      .record(
        {
          name: fc.string(),
          code: fc.string(),
          message: fc.string(),
          httpStatusCode: fc.integer({ min: 100, max: 599 }),
        },
        { requiredKeys: [] },
      )
      .map((r) => {
        const err: Record<string, unknown> = {};
        if (r.name !== undefined) err.name = r.name;
        if (r.code !== undefined) err.code = r.code;
        if (r.message !== undefined) err.message = r.message;
        if (r.httpStatusCode !== undefined) err.$metadata = { httpStatusCode: r.httpStatusCode };
        return err;
      });

    const realError = fc
      .tuple(fc.string(), fc.option(fc.string(), { nil: undefined }))
      .map(([message, name]) => {
        const e = new Error(message);
        if (name !== undefined) e.name = name;
        return e;
      });

    const anyInput = fc.oneof(
      fc.anything(), // objects, arrays, numbers, booleans, strings, null
      fc.constantFrom(null, undefined, '', 0, NaN, false, [], {}),
      fc.string(),
      sdkShapedError,
      realError,
    );

    fc.assert(
      fc.property(anyInput, (input) => {
        const cls = errorReporter.classify(input);
        // Total: result is one of the four classes...
        expect(VALID_CLASSES).toContain(cls);
        // ...and deterministic (same input always yields the same class).
        expect(errorReporter.classify(input)).toBe(cls);
      }),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 5b: Fixed precedence across single and multiple co-occurring signals.
  //
  // We activate each class through an independent channel (code / message /
  // HTTP status). The classifier must return the highest-precedence active class
  // regardless of which channel carries each signal.
  // -------------------------------------------------------------------------
  it('returns the highest-precedence class when signals co-occur (Req 6.7)', () => {
    const spec = fc.record({
      cred: fc.constantFrom<Channel>('none', 'code', 'message'),
      access: fc.constantFrom<Channel>('none', 'code', 'message', 'status'),
      throttle: fc.constantFrom<Channel>('none', 'code', 'message', 'status'),
      credCode: fc.constantFrom(...CREDENTIAL_CODES),
      credMsg: fc.constantFrom(...CREDENTIAL_MSGS),
      accessCode: fc.constantFrom(...ACCESS_CODES),
      accessMsg: fc.constantFrom(...ACCESS_MSGS),
      throttleCode: fc.constantFrom(...THROTTLE_CODES),
      throttleMsg: fc.constantFrom(...THROTTLE_MSGS),
      codeField: fc.constantFrom<'code' | 'name'>('code', 'name'),
      asError: fc.boolean(),
      includeFiller: fc.boolean(),
    });

    fc.assert(
      fc.property(spec, (r) => {
        let cred = r.cred;
        let access = r.access;
        let throttle = r.throttle;

        // A single error object has one `code`/`name` field: keep the
        // highest-precedence code claimant, downgrade the rest to `message`
        // (still a valid signal for the same class, so the active set is unchanged).
        const codeClaimants: Array<'cred' | 'access' | 'throttle'> = [];
        if (cred === 'code') codeClaimants.push('cred');
        if (access === 'code') codeClaimants.push('access');
        if (throttle === 'code') codeClaimants.push('throttle');
        for (const loser of codeClaimants.slice(1)) {
          if (loser === 'cred') cred = 'message';
          else if (loser === 'access') access = 'message';
          else throttle = 'message';
        }

        // A single `$metadata.httpStatusCode` can encode only one status: 403
        // maps to access-denied, 429 to throttling. Keep access, downgrade throttle.
        if (access === 'status' && throttle === 'status') throttle = 'message';

        // Assemble the message from the chosen message-channel patterns.
        const messageParts: string[] = [];
        if (cred === 'message') messageParts.push(r.credMsg);
        if (access === 'message') messageParts.push(r.accessMsg);
        if (throttle === 'message') messageParts.push(r.throttleMsg);
        if (r.includeFiller) messageParts.push(SAFE_FILLER);
        const message = messageParts.length > 0 ? messageParts.join(' | ') : undefined;

        // At most one class claims the code channel after conflict resolution.
        let codeValue: string | undefined;
        if (cred === 'code') codeValue = r.credCode;
        else if (access === 'code') codeValue = r.accessCode;
        else if (throttle === 'code') codeValue = r.throttleCode;

        // At most one class claims the status channel after conflict resolution.
        let status: number | undefined;
        if (access === 'status') status = 403;
        else if (throttle === 'status') status = 429;

        // Build the error as either an Error instance or a plain SDK-shaped object.
        let err: Record<string, unknown> | Error;
        if (r.asError) {
          const e = new Error(message ?? '');
          if (codeValue !== undefined) (e as Record<string, unknown>)[r.codeField] = codeValue;
          err = e;
        } else {
          const o: Record<string, unknown> = {};
          if (message !== undefined) o.message = message;
          if (codeValue !== undefined) o[r.codeField] = codeValue;
          err = o;
        }
        if (status !== undefined) {
          (err as Record<string, unknown>).$metadata = { httpStatusCode: status };
        }

        const active = new Set<FailureClass>();
        if (cred !== 'none') active.add('credentials');
        if (access !== 'none') active.add('access-denied');
        if (throttle !== 'none') active.add('throttling');

        expect(errorReporter.classify(err)).toBe(expectedClass(active));
      }),
      { numRuns: 400 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 5c: The documented precedence example — a credential code combined
  // with a throttling message must classify as credentials, never throttling.
  // -------------------------------------------------------------------------
  it('classifies credential-code + throttling-message as credentials (Req 6.7)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CREDENTIAL_CODES),
        fc.constantFrom(...THROTTLE_MSGS),
        fc.constantFrom<'code' | 'name'>('code', 'name'),
        (code, throttleMessage, field) => {
          const err: Record<string, unknown> = { message: `${throttleMessage} | ${SAFE_FILLER}` };
          err[field] = code;
          expect(errorReporter.classify(err)).toBe('credentials');
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 5d: Access-denied outranks throttling when both signals co-occur.
  // -------------------------------------------------------------------------
  it('classifies access-denied over throttling when both co-occur (Req 6.7)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ACCESS_MSGS),
        fc.constantFrom(...THROTTLE_CODES),
        (accessMessage, throttleCode) => {
          const err = { code: throttleCode, message: `${accessMessage} | ${SAFE_FILLER}` };
          expect(errorReporter.classify(err)).toBe('access-denied');
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 5e: Each single signal in isolation maps to its own class, and an
  // input carrying no recognized signal maps to `unknown` (Req 6.6).
  // -------------------------------------------------------------------------
  it('classifies each isolated signal to its own class and otherwise to unknown', () => {
    const credSignal = fc
      .oneof(fc.constantFrom(...CREDENTIAL_CODES), fc.constantFrom(...CREDENTIAL_MSGS))
      .map((v) => ({ value: v, expected: 'credentials' as FailureClass }));
    const accessSignal = fc
      .oneof(fc.constantFrom(...ACCESS_CODES), fc.constantFrom(...ACCESS_MSGS))
      .map((v) => ({ value: v, expected: 'access-denied' as FailureClass }));
    const throttleSignal = fc
      .oneof(fc.constantFrom(...THROTTLE_CODES), fc.constantFrom(...THROTTLE_MSGS))
      .map((v) => ({ value: v, expected: 'throttling' as FailureClass }));

    // Single-signal cases: put the trigger in `code` (codes) or `message` (phrases).
    fc.assert(
      fc.property(fc.oneof(credSignal, accessSignal, throttleSignal), ({ value, expected }) => {
        const asCode = errorReporter.classify({ code: value });
        const asMessage = errorReporter.classify({ message: `${value} | ${SAFE_FILLER}` });
        // The trigger classifies to its class via at least one of the channels;
        // codes classify via the code channel, phrases via the message channel.
        expect([asCode, asMessage]).toContain(expected);
      }),
      { numRuns: 200 },
    );

    // No-signal case: benign messages and unrelated codes are `unknown`.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(SAFE_FILLER),
          fc.constantFrom('ResourceNotFoundException', 'ValidationException', 'ConflictException'),
        ),
        (benign) => {
          expect(errorReporter.classify({ message: SAFE_FILLER, name: benign })).toBe('unknown');
        },
      ),
      { numRuns: 100 },
    );
  });
});
