# Multi-Profile Deployment Guide

This guide explains how to deploy the Billing Transfer Automation project to
multiple AWS accounts (one bill-transfer "payer" account per AWS profile) and
manage the per-account CodeCommit repositories using the `bt` CLI.

## Overview

This project is deployed as a self-mutating **CDK Pipeline**. Deploying the
`PipelineStack` into an account provisions a CodePipeline that then builds and
deploys the feature stacks. To roll the solution out to many payer accounts,
you deploy the `PipelineStack` once per account.

Each target account gets its own:
- CDK Pipeline stack
- CodeCommit repository
- Application stacks (deployed via the pipeline)

### Profile list (no hard-coded accounts)

The deployment commands do **not** hard-code account names. They read a list of
AWS profile names from a file:

- `payer-profiles.txt` — your local list at the repo root, one profile per line
  (git-ignored, since it is environment-specific). This is the default the `bt`
  CLI reads.

Point `bt` at a different location with the `--profiles-file <path>` option or
the `PAYER_PROFILES_FILE` environment variable (default: `./payer-profiles.txt`,
resolved relative to the current directory).

The commands reference profiles **by name only**, so the credential source is up
to you. Internal Amazon users may back a profile with a `credential_process`;
external partners typically use IAM Identity Center (SSO) or IAM access keys.
`bt` works the same either way.

Get started — create the list with one AWS profile name per line (blank lines and
lines starting with `#` are ignored):

```bash
# payer-profiles.txt (repo root, git-ignored)
payer-account-1
payer-account-2
payer-account-3
```

## Prerequisites

1. **AWS CLI** with each profile configured in `~/.aws/config`:
   ```bash
   aws configure list-profiles
   ```
2. **git-remote-codecommit** (for pushing to CodeCommit):
   ```bash
   pip install git-remote-codecommit
   ```
3. **Node.js 22+** and dependencies:
   ```bash
   npm install
   ```
4. **Credentials** valid for each profile (SSO, IAM keys, or credential_process).

## Deployment Process

### Step 1: Deploy the Pipeline to Each Account

Dry-run first (prints the actions without touching any account):

```bash
bt fleet deploy --all-profiles
```

Then execute:

```bash
bt fleet deploy --all-profiles --execute
```

For each profile the command:
1. Resolves the target account ID and region.
2. Runs `cdk bootstrap` for that account/region (idempotent). Pass
   `--skip-bootstrap` if every account is already bootstrapped.
3. Deploys the `PipelineStack`.

It continues on per-account failures and prints a success/failure summary at the
end (and exits non-zero if any account failed).

#### Faster rollout: parallel mode

By default accounts deploy sequentially with live output. For many accounts, use
`--parallel [N]` to deploy up to N at a time (default 5):

```bash
bt fleet deploy --all-profiles --execute --parallel 5
```

Each concurrent job synthesizes under its own profile into an isolated output
directory, then bootstraps and deploys that account, writing to its own log
file. A run summary lists OK/FAIL per account at the end.

> **Why a concurrency cap (and not "all at once")?** The cap throttles *local*
> work — each job runs `cdk synth` (esbuild bundling) and uploads Lambda assets
> from your machine — plus credential/API throttling. It does **not** limit
> CloudFormation, which runs each stack in parallel server-side regardless.
>
> **Local-driver caveat:** `bt` must stay running long enough to *kick
> off* each account's CloudFormation deploy. A stack already handed to
> CloudFormation finishes server-side even if your machine sleeps or the command
> is interrupted — but accounts that hadn't started yet will not. If a run is
> interrupted, re-run it: completed stacks are skipped/updated idempotently.
> Use the monitoring snippet below (or re-run the dry-run) to see real state.

**About bootstrap:** `cdk bootstrap` provisions the CDK toolkit stack
(`CDKToolkit`) — an assets S3 bucket, an ECR repo, and the IAM roles CDK assumes
to publish assets and deploy. It is required once per account+region before the
first deploy, and re-running it is a safe no-op/update.

**Expected duration:** ~5-10 minutes per account (sequential); parallel mode
overlaps the CloudFormation wait across accounts.

### Step 2: Set Up Git Remotes

```bash
bt git setup-remotes --all-profiles
```

For each profile, this reads the CodeCommit repository name from the deployed
`PipelineStack` outputs and adds a git remote named `codecommit-<profile>` (the
profile name lowercased, non-alphanumeric characters replaced with `-`).

### Step 3: Push Code to Trigger Pipelines

> **Important — this step is required to actually deploy the automation.**
> After Step 1 the `PipelineStack`, an *empty* CodeCommit repository, and the
> CodePipeline exist, but **none of the feature stacks are deployed yet**. The
> pipeline auto-runs on creation, finds the repo empty, and **fails at the
> Source stage** — this is expected. The feature stacks (event handler,
> billing-group reconciliation, CUR reconciliation, termination notifications)
> are only deployed once you push source to the repo and the pipeline runs
> successfully.

Push to a remote to trigger that account's pipeline:

```bash
git push codecommit-<profile> main
```

Push to every account at once (dry-run by default; add `--execute` to push):

```bash
bt git push --all-profiles --execute
```

After a successful push, the pipeline runs Source → Build/Synth → self-mutate →
deploy of the feature stacks (~10-15 minutes). Confirm with `bt fleet status`
(below).

You can do Steps 1-3 in one pass for the whole fleet:

```bash
bt fleet deploy --all-profiles --execute --parallel 5   # 1. pipelines
bt git setup-remotes --all-profiles                     # 2. remotes
bt git push --all-profiles --execute                    # 3. activate
bt fleet status --all-profiles                          # verify
```

## Fleet Management

Once deployed, these `bt` fleet commands manage the whole fleet. They
all read `payer-profiles.txt` (or `$PAYER_PROFILES_FILE`, or
`--profiles-file <path>`).

### Where the account list comes from

`payer-profiles.txt` is the operational target list — one AWS profile
per payer account. It is the local, git-ignored source of truth for *which*
accounts these commands act on. Keep it in sync with your authoritative payer
inventory. When the inventory changes, update this file (see "Onboarding").

### Check fleet health

```bash
bt fleet status --all-profiles
```

Reports, per account: `PipelineStack` status, latest pipeline execution status,
and how many of the 5 feature stacks are deployed (`n/5`). Quick interpretation:

| Output | Meaning | Action |
|--------|---------|--------|
| `CREATE_COMPLETE` / `Succeeded` / `5/5` | Fully deployed and live | none |
| `… / Failed / 0/5` | Pipeline exists, repo empty (source not pushed) | `bt git push --all-profiles --execute` |
| `NONE / - / 0/5` | Pipeline not deployed | `bt fleet deploy --all-profiles --execute` |

### Run reconciliation across the fleet

```bash
bt reconciliation trigger --all-profiles            # dry-run
bt reconciliation trigger --all-profiles --execute  # invoke in every account
```

Invokes the billing-group and CUR reconciliation Lambdas in each account. Only
works where the feature stacks are deployed (check `bt fleet status` first).

### Audit transfers across the fleet (read-only)

```bash
bt transfers analyze --all-profiles -- --validate
```

Per-account rollup of transfers and their resources (billing groups, CUR
configs, orphans).

### Push a code update to every account

When you change the application code and want it live everywhere:

```bash
git commit -am "your change"
bt git push --all-profiles --execute   # triggers every account's pipeline
bt fleet status --all-profiles         # watch EXEC go Succeeded
```

Each account's pipeline self-mutates and redeploys. Because the 24 pipelines are
independent, an update is "rolled out" only once every account's latest
execution shows `Succeeded` in `bt fleet status`. Watch for version skew: if one
account's push failed, it stays on the prior version until re-pushed.

### Onboarding a new payer account

1. Add an AWS profile for the new account in `~/.aws/config`.
2. Add its profile name to `payer-profiles.txt`.
3. Deploy + wire + activate just that account (scope with a one-line file):
   ```bash
   echo "<new-profile>" > /tmp/one.txt
   bt fleet deploy --all-profiles --profiles-file /tmp/one.txt --execute
   bt git setup-remotes --all-profiles --profiles-file /tmp/one.txt
   bt git push --all-profiles --profiles-file /tmp/one.txt --execute
   ```
4. Verify with `bt fleet status --all-profiles --profiles-file /tmp/one.txt`.

### Offboarding / cleanup

See [Cleanup](#cleanup) below to remove the solution from one or all accounts.

## Troubleshooting

### Remote Not Found

If `bt git setup-remotes` can't find a repository for a profile:

1. Verify the pipeline stack deployed:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name SampleAutomationsForBillingTransfer-PipelineStack \
     --profile <profile> --no-cli-pager
   ```
2. List CodeCommit repositories:
   ```bash
   aws codecommit list-repositories --profile <profile> --no-cli-pager
   ```

### Authentication Issues

```bash
# Confirm the profile resolves to the expected account
aws sts get-caller-identity --profile <profile> --no-cli-pager

# Upgrade git-remote-codecommit if pushes fail
pip install --upgrade git-remote-codecommit
```

### Pipeline Not Triggering

```bash
aws codepipeline list-pipeline-executions \
  --pipeline-name SampleAutomationsForBillingTransferPipeline \
  --profile <profile> --max-results 5 --no-cli-pager

# Manually start if needed
aws codepipeline start-pipeline-execution \
  --name SampleAutomationsForBillingTransferPipeline \
  --profile <profile> --no-cli-pager
```

## Cleanup

> **High blast radius.** This deletes the automation's stacks and resources in
> the target account(s). Review carefully and prefer one account first.

`npx cdk destroy --all` only removes what the local app defines — the
**PipelineStack**. The feature stacks were deployed *by the pipeline*, so they
must be deleted directly, and some resources are retained by design.

Remove from a single account:

```bash
P=<profile>
# 1. Delete the feature stacks (deployed by the pipeline)
for s in BT-BillingGroupEventHandlerStack BT-BillingGroupReconciliationStack \
         BT-CURReconciliationStack BT-BillingTransferTerminationStack; do
  aws cloudformation delete-stack --stack-name "$s" --profile "$P" --no-cli-pager
done
# 2. Delete the pipeline stack
npx cdk destroy SampleAutomationsForBillingTransfer-PipelineStack --profile "$P" --force
```

Remove from all listed accounts (loops the profile list):

```bash
while IFS= read -r profile; do
  case "$profile" in ''|\#*) continue ;; esac
  echo "Destroying in $profile..."
  for s in BT-BillingGroupEventHandlerStack BT-BillingGroupReconciliationStack \
           BT-CURReconciliationStack BT-BillingTransferTerminationStack; do
    aws cloudformation delete-stack --stack-name "$s" --profile "$profile" --no-cli-pager
  done
  npx cdk destroy SampleAutomationsForBillingTransfer-PipelineStack --profile "$profile" --force
done < payer-profiles.txt
```

**Then handle retained resources** (not removed by stack deletion):
- **CodeCommit repository** `sample-automations-for-billing-transfer` (retains your source).
- **S3 buckets** with a Retain policy (CUR destination, config, access logs, pipeline artifacts).
- **KMS keys** (scheduled for deletion, not immediate).
- Remove the corresponding `codecommit-<profile>` git remotes locally and the
  account's line from `payer-profiles.txt`.

```bash
# Example: inspect what remains in an account before manual deletion
aws codecommit list-repositories --profile "$P" --no-cli-pager
aws s3 ls --profile "$P" | grep -iE "cur|billing|artifact"
```

## Best Practices

1. **Dry-run first**, then `--execute` (deploy, push, and reconciliation commands all support it).
2. **Pilot on one account** before rolling out to the whole list (`--profiles-file /tmp/one.txt`).
3. **Keep `payer-profiles.txt` local and in sync** with your payer inventory — it is git-ignored on purpose.
4. **Verify with `bt fleet status`** after deploy/push, and watch for version skew.
5. **Local-driver caveat:** keep the machine awake during a fleet deploy; stacks already kicked off finish server-side, but pending ones need a re-run.
6. **Never commit AWS credentials.** Use SSO or credential_process.

## Additional Resources

- [Pipeline Guide](.kiro/steering/pipeline-guide.md)
- [Development Guide](.kiro/steering/development-guide.md)
- [AWS CDK Pipelines](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.pipelines-readme.html)
- [Git Remote CodeCommit](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-git-remote-codecommit.html)
