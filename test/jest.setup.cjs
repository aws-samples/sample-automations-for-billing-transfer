// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Jest global setup: skip esbuild Lambda bundling during unit tests.
 *
 * The stack tests synthesize CDK stacks with `Template.fromStack(...)`. Each
 * synth normally runs esbuild to bundle every `NodejsFunction` — and the
 * property tests synthesize the same stack up to 100 times, so the bundling
 * cost dominated the suite (the slowest single test spent ~90s bundling).
 *
 * CDK only bundles a stack whose construct path matches the
 * `aws:cdk:bundling-stacks` context (default `["**"]` = bundle everything).
 * Setting it to an empty list here means NO stack matches, so synthesis
 * produces a placeholder Lambda asset instead of running esbuild. This is safe
 * for these tests because they assert only on the synthesized CloudFormation
 * *template structure* (IAM policies, resource properties, CDK-Nag
 * suppressions) — never on the bundled Lambda code bytes or asset hash, which
 * are the only things the bypass changes.
 *
 * Scope: this affects the Jest process ONLY. Real bundling stays fully
 * exercised by `cdk synth` (the CI `cdk-synth` job and local `npm run
 * cdk:synth`) and by the payer CodePipeline, none of which load this file —
 * they keep the default `["**"]` and bundle for real. We merge (not overwrite)
 * any existing CDK_CONTEXT_JSON and only set the key when unset, so an explicit
 * override still wins.
 */
const KEY = 'aws:cdk:bundling-stacks';

let context = {};
if (process.env.CDK_CONTEXT_JSON) {
  try {
    context = JSON.parse(process.env.CDK_CONTEXT_JSON);
  } catch {
    context = {};
  }
}

if (!(KEY in context)) {
  context[KEY] = [];
  process.env.CDK_CONTEXT_JSON = JSON.stringify(context);
}
