// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Input_Validator — pure, AWS-free argument/option checks for the `bt` CLI.
 *
 * Every check in this module runs *before* any AWS call so non-expert operators
 * catch malformed input immediately, with a clear list of accepted values and
 * no partial side effects (Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 12.5).
 * The validators are deliberately free of network/SDK access and of
 * `process.exit`; they return a typed {@link Result} that the caller (the
 * command handler / router) maps to an Error_Reporter message and a non-zero
 * exit. A rejected {@link Result} carries the offending value and the complete
 * accepted-values list, which is exactly what the Error_Reporter renders
 * (Req 5.7).
 *
 * Maximum reuse, zero re-definition:
 * - Account ids reuse the canonical, CDK-free 12-digit shape check
 *   {@link isValidAccountId} (`/^\d{12}$/`) from `lib/stacks/channel-role-specs`,
 *   the same predicate the Partner Central channel-role stacks validate with.
 * - Relationship states and transfer types reuse the {@link VALID_STATES} /
 *   {@link VALID_TYPES} literal lists exported from the shared
 *   `billing-transfer` model (kept in lock-step with the `RelationshipState` /
 *   `TransferType` unions), rather than re-declaring the enumerations here.
 * - PMA program values reuse the AWS SDK {@link Program} enum
 *   (`DISTRIBUTION` / `SOLUTION_PROVIDER` / `DISTRIBUTION_SELLER`) — the "enum
 *   forms" the legacy `register-pma.sh` maps the friendly `DP` / `SPP` / `DS`
 *   identifiers onto — so the accepted program set tracks the SDK contract.
 *
 * @module input-validator
 */

import { Program } from '@aws-sdk/client-partnercentral-channel';
import {
  RelationshipState,
  TransferType,
  VALID_STATES,
  VALID_TYPES,
} from '../../lib/lambda/common/models/billing-transfer.js';
import { isValidAccountId } from '../../lib/stacks/channel-role-specs.js';

/**
 * Outcome of a single Input_Validator check.
 *
 * On success the validated, narrowed value is returned. On failure the original
 * offending value and the complete list of accepted values are returned so the
 * Error_Reporter can render "invalid value X; accepted: …" without the
 * validator itself touching any output stream or exiting the process (Req 5.7).
 *
 * @typeParam T - the narrowed value type produced on success.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; invalidValue: string; accepted: string[] };

/**
 * Reconciliation_Target selector accepted by the reconciliation commands
 * (Req 5.5). `bg` = billing-group, `cur` = Cost and Usage Report, `both` = both.
 */
export type ReconciliationTarget = 'bg' | 'cur' | 'both';

/** Accepted Reconciliation_Target values, in display order (Req 5.5). */
export const VALID_RECONCILIATION_TARGETS = ['bg', 'cur', 'both'] as const satisfies readonly ReconciliationTarget[];

/** Friendly PMA program identifier accepted on the command line (Req 5.6). */
export type PmaProgramType = 'DP' | 'SPP' | 'DS';

/**
 * Result of a successful PMA program validation: the friendly {@link PmaProgramType}
 * and the corresponding AWS SDK {@link Program} enum value, mirroring the
 * `DP`→`DISTRIBUTION` / `SPP`→`SOLUTION_PROVIDER` / `DS`→`DISTRIBUTION_SELLER`
 * mapping in the legacy `register-pma.sh` (Req 5.6, 17.4).
 */
export interface PmaProgram {
  /** Friendly two/three-letter identifier. */
  type: PmaProgramType;
  /** AWS SDK Partner Central {@link Program} enum value. */
  program: string;
}

/** Inclusive lower bound for `--lookback`, in minutes (Req 12.5). */
export const LOOKBACK_MIN_MINUTES = 1;
/** Inclusive upper bound for `--lookback`, in minutes — 7 days (Req 12.5). */
export const LOOKBACK_MAX_MINUTES = 10080;

/**
 * Mapping from each accepted PMA program identifier (both the friendly form and
 * the SDK enum form) to its canonical {@link PmaProgram} result. Derived from
 * the SDK {@link Program} enum so the accepted set tracks the SDK rather than a
 * hand-maintained copy (Req 5.6).
 */
const PMA_PROGRAM_BY_INPUT: Readonly<Record<string, PmaProgram>> = {
  // Friendly identifiers accepted on the command line.
  DP: { type: 'DP', program: Program.DISTRIBUTION },
  SPP: { type: 'SPP', program: Program.SOLUTION_PROVIDER },
  DS: { type: 'DS', program: Program.DISTRIBUTION_SELLER },
  // Corresponding SDK Program enum forms (also accepted).
  [Program.DISTRIBUTION]: { type: 'DP', program: Program.DISTRIBUTION },
  [Program.SOLUTION_PROVIDER]: { type: 'SPP', program: Program.SOLUTION_PROVIDER },
  [Program.DISTRIBUTION_SELLER]: { type: 'DS', program: Program.DISTRIBUTION_SELLER },
};

/**
 * The complete, ordered list of accepted PMA program identifiers reported on
 * rejection: the three friendly identifiers followed by the three SDK enum
 * forms (Req 5.6, 5.7).
 */
export const VALID_PMA_PROGRAMS: readonly string[] = [
  'DP',
  'SPP',
  'DS',
  Program.DISTRIBUTION,
  Program.SOLUTION_PROVIDER,
  Program.DISTRIBUTION_SELLER,
];

/** Builds a successful {@link Result}. */
function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Builds a rejected {@link Result} carrying the offending value + accepted list. */
function reject<T>(invalidValue: string, accepted: readonly string[]): Result<T> {
  return { ok: false, invalidValue, accepted: [...accepted] };
}

/**
 * Validates a value against a fixed enumeration using a case-sensitive exact
 * match (Req 5.3, 5.4, 5.5, 5.6). Returns the matched member narrowed to `T`,
 * or a rejection whose accepted list is the enumeration itself.
 */
function validateEnum<T extends string>(value: string, accepted: readonly T[]): Result<T> {
  // Case-sensitive exact membership — no trimming, no case folding (Req 5.7).
  if ((accepted as readonly string[]).includes(value)) {
    return ok(value as T);
  }
  return reject(value, accepted);
}

/**
 * The Input_Validator contract. Each method is a pure function that performs no
 * AWS call and returns a typed {@link Result}; the caller maps a rejection to an
 * Error_Reporter message + non-zero exit (Req 5.7).
 */
export interface InputValidator {
  /** Accepts an Account_Id of exactly 12 digits (0-9), nothing else (Req 5.1, 5.2). */
  accountId(value: string): Result<string>;
  /** Accepts a Relationship_State by case-sensitive exact match (Req 5.3). */
  relationshipState(value: string): Result<RelationshipState>;
  /** Accepts a Transfer_Type by case-sensitive exact match (Req 5.4). */
  transferType(value: string): Result<TransferType>;
  /** Accepts a Reconciliation_Target: `bg`, `cur`, or `both` (Req 5.5). */
  reconciliationTarget(value: string): Result<ReconciliationTarget>;
  /** Accepts a PMA program (friendly `DP`/`SPP`/`DS` or SDK enum form) (Req 5.6). */
  pmaProgram(value: string): Result<PmaProgram>;
  /** Accepts a `--lookback` integer in `[1, 10080]` minutes (Req 12.5). */
  lookbackMinutes(value: string): Result<number>;
}

/**
 * The default, stateless {@link InputValidator} implementation used by the CLI.
 *
 * It is a plain object of pure functions (no construction, no shared state) so
 * handlers and tests can call any check in isolation. All checks are total —
 * every string input yields either an accepting or a rejecting {@link Result},
 * never a throw — which is what lets the commands run validation up front and
 * guarantee no AWS call on rejection (Req 5.7).
 */
export const inputValidator: InputValidator = {
  accountId(value: string): Result<string> {
    // Reuse the canonical 12-digit shape predicate (`/^\d{12}$/`) so the CLI
    // and the channel-role stacks validate account ids identically (Req 5.1).
    if (isValidAccountId(value)) {
      return ok(value);
    }
    return reject(value, ['a 12-digit AWS account id (digits 0-9 only, no whitespace, separators, or sign)']);
  },

  relationshipState(value: string): Result<RelationshipState> {
    return validateEnum<RelationshipState>(value, VALID_STATES);
  },

  transferType(value: string): Result<TransferType> {
    return validateEnum<TransferType>(value, VALID_TYPES);
  },

  reconciliationTarget(value: string): Result<ReconciliationTarget> {
    return validateEnum<ReconciliationTarget>(value, VALID_RECONCILIATION_TARGETS);
  },

  pmaProgram(value: string): Result<PmaProgram> {
    // Case-sensitive exact match against both the friendly identifiers and the
    // SDK Program enum forms (Req 5.6).
    const match = Object.prototype.hasOwnProperty.call(PMA_PROGRAM_BY_INPUT, value)
      ? PMA_PROGRAM_BY_INPUT[value]
      : undefined;
    if (match) {
      return ok(match);
    }
    return reject(value, VALID_PMA_PROGRAMS);
  },

  lookbackMinutes(value: string): Result<number> {
    const accepted = [`a whole number of minutes between ${LOOKBACK_MIN_MINUTES} and ${LOOKBACK_MAX_MINUTES} inclusive`];
    // Reject anything that is not a base-10 integer literal: no decimals, no
    // sign, no exponent, no surrounding whitespace, no thousands separators.
    if (!/^[0-9]+$/.test(value)) {
      return reject(value, accepted);
    }
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < LOOKBACK_MIN_MINUTES || minutes > LOOKBACK_MAX_MINUTES) {
      return reject(value, accepted);
    }
    return ok(minutes);
  },
};
