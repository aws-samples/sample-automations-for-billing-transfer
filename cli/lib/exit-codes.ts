// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Standardized process exit codes for the `bt` CLI.
 *
 * The `CliExitCode` enum centralizes these values so command handlers return a
 * typed code rather than calling `process.exit` directly; only `cli/bin/bt.ts`
 * translates the returned code into a process exit. This keeps the exit
 * contract consistent across single-account commands, fleet operations, and
 * usage errors (Requirements 1.7, 6.4, 20.4, 20.5).
 */
export enum CliExitCode {
  /** Command completed successfully. */
  Success = 0,
  /** Validation failure, unknown error, or single-account failure (Req 6.4). */
  GeneralError = 1,
  /** One or more accounts failed in a fleet run (Req 20.4, 20.5). */
  FleetPartialFailure = 2,
  /** Unknown command/option (sysexits-style; non-zero is the contract) (Req 1.7). */
  Usage = 64,
}
