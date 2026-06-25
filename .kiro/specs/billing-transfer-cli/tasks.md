<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->

# Implementation Plan: Billing Transfer CLI (`bt`)

## Overview

This plan implements the `bt` CLI in TypeScript using `commander`, reusing the typed services, models, and
utilities in `lib/lambda/common`. Foundational and shared components come first (Resource_Registry, IoContext,
pure-logic utilities, runners), then per-command handlers (pure, injectable functions), then the commander
entrypoint wiring and the script migration. Property tests use `fast-check` (minimum 100 runs each, tagged
`// Feature: billing-transfer-cli, Property <N>: <text>`) and unit/example tests use `aws-sdk-client-mock`
with stubbed `ExternalToolRunner`/`FleetRunner`. Test sub-tasks are marked `*` (optional). Because the work
touches shared Lambda code (`retry.ts`, reconciliation handlers) and bumps the AWS SDK band, build, test, and
`cdk synth` are gated after the dependency/refactor work and again at the end.

## Tasks

- [x] 1. Dependencies and project wiring
  - [x] 1.1 Add new runtime dependencies and align the AWS SDK band
    - Add `@aws-sdk/client-sqs`, `@aws-sdk/client-codepipeline`, `@aws-sdk/client-ssm`, `@aws-sdk/client-partnercentral-channel`, and `commander`
    - Bump all existing `@aws-sdk/*` packages to a single current aligned band (~3.1057.x) per the design Dependencies section; pin resolved versions and commit `package-lock.json`
    - _Requirements: 22.1, 22.5, 17.2_
  - [x] 1.2 Wire the `bt` executable and TypeScript build for `cli/`
    - Add `package.json` `bin: { "bt": "cli/bin/bt.js" }`, an npm `bt` script (via `tsx`), and repoint the `analyze-transfers` alias to `bt transfers analyze`
    - Ensure `tsconfig.json` compiles the new `cli/` directory into `dist/`
    - _Requirements: 22.1, 23.2_
  - [x] 1.3 Verify the dependency bump keeps the project green
    - Run `npm run build`, `npm test`, and `npm run cdk:synth` to confirm the realigned AWS SDK band still bundles the Lambdas and synthesizes the CDK app
    - _Requirements: 22.1_

- [x] 2. Shared-code refactors in `lib/lambda/common` (preserve Lambda behavior)
  - [x] 2.1 Extract reconciliation log markers into `lib/lambda/common/log-markers.ts`
    - Define `RECON_MARKERS` (bg/cur completion and failure strings) as the single source of truth per design "Refactor: shared log-marker constants"
    - Import the constants in `billing-group-reconciliation/index.ts` and `cur-reconciliation/index.ts` where the literal marker strings are currently inlined in `logger.info`/`logger.error`
    - _Requirements: 12.1, 12.2, 12.3, 22.2_
  - [x]* 2.2 Unit test the shared log markers and handler usage
    - Assert handlers reference `RECON_MARKERS` rather than inlined literals so the CLI status command cannot drift
    - _Requirements: 12.1_
  - [x] 2.3 Refactor `lib/lambda/common/utils/retry.ts` to log via the shared Powertools `logger`
    - Replace `console.log(JSON.stringify(...))` with `logger.warn` (retry-pending) and `logger.error` (non-retryable, exhausted), preserving equivalent structured fields and levels per design "Refactor: silence shared logging"
    - _Requirements: 24.2_
  - [x]* 2.4 Unit test `retry.ts` logging path
    - Assert retry diagnostics are emitted through the shared `logger` (warn/error) and never via `console.log`
    - _Requirements: 24.2, 24.5_

- [x] 3. CLI foundation: exit codes, IO context, and Resource_Registry
  - [x] 3.1 Implement `cli/lib/exit-codes.ts` (`CliExitCode` enum)
    - Define `Success`, `GeneralError`, `FleetPartialFailure`, `Usage` per the design Data Models
    - _Requirements: 1.7, 6.4, 20.4, 20.5_
  - [x] 3.2 Implement `cli/lib/io-context.ts`
    - Define `Scope`, `GlobalOptions`, `OutputSink`, `IoContext`, and the `CommandHandler<TOptions, TResult>` type so router, Fleet_Runner, and tests treat handlers uniformly
    - _Requirements: 3.1, 3.2, 3.3, 22.3, 22.4_
  - [x] 3.3 Implement `cli/lib/resource-registry.ts` (Resource_Registry)
    - Port the `scripts/lib/common.sh` constants once: pipeline stack/pipeline name, feature stacks, reconciliation/termination function names, DLQ names, SSM param paths, and `defaultRegion = 'us-east-1'`; derive `FEATURE_STACK_COUNT`
    - _Requirements: 21.1, 21.2, 21.3, 21.6_
  - [x]* 3.4 Smoke test the Resource_Registry
    - Assert `defaultRegion === 'us-east-1'`, each name is defined exactly once, and names are not hard-coded elsewhere in `cli/`
    - _Requirements: 21.1, 21.2, 21.6_

- [x] 4. Profile loading and input validation (pure logic)
  - [x] 4.1 Implement `cli/lib/profile-loader.ts` (Profile_Loader)
    - Implement `parseProfiles` (drop blank/`#` lines, strip inline comments, trim, preserve order), `resolvePath` (option → `PAYER_PROFILES_FILE` → `<cwd>/payer-profiles.txt`), and `load` throwing `ProfileListError` on not-found, unreadable, and zero-profiles
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_
  - [x]* 4.2 Write property test for profile parsing
    - **Property 1: Profile parsing produces clean, ordered, idempotent output**
    - **Validates: Requirements 4.1, 4.4, 4.5**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 1: Profile parsing produces clean, ordered, idempotent output`
  - [x]* 4.3 Unit test profile path resolution and error conditions
    - Cover precedence (option > env > cwd default) and the not-found, empty-after-parse, and unreadable error conditions
    - _Requirements: 4.2, 4.3, 4.4, 4.7, 4.8, 4.9_
  - [x] 4.4 Implement `cli/lib/input-validator.ts` (Input_Validator)
    - Implement `accountId`, `relationshipState`, `transferType`, `reconciliationTarget`, `pmaProgram`, and `lookbackMinutes` returning a `Result<T>` that drives the Error_Reporter accepted-values message; all checks run before any AWS call
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 12.5_
  - [x]* 4.5 Write property test for account-id validation
    - **Property 2: Account IDs are accepted exactly when they are 12 digits**
    - **Validates: Requirements 5.1, 5.2, 5.7, 17.3, 18.3**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 2: Account IDs are accepted exactly when they are 12 digits`
  - [x]* 4.6 Write property test for enumeration validation
    - **Property 3: Enumeration options are accepted exactly on case-sensitive membership**
    - **Validates: Requirements 5.3, 5.4, 5.5, 5.6, 5.7**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 3: Enumeration options are accepted exactly on case-sensitive membership`
  - [x]* 4.7 Write property test for lookback validation
    - **Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]**
    - **Validates: Requirements 12.5**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 4: Lookback is accepted exactly when it is an integer in [1, 10080]`
  - [x]* 4.8 Unit test Input_Validator edge cases
    - Cover whitespace/sign/separator rejection and that rejection initiates no AWS call
    - _Requirements: 5.2, 5.7_

- [x] 5. Error reporting and output formatting
  - [x] 5.1 Implement `cli/lib/error-reporter.ts` (Error_Reporter)
    - Classify with fixed precedence credentials → access-denied → throttling → unknown, reusing `errors.ts` helpers (`getErrorCode`, `getErrorMessage`, `toError`, retryable/critical predicates); write message + remediation to stderr only; include the credentials and unavailable-default-region cases
    - _Requirements: 3.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 21.5, 24.1_
  - [x]* 5.2 Write property test for error classification
    - **Property 5: AWS error classification is total and follows the fixed precedence**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.6, 6.7**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 5: AWS error classification is total and follows the fixed precedence`
  - [x]* 5.3 Unit test Error_Reporter remediation and stream discipline
    - Assert remediation hints per class and that nothing is written to stdout
    - _Requirements: 6.4, 6.5_
  - [x] 5.4 Implement `cli/lib/output-formatter.ts` (Output_Formatter)
    - `renderHuman` (tables/colors honoring the color flag), `renderJson` (exactly one JSON document to stdout on success and on failure), and `emit` choosing the path from `global.json`; all diagnostics to stderr
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [x]* 5.5 Write property test for JSON output-channel discipline
    - **Property 6: Output-channel discipline in JSON mode**
    - **Validates: Requirements 6.5, 7.2, 7.3, 7.4**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 6: Output-channel discipline in JSON mode`
  - [x]* 5.6 Unit test Output_Formatter stdout/stderr split
    - Assert human vs `--json` paths and the single-JSON-document failure object
    - _Requirements: 7.1, 7.4_

- [x] 6. Diagnostic logging, AWS client factory, and external tool runner
  - [x] 6.1 Implement CLI diagnostic-logging wiring (`cli/lib/logging.ts`)
    - Configure the shared Powertools `logger` silent-by-default and route to stderr only under `--verbose`; never to stdout, including under `--json`; omit EMF metrics, X-Ray tracer, and Middy middleware
    - _Requirements: 24.3, 24.4, 24.5, 24.6, 24.7_
  - [x]* 6.2 Write property test for diagnostic-log discipline
    - **Property 19: Diagnostic logs never reach stdout**
    - **Validates: Requirements 24.3, 24.4, 24.5, 24.6**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 19: Diagnostic logs never reach stdout`
  - [x]* 6.3 Unit test logging discipline with reused code
    - Assert `retry.ts` diagnostics flow through the silenced logger and that nothing reaches stdout under `--json`
    - _Requirements: 24.2, 24.5, 24.6_
  - [x] 6.4 Implement `cli/lib/aws-clients.ts` (AwsClientFactory)
    - Construct per-context clients (organizations, billing, billingConductor, cur, lambda, cloudWatchLogs, sqs, ssm, cloudFormation, codepipeline) with `ResourceRegistry.defaultRegion` and adaptive retry; wrap direct SDK calls with `retryWithBackoff`; constructed per invocation so tests can inject mocks
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 21.4, 22.4, 24.2_
  - [x]* 6.5 Unit test AwsClientFactory mock seam
    - Assert clients are constructible and intercepted by `aws-sdk-client-mock` with no real AWS call
    - _Requirements: 22.4_
  - [x] 6.6 Implement `cli/lib/external-tool-runner.ts` (ExternalToolRunner)
    - Typed non-interactive spawn wrappers for `cdk`/`git`/`aws` (`--no-cli-pager`, no approval prompts) with a dry-run `render` that returns the command line without executing
    - _Requirements: 7.5, 22.4_
  - [x]* 6.7 Unit test ExternalToolRunner fake and `render`
    - Assert the in-memory fake records invocations and `render` produces the planned command without spawning
    - _Requirements: 7.5_

- [x] 7. Fleet_Runner child-process pool
  - [x] 7.1 Implement `cli/lib/fleet-runner.ts` (Fleet_Runner)
    - Bounded-concurrency wave model spawning the same single-account command per profile; per-account stderr logs, continue-on-failure, aggregation into `FleetResult` with a CI exit code; `selfInvocation` resolving compiled (`node dist/cli/bin/bt.js`) vs dev (`tsx bt.ts`) argv via an injectable spawn function
    - _Requirements: 9.1, 9.6, 11.4, 11.5, 13.4, 13.5, 13.8, 13.9, 16.5, 16.6, 20.2, 20.3, 20.4, 20.5, 20.6_
  - [x]* 7.2 Write property test for fleet completion and exit code
    - **Property 9: Fleet runs process every account and exit non-zero exactly when any account fails**
    - **Validates: Requirements 9.6, 9.7, 9.8, 11.6, 11.7, 16.5, 18.7, 18.8, 20.2, 20.4, 20.5**
    - fast-check, >=100 runs with a stub spawner; tag `// Feature: billing-transfer-cli, Property 9: Fleet runs process every account and exit non-zero exactly when any account fails`
  - [x]* 7.3 Write property test for bounded concurrency
    - **Property 10: Bounded concurrency is never exceeded and every account runs once**
    - **Validates: Requirements 11.5, 13.4, 13.8, 16.6, 20.6**
    - fast-check, >=100 runs with an instrumented stub worker tracking live count; tag `// Feature: billing-transfer-cli, Property 10: Bounded concurrency is never exceeded and every account runs once`
  - [x]* 7.4 Unit test child-process orchestration with a stub spawner
    - Assert stdout-JSON aggregation, per-account log writing, and `selfInvocation` argv for compiled vs `tsx`
    - _Requirements: 20.3, 20.4_

- [x] 8. Partner Central client
  - [x] 8.1 Implement `cli/lib/partner-central-client.ts`
    - Define `PartnerCentralClient` with `SdkPartnerCentralClient` (primary, typed `@aws-sdk/client-partnercentral-channel` commands) and `CliPartnerCentralClient` (contingency `aws partnercentral-channel ... --output json` parsed in TypeScript); no `python3`
    - _Requirements: 17.2, 22.5_
  - [x]* 8.2 Unit test both Partner Central implementations
    - Mock the SDK client and stub the CLI-spawn fallback; assert TypeScript-only response parsing
    - _Requirements: 17.2, 22.4_

- [x] 9. Checkpoint - core CLI building blocks compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Transfer analysis command (`bt transfers analyze`)
  - [x] 10.1 Implement the single-account analyze handler (`cli/commands/transfers/analyze.ts`)
    - Call `transfer-analysis-service.analyzeTransfers` / `analyzeAccountTransfers` / `validateTransferResources`; default state `ACCEPTED`; apply `--state`/`--account`/`--type`/`--validate`; render four present/absent resource indicators, the analysis summary, and the no-transfers (exit 0) case
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 22.2_
  - [x] 10.2 Implement the `--all-profiles` fleet rollup
    - Route through Fleet_Runner and build `AnalyzeRollupRow` from typed `AnalysisSummaryModel`/`ValidationResultModel` fields (no stdout scraping); fleet totals, per-account failure indicator, success/failure counts, and `--validate` not-computed indicator; degrade rather than fail when validation data is unavailable
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.9_
  - [x]* 10.3 Write property test for fleet rollup totals
    - **Property 8: Fleet rollup totals equal the sum over successfully analyzed accounts**
    - **Validates: Requirements 9.2, 9.5**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 8: Fleet rollup totals equal the sum over successfully analyzed accounts`
  - [x]* 10.4 Unit/example tests for single-account analyze
    - Cover state/account/type filters, present/absent indicators, `--validate` output, and the no-transfers exit-0 message with mocked services
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.10_

- [x] 11. Reconciliation commands (trigger + status)
  - [x] 11.1 Implement the reconciliation trigger handler (`cli/commands/reconciliation/trigger.ts`)
    - Async `LambdaClient` invoke with function names from Resource_Registry; `--target bg|cur|both`; for `both`, submit bg before cur without waiting; single + `--all-profiles` (Fleet_Runner, dry-run default); partial/total failure reporting and exit codes; wrap invokes with `retryWithBackoff`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 11.1, 11.2, 11.3, 11.4, 11.6, 11.7, 20.1, 24.2_
  - [x]* 11.2 Unit/example tests for reconciliation trigger
    - Assert invoke mapping per target, bg-before-cur ordering, accepted/failed reporting, and exit codes with mocked Lambda client
    - _Requirements: 10.4, 10.5, 10.6, 11.2, 11.3_
  - [x] 11.3 Implement the reconciliation status handler (`cli/commands/reconciliation/status.ts`)
    - Read CloudWatch Logs markers from `log-markers.ts` plus SQS DLQ visible-message depth; parse typed `ReconciliationSummary`/CUR summary shapes; derive per-function status truth table; least-healthy account rollup; default 120-minute lookback; uniform scope (profile/all-profiles/ambient); reject conflicting `--profile` + `--all-profiles`; wrap calls with `retryWithBackoff`
    - _Requirements: 12.1, 12.2, 12.3, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 24.2_
  - [x]* 11.4 Write property test for status derivation
    - **Property 12: Reconciliation status derivation follows the marker/error/DLQ truth table**
    - **Validates: Requirements 12.1, 12.2, 12.3**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 12: Reconciliation status derivation follows the marker/error/DLQ truth table`
  - [x]* 11.5 Write property test for least-healthy account status
    - **Property 13: Account status is the least-healthy evaluated function status**
    - **Validates: Requirements 12.8, 12.9**
    - fast-check, >=100 runs; tag `// Feature: billing-transfer-cli, Property 13: Account status is the least-healthy evaluated function status`
  - [x]* 11.6 Unit/example tests for status scope and lookback
    - Cover ambient/profile/all-profiles routing, conflicting-options rejection before any AWS call, and the 120-minute default with mocked Logs/SQS clients
    - _Requirements: 12.6, 12.7, 12.9, 12.10, 12.11_

- [x] 12. Fleet commands (deploy + status)
  - [x] 12.1 Implement the fleet deploy handler (`cli/commands/fleet/deploy.ts`)
    - Per account resolve identifier/region and run `cdk bootstrap` (unless `--skip-bootstrap`) then `cdk deploy` of the pipeline stack (name from Resource_Registry) under that profile into an isolated `--output`; dry-run by default, `--execute` to perform; `--parallel [N]` (default 5) via Fleet_Runner; record account-resolution failures and continue
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10_
  - [x]* 12.2 Unit/example tests for fleet deploy
    - Assert dry-run prints planned actions and mutates nothing, execute path, `--skip-bootstrap`, parallel default, and account-resolution failure handling with a stubbed tool runner
    - _Requirements: 13.1, 13.3, 13.7, 13.9_
  - [x] 12.3 Implement the fleet status handler (`cli/commands/fleet/status.ts`)
    - Read CloudFormation pipeline-stack status, latest CodePipeline execution, and deployed feature-stack count (total from Resource_Registry); classify fully/partially/no-pipeline; read-only; continue-on-failure; `--parallel`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_
  - [x]* 12.4 Unit/example tests for fleet status
    - Assert classification thresholds and continue-on-failure with mocked CloudFormation/CodePipeline clients
    - _Requirements: 16.3, 16.5_

- [x] 13. Git commands (setup-remotes + push)
  - [x] 13.1 Implement the git setup-remotes handler (`cli/commands/git/setup-remotes.ts`)
    - Read each account's repo name from pipeline-stack outputs; derive remote name deterministically (`codecommit-` + lowercased profile with non-alphanumeric runs collapsed to `-`); add vs replace existing remote; skip accounts with no repo; continue-on-failure; report added/updated/skipped/failed counts
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_
  - [x] 13.2 Implement the git push handler (`cli/commands/git/push.ts`)
    - Dry-run by default (exit 0); execute pushes the selected `--ref` (default current HEAD) to the derived remote `--branch` (default `main`); skip on missing remote; report pushed/skipped/failed; exit non-zero on any push failure
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_
  - [x]* 13.3 Write property test for remote-name derivation
    - **Property 7: Remote-name derivation is deterministic, well-formed, and agreed upon**
    - **Validates: Requirements 14.2, 15.2**
    - fast-check, >=100 runs (including unicode/symbol/mixed-case names); assert setup/push parity; tag `// Feature: billing-transfer-cli, Property 7: Remote-name derivation is deterministic, well-formed, and agreed upon`
  - [x]* 13.4 Unit/example tests for git setup and push
    - Assert add-vs-replace, skip-on-missing-repo/remote, dry-run safety, and the reported counts with a stubbed git runner
    - _Requirements: 14.5, 14.6, 14.7, 15.1, 15.5, 15.6, 15.7_

- [x] 14. Partner Central commands (register-pma + seed-params)
  - [x] 14.1 Implement the register-pma handler (`cli/commands/partner-central/register-pma.ts`)
    - Three ordered steps (register with central profile → create handshake from central → accept from payer, defaulting payer profile to the account id); each step begins only after the prior succeeds; default display name `PMA-<TYPE>-<last4>`; require central profile; on accept failure report the PMA id and that the handshake stays pending; use the PartnerCentralClient
    - _Requirements: 17.1, 17.4, 17.5, 17.6, 17.8, 17.9, 17.10_
  - [x]* 14.2 Write property test for PMA step short-circuit
    - **Property 16: PMA registration short-circuits on the first failing step**
    - **Validates: Requirements 17.1, 17.8, 17.9, 17.10**
    - fast-check, >=100 runs over the first-failing-step index; tag `// Feature: billing-transfer-cli, Property 16: PMA registration short-circuits on the first failing step`
  - [x]* 14.3 Write property test for default display-name derivation
    - **Property 17: Default PMA display name derivation**
    - **Validates: Requirements 17.4, 17.7**
    - fast-check, >=100 runs (valid and malformed inputs); tag `// Feature: billing-transfer-cli, Property 17: Default PMA display name derivation`
  - [x]* 14.4 Unit/example tests for register-pma
    - Assert central-profile-required failure, accept-failure reports the PMA id, and exit codes with a stubbed PartnerCentralClient
    - _Requirements: 17.5, 17.6, 17.8_
  - [x] 14.5 Implement the seed-params handler (`cli/commands/partner-central/seed-params.ts`)
    - Write the two SSM params (paths from Resource_Registry); resolve linked-account-id and enable-management-role with precedence option → env → repo-root `.env`; normalize enable-management-role to `'true'` only for an exact `true`; dry-run by default; single (`--profile`) or fleet (Fleet_Runner); per-account failure detail and aggregated summary; wrap writes with `retryWithBackoff`
    - _Requirements: 18.1, 18.2, 18.4, 18.5, 18.6, 18.7, 18.8, 24.2_
  - [x]* 14.6 Write property test for enable-management-role normalization
    - **Property 14: enable-management-role normalizes to 'true' only for an exact 'true'**
    - **Validates: Requirements 18.6**
    - fast-check, >=100 runs (incl. absent/garbage values); tag `// Feature: billing-transfer-cli, Property 14: enable-management-role normalizes to 'true' only for an exact 'true'`
  - [x]* 14.7 Write property test for value-source precedence
    - **Property 15: Value resolution selects the first non-empty source in precedence order**
    - **Validates: Requirements 18.4**
    - fast-check, >=100 runs over option/env/.env presence combinations; tag `// Feature: billing-transfer-cli, Property 15: Value resolution selects the first non-empty source in precedence order`
  - [x]* 14.8 Unit/example tests for seed-params
    - Assert dry-run vs execute, linked-account-id validation before any write, and the aggregated success/failure summary with mocked SSM client
    - _Requirements: 18.1, 18.3, 18.7, 18.8_

- [x] 15. Termination test command and cross-cutting fleet safety
  - [x] 15.1 Implement the termination test handler (`cli/commands/test/termination.ts`)
    - `--deploy` brings the termination stack to a completed state; run the Jest termination integration test against the deployed function (names from Resource_Registry); guard against a non-completed stack; `--cleanup` destroys regardless of pass/fail; always produce a definitive pass/fail and corresponding exit code
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8_
  - [x]* 15.2 Unit/example tests for the termination command
    - Assert deploy/test-only/cleanup gating, the not-completed-stack guard, cleanup-regardless behavior, and exit codes with a stubbed tool runner
    - _Requirements: 19.3, 19.4, 19.6, 19.7_
  - [x]* 15.3 Write property test for fleet dry-run safety
    - **Property 11: Fleet mutating operations never mutate in dry-run**
    - **Validates: Requirements 11.2, 13.1, 15.1, 18.1, 20.1, 20.7**
    - fast-check, >=100 runs across reconciliation trigger, fleet deploy, git push, and seed-params with stubbed tools/clients; tag `// Feature: billing-transfer-cli, Property 11: Fleet mutating operations never mutate in dry-run`
  - [x]* 15.4 Cross-cutting fleet safety example tests
    - Assert the aggregated success/failure summary, per-failed-account detail or log pointer, continue-on-failure, and exit codes across the mutating fleet commands
    - _Requirements: 20.2, 20.3, 20.4, 20.5_

- [x] 16. Commander entrypoint and routing (final wiring)
  - [x] 16.1 Implement `cli/bin/bt.ts`
    - Configure the silent-by-default logger; parse global options (`--profile`, `--all-profiles`, `--profiles-file`, `--json`, `--no-color`, `--execute`, `--parallel`, `--verbose`, `-h/--help`, `-v/--version`); resolve scope; register the six command groups and their handlers with per-command help and examples; `bt help profiles` topic; version from `package.json`; route unknown command/option to stderr with a non-zero code; the single `process.exit` site translating `CliExitCode`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 22.1_
  - [x]* 16.2 Write property test for unknown-token rejection
    - **Property 18: Unknown command or option is rejected on stderr with a non-zero exit**
    - **Validates: Requirements 1.7**
    - fast-check, >=100 runs over tokens outside the known command/option set; tag `// Feature: billing-transfer-cli, Property 18: Unknown command or option is rejected on stderr with a non-zero exit`
  - [x]* 16.3 Unit/example tests for help, version, and group listing
    - Assert root/group/command help on stdout with exit 0, `bt help profiles`, version output, no-args group listing, and the exact six-group listing rule
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.7, 2.8_
  - [x]* 16.4 Integration smoke test of the stdout/stderr contract
    - Spawn one real child of a trivial `--json` command and assert stdout is a single clean JSON document with diagnostics on stderr; assert no `python3`/`jq` is invoked
    - _Requirements: 7.2, 7.3, 17.2, 22.5_

- [x] 17. Migration and documentation
  - [x] 17.1 Document the script-to-command mapping
    - Update `scripts/README.md` (or a new CLI README) with the full mapping table for every script entry, including `lib/profiles.sh` → Profile_Loader/Profile_List_File and the profile config files
    - _Requirements: 23.1, 23.3, 23.4_
  - [x] 17.2 Update walkthrough docs to use `bt`
    - Replace `./scripts/*.sh` invocations in `README.md` and `MULTI_PROFILE_DEPLOYMENT.md` with the equivalent `bt` commands
    - _Requirements: 23.1, 23.2_
  - [x] 17.3 Convert legacy bash scripts to deprecation shims
    - Replace each replaced `scripts/*.sh` body with a thin shim that prints the replacement `bt` command (per design Open Question #1 recommendation), keeping this as a discrete, reversible change
    - _Requirements: 23.1_

- [x] 18. Final verification
  - [x] 18.1 Run the full build/test/synth gate
    - Run `npm run build`, `npm test` (unit + property suites), and `npm run cdk:synth`; confirm the SDK bump and shared-code refactors keep the Lambda/CDK app green and all CLI tests pass; fix any regressions
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each property test implements exactly one Correctness Property from the design, runs a minimum of 100 `fast-check` iterations, and is tagged `// Feature: billing-transfer-cli, Property <N>: <text>`. The `Validates` lines mirror the design's property-to-requirement annotations.
- Unit/example tests use `aws-sdk-client-mock` for AWS clients and in-memory stubs for the `ExternalToolRunner`, `FleetRunner`, and `PartnerCentralClient`; handlers are invoked directly (no spawning of `bt`), per Req 22.3/22.4.
- The commander entrypoint is wired last so command handlers stay independently testable and no code is orphaned before integration.
- Build, test, and `cdk synth` are gated after the dependency bump/shared refactors (1.3) and again at the end (18.1) because shared Lambda code is touched.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3", "3.1", "3.2", "3.3"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.4", "3.4", "4.1", "4.4", "5.1", "5.4", "6.1", "6.4", "6.6", "7.1", "8.1"] },
    { "id": 2, "tasks": ["1.3", "4.2", "4.3", "4.5", "4.6", "4.7", "4.8", "5.2", "5.3", "5.5", "5.6", "6.2", "6.3", "6.5", "6.7", "7.2", "7.3", "7.4", "8.2", "10.1", "11.1", "11.3", "12.1", "12.3", "13.1", "13.2", "14.1", "14.5", "15.1"] },
    { "id": 3, "tasks": ["10.2", "10.4", "11.2", "11.4", "11.5", "11.6", "12.2", "12.4", "13.3", "13.4", "14.2", "14.3", "14.4", "14.6", "14.7", "14.8", "15.2", "15.3", "15.4"] },
    { "id": 4, "tasks": ["10.3", "16.1"] },
    { "id": 5, "tasks": ["16.2", "16.3", "16.4", "17.1", "17.2", "17.3"] },
    { "id": 6, "tasks": ["18.1"] }
  ]
}
```
