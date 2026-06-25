<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->

# Requirements Document

## Introduction

The Billing Transfer Automation sample currently ships a collection of operational helper scripts
(12 Bash scripts plus 1 TypeScript script under `scripts/`) for deploying, operating, and inspecting
the solution across one or many AWS payer accounts. The scripts are split across two languages, depend
on external runtime tools (`jq`, `python3`), duplicate AWS lookups, and re-derive billing logic through
the AWS CLI rather than reusing the project's typed services.

This feature replaces those scripts with a single, maintainable TypeScript-based command-line tool,
exposed as the `bt` command, that aggregates AWS API calls into logical, higher-level Billing Transfer
operations. The tool targets AWS partners who are not always technical: it provides discoverable help,
input validation, clear and actionable error messages, dry-run safety on mutating operations, and both
human-readable and machine-readable output. It preserves the existing fleet (multi-account) operating
model — profile-list loading, bounded concurrency, per-account logs, aggregated rollups, and CI-friendly
exit codes — while reusing the project's existing typed services and models.

This document defines the requirements for the CLI. The choice of CLI framework, the internal module
layout, and concrete concurrency-implementation details are design concerns addressed in the design phase.

## Glossary

- **CLI**: The single command-line tool delivered by this feature, exposed as the `bt` executable.
- **Command**: A single CLI operation (for example `bt transfers analyze`), composed of a command group
  and an action, that performs one logical Billing Transfer task.
- **Command_Group**: A named collection of related Commands (for example `transfers`, `reconciliation`,
  `fleet`, `git`, `partner-central`, `test`).
- **Input_Validator**: The CLI component that checks command arguments and options against defined rules
  before any AWS call is made.
- **Output_Formatter**: The CLI component that renders Command results as either human-readable text/tables
  or machine-readable JSON.
- **Error_Reporter**: The CLI component that maps failures to user-facing messages and remediation hints.
- **Profile_Loader**: The CLI component that resolves the list of target AWS profiles for multi-account
  operations.
- **Fleet_Runner**: The CLI component that executes a Command across multiple AWS profiles with bounded
  concurrency, per-account logging, and result aggregation.
- **Resource_Registry**: The single in-code source of truth for AWS resource names (stack names, Lambda
  function names, dead-letter-queue names) and the default AWS region.
- **AWS_Profile**: A named AWS credentials profile defined in the user's AWS configuration; the credential
  source behind it (IAM Identity Center / SSO, IAM access keys, or `credential_process`) is unconstrained.
- **Profile_List_File**: The file that lists target AWS profile names for fleet operations, resolved from
  the `--profiles-file` option when provided, otherwise from `$PAYER_PROFILES_FILE` when set, otherwise
  `./payer-profiles.txt` resolved relative to the current working directory.
- **Fleet_Operation**: A Command that acts on every AWS profile in the resolved profile list.
- **Mutating_Operation**: A Command that changes AWS or remote state (for example deploying stacks,
  invoking reconciliation Lambdas, pushing to remotes, writing SSM parameters, registering a PMA).
- **Read_Operation**: A Command that only reads AWS or local state and does not change it.
- **Dry_Run**: An execution mode in which a Mutating_Operation prints the actions it would take without
  performing them.
- **Account_Id**: A 12-digit AWS account identifier.
- **Relationship_State**: An AWS Organizations billing-transfer relationship state; one of `ACCEPTED`,
  `PENDING`, `TERMINATED`, `WITHDRAWN`, `DECLINED`, `CANCELED`, `EXPIRED`.
- **Transfer_Type**: A billing-transfer classification; one of `direct` or `indirect`.
- **Reconciliation_Target**: The reconciliation function selector; one of `bg` (billing-group),
  `cur` (Cost and Usage Report), or `both`.
- **PMA**: A Partner Central Channel Program Management Account.
- **Default_Region**: The default AWS region for Commands when no region is configured, fixed at
  `us-east-1`.
- **Global_Service**: An AWS Billing Transfer service accessed through a global endpoint in the
  Default_Region: AWS Organizations, AWS Billing, AWS Billing Conductor, and the Cost and Usage Report
  service.
- **Regional_Service**: An AWS service the CLI accesses in the region resolved for the active AWS_Profile:
  Lambda, CloudWatch Logs, SQS (dead-letter queues), CloudFormation, and CodePipeline.
- **Shared_Services**: The existing typed TypeScript services in `lib/lambda/common/services`.
- **Shared_Models**: The existing typed TypeScript models in `lib/lambda/common/models`.
- **Shared_Utilities**: The existing typed TypeScript utilities in `lib/lambda/common/utils` (for example
  error helpers and the retry helper) that the CLI reuses where appropriate.
- **Diagnostic_Log**: A progress, debug, or internal log line emitted by the CLI or by reused Shared_Services
  or Shared_Utilities, distinct from the Command's result output.

## Requirements

### Requirement 1: Single CLI entrypoint and discoverability

**User Story:** As an AWS partner operator, I want one command with discoverable subcommands and help, so
that I can find and run Billing Transfer operations without reading source code.

#### Acceptance Criteria

1. THE CLI SHALL expose a single executable named `bt` through the `package.json` `bin` field.
2. WHEN the CLI is invoked with no Command, THE CLI SHALL display on standard output the list of available
   Command_Groups and a usage summary that includes the `bt` invocation syntax, and THE CLI SHALL exit with
   a zero status code.
3. WHEN the CLI is invoked with `--help` or `-h` and no Command_Group or Command, THE CLI SHALL display on
   standard output usage text listing the available Command_Groups and options, and THE CLI SHALL exit with a
   zero status code.
4. WHEN the CLI is invoked with a Command_Group and `--help`, THE CLI SHALL display on standard output the
   Commands and options available within that Command_Group, and THE CLI SHALL exit with a zero status code.
5. WHEN the CLI is invoked with a Command and `--help`, THE CLI SHALL display on standard output that
   Command's purpose, accepted options, and at least one usage example, and THE CLI SHALL exit with a zero
   status code.
6. WHEN the CLI is invoked with `--version`, THE CLI SHALL display on standard output the tool version read
   from the `package.json` `version` field, and THE CLI SHALL exit with a zero status code.
7. IF the CLI is invoked with an unrecognized Command or option, THEN THE CLI SHALL display on standard error
   an error message that names the unrecognized input, and THE CLI SHALL exit with a non-zero status code.

### Requirement 2: Logical command groups

**User Story:** As an operator, I want commands organized into logical groups, so that related operations
are grouped together and easy to locate.

#### Acceptance Criteria

1. THE CLI SHALL provide a `transfers` Command_Group, containing at least one Command, for billing-transfer
   analysis, and every Command in the `transfers` Command_Group SHALL be a Read_Operation.
2. THE CLI SHALL provide a `reconciliation` Command_Group, containing at least one Command, for triggering
   reconciliation and checking reconciliation status.
3. THE CLI SHALL provide a `fleet` Command_Group, containing at least one Command, for multi-account
   deployment and deployment-health status.
4. THE CLI SHALL provide a `git` Command_Group, containing at least one Command, for configuring CodeCommit
   remotes and pushing source to trigger pipelines.
5. THE CLI SHALL provide a `partner-central` Command_Group, containing at least one Command, for PMA
   registration and channel-role SSM parameter seeding.
6. THE CLI SHALL provide a `test` Command_Group, containing at least one Command, for the termination-handler
   integration test.
7. WHEN the CLI displays the list of available Command_Groups, THE CLI SHALL list, from among the `transfers`,
   `reconciliation`, `fleet`, `git`, `partner-central`, and `test` Command_Groups, exactly those Command_Groups
   that have at least one available Command in the current invocation context, each appearing exactly once and
   no other Command_Group appearing.
8. WHERE a Command_Group has no available Commands in the current invocation context, THE CLI SHALL NOT display
   that Command_Group in the listing.

### Requirement 3: Account referencing by profile

**User Story:** As an operator using SSO, IAM keys, or a credential process, I want to reference accounts by
profile name, so that the CLI works regardless of how my credentials are sourced.

#### Acceptance Criteria

1. THE CLI SHALL reference AWS accounts by AWS_Profile name only, and SHALL NOT require an Account_Id or any
   other identifier to select the account for a Command's AWS calls.
2. WHERE a Command accepts a `--profile` option and a `--profile` value is provided, THE CLI SHALL target the
   AWS_Profile whose name is a case-sensitive exact match of that value for that Command's AWS calls.
3. WHERE a single-account Command is invoked without a `--profile` option, THE CLI SHALL resolve credentials
   using the standard AWS credential resolution chain (the `AWS_PROFILE` environment variable, the standard
   AWS credential environment variables, and the default profile) in standard AWS precedence order.
4. THE CLI SHALL produce the same observable behavior for a given AWS_Profile whether that profile's
   credential source is IAM Identity Center / SSO, IAM access keys, or `credential_process`, and SHALL NOT
   require any specific one of these credential sources.
5. IF the standard AWS credential resolution chain fails or no credentials are available, THEN THE
   Error_Reporter SHALL report a credentials error, and THE CLI SHALL exit immediately with a non-zero status
   code.

### Requirement 4: Profile-list loading for fleet operations

**User Story:** As an operator managing many payer accounts, I want fleet commands to read the account list
from a file, so that I do not hard-code account names in commands.

#### Acceptance Criteria

1. WHEN a Fleet_Operation runs, THE Profile_Loader SHALL read AWS_Profile names from the Profile_List_File,
   treating each non-blank, non-comment line as exactly one AWS_Profile name and preserving the order in which
   the names appear in the file.
2. WHERE a `--profiles-file <path>` option is provided, THE Profile_Loader SHALL resolve the Profile_List_File
   from that path, taking precedence over `$PAYER_PROFILES_FILE` and the default.
3. WHERE the `--profiles-file` option is not provided and the environment variable `PAYER_PROFILES_FILE` is
   set to a non-empty value, THE Profile_Loader SHALL resolve the Profile_List_File from that variable's value.
4. WHERE the `--profiles-file` option is not provided and the environment variable `PAYER_PROFILES_FILE` is
   unset or empty, THE Profile_Loader SHALL resolve the Profile_List_File to `./payer-profiles.txt` resolved
   relative to the current working directory.
5. WHEN the Profile_Loader reads the Profile_List_File, THE Profile_Loader SHALL ignore blank lines and lines
   whose first non-whitespace character is `#`.
6. WHEN the Profile_Loader reads the Profile_List_File, THE Profile_Loader SHALL strip inline comments
   beginning with `#` and SHALL remove leading and trailing whitespace, so the resolved AWS_Profile name
   contains no comment text and no surrounding whitespace.
7. IF the Profile_List_File does not exist, THEN THE Error_Reporter SHALL report that the profile list was
   not found, SHALL state how to create it, THE CLI SHALL halt the Fleet_Operation immediately without
   processing any account, and THE CLI SHALL exit with a non-zero status code.
8. IF, after applying the blank-line, comment, and whitespace processing, the Profile_List_File yields zero
   AWS_Profile names, THEN THE Error_Reporter SHALL report that no profiles were found, and THE CLI SHALL exit
   with a non-zero status code.
9. IF the Profile_List_File exists but cannot be read, THEN THE Error_Reporter SHALL report the failure
   specifically as a read failure and SHALL NOT report it as a file-not-found condition, THE Profile_Loader
   SHALL NOT operate on partially read data, and THE CLI SHALL exit with a non-zero status code.

### Requirement 5: Input validation

**User Story:** As a non-expert partner user, I want my inputs validated with clear messages, so that I catch
mistakes before any AWS call runs.

#### Acceptance Criteria

1. WHEN a Command receives an Account_Id argument, THE Input_Validator SHALL verify, before initiating any
   AWS call, that the value consists of exactly 12 numeric characters (digits 0-9) with no other characters,
   including no whitespace, separators, or sign.
2. IF an Account_Id argument is not exactly 12 numeric characters (digits 0-9), THEN THE Error_Reporter SHALL
   report the invalid value and the expected format (exactly 12 digits, 0-9), and THE CLI SHALL exit with a
   non-zero status code without initiating any AWS call.
3. WHEN a Command receives a Relationship_State option, THE Input_Validator SHALL verify, before initiating
   any AWS call, that the value is a case-sensitive exact match of one of the defined Relationship_State
   values.
4. WHEN a Command receives a Transfer_Type option, THE Input_Validator SHALL verify, before initiating any
   AWS call, that the value is a case-sensitive exact match of one of the defined Transfer_Type values.
5. WHEN a Command receives a Reconciliation_Target option, THE Input_Validator SHALL verify, before
   initiating any AWS call, that the value is a case-sensitive exact match of `bg`, `cur`, or `both`.
6. WHEN a Command receives a PMA program option, THE Input_Validator SHALL verify, before initiating any AWS
   call, that the value is a case-sensitive exact match of one of the accepted program identifiers (`DP`,
   `SPP`, `DS`) or one of the corresponding defined program enum values.
7. IF an Input_Validator check fails, THEN THE Error_Reporter SHALL report the invalid value and the complete
   list of accepted values, and THE CLI SHALL exit with a non-zero status code without initiating any AWS
   call.

### Requirement 6: Friendly, actionable error reporting

**User Story:** As a partner who is not an AWS expert, I want errors explained with next steps, so that I can
resolve problems without external help.

#### Acceptance Criteria

1. IF an AWS call fails because credentials are missing or invalid, THEN THE Error_Reporter SHALL report a
   credentials-related message and SHALL include a remediation hint to verify the credentials for the
   targeted AWS_Profile.
2. IF an AWS call fails with an access-denied condition, THEN THE Error_Reporter SHALL report a
   permissions-related message and SHALL include a remediation hint that identifies the AWS permission
   required by the failed operation.
3. IF an AWS call fails because of API throttling, THEN THE Error_Reporter SHALL report a rate-limit message
   and SHALL include a remediation hint to retry the operation after a delay.
4. WHEN any Command terminates because of an error, THE CLI SHALL exit with a non-zero status code,
   regardless of whether the Error_Reporter succeeds in reporting the error.
5. WHEN the Error_Reporter reports an error, THE Error_Reporter SHALL write the error message and its
   remediation hint to standard error, and SHALL NOT write any part of the error message or remediation hint
   to standard output.
6. IF an AWS call fails with a condition that does not match the missing-or-invalid-credentials,
   access-denied, or API-throttling conditions, THEN THE Error_Reporter SHALL report a message describing the
   failure and SHALL include a remediation hint stating a next step the user can take.
7. WHEN an AWS call failure matches more than one recognized condition, THE Error_Reporter SHALL classify the
   failure by applying the recognized conditions in the order missing-or-invalid-credentials, then
   access-denied, then API-throttling, and SHALL report the message and remediation hint for the first
   matching condition only.

### Requirement 7: Structured and human-readable output

**User Story:** As an operator who both reads results and pipes them into other tools, I want a choice of
human-readable or machine-readable output, so that the CLI serves interactive and automated use.

#### Acceptance Criteria

1. WHERE a Command is invoked without the `--json` option, THE Output_Formatter SHALL render the Command
   result to standard output as human-readable text or tables.
2. WHERE a Command is invoked with the `--json` option, THE Output_Formatter SHALL render the Command result
   to standard output as a single, syntactically valid JSON document that is parseable by a standard JSON
   parser without modification.
3. WHILE a Command renders machine-readable JSON, THE Output_Formatter SHALL write only the JSON document to
   standard output and SHALL write all progress and diagnostic messages to standard error.
4. IF a Command fails while the `--json` option is set, THEN THE Output_Formatter SHALL write to standard
   output exactly one syntactically valid JSON document describing the error as a structured error object,
   SHALL write human-readable diagnostics to standard error, and THE CLI SHALL exit with a non-zero status
   code.
5. THE CLI SHALL invoke AWS CLI operations in a non-interactive, non-paged manner so that no Command blocks
   on an interactive pager.

### Requirement 8: Transfer analysis (single account)

**User Story:** As an operator, I want to list billing transfers and their associated resources for an
account, so that I can verify what the automation sees and audit configuration.

#### Acceptance Criteria

1. WHEN the transfer-analysis Command runs, THE CLI SHALL list billing transfers using the Shared_Services
   for transfer analysis rather than deriving results from raw AWS CLI output.
2. WHERE no Relationship_State option is provided, THE CLI SHALL analyze transfers in the `ACCEPTED` state.
3. WHERE a `--state` option is provided, THE CLI SHALL analyze transfers in the specified Relationship_State.
4. WHERE an `--account` option is provided, THE CLI SHALL restrict analysis to transfers for the specified
   bill-source Account_Id.
5. WHERE a `--type` option is provided, THE CLI SHALL restrict displayed transfers to the specified
   Transfer_Type.
6. WHEN the transfer-analysis Command renders a transfer, THE Output_Formatter SHALL display, for that
   transfer, a distinct indicator for each of its four associated resources — billing view, billing group,
   pricing plan, and CUR configuration — where each indicator shows exactly one of two observable states:
   present or absent.
7. WHERE a `--validate` option is provided, THE Output_Formatter SHALL include consistency-validation results
   that report, for the analyzed transfers, each missing resource — defined as a billing view, billing group,
   pricing plan, or CUR configuration that is expected to be associated with a transfer but does not exist —
   and each orphaned resource — defined as an existing billing view, billing group, pricing plan, or CUR
   configuration that is not associated with any analyzed transfer.
8. WHERE no `--type` option is provided, THE CLI SHALL display both direct and indirect transfers.
9. WHEN the transfer-analysis Command completes, THE Output_Formatter SHALL display an analysis summary that
   reports, for each of the four associated resource types (billing view, billing group, pricing plan, and
   CUR configuration), the count of analyzed transfers for which the resource is present and the count of
   analyzed transfers for which the resource is missing.
10. WHEN the transfer-analysis Command finds no transfers matching the analyzed Relationship_State and any
    applied `--account` or `--type` filters, THE Output_Formatter SHALL display a message indicating that no
    transfers were found, and THE CLI SHALL exit with a zero status code.

### Requirement 9: Fleet transfer analysis rollup

**User Story:** As an operator auditing all payers, I want a per-account analysis rollup, so that I can spot
missing billing groups, missing CUR configs, and orphaned resources across the fleet at a glance.

#### Acceptance Criteria

1. WHEN the fleet transfer-analysis Command runs, THE Fleet_Runner SHALL run the transfer analysis against
   every AWS_Profile resolved by the Profile_Loader.
2. THE Output_Formatter SHALL render a per-account rollup that includes, for each account whose transfer
   analysis completed successfully, total transfer count, direct transfer count, indirect transfer count,
   count of transfers with a billing group, count of transfers missing a billing group, and count of
   transfers missing a CUR configuration.
3. WHERE the `--validate` option is provided, THE Output_Formatter SHALL include in each successfully
   analyzed account's rollup an orphaned-resource count equal to the sum of that account's orphaned billing
   views and orphaned billing groups, and SHALL indicate that validation was performed.
4. WHERE the `--validate` option is not provided, THE Output_Formatter SHALL indicate that the
   orphaned-resource count was not computed using an indicator that is observably distinct from a numeric
   count of zero.
5. WHEN the fleet transfer-analysis Command completes, THE Output_Formatter SHALL display fleet-wide totals,
   aggregated across only the accounts whose transfer analysis completed successfully, for transfers,
   transfers missing billing groups, and transfers missing CUR configurations, and SHALL display the count of
   accounts analyzed successfully and the count of accounts whose analysis failed.
6. IF an account's transfer analysis fails, THEN THE Fleet_Runner SHALL record that account as failed and
   SHALL continue running the transfer analysis against the remaining AWS_Profiles resolved by the
   Profile_Loader, and THE Output_Formatter SHALL render that account's rollup row with a failure indicator
   that is observably distinct from a zero count and from a successfully analyzed row.
7. IF one or more accounts fail their transfer analysis, THEN THE CLI SHALL exit with a non-zero status code.
8. WHEN the fleet transfer-analysis Command completes with every account analyzed successfully, THE CLI SHALL
   exit with a zero status code.
9. IF validation data cannot be included for the fleet transfer analysis when the `--validate` option is
   provided, THEN THE CLI SHALL proceed without validation and SHALL indicate the validation limitation in the
   output rather than failing the Command.

### Requirement 10: Trigger reconciliation

**User Story:** As an operator, I want to trigger the reconciliation functions on demand, so that I can force
a reconciliation pass without waiting for the daily schedule.

#### Acceptance Criteria

1. WHEN the trigger-reconciliation Command runs with Reconciliation_Target `bg`, THE CLI SHALL submit an
   asynchronous invocation of the billing-group reconciliation function and SHALL NOT wait for the
   reconciliation to complete before returning.
2. WHEN the trigger-reconciliation Command runs with Reconciliation_Target `cur`, THE CLI SHALL submit an
   asynchronous invocation of the CUR reconciliation function and SHALL NOT wait for the reconciliation to
   complete before returning.
3. WHERE no Reconciliation_Target option is provided, THE CLI SHALL submit an asynchronous invocation of the
   billing-group reconciliation function before submitting an asynchronous invocation of the CUR
   reconciliation function, and SHALL NOT wait for either reconciliation to complete before returning.
4. IF the trigger-reconciliation Command targets both functions and neither function can be invoked, THEN
   THE Error_Reporter SHALL report that both the billing-group and CUR reconciliation functions were not
   submitted, and THE CLI SHALL exit with a non-zero status code.
5. IF the trigger-reconciliation Command targets both functions and exactly one of the two invocations fails
   to submit, THEN THE Error_Reporter SHALL report which function was not submitted, THE Output_Formatter
   SHALL report that the other function's invocation was accepted, and THE CLI SHALL exit with a non-zero
   status code.
6. WHEN the CLI submits a reconciliation invocation, THE Output_Formatter SHALL report the targeted
   reconciliation function and whether the asynchronous invocation request was accepted.
7. THE CLI SHALL resolve the reconciliation function names from the Resource_Registry.

### Requirement 11: Fleet reconciliation

**User Story:** As an operator, I want to trigger reconciliation across all payer accounts, so that I can run
a fleet-wide reconciliation pass after onboarding several transfers.

#### Acceptance Criteria

1. WHEN the fleet reconciliation Command runs in execute mode, THE Fleet_Runner SHALL submit, for every
   AWS_Profile resolved by the Profile_Loader, the reconciliation invocations selected by the
   Reconciliation_Target — the billing-group reconciliation function for `bg`, the CUR reconciliation
   function for `cur`, or both reconciliation functions for `both`, defaulting to `both` when no
   Reconciliation_Target is provided.
2. WHERE the fleet reconciliation Command is invoked without the `--execute` option, THE CLI SHALL run as a
   Dry_Run, SHALL print, per account, the reconciliation functions selected by the Reconciliation_Target that
   would be invoked, SHALL NOT submit any invocation, and SHALL exit with a zero status code.
3. WHEN the fleet reconciliation Command completes in execute mode, THE Output_Formatter SHALL report, per
   account, whether the invocation was submitted successfully or failed to submit.
4. WHEN the fleet reconciliation Command runs in execute mode, THE Fleet_Runner SHALL write each account's
   output to a per-account log destination.
5. WHILE the fleet reconciliation Command runs in execute mode, WHERE a `--parallel` option with a
   concurrency value N is provided, THE Fleet_Runner SHALL submit reconciliation invocations for at most N
   accounts concurrently, where N is an integer greater than or equal to 1, and WHERE the `--parallel` option
   is not provided, THE Fleet_Runner SHALL submit reconciliation invocations sequentially, one account at a
   time; in a Dry_Run THE Fleet_Runner SHALL submit no reconciliation invocation regardless of the `--parallel`
   option.
6. IF submitting the selected reconciliation invocation for an account fails, THEN THE Fleet_Runner SHALL
   record that account as failed and SHALL continue submitting invocations for the remaining accounts.
7. IF the fleet reconciliation Command completes in execute mode with one or more selected invocations having
   failed to submit, THEN THE CLI SHALL exit with a non-zero status code, and WHEN every selected invocation
   was submitted successfully, THE CLI SHALL exit with a zero status code.

### Requirement 12: Reconciliation status check

**User Story:** As an operator, I want to check whether the most recent reconciliation run succeeded, so that
I have a go/no-go before triggering dependent steps.

#### Acceptance Criteria

1. WHEN the reconciliation-status Command runs for an account, THE CLI SHALL evaluate each reconciliation
   function selected by the Reconciliation_Target — or both reconciliation functions when no
   Reconciliation_Target is provided — and SHALL assign each evaluated function exactly one status of `DONE`,
   `ATTENTION`, `FAILED`, or `PENDING`, derived from CloudWatch Logs completion and failure markers emitted
   within the lookback window and the function's dead-letter-queue visible-message count, by assigning `DONE`
   when a completion marker is present within the lookback window with no failure marker, zero reported item
   errors, and a dead-letter-queue visible-message count of zero, and by assigning `PENDING` when neither a
   completion marker nor a failure marker is present within the lookback window.
2. IF a failure marker is logged for an evaluated function within the lookback window, THEN THE CLI SHALL
   assign that function the `FAILED` status regardless of any completion marker or dead-letter-queue count.
3. WHEN a completion marker but no failure marker is logged for an evaluated function within the lookback
   window, and the completion marker reports one or more item errors or the function's dead-letter-queue
   visible-message count is greater than zero, THE CLI SHALL assign that function the `ATTENTION` status.
4. WHERE no `--lookback` option is provided, THE CLI SHALL use a lookback window of 120 minutes ending at the
   time the Command runs.
5. IF a `--lookback` option value is provided that is not a whole number of minutes between 1 and 10080
   inclusive, THEN THE Error_Reporter SHALL report the invalid value and the accepted range, and THE CLI SHALL
   exit with a non-zero status code before initiating any AWS call.
6. WHERE neither `--profile` nor `--all-profiles` is provided, THE CLI SHALL check a single account using the
   active AWS credentials.
7. WHERE a `--profile <name>` option is provided, THE CLI SHALL check only that single named account.
8. WHERE the `--all-profiles` option is provided, THE Fleet_Runner SHALL check every AWS_Profile resolved by
   the Profile_Loader.
9. IF both `--profile` and `--all-profiles` are provided, THEN THE Error_Reporter SHALL report the conflicting
   options, and THE CLI SHALL exit with a non-zero status code before initiating any AWS call and without
   processing any account.
10. WHEN the reconciliation-status Command completes, THE Output_Formatter SHALL classify each checked account
    by its least-healthy evaluated-function status — ranked from least to most healthy as `FAILED`, `PENDING`,
    `ATTENTION`, `DONE` — and SHALL display the number of accounts in each status.
11. IF any checked function is not in the `DONE` status, THEN THE CLI SHALL exit with a non-zero status code.

### Requirement 13: Fleet deployment

**User Story:** As an operator rolling out the solution, I want to deploy the pipeline stack to every payer
account, so that I can provision the automation across the fleet in one operation.

#### Acceptance Criteria

1. WHERE the fleet-deploy Command is invoked without the `--execute` option, THE CLI SHALL run as a Dry_Run
   and SHALL print the bootstrap and deploy actions that would be taken per account without performing them.
2. WHEN the fleet-deploy Command runs in execute mode, THE Fleet_Runner SHALL, for every AWS_Profile resolved
   by the Profile_Loader, resolve that profile's account identifier and region and deploy the pipeline stack
   to the resolved account and region using that profile's credentials.
3. WHERE the `--skip-bootstrap` option is provided, THE CLI SHALL omit the CDK bootstrap action for each
   account.
4. WHERE a `--parallel` option with a concurrency value N is provided, THE Fleet_Runner SHALL deploy at most
   N accounts concurrently, where N is an integer greater than or equal to 1.
5. WHILE the fleet-deploy Command deploys accounts concurrently, THE Fleet_Runner SHALL write each account's
   deployment output to a per-account log destination.
6. THE CLI SHALL resolve the pipeline stack name from the Resource_Registry.
7. IF resolving an account identifier for a profile fails, THEN THE Fleet_Runner SHALL record that account as
   failed and SHALL continue with the remaining accounts.
8. WHERE the `--parallel` option is provided without a concurrency value, THE Fleet_Runner SHALL deploy at
   most 5 accounts concurrently.
9. WHERE the `--parallel` option is not provided, THE Fleet_Runner SHALL deploy accounts sequentially, one at
   a time.
10. WHILE the fleet-deploy Command deploys accounts concurrently, THE Fleet_Runner SHALL synthesize the CDK
    app for each account under that account's own profile into an isolated output location, so that concurrent
    synthesis for different accounts does not collide.

### Requirement 14: Git remote wiring

**User Story:** As an operator, I want a CodeCommit git remote configured per payer account, so that I can
push source to trigger each account's pipeline.

#### Acceptance Criteria

1. WHEN the git-remote-setup Command runs, THE CLI SHALL read each account's repository name from the
   outputs of the pipeline stack whose name is provided by the Resource_Registry, for every AWS_Profile
   resolved by the Profile_Loader.
2. WHEN the CLI configures a remote for an account, THE CLI SHALL derive the remote name deterministically by
   lowercasing the AWS_Profile name, replacing each run of one or more non-alphanumeric characters with a
   single hyphen, and prefixing the result with `codecommit-`.
3. WHERE no remote with the derived name exists, THE CLI SHALL add a remote with the derived name whose URL is
   the profile-based git-remote-codecommit form for that account's AWS_Profile.
4. WHERE a remote with the derived name already exists, THE CLI SHALL replace the existing remote with a URL
   in the profile-based git-remote-codecommit form for that account's AWS_Profile.
5. IF an account's pipeline stack does not expose a repository name, THEN THE CLI SHALL skip that account,
   SHALL report the account as skipped, and SHALL continue configuring remotes for the remaining accounts.
6. IF configuring the remote for an account fails, THEN THE CLI SHALL report that account as failed and SHALL
   continue configuring remotes for the remaining accounts.
7. WHEN the git-remote-setup Command completes, THE Output_Formatter SHALL report the count of remotes added,
   the count of remotes updated, the count of accounts skipped, and the count of accounts failed.

### Requirement 15: Fleet source push

**User Story:** As an operator, I want to push source to every payer account's remote, so that I can activate
or update the automation across the fleet.

#### Acceptance Criteria

1. WHERE the fleet-push Command is invoked without the `--execute` option, THE CLI SHALL run as a Dry_Run,
   SHALL print the push actions that would be taken per account without performing them, SHALL push nothing,
   and SHALL exit with a zero status code.
2. WHEN the fleet-push Command runs in execute mode, THE CLI SHALL push the selected local reference to each
   account's derived remote branch for every AWS_Profile resolved by the Profile_Loader, where the derived
   remote name matches the deterministic remote name produced by the git-remote-setup Command.
3. WHERE no `--branch` option is provided, THE CLI SHALL push to the remote branch `main`.
4. WHERE no `--ref` option is provided, THE CLI SHALL push the current local HEAD branch.
5. IF an account's derived remote does not exist, THEN THE CLI SHALL skip that account, SHALL report the
   account as skipped, and SHALL continue with the remaining accounts.
6. WHEN the fleet-push Command completes, THE Output_Formatter SHALL report the counts of pushed, skipped, and
   failed accounts.
7. IF pushing to an account's derived remote fails in execute mode, THEN THE CLI SHALL record that account as
   failed, SHALL report it distinctly from a skipped account, and SHALL continue pushing to the remaining
   accounts.
8. IF one or more account pushes fail in execute mode, THEN THE CLI SHALL exit with a non-zero status code,
   and WHEN every account was pushed or skipped without a push failure, THE CLI SHALL exit with a zero status
   code.

### Requirement 16: Fleet deployment-health status

**User Story:** As an operator, I want a one-glance health view across all payers, so that I can see which
accounts are fully deployed versus pending.

#### Acceptance Criteria

1. WHEN the fleet-status Command runs, THE Fleet_Runner SHALL report, for each AWS_Profile resolved by the
   Profile_Loader, the pipeline stack status, the latest pipeline execution status, the count of tracked
   feature stacks that are deployed, and the total count of tracked feature stacks, where the total count is
   the size of the tracked feature-stack set resolved from the Resource_Registry.
2. THE CLI SHALL resolve the set of tracked feature stacks from the Resource_Registry.
3. WHEN the fleet-status Command completes, THE Output_Formatter SHALL display the count of fully deployed
   accounts, the count of partially deployed accounts, and the count of accounts with no pipeline, where, for
   each reported account: the account is fully deployed when its pipeline stack is present and its deployed
   feature-stack count equals the total count of tracked feature stacks resolved from the Resource_Registry;
   the account is partially deployed when its pipeline stack is present and its deployed feature-stack count
   is less than that total count; and the account has no pipeline when its pipeline stack status indicates
   that the pipeline stack does not exist.
4. THE fleet-status Command SHALL be a Read_Operation and SHALL NOT change AWS state, but MAY write local
   state such as logs, caches, or temporary status files during execution.
5. IF determining an account's deployment-health status fails for an AWS_Profile, THEN THE Fleet_Runner SHALL
   record that account as failed and SHALL continue determining status for the remaining AWS_Profiles resolved
   by the Profile_Loader.
6. WHERE a `--parallel` option with a concurrency value N is provided, THE Fleet_Runner SHALL determine
   deployment-health status for at most N accounts concurrently, where N is an integer greater than or equal
   to 1.

### Requirement 17: Partner Central PMA registration

**User Story:** As an operator onboarding a payer, I want to register and confirm a Partner Central PMA, so
that the account is enabled as a Billing Transfer Channel PMA.

#### Acceptance Criteria

1. WHEN the PMA-registration Command runs, THE CLI SHALL perform exactly three steps in the following order:
   (1) register the PMA using the central-account profile, (2) create the program-management confirmation
   handshake from the central account using the central-account profile, and (3) accept the handshake from
   the payer account using the payer-account profile, where the payer-account profile defaults to the supplied
   Account_Id when no payer-account profile is provided, and THE CLI SHALL begin each step only after the
   immediately preceding step has completed successfully.
2. THE CLI SHALL parse Partner Central API responses using TypeScript without invoking an external runtime
   interpreter.
3. WHEN the PMA-registration Command runs, THE Input_Validator SHALL verify the supplied Account_Id is
   exactly 12 digits before initiating any AWS call.
4. WHERE no display-name option is provided, THE CLI SHALL derive a default display name from the program
   identifier and the last four digits of the Account_Id.
5. IF the central-account profile is not provided, THEN THE Error_Reporter SHALL report that the central
   profile is required and THE CLI SHALL exit with a non-zero status code.
6. IF accepting the handshake from the payer account fails, THEN THE Error_Reporter SHALL report the failure,
   SHALL state that the handshake remains pending and can be accepted later, THE Output_Formatter SHALL report
   the resulting PMA identifier produced by the register step, and THE CLI SHALL exit with a non-zero status
   code.
7. IF the default display name cannot be derived because the program identifier or Account_Id is missing or
   malformed, THEN THE Error_Reporter SHALL report the failure and THE CLI SHALL exit with a non-zero status
   code before initiating any AWS call.
8. WHEN the accept-handshake step completes successfully, THE CLI SHALL report the resulting PMA identifier
   and exit with a zero status code.
9. IF registering the PMA fails, THEN THE Error_Reporter SHALL report the failure, THE CLI SHALL not create or
   accept the program-management confirmation handshake, and THE CLI SHALL exit with a non-zero status code.
10. IF creating the program-management confirmation handshake fails, THEN THE Error_Reporter SHALL report the
    failure, THE CLI SHALL not accept the handshake, and THE CLI SHALL exit with a non-zero status code.

### Requirement 18: Channel-role SSM parameter seeding

**User Story:** As an operator, I want to seed the Partner Central channel-role SSM parameters into payer
accounts, so that the pipeline's build step can read them as the durable source of truth.

#### Acceptance Criteria

1. WHERE the SSM-seeding Command is invoked without the `--execute` option, THE CLI SHALL run as a Dry_Run,
   SHALL print, per targeted account, the parameter names and values that would be written, SHALL NOT write
   any parameter, and SHALL exit with a zero status code.
2. WHEN the SSM-seeding Command runs in execute mode, THE CLI SHALL write, for each targeted account, the
   linked-account-id parameter at the fixed path `/billing-transfer/partner-central/linked-account-id` and
   the enable-management-role parameter at the fixed path
   `/billing-transfer/partner-central/enable-management-role`.
3. THE Input_Validator SHALL verify, before any parameter is written, that the linked-account-id value
   consists of exactly 12 numeric characters (digits 0-9) with no other characters, and IF the
   linked-account-id value is not exactly 12 numeric characters (digits 0-9), THEN THE Error_Reporter SHALL
   report the invalid value and the expected format (exactly 12 digits, 0-9) and THE CLI SHALL exit with a
   non-zero status code without writing any parameter.
4. WHEN the SSM-seeding Command resolves its values, THE CLI SHALL source the linked-account-id and
   enable-management-role from command options, then environment variables, then the repository-root `.env`
   file, in that order of precedence, using the first source in that order that provides a non-empty value.
5. WHERE a `--profile` option is provided, THE CLI SHALL target only the specified account; otherwise THE
   Fleet_Runner SHALL target every AWS_Profile resolved by the Profile_Loader.
6. WHEN the SSM-seeding Command resolves the enable-management-role value, THE CLI SHALL normalize it to the
   string `true` only when the resolved value is exactly `true`, SHALL normalize it to the string `false` in
   every other case — including when the value is absent or is neither exactly `true` nor exactly `false` —
   and SHALL write the normalized string as the enable-management-role parameter value.
7. IF writing the linked-account-id parameter or the enable-management-role parameter for an account fails in
   execute mode, THEN THE Fleet_Runner SHALL record that account as failed, SHALL report which parameter write
   failed, and SHALL continue writing parameters for the remaining targeted AWS_Profiles.
8. WHEN the SSM-seeding Command completes in execute mode, THE Output_Formatter SHALL display an aggregated
   summary reporting the count of accounts whose parameters were written successfully and the count of
   accounts that failed, and IF one or more targeted accounts failed, THEN THE CLI SHALL exit with a non-zero
   status code; otherwise THE CLI SHALL exit with a zero status code.

### Requirement 19: Termination-handler integration test

**User Story:** As a developer, I want to run the termination-handler integration test from the CLI, so that
I can validate the termination-notification path in a real account.

#### Acceptance Criteria

1. WHERE the `--deploy` option is provided, THE CLI SHALL deploy the termination stack to a completed
   deployment state before running the integration test.
2. WHILE the termination stack is in a completed deployment state, WHEN the termination-test Command runs,
   THE CLI SHALL run the termination-handler integration test against the deployed termination function.
3. WHERE the `--cleanup` option is provided, THE CLI SHALL destroy the termination stack after the
   integration test completes, regardless of whether the integration test passed or failed.
4. IF the termination stack is not in a completed deployment state when a test run is requested, THEN THE
   Error_Reporter SHALL report that the stack is unavailable, THE CLI SHALL NOT run the integration test, and
   THE CLI SHALL exit with a non-zero status code.
5. THE CLI SHALL resolve the termination stack name and termination function name from the Resource_Registry.
6. WHEN the integration test passes, THE CLI SHALL exit with a zero status code after any requested cleanup
   completes.
7. IF the integration test fails, THEN THE CLI SHALL exit with a non-zero status code after any requested
   cleanup completes.
8. WHEN the termination-test Command runs the integration test while the termination stack is in a completed
   deployment state, THE CLI SHALL always produce a definitive pass or fail result and SHALL NOT leave the
   result indeterminate.
9. WHERE the `--test-only` option is provided, THE CLI SHALL run the integration test against the
   already-deployed termination stack and SHALL NOT deploy the stack first.
10. IF both the `--deploy` and `--test-only` options are provided, THEN THE Error_Reporter SHALL report the
    conflicting options, and THE CLI SHALL exit with a non-zero status code before deploying or testing.

### Requirement 20: Fleet operation safety and CI behavior

**User Story:** As an operator running fleet commands in CI, I want safe defaults and predictable exit codes,
so that automation behaves correctly and fails loudly.

#### Acceptance Criteria

1. WHERE a Mutating_Operation that acts on the fleet is invoked without the `--execute` option, THE CLI SHALL
   run that operation as a Dry_Run that performs no AWS or remote state change and prints, per account, the
   actions it would take.
2. WHEN a Fleet_Operation processes accounts, IF an individual account fails, THEN THE Fleet_Runner SHALL
   record that account as failed and SHALL continue processing the remaining accounts in the resolved profile
   list.
3. WHEN a Fleet_Operation completes, THE Output_Formatter SHALL display an aggregated summary that reports the
   count of accounts that succeeded and the count of accounts that failed.
4. IF one or more accounts fail during a Fleet_Operation, THEN THE Output_Formatter SHALL include in the
   aggregated summary, for each failed account, either a failure detail describing the cause of the failure or
   a pointer to that account's per-account log, and THE CLI SHALL exit with a non-zero status code.
5. WHEN all accounts succeed during a Fleet_Operation run in execute mode, THE CLI SHALL exit with a zero
   status code.
6. WHEN a Fleet_Operation runs with a concurrency limit N, where N is an integer greater than or equal to 1,
   THE Fleet_Runner SHALL run at most N accounts concurrently.
7. WHEN a fleet Mutating_Operation completes as a Dry_Run, THE CLI SHALL exit with a zero status code.

### Requirement 21: Single source of truth for resource names

**User Story:** As a maintainer, I want resource names defined once, so that renaming a stack or function
updates every Command consistently.

#### Acceptance Criteria

1. THE Resource_Registry SHALL define, in one in-code location, the pipeline stack name, the CodePipeline
   pipeline execution name, the feature stack names, the reconciliation function names, the termination
   function name, and the dead-letter-queue names.
2. THE Resource_Registry SHALL define the Default_Region as `us-east-1`.
3. WHEN a Command references an AWS resource name listed in the Resource_Registry, THE Command SHALL obtain
   that name from the Resource_Registry.
4. WHEN a Command calls a Global_Service, THE Command SHALL use the Default_Region (`us-east-1`).
5. WHEN a Command calls a Regional_Service, THE Command SHALL use the region configured for the active
   AWS_Profile, and WHERE the active AWS_Profile has no configured region, THE Command SHALL use the
   Default_Region.
6. IF the Default_Region is unavailable or a Command fails because of the region, THEN THE Error_Reporter
   SHALL report the unavailable default region, and THE CLI SHALL exit immediately with a non-zero status
   code.
7. THE CLI SHALL define each AWS resource name listed in the Resource_Registry exactly once, within the
   Resource_Registry, and SHALL NOT hard-code any such name in any location outside the Resource_Registry.

### Requirement 22: Maintainability, reuse, and testability

**User Story:** As a maintainer, I want a single-language, testable codebase that reuses existing typed code,
so that the tool is high quality and easy to extend.

#### Acceptance Criteria

1. THE CLI SHALL be implemented in TypeScript as a single codebase, with no portion of Command logic
   implemented in another programming language and with no runtime dependency on the project's legacy Bash
   script libraries.
2. WHEN a Command performs billing-transfer analysis or resource lookups, THE Command SHALL reuse the
   Shared_Services and Shared_Models rather than re-deriving billing logic from raw AWS CLI output.
3. THE CLI SHALL implement each Command's logic in a handler that can be invoked directly from a unit test
   through a function call, without spawning a child process that runs the `bt` executable or the CLI
   entrypoint.
4. THE CLI SHALL provide, for each Command handler, a means of supplying substitute (mocked) AWS client
   implementations, so that the handler can be unit-tested with mocked AWS clients and without making any real
   AWS call.
5. THE CLI SHALL operate without requiring `jq` or `python3` at runtime.

### Requirement 23: Migration from existing scripts and npm wiring

**User Story:** As a maintainer adopting the CLI, I want the CLI wired into the project and mapped to the
existing scripts, so that the transition is clear and the tool is runnable through the project tooling.

#### Acceptance Criteria

1. THE CLI SHALL provide, for each operational script listed in `scripts/README.md`, at least one Command
   that performs that script's function, and these Commands SHALL collectively cover single-account transfer
   analysis, fleet transfer analysis, single-account reconciliation triggering, fleet reconciliation
   triggering, reconciliation status checking, fleet pipeline deployment, CodeCommit git-remote setup, fleet
   source push, fleet deployment-health status, PMA registration, channel-role SSM parameter seeding, and the
   termination-handler integration test.
2. THE CLI SHALL be runnable through a `package.json` script entry that invokes the same `bt` executable, in
   addition to direct invocation of the `bt` executable.
3. THE CLI documentation SHALL provide a mapping that lists every script entry in `scripts/README.md` —
   including the operational scripts, the shared helper `lib/profiles.sh`, and the profile configuration
   files — and, for each entry, names either the replacement Command or the CLI component, option, or behavior
   that provides the equivalent function.
4. WHERE a script entry in `scripts/README.md` has no direct replacement Command — specifically the shared
   helper `lib/profiles.sh` and the profile configuration files — THE CLI documentation SHALL identify the
   Profile_Loader and the Profile_List_File as providing the equivalent profile-list-loading function.

### Requirement 24: Diagnostic logging and shared-utility reuse

**User Story:** As a maintainer, I want the CLI to reuse the main application's shared utilities and keep
diagnostic logging off the result stream, so that the tool stays consistent with the codebase and its
machine-readable output is never corrupted.

#### Acceptance Criteria

1. THE CLI SHALL reuse the Shared_Utilities error helpers (error-code extraction, error-message extraction,
   and error normalization) for classifying and reporting AWS failures rather than re-implementing them.
2. WHEN a Command performs a direct AWS SDK call that is not made through a Shared_Service, THE CLI SHALL
   apply the Shared_Utilities retry-with-backoff helper for transient-failure handling.
3. WHERE the `--verbose` option is not provided, THE CLI SHALL suppress Diagnostic_Log output from the CLI and
   from reused Shared_Services and Shared_Utilities, so that no Diagnostic_Log line is written to standard
   output.
4. WHERE the `--verbose` option is provided, THE CLI SHALL write Diagnostic_Log output to standard error.
5. THE CLI SHALL write no Diagnostic_Log line to standard output, regardless of the `--verbose` option or the
   `--json` option.
6. WHILE the `--json` option is set, THE CLI SHALL keep standard output limited to the single JSON result
   document defined in Requirement 7, with all Diagnostic_Log output routed to standard error only.
7. THE CLI SHALL emit no CloudWatch Embedded Metric Format metrics, AWS X-Ray trace segments, or Lambda
   middleware instrumentation, because these Lambda-only utilities are out of scope for the CLI.

### Requirement 25: Documentation and CI migration

**User Story:** As a maintainer adopting the CLI, I want the project's documentation and CI to reference the
CLI instead of the legacy scripts, so that the transition is complete and nothing still points at removed or
deprecated scripts.

#### Acceptance Criteria

1. THE CLI documentation SHALL update `README.md` and `scripts/README.md` to present the `bt` Commands as the
   supported way to run the operations previously provided by the scripts.
2. THE CLI documentation SHALL update the multi-account deployment walkthrough (`MULTI_PROFILE_DEPLOYMENT.md`)
   to use the `bt` fleet and git Commands in place of the legacy fleet scripts.
3. WHERE a continuous-integration configuration in the repository invokes a legacy script that a `bt` Command
   replaces, THE CLI migration SHALL update that configuration to invoke the equivalent `bt` Command.
4. THE CLI documentation SHALL document how an operator installs and runs `bt` (for example via the
   `package.json` script entry and the `bin` executable), so that a non-expert partner can run it without
   reading source code.
5. THE CLI documentation SHALL update the project steering guides under `.kiro/steering` that reference the
   legacy scripts so that they reference the equivalent `bt` Commands.

## Open Questions

These product decisions are recorded for resolution during requirements review or design; they are not yet
settled by the requirements above.

1. **Transition strategy for the existing scripts.** Should the existing Bash scripts be retained during a
   deprecation period (with a notice pointing to the CLI), removed immediately on CLI release, or kept as thin
   wrappers that call the CLI? Requirement 23 currently assumes coexistence without specifying a removal date.
2. **Profile-list file location.** _Resolved:_ the default Profile_List_File is `./payer-profiles.txt`
   resolved relative to the current working directory, overridable by the `--profiles-file` option (highest
   precedence) and the `$PAYER_PROFILES_FILE` environment variable (see Requirement 4).
3. **JSON output coverage.** Requirement 7 mandates a `--json` option. Is structured JSON output required for
   every Command (including fleet deployment and git wiring), or only for the read-oriented analysis and
   status Commands in the first release?
4. **Backward-compatible flags and environment variables.** _Resolved:_ the CLI continues to honor
   `PAYER_PROFILES_FILE` (per Requirement 4), and the design documents the other legacy environment variables
   (`ANALYZE_LOG_DIR`, `RECON_LOG_DIR`, `DEPLOY_LOG_DIR`, `FLEET_STATUS_PARALLEL`, `CENTRAL_PROFILE`, and
   similar) as honored.
5. **Default fleet concurrency.** _Resolved:_ per-operation behavior is specified in the requirements —
   fleet-deploy runs sequentially when `--parallel` is absent, at most 5 accounts concurrently when
   `--parallel` is given without a value, and at most N when a value is provided; other fleet operations accept
   `--parallel N` with N >= 1 (see Requirements 11, 13, and 16).
