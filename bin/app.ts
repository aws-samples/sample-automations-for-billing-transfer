#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import 'source-map-support/register.js';
import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PipelineStack } from '../lib/stacks/pipeline-stack.js';

// Load local configuration from `.env` (gitignored) so the INITIAL pipeline
// deploy can seed the Partner Central SSM parameters from local values. See
// `.env.example` for the supported keys. `dotenv` only fills in process.env
// values that are not already set, so an explicit shell export or CI variable
// always wins over the file.
//
// `.env` is read ONLY here, for the initial local `cdk deploy` of the
// PipelineStack. After that, the pipeline owns every deployment and reads the
// linked-account config from SSM (see lib/stacks/pipeline-stack.ts). The
// feature stacks — including the Partner Central channel-roles stack — are
// deployed exclusively by the pipeline, never directly from this app.
//
// `quiet: true` suppresses dotenv's promotional console tips (added in
// dotenv 17), keeping synth/deploy output clean.
dotenv.config({ quiet: true });

const app = new cdk.App();

// CDK Pipeline Stack (self-mutating CI/CD pipeline). This is the only stack
// deployed by a local `cdk deploy`; it provisions the pipeline and seeds the
// Partner Central SSM parameters from `.env`. All other stacks are deployed by
// the pipeline.
new PipelineStack(app, 'SampleAutomationsForBillingTransfer-PipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// Apply CDK Nag security checks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
