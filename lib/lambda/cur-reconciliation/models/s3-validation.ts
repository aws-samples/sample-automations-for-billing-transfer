// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * S3 validation models
 */

/**
 * Result of S3 bucket validation
 */
export interface S3ValidationResult {
  bucketExists: boolean;
  hasBucketPolicy: boolean;
  policyIsValid: boolean;
  errorMessage?: string;
  remediationSteps?: string[];
}
