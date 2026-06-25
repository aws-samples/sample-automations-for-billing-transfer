// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
import {
  inputValidator,
  Result,
  VALID_PMA_PROGRAMS,
  VALID_RECONCILIATION_TARGETS,
} from '../../../cli/lib/input-validator.js';
import { VALID_STATES, VALID_TYPES } from '../../../lib/lambda/common/models/billing-transfer.js';

const __dirname = __pathDirname(__fileURLToPath(import.meta.url));

/**
 * Unit / example tests for Input_Validator edge cases (Requirements 5.2, 5.7).
 *
 * These complement the account-id and enumeration property tests by pinning the
 * concrete rejection edge cases a non-expert operator is most likely to type:
 * leading/trailing/internal whitespace, a leading sign, digit-group separators,
 * and wrong-length inputs (Req 5.2). They also lock the rejected {@link Result}
 * contract — the offending value and the complete accepted-values list the
 * Error_Reporter renders (Req 5.7) — and assert structurally that a rejection
 * initiates no AWS call (the validators are pure: no AWS client is constructed
 * and nothing is `.send()`-ed; a rejection simply returns `{ ok: false }`).
 */
describe('Input_Validator edge cases (Req 5.2, 5.7)', () => {
  /** The exact accepted-values list account-id rejections must carry (Req 5.7). */
  const ACCOUNT_ID_ACCEPTED = [
    'a 12-digit AWS account id (digits 0-9 only, no whitespace, separators, or sign)',
  ];

  /** Narrows a Result to its rejection branch, failing loudly otherwise. */
  function expectRejected<T>(result: Result<T>): { ok: false; invalidValue: string; accepted: string[] } {
    if (result.ok) {
      throw new Error(`expected a rejected Result, but it accepted: ${JSON.stringify(result)}`);
    }
    return result;
  }

  describe('accountId rejects whitespace (Req 5.2)', () => {
    // A 12-digit core surrounded/interrupted by every flavour of whitespace.
    const whitespaceCases: Array<[string, string]> = [
      ['leading space', ' 123456789012'],
      ['trailing space', '123456789012 '],
      ['leading + trailing space', ' 123456789012 '],
      ['internal space', '123456 789012'],
      ['leading tab', '\t123456789012'],
      ['trailing newline', '123456789012\n'],
      ['internal tab', '12345678\t9012'],
      ['all spaces', '            '],
    ];

    it.each(whitespaceCases)('rejects %s', (_label, value) => {
      const result = inputValidator.accountId(value);
      const rejection = expectRejected(result);
      // The offending value is echoed back verbatim, whitespace included (Req 5.7).
      expect(rejection.invalidValue).toBe(value);
      expect(rejection.accepted).toEqual(ACCOUNT_ID_ACCEPTED);
    });
  });

  describe('accountId rejects a leading sign (Req 5.2)', () => {
    const signCases: Array<[string, string]> = [
      ['plus sign, 12-char total', '+12345678901'],
      ['minus sign, 12-char total', '-12345678901'],
      ['plus sign before 12 digits', '+123456789012'],
      ['minus sign before 12 digits', '-123456789012'],
    ];

    it.each(signCases)('rejects %s', (_label, value) => {
      const rejection = expectRejected(inputValidator.accountId(value));
      expect(rejection.invalidValue).toBe(value);
      expect(rejection.accepted).toEqual(ACCOUNT_ID_ACCEPTED);
    });
  });

  describe('accountId rejects digit separators (Req 5.2)', () => {
    const separatorCases: Array<[string, string]> = [
      ['hyphen separators', '1234-5678-9012'],
      ['space separators', '1234 5678 9012'],
      ['comma separators', '123,456,789,012'],
      ['dot separators', '123.456.789.012'],
      ['underscore separators', '1234_5678_9012'],
    ];

    it.each(separatorCases)('rejects %s', (_label, value) => {
      const rejection = expectRejected(inputValidator.accountId(value));
      expect(rejection.invalidValue).toBe(value);
      expect(rejection.accepted).toEqual(ACCOUNT_ID_ACCEPTED);
    });
  });

  describe('accountId rejects wrong lengths (Req 5.2)', () => {
    const lengthCases: Array<[string, string]> = [
      ['empty string', ''],
      ['single digit', '1'],
      ['11 digits', '12345678901'],
      ['13 digits', '1234567890123'],
      ['20 digits', '12345678901234567890'],
    ];

    it.each(lengthCases)('rejects %s', (_label, value) => {
      const rejection = expectRejected(inputValidator.accountId(value));
      expect(rejection.invalidValue).toBe(value);
      expect(rejection.accepted).toEqual(ACCOUNT_ID_ACCEPTED);
    });

    it('accepts exactly 12 digits (boundary sanity)', () => {
      const result = inputValidator.accountId('123456789012');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('123456789012');
      }
    });
  });

  describe('rejected Result carries the offending value and complete accepted list (Req 5.7)', () => {
    it('account-id rejection reports the invalid value and accepted format', () => {
      const rejection = expectRejected(inputValidator.accountId('not-an-id'));
      expect(rejection.invalidValue).toBe('not-an-id');
      expect(rejection.accepted).toEqual(ACCOUNT_ID_ACCEPTED);
    });

    it('relationship-state rejection reports the COMPLETE accepted list', () => {
      const rejection = expectRejected(inputValidator.relationshipState('accepted'));
      // Case-sensitive: lowercase is rejected and the full enum is offered.
      expect(rejection.invalidValue).toBe('accepted');
      expect(rejection.accepted).toEqual([...VALID_STATES]);
    });

    it('transfer-type rejection reports the COMPLETE accepted list', () => {
      const rejection = expectRejected(inputValidator.transferType('DIRECT'));
      expect(rejection.invalidValue).toBe('DIRECT');
      expect(rejection.accepted).toEqual([...VALID_TYPES]);
    });

    it('reconciliation-target rejection reports the COMPLETE accepted list', () => {
      const rejection = expectRejected(inputValidator.reconciliationTarget('all'));
      expect(rejection.invalidValue).toBe('all');
      expect(rejection.accepted).toEqual([...VALID_RECONCILIATION_TARGETS]);
    });

    it('pma-program rejection reports the COMPLETE accepted list', () => {
      const rejection = expectRejected(inputValidator.pmaProgram('dp'));
      expect(rejection.invalidValue).toBe('dp');
      expect(rejection.accepted).toEqual([...VALID_PMA_PROGRAMS]);
    });

    it('returns a fresh accepted array each time (no shared mutable state)', () => {
      const first = expectRejected(inputValidator.relationshipState('x'));
      const second = expectRejected(inputValidator.relationshipState('y'));
      expect(first.accepted).not.toBe(second.accepted);
      // Mutating one rejection's list must not corrupt the canonical source.
      first.accepted.push('TAMPERED');
      expect(second.accepted).toEqual([...VALID_STATES]);
    });
  });

  describe('a rejection initiates no AWS call (Req 5.7)', () => {
    it('returns a plain synchronous Result, never a thenable AWS promise', () => {
      const result = inputValidator.accountId(' 12 ');
      // A pure validator returns its verdict in-band: not a Promise/thenable,
      // so no awaited AWS operation could have run before rejecting.
      expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
      expect(result).toEqual({
        ok: false,
        invalidValue: ' 12 ',
        accepted: ACCOUNT_ID_ACCEPTED,
      });
    });

    it('constructs no AWS SDK client and sends no SDK command (structural)', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../cli/lib/input-validator.ts'),
        'utf8'
      );
      // No AWS client is ever instantiated...
      expect(source).not.toMatch(/new\s+\w*Client\s*\(/);
      // ...and no SDK command is ever dispatched, so validation (and any
      // rejection) cannot reach AWS.
      expect(source).not.toMatch(/\.send\s*\(/);
      // The lone @aws-sdk dependency is the Program *enum* (a value/type), not
      // a client constructor.
      const awsImports = source.match(/from\s+'@aws-sdk\/[^']+'/g) ?? [];
      expect(awsImports).toEqual(["from '@aws-sdk/client-partnercentral-channel'"]);
    });
  });
});
