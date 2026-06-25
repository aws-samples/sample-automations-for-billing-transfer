# Steering Documentation

Optimized guidance for the Billing Transfer Automation project.

## Always Loaded (2 files)

- **project-overview.md** - Architecture, key concepts, critical requirements
- **development-guide.md** - CDK standards, Lambda config, shared code patterns, AWS CLI defaults (`--no-cli-pager`)

## Load When Needed (Use #filename in chat)

- **#testing-guide** - Jest commands and patterns
- **#billing-conductor-guide** - Billing Conductor API implementation
- **#cdk-nag-guide** - Project-specific CDK Nag suppressions
- **#data-exports-guide** - CUR automation via Legacy CUR API
- **#security-scanning-guide** - Running the security scanners locally (grype, gitleaks, semgrep, checkov, cdk-nag)
- **#pipeline-guide** - CodePipeline architecture, troubleshooting, and debugging (build, deploy, and Lambda runtime)
- **#support-case-policy** - Support case handling policy

## Power-Managed (do not edit by hand)

These files are created and tracked by the **ltm-power** (see `ltm/manifest.json`).
They are part of the long-term memory runtime layer, not hand-authored steering.
To change LTM behavior, use the power ("Validate memory" / "Repair memory"),
not direct edits.

- **ltm-operations.md** - LTM recall/checkpoint/maintenance operations (`inclusion: auto`)
- **ltm-memory-format.md** - LTM JSONL record formats (`inclusion: fileMatch` on `ltm/**/*`)

## Usage

Type `#testing-guide` in chat to load testing patterns, `#pipeline-guide` for
pipeline and deployment troubleshooting, etc.

## Notes

- Generic CDK / CloudFormation and CDK-NAG guidance is provided by the
  **aws-infrastructure-as-code** power; `cdk-nag-guide.md` only documents this
  project's specific suppressions.
- The `--no-cli-pager` rule now lives in `development-guide.md` (always loaded)
  so it applies to every `aws` command without needing a manual `#` include.
