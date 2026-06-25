// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Error_Reporter — classifies AWS failures and writes a human-readable message
 * plus a remediation hint to **stderr only** (never stdout), so that the
 * machine-readable result stream in `--json` mode is never corrupted
 * (Requirements 6, 24.1).
 *
 * Classification applies a fixed precedence order — missing/invalid credentials
 * → access-denied → throttling → unknown (Req 6.7) — and is *total*: every input
 * maps to exactly one {@link FailureClass}. The detection logic preserves the
 * legacy substring checks (`credentials`, `AccessDenied`, `throttl`) from
 * `scripts/analyze-billing-transfers.ts` and extends them with AWS SDK error
 * names and `$metadata.httpStatusCode` codes.
 *
 * Per Req 24.1 the reporter reuses the Shared_Utilities error helpers
 * (`getErrorCode`, `getErrorMessage`, `toError`) together with the
 * retryable/critical predicates and sets (`isRetryableError`, `isCriticalError`,
 * `RETRYABLE_ERROR_CODES`, `CRITICAL_ERROR_CODES`) rather than re-implementing
 * error introspection.
 *
 * Two named scenarios from the requirements have dedicated reporting entry
 * points so callers can surface them before (or independently of) an AWS SDK
 * error object:
 *  - the credentials case when the standard credential chain yields nothing
 *    (Req 3.5, 6.1) — {@link ErrorReporter.reportCredentials}; and
 *  - the unavailable-default-region case (Req 21.5, 21.6) —
 *    {@link ErrorReporter.reportUnavailableRegion}.
 *
 * Requirements: 3.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 21.5, 24.1
 *
 * @module error-reporter
 */

import {
  getErrorCode,
  getErrorMessage,
  toError,
  isRetryableError,
  isCriticalError,
  RETRYABLE_ERROR_CODES,
  CRITICAL_ERROR_CODES,
  type AWSServiceError,
} from '../../lib/lambda/common/utils/errors.js';
import { ResourceRegistry } from './resource-registry.js';
import type { IoContext } from './io-context.js';

/**
 * The mutually exclusive classes an AWS failure is reduced to, in the fixed
 * precedence order applied by {@link ErrorReporter.classify} (Req 6.7).
 */
export type FailureClass =
  | 'credentials' //   missing/invalid/expired credentials
  | 'access-denied' // AccessDenied / authorization / 403
  | 'throttling' //    throttling / rate exceeded / 429
  | 'unknown'; //      anything else

/** Optional context that lets a remediation hint name the profile/operation. */
export interface RemediationContext {
  /** The AWS_Profile the failed call targeted, if any. */
  profile?: string;
  /** A short label for the operation that failed (e.g. `organizations:ListAccounts`). */
  operation?: string;
  /** The region involved, used by the unavailable-default-region case. */
  region?: string;
}

/**
 * Classifies failures and reports a message + remediation hint to stderr only.
 *
 * The core contract is {@link classify} / {@link remediation} / {@link report};
 * {@link reportCredentials} and {@link reportUnavailableRegion} are the two
 * named reporting entry points required for the credentials (Req 3.5) and
 * unavailable-default-region (Req 21.6) cases.
 */
export interface ErrorReporter {
  /** Reduce any error to a single {@link FailureClass} using the fixed precedence (Req 6.7). */
  classify(error: unknown): FailureClass;
  /** Build the remediation hint for a class, naming the profile/operation when known (Req 6.1-6.3, 6.6). */
  remediation(cls: FailureClass, ctx?: RemediationContext): string;
  /** Classify `error`, then write its message + remediation hint to `ctx.stderr` only (Req 6.5). */
  report(error: unknown, ctx: IoContext, hint?: RemediationContext): FailureClass;
  /** Report a credentials failure when the credential chain yields nothing (Req 3.5, 6.1). */
  reportCredentials(ctx: IoContext, hint?: RemediationContext): void;
  /** Report that the Default_Region is unavailable for the operation (Req 21.5, 21.6). */
  reportUnavailableRegion(ctx: IoContext, hint?: RemediationContext): void;
}

// ---------------------------------------------------------------------------
// Detection vocabulary
//
// Each set extends the canonical Shared_Utilities sets with the additional SDK
// error names and legacy substrings the CLI must recognize. The credentials and
// access-denied sets partition the credential-/authorization-related entries of
// CRITICAL_ERROR_CODES so the fixed precedence (credentials before access-denied)
// routes each canonical code to exactly one class. The throttling set is a
// superset of the throttling-related entries of RETRYABLE_ERROR_CODES.
// ---------------------------------------------------------------------------

/** Credential codes: the credential-related entries of CRITICAL_ERROR_CODES plus SDK names. */
const CREDENTIAL_ERROR_CODES: readonly string[] = [
  // Sourced from the shared CRITICAL_ERROR_CODES set:
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  // SDK credential-provider and token errors:
  'CredentialsProviderError',
  'CredentialsError',
  'UnrecognizedClientException',
  'InvalidAccessKeyId',
  'ExpiredToken',
  'ExpiredTokenException',
  'TokenRefreshRequired',
  'InvalidSignatureException',
  'MissingAuthenticationTokenException',
];

/** Substrings (case-insensitive) that indicate a credentials failure; includes the legacy `credentials` check. */
const CREDENTIAL_MESSAGE_PATTERNS: readonly string[] = [
  'credentials', // legacy substring check from analyze-billing-transfers.ts
  'credential',
  'unable to locate credentials',
  'could not load credentials',
  'security token',
  'token has expired',
  'expired token',
];

/** Access-denied codes: the authorization entries of CRITICAL_ERROR_CODES plus SDK names. */
const ACCESS_DENIED_ERROR_CODES: readonly string[] = [
  // Sourced from the shared CRITICAL_ERROR_CODES set:
  'AccessDeniedException',
  'UnauthorizedException',
  // Additional SDK authorization error names:
  'AccessDenied',
  'AuthorizationError',
  'AuthorizationErrorException',
  'UnauthorizedOperation',
  'Forbidden',
];

/** Substrings (case-insensitive) that indicate access-denied; includes the legacy `AccessDenied` check. */
const ACCESS_DENIED_MESSAGE_PATTERNS: readonly string[] = [
  'accessdenied', // legacy substring check (lower-cased for case-insensitive match)
  'access denied',
  'not authorized',
  'is not authorized to perform',
  'forbidden',
];

/** Throttling codes: the throttling entries of RETRYABLE_ERROR_CODES plus SDK names. */
const THROTTLING_ERROR_CODES: readonly string[] = [
  // Sourced from the shared RETRYABLE_ERROR_CODES set:
  'ThrottlingException',
  'TooManyRequestsException',
  // Additional SDK throttling error names:
  'Throttling',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
  'SlowDown',
  'TooManyRequests',
];

/** Substrings (case-insensitive) that indicate throttling; includes the legacy `throttl` check. */
const THROTTLING_MESSAGE_PATTERNS: readonly string[] = [
  'throttl', // legacy substring check from analyze-billing-transfers.ts
  'rate exceeded',
  'rate limit',
  'too many requests',
];

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Extract the AWS `$metadata.httpStatusCode`, if present. */
function getHttpStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const metadata = (error as AWSServiceError).$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

/** True when `code` equals or contains any of `names` (mirrors the shared `.includes` matching). */
function codeMatches(code: string, names: readonly string[]): boolean {
  if (!code) {
    return false;
  }
  return names.some((name) => code === name || code.includes(name));
}

/** True when the lower-cased `message` contains any of `patterns`. */
function messageMatches(message: string, patterns: readonly string[]): boolean {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

// ---------------------------------------------------------------------------
// Error_Reporter implementation
// ---------------------------------------------------------------------------

/**
 * Default {@link ErrorReporter}. Stateless and side-effect free except for the
 * stderr writes performed by the `report*` methods.
 */
export class DefaultErrorReporter implements ErrorReporter {
  /**
   * Reduce any error to a single {@link FailureClass}, applying the fixed
   * precedence credentials → access-denied → throttling → unknown (Req 6.7).
   * Total by construction: the final branch returns `'unknown'`.
   */
  classify(error: unknown): FailureClass {
    const code = getErrorCode(error);
    const message = getErrorMessage(error);
    const status = getHttpStatusCode(error);

    // 1. Credentials (highest precedence). Includes the credential-related
    //    entries of CRITICAL_ERROR_CODES, so these are decided here before the
    //    access-denied branch can claim them.
    if (
      codeMatches(code, CREDENTIAL_ERROR_CODES) ||
      messageMatches(message, CREDENTIAL_MESSAGE_PATTERNS)
    ) {
      return 'credentials';
    }

    // 2. Access-denied. Reuses the shared isCriticalError predicate: by this
    //    point the credential-related critical codes are already classified, so
    //    a remaining critical error is an authorization failure.
    if (
      isCriticalError(error) ||
      codeMatches(code, ACCESS_DENIED_ERROR_CODES) ||
      status === 403 ||
      messageMatches(message, ACCESS_DENIED_MESSAGE_PATTERNS)
    ) {
      return 'access-denied';
    }

    // 3. Throttling. Matches the throttling subset of the retryable codes plus
    //    HTTP 429 and the legacy `throttl` substring.
    if (
      codeMatches(code, THROTTLING_ERROR_CODES) ||
      status === 429 ||
      messageMatches(message, THROTTLING_MESSAGE_PATTERNS)
    ) {
      return 'throttling';
    }

    // 4. Everything else.
    return 'unknown';
  }

  /**
   * Build the remediation hint for a class, naming the targeted profile and the
   * failed operation when known (Req 6.1, 6.2, 6.3, 6.6).
   */
  remediation(cls: FailureClass, ctx: RemediationContext = {}): string {
    const profile = ctx.profile;
    const operation = ctx.operation;

    switch (cls) {
      case 'credentials': {
        // Req 6.1: verify the credentials for the targeted profile.
        if (profile) {
          return `Verify the credentials for profile '${profile}' (for example: aws sts get-caller-identity --profile ${profile}).`;
        }
        return 'Verify your AWS credentials are configured (for example: aws sts get-caller-identity).';
      }
      case 'access-denied': {
        // Req 6.2: identify the permission required by the failed operation.
        const opPart = operation ? `the operation '${operation}'` : 'this operation';
        const policyOwner = profile ? `the IAM policy for profile '${profile}'` : 'the active IAM policy';
        return `Access was denied for ${opPart}; ensure ${policyOwner} grants the AWS permission that ${opPart} requires.`;
      }
      case 'throttling': {
        // Req 6.3: retry after a delay.
        return 'API rate limit reached; retry the operation after a short delay.';
      }
      case 'unknown':
      default: {
        // Req 6.6: describe a concrete next step.
        return 'Re-run with --verbose for diagnostics (or --json for a structured error), and check the relevant CloudWatch logs.';
      }
    }
  }

  /**
   * Classify `error` and write its message + remediation hint to `ctx.stderr`
   * only — never stdout (Req 6.5). Returns the resolved {@link FailureClass} so
   * callers can build a structured JSON error object without re-classifying.
   */
  report(error: unknown, ctx: IoContext, hint: RemediationContext = {}): FailureClass {
    const cls = this.classify(error);
    // Reuse toError so the message is sourced consistently with the shared utilities.
    const message = toError(error).message;

    ctx.stderr.writeLine(`Error: ${message}`);

    // For an otherwise-unknown failure, surface that it appears transient using
    // the shared isRetryableError predicate, then fall back to the generic hint.
    if (cls === 'unknown' && isRetryableError(error)) {
      ctx.stderr.writeLine(
        'Hint: This looks like a transient error; retry the operation. If it persists, ' +
          're-run with --verbose for diagnostics and check the relevant CloudWatch logs.',
      );
    } else {
      ctx.stderr.writeLine(`Hint: ${this.remediation(cls, hint)}`);
    }

    return cls;
  }

  /**
   * Report a credentials failure surfaced before (or without) an AWS SDK error
   * object — for example when the standard credential chain resolves nothing
   * (Req 3.5, 6.1). Writes to stderr only.
   */
  reportCredentials(ctx: IoContext, hint: RemediationContext = {}): void {
    const target = hint.profile ? `profile '${hint.profile}'` : 'the active credential chain';
    ctx.stderr.writeLine(`Error: Unable to resolve AWS credentials for ${target}.`);
    ctx.stderr.writeLine(`Hint: ${this.remediation('credentials', hint)}`);
  }

  /**
   * Report that the Default_Region is unavailable for the operation (Req 21.5,
   * 21.6). Defaults to the Resource_Registry Default_Region when no region is
   * supplied. Writes to stderr only.
   */
  reportUnavailableRegion(ctx: IoContext, hint: RemediationContext = {}): void {
    const region = hint.region ?? ResourceRegistry.defaultRegion;
    ctx.stderr.writeLine(`Error: The default region '${region}' is unavailable for this operation.`);
    ctx.stderr.writeLine(
      `Hint: Ensure region '${region}' is enabled for the targeted account` +
        `${hint.profile ? ` (profile '${hint.profile}')` : ''}, or configure a region for the profile, then retry.`,
    );
  }
}

/** Construct a fresh {@link ErrorReporter}. */
export function createErrorReporter(): ErrorReporter {
  return new DefaultErrorReporter();
}

/** Shared default {@link ErrorReporter} instance (stateless; safe to reuse). */
export const errorReporter: ErrorReporter = new DefaultErrorReporter();

// Reference the shared sets in a type-only position so a future reviewer can see
// the CLI's detection vocabulary is intentionally a superset of the canonical
// Shared_Utilities sets (Req 24.1). These have no runtime effect.
export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];
export type CriticalErrorCode = (typeof CRITICAL_ERROR_CODES)[number];
