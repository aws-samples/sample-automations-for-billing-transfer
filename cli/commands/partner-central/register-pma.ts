// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `bt partner-central register-pma` — register and confirm a single Partner
 * Central Channel Program Management Account (PMA), end-to-end (Requirement 17).
 *
 * This is the TypeScript replacement for `scripts/register-pma.sh`. It performs
 * exactly three steps, in order, and begins each step only after the
 * immediately preceding step has completed successfully (Req 17.1):
 *
 *   1. **register** the PMA using the central-account profile
 *      (`createProgramManagementAccount`).
 *   2. **create** the `PROGRAM_MANAGEMENT_ACCOUNT` confirmation handshake from
 *      the central account using the central-account profile
 *      (`createChannelHandshake`, associated with the PMA id from step 1).
 *   3. **accept** the handshake from the payer account using the payer-account
 *      profile (`acceptChannelHandshake`), where the payer profile defaults to
 *      the supplied Account_Id when no payer profile is provided.
 *
 * The flow short-circuits on the first failing step: if registration fails the
 * handshake is neither created nor accepted (Req 17.9); if handshake creation
 * fails the handshake is not accepted (Req 17.10); and if the accept step fails
 * the Error_Reporter reports the failure, states the handshake remains pending
 * and can be accepted later, and the Output_Formatter still reports the PMA id
 * produced by the register step (Req 17.6). Every failure exits non-zero; a
 * successful accept reports the PMA id and exits zero (Req 17.8).
 *
 * All pre-flight checks (program, Account_Id, central-profile presence, and the
 * default display-name derivation) run before any AWS call (Req 17.3, 17.5,
 * 17.7). Partner Central API responses are parsed in TypeScript via the
 * {@link PartnerCentralClient} (SDK primary), never an external interpreter
 * (Req 17.2).
 *
 * Requirements: 17.1, 17.4, 17.5, 17.6, 17.8, 17.9, 17.10
 *
 * @module commands/partner-central/register-pma
 */

import type { CommandHandler, IoContext, RenderableView } from '../../lib/io-context.js';
import { CliExitCode } from '../../lib/exit-codes.js';
import { inputValidator, type PmaProgramType } from '../../lib/input-validator.js';
import { ResourceRegistry } from '../../lib/resource-registry.js';
import {
  createPartnerCentralClient,
  type PartnerCentralClient,
} from '../../lib/partner-central-client.js';
import type { HandshakeType, Program } from '@aws-sdk/client-partnercentral-channel';
import { getErrorMessage } from '../../../lib/lambda/common/utils/errors.js';

/** Partner Central catalog used when no `--catalog` override is supplied. */
export const DEFAULT_CATALOG = 'AWS';

/** Handshake type for the PMA registration-confirmation flow (Req 17.1, step 2). */
const PMA_HANDSHAKE_TYPE: HandshakeType = 'PROGRAM_MANAGEMENT_ACCOUNT';

/**
 * Outcome of {@link deriveDefaultDisplayName}: either the derived name, or a
 * failure carrying a human-readable reason. Kept deliberately small and free of
 * AWS/stream access so the property test (Task 14.3, Property 17) can target the
 * derivation in isolation.
 */
export type DisplayNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Derive the default PMA display name `PMA-<TYPE>-<last4>` from the program
 * identifier and the last four digits of the Account_Id (Req 17.4).
 *
 * `<TYPE>` is the friendly program identifier (`DP` | `SPP` | `DS`) — the same
 * mapping the legacy `register-pma.sh` applied — resolved by reusing
 * {@link inputValidator.pmaProgram}, so both the friendly forms and the SDK
 * `Program` enum forms are accepted. `<last4>` is the final four digits of a
 * valid 12-digit Account_Id, validated by reusing {@link inputValidator.accountId}.
 *
 * Pure and total: when the program identifier or Account_Id is missing or
 * malformed it returns `{ ok: false }` with a reason rather than throwing, so
 * the caller can report the failure and exit non-zero before any AWS call
 * (Req 17.7).
 *
 * @param program - friendly (`DP`/`SPP`/`DS`) or SDK-enum program identifier.
 * @param accountId - the 12-digit AWS account id whose last four digits are used.
 */
export function deriveDefaultDisplayName(
  program: string | undefined,
  accountId: string | undefined,
): DisplayNameResult {
  const programResult = inputValidator.pmaProgram(program ?? '');
  if (!programResult.ok) {
    return {
      ok: false,
      reason: `cannot derive a default display name: program '${program ?? ''}' is missing or malformed (expected one of ${programResult.accepted.join(', ')})`,
    };
  }

  const accountResult = inputValidator.accountId(accountId ?? '');
  if (!accountResult.ok) {
    return {
      ok: false,
      reason: `cannot derive a default display name: account id '${accountId ?? ''}' is missing or malformed (expected exactly 12 digits)`,
    };
  }

  const type: PmaProgramType = programResult.value.type;
  const last4 = accountResult.value.slice(-4);
  return { ok: true, value: `PMA-${type}-${last4}` };
}

/**
 * Parsed options for the register-pma command (merged with the global options
 * by the {@link CommandHandler} contract).
 */
export interface RegisterPmaOptions {
  /** The 12-digit AWS account id to register as a PMA (validated before any call). */
  accountId: string;
  /** The program identifier: friendly `DP`/`SPP`/`DS` or an SDK `Program` enum form. */
  program: string;
  /** Optional display-name override; defaults to `PMA-<TYPE>-<last4>` (Req 17.4). */
  displayName?: string;
  /** REQUIRED central-account profile used by steps 1 and 2 (Req 17.5). */
  centralProfile?: string;
  /** Payer-account profile used by step 3; defaults to the Account_Id (Req 17.1). */
  payerProfile?: string;
  /** Partner Central catalog; defaults to {@link DEFAULT_CATALOG}. */
  catalog?: string;
  /** Region override; defaults to {@link ResourceRegistry.defaultRegion}. */
  region?: string;
  /**
   * Injectable {@link PartnerCentralClient} test seam. When omitted, the primary
   * SDK-backed client is constructed via {@link createPartnerCentralClient}.
   */
  partnerCentral?: PartnerCentralClient;
}

/** The discrete outcomes the command reports, for the structured result payload. */
export type RegisterPmaOutcome =
  | 'success'
  | 'validation-error'
  | 'central-profile-required'
  | 'register-failed'
  | 'create-handshake-failed'
  | 'accept-failed';

/** Typed result payload produced by the register-pma handler (the `--json` shape). */
export interface RegisterPmaResult {
  /** Which terminal outcome the command reached. */
  outcome: RegisterPmaOutcome;
  /** True only for the fully successful three-step flow. */
  succeeded: boolean;
  /** The targeted account id (echoed back; present once known). */
  accountId?: string;
  /** Friendly program identifier (`DP`/`SPP`/`DS`), once resolved. */
  programType?: PmaProgramType;
  /** SDK `Program` enum value, once resolved. */
  program?: string;
  /** The display name used (resolved or overridden). */
  displayName?: string;
  /** Central-account profile used for steps 1 and 2. */
  centralProfile?: string;
  /** Payer-account profile used for step 3. */
  payerProfile?: string;
  /** Partner Central catalog used. */
  catalog?: string;
  /** Region used. */
  region?: string;
  /** PMA id produced by the register step (present from step 1 onward). */
  pmaId?: string;
  /** Handshake id produced by the create step (present from step 2 onward). */
  handshakeId?: string;
  /** Resulting handshake status from the accept step (on success). */
  status?: string;
  /** True when the handshake was created but the accept step failed (Req 17.6). */
  handshakePending?: boolean;
  /** Step at which the flow short-circuited, when it failed. */
  failedStep?: 'register' | 'create-handshake' | 'accept';
}

/** Concrete handler type for the register-pma command. */
export type RegisterPmaHandler = CommandHandler<RegisterPmaOptions, RegisterPmaResult>;

/** Build an empty view (used when the only output is a stderr diagnostic). */
function emptyView(): RenderableView {
  return { blocks: [] };
}

/**
 * The register-pma command handler. Pure with respect to the injected
 * {@link IoContext}: all IO flows through `ctx` (clients, formatter, reporter,
 * streams), so it is invoked directly in tests with stubbed dependencies.
 */
export const registerPmaHandler: RegisterPmaHandler = async (options, ctx) => {
  const { global } = options;
  const catalog = options.catalog ?? DEFAULT_CATALOG;
  const region = options.region ?? ResourceRegistry.defaultRegion;

  // --- Pre-flight checks: all run before any AWS call (Req 17.3, 17.5, 17.7) ---

  // Validate the program identifier (Req 5.6 / 17.7).
  const programResult = inputValidator.pmaProgram(options.program);
  if (!programResult.ok) {
    ctx.stderr.writeLine(
      `Error: invalid program '${programResult.invalidValue}'.`,
    );
    ctx.stderr.writeLine(`Hint: accepted values are ${programResult.accepted.join(', ')}.`);
    const result: RegisterPmaResult = { outcome: 'validation-error', succeeded: false };
    ctx.formatter.emit(result, emptyView(), global, ctx);
    return { result, exitCode: CliExitCode.GeneralError };
  }

  // Validate the Account_Id is exactly 12 digits (Req 17.3).
  const accountResult = inputValidator.accountId(options.accountId);
  if (!accountResult.ok) {
    ctx.stderr.writeLine(
      `Error: invalid account id '${accountResult.invalidValue}'.`,
    );
    ctx.stderr.writeLine(`Hint: accepted value is ${accountResult.accepted.join(', ')}.`);
    const result: RegisterPmaResult = {
      outcome: 'validation-error',
      succeeded: false,
      programType: programResult.value.type,
      program: programResult.value.program,
    };
    ctx.formatter.emit(result, emptyView(), global, ctx);
    return { result, exitCode: CliExitCode.GeneralError };
  }

  const accountId = accountResult.value;
  const program = programResult.value.program as Program;
  const programType = programResult.value.type;

  // The central profile is required (Req 17.5).
  const centralProfile = options.centralProfile?.trim();
  if (!centralProfile) {
    ctx.stderr.writeLine('Error: the central-account profile is required.');
    ctx.stderr.writeLine(
      'Hint: provide the Partner Central linked (central) account profile via --central-profile ' +
        '(for example: --central-profile central-<LINKED_ACCOUNT_ID>).',
    );
    const result: RegisterPmaResult = {
      outcome: 'central-profile-required',
      succeeded: false,
      accountId,
      programType,
      program,
    };
    ctx.formatter.emit(result, emptyView(), global, ctx);
    return { result, exitCode: CliExitCode.GeneralError };
  }

  // Resolve the display name: explicit override, else derive PMA-<TYPE>-<last4>
  // (Req 17.4). Derivation is total; a failure here is reported before any AWS
  // call (Req 17.7).
  let displayName = options.displayName?.trim();
  if (!displayName) {
    const derived = deriveDefaultDisplayName(options.program, accountId);
    if (!derived.ok) {
      ctx.stderr.writeLine(`Error: ${derived.reason}.`);
      ctx.stderr.writeLine('Hint: pass an explicit --display-name, or supply a valid program and 12-digit account id.');
      const result: RegisterPmaResult = {
        outcome: 'validation-error',
        succeeded: false,
        accountId,
        programType,
        program,
        centralProfile,
      };
      ctx.formatter.emit(result, emptyView(), global, ctx);
      return { result, exitCode: CliExitCode.GeneralError };
    }
    displayName = derived.value;
  }

  // The payer profile defaults to the account id (Req 17.1).
  const payerProfile = options.payerProfile?.trim() || accountId;

  // Construct the Partner Central client (SDK primary) unless one is injected.
  const client =
    options.partnerCentral ?? createPartnerCentralClient({ defaultRegion: region, tools: ctx.tools });

  // Common context echoed into every result payload.
  const base: RegisterPmaResult = {
    outcome: 'success',
    succeeded: false,
    accountId,
    programType,
    program,
    displayName,
    centralProfile,
    payerProfile,
    catalog,
    region,
  };

  // --- Step 1: register the PMA from the central profile (Req 17.1) ---------
  let pmaId: string;
  try {
    const registered = await client.createProgramManagementAccount({
      catalog,
      program,
      displayName,
      accountId,
      clientToken: `register-pma-${accountId}`,
      profile: centralProfile,
      region,
    });
    pmaId = registered.pmaId;
  } catch (error) {
    // Registration failed: do NOT create or accept a handshake (Req 17.9).
    ctx.reporter.report(error, ctx, {
      profile: centralProfile,
      operation: 'partnercentral-channel:CreateProgramManagementAccount',
      region,
    });
    const result: RegisterPmaResult = { ...base, outcome: 'register-failed', failedStep: 'register' };
    ctx.formatter.emit(result, registerFailedView(result, error), global, ctx);
    return { result, exitCode: CliExitCode.GeneralError };
  }

  // --- Step 2: create the confirmation handshake from the central profile ---
  let handshakeId: string;
  try {
    const handshake = await client.createChannelHandshake({
      catalog,
      handshakeType: PMA_HANDSHAKE_TYPE,
      associatedResourceIdentifier: pmaId,
      clientToken: `invite-pma-${accountId}`,
      profile: centralProfile,
      region,
    });
    handshakeId = handshake.handshakeId;
  } catch (error) {
    // Handshake creation failed: do NOT accept (Req 17.10). The PMA id is known.
    ctx.reporter.report(error, ctx, {
      profile: centralProfile,
      operation: 'partnercentral-channel:CreateChannelHandshake',
      region,
    });
    const result: RegisterPmaResult = {
      ...base,
      outcome: 'create-handshake-failed',
      failedStep: 'create-handshake',
      pmaId,
    };
    ctx.formatter.emit(result, createHandshakeFailedView(result, error), global, ctx);
    return { result, exitCode: CliExitCode.GeneralError };
  }

  // --- Step 3: accept the handshake from the payer profile (Req 17.1) -------
  try {
    const accepted = await client.acceptChannelHandshake({
      catalog,
      identifier: handshakeId,
      profile: payerProfile,
      region,
    });

    // Success: report the PMA id and exit zero (Req 17.8).
    const result: RegisterPmaResult = {
      ...base,
      outcome: 'success',
      succeeded: true,
      pmaId,
      handshakeId,
      status: accepted.status,
    };
    ctx.formatter.emit(result, successView(result), global, ctx);
    return { result, exitCode: CliExitCode.Success };
  } catch (error) {
    // Accept failed: report the failure, state the handshake remains pending and
    // can be accepted later, and still report the PMA id (Req 17.6).
    ctx.reporter.report(error, ctx, {
      profile: payerProfile,
      operation: 'partnercentral-channel:AcceptChannelHandshake',
      region,
    });
    ctx.stderr.writeLine(
      `Note: handshake ${handshakeId} remains PENDING and can be accepted later from payer profile '${payerProfile}' ` +
        '(the payer credentials must allow partnercentral:AcceptChannelHandshake).',
    );
    const result: RegisterPmaResult = {
      ...base,
      outcome: 'accept-failed',
      failedStep: 'accept',
      pmaId,
      handshakeId,
      handshakePending: true,
    };
    ctx.formatter.emit(result, acceptFailedView(result), global, ctx);
    return { result, exitCode: CliExitCode.GeneralError };
  }
};

// ---------------------------------------------------------------------------
// Human-readable views (stdout). In `--json` mode the formatter ignores these
// and emits the structured result payload instead.
// ---------------------------------------------------------------------------

/** Shared key/value block describing the registration parameters. */
function parametersBlock(result: RegisterPmaResult): RenderableView['blocks'][number] {
  return {
    kind: 'keyValue',
    entries: [
      { label: 'Account', value: result.accountId ?? '' },
      { label: 'Program', value: `${result.program ?? ''} (${result.programType ?? ''})` },
      { label: 'Display name', value: result.displayName ?? '' },
      { label: 'Central profile', value: result.centralProfile ?? '' },
      { label: 'Payer profile', value: result.payerProfile ?? '' },
      { label: 'Catalog', value: result.catalog ?? '' },
      { label: 'Region', value: result.region ?? '' },
    ],
  };
}

/** Success view: parameters plus the PMA id, handshake id, and status (Req 17.8). */
function successView(result: RegisterPmaResult): RenderableView {
  return {
    blocks: [
      { kind: 'heading', text: 'Partner Central PMA registration', tone: 'success' },
      parametersBlock(result),
      {
        kind: 'keyValue',
        entries: [
          { label: 'PMA id', value: { value: result.pmaId ?? '', tone: 'success' } },
          { label: 'Handshake id', value: result.handshakeId ?? '' },
          { label: 'Status', value: result.status ?? '' },
        ],
      },
      {
        kind: 'text',
        tone: 'success',
        lines: [`PMA ${result.pmaId} for account ${result.accountId} is registered and confirmed.`],
      },
    ],
  };
}

/** Register-step failure view (the detailed error is on stderr via the reporter). */
function registerFailedView(result: RegisterPmaResult, error: unknown): RenderableView {
  return {
    blocks: [
      { kind: 'heading', text: 'Partner Central PMA registration failed', tone: 'failure' },
      parametersBlock(result),
      {
        kind: 'text',
        tone: 'failure',
        lines: [
          `Step 1 (register) failed: ${getErrorMessage(error)}`,
          'No confirmation handshake was created or accepted.',
        ],
      },
    ],
  };
}

/** Create-handshake-step failure view; still reports the PMA id from step 1. */
function createHandshakeFailedView(result: RegisterPmaResult, error: unknown): RenderableView {
  return {
    blocks: [
      { kind: 'heading', text: 'Partner Central PMA registration failed', tone: 'failure' },
      parametersBlock(result),
      {
        kind: 'keyValue',
        entries: [{ label: 'PMA id', value: { value: result.pmaId ?? '', tone: 'warning' } }],
      },
      {
        kind: 'text',
        tone: 'failure',
        lines: [
          `Step 2 (create handshake) failed: ${getErrorMessage(error)}`,
          'The handshake was not accepted.',
        ],
      },
    ],
  };
}

/**
 * Accept-step failure view. Reports the PMA id (Req 17.6) and that the handshake
 * remains pending; the underlying error/remediation is written to stderr by the
 * Error_Reporter.
 */
function acceptFailedView(result: RegisterPmaResult): RenderableView {
  return {
    blocks: [
      { kind: 'heading', text: 'Partner Central PMA registration incomplete', tone: 'failure' },
      parametersBlock(result),
      {
        kind: 'keyValue',
        entries: [
          { label: 'PMA id', value: { value: result.pmaId ?? '', tone: 'warning' } },
          { label: 'Handshake id', value: result.handshakeId ?? '' },
          { label: 'Handshake', value: { value: 'PENDING', tone: 'warning' } },
        ],
      },
      {
        kind: 'text',
        tone: 'warning',
        lines: [
          `PMA ${result.pmaId} was registered, but accepting the handshake from payer profile ` +
            `'${result.payerProfile}' failed. The handshake remains PENDING and can be accepted later.`,
        ],
      },
    ],
  };
}
