---
inclusion: manual
---

# Security Scanning Guide (Local)

This project ships a set of open-source security scanners you can run locally to
catch findings before pushing, instead of waiting for a CI round-trip. This
guide documents the tools, commands, and the project-specific
suppressions/fixes that keep each one clean.

> Scanners operate on the **git-tracked tree**, not your local working
> directory. Local runs that walk `node_modules/`, `cdk.out/`, or other
> gitignored dirs will report noise that the tracked tree never contains —
> always scope local runs to the source (`lib cli bin`) or exclude
> build/artifact dirs.

## Scanners and local equivalents

| Scan | Local tool | Install |
|------|-----------|---------|
| dependencies | `grype` | `brew install grype` |
| secrets | `gitleaks` | `brew install gitleaks` |
| SAST | `semgrep` | `pipx install semgrep` / `brew install semgrep` |
| IaC | `checkov` | `pip install checkov` |
| Python | `bandit` | `pip install bandit` |
| CDK Nag | `cdk-nag` (in-repo) | `npm run cdk:synth` |

## Commands

```bash
# Dependencies (npm). Expect 0 critical/high. Remaining Medium are CDK-bundled
# (brace-expansion) or aws-cdk CLI Python init-template files (pytest) — not our code.
grype dir:. --quiet -o table

# Secrets. Honors .gitleaksignore (fingerprint allowlist). Scan the repo, not the
# working tree; cdk.out/.tmp-* hits locally are gitignored noise.
gitleaks dir . --no-banner

# SAST. Scope to shipped source; expect 0 findings (suppressions are inline nosemgrep).
semgrep scan --config p/javascript --config p/typescript --config p/secrets \
  --exclude node_modules --exclude cdk.out --metrics off lib cli bin

# IaC. Scans cdk.out (run `npm run cdk:synth` first). Expect 0 failed.
npm run cdk:synth
checkov --config-file .checkov.yaml --compact

# CDK Nag (runs in synth). Expect 6 NagReport CSVs, all 0 Non-Compliant.
npm run cdk:synth
```

## How each scanner is kept clean

### grype (dependencies)
- The `minimatch@3.1.2` ReDoS criticals were fixed by `overrides: { minimatch: ^3.1.5 }`
  in `package.json` (covers Jest/ts-jest copies) **and** upgrading `aws-cdk-lib`
  (its bundled minimatch is now 10.x). `overrides` cannot touch a package's
  `bundledDependencies` — only a version bump of the bundling package can.
- Remaining Medium findings are CDK-bundled (`brace-expansion`) or live in the
  `aws-cdk` CLI's `init-templates/**/requirements-dev.txt` (`pytest`) — neither is
  a dependency of this sample. Accept/document; they clear when AWS ships updates.

### gitleaks (secrets)
- `.gitleaksignore` holds finding **fingerprints** (`<sha>:<path>:<rule>:<line>`)
  for reviewed false positives (e.g. secret-redaction unit-test fixtures).
- `.gitleaksignore` is fingerprint-based; if a flagged line moves, regenerate the
  fingerprint from the gitleaks export.

### semgrep (SAST)
- `.semgrepignore` excludes `package.json` and `test/`.
- Inline `// nosemgrep: <rule-id> -- <reason>` annotations suppress reviewed
  findings in `cli/` (operator-supplied/`os.tmpdir` paths, not external input).
  **Placement matters:** the comment must be on the **same line** as the matched
  expression (or immediately above the matched line), and must name the **exact
  rule id** reported — a comment for a different rule on the same line will not
  suppress.
- ReDoS findings (`detect-redos`) were removed by rewriting vulnerable regexes as
  non-regex validators (see `isAwsRegionShape` in
  `partner-central-channel-roles-stack.ts`) rather than suppressing.

### checkov (IaC)
- `.checkov.yaml` scans `cdk.out` and lists intentional `skip-check` entries with
  justifications (Lambda VPC, pipeline/access-log buckets, framework custom-resource
  Lambdas). Keep skip reasons accurate.

### cdk-nag
- See `cdk-nag-guide.md`. The aspect runs at app **and** stage level so all six
  stacks emit NagReports; suppressions are documented per resource.

## Workflow before pushing

Run these before pushing. The first two (`build`, `test`) are the
build-correctness gates — most important when bumping dependencies — followed by
the security scanners.

1. `npm run build` — TypeScript compile (tsc). Must exit 0.
2. `npm test` — full suite. Run `npm test -- --coverage` when you want coverage parity. Must be all-green.
3. `npm run cdk:synth` (regenerates `cdk.out`, runs cdk-nag) → 6 NagReports, 0 Non-Compliant
4. `grype dir:. --quiet -o table` → 0 critical/high
5. `gitleaks dir . --no-banner` → no unreviewed leaks
6. `semgrep scan --config p/javascript --config p/typescript --config p/secrets --exclude node_modules --exclude cdk.out lib cli bin` → 0
7. `checkov --config-file .checkov.yaml --compact` → 0 failed

> **Dependency-upgrade validation:** after any `npm install` / `npm update` /
> override change, run steps 1–3 first (build, test, synth) — a major bump that
> breaks compilation or tests will surface there before the scanners. Then run
> 4–7 to confirm no new vulnerabilities or findings were introduced (e.g. grype
> after a dep bump, semgrep/checkov after a CDK bump that changes synthesized
> output).

> **`--config auto` pitfall:** `semgrep scan --config auto` fetches the full
> registry and scans `node_modules/`, which can hang for minutes. Use the pinned
> rulesets above scoped to `lib cli bin` instead.
