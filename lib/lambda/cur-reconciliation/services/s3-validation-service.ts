// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Service for validating S3 bucket configuration for Legacy CUR API
 */

import {
  S3Client,
  HeadBucketCommand,
  GetBucketPolicyCommand,
  GetBucketLocationCommand,
} from '@aws-sdk/client-s3';
import { S3ValidationResult } from '../models/s3-validation.js';

export class S3ValidationService {
  private s3Client: S3Client;

  constructor(s3Client?: S3Client) {
    this.s3Client = s3Client || new S3Client({});
  }

  /**
   * Validates that an S3 bucket exists and has the required bucket policy for Legacy CUR API delivery
   * 
   * @param bucketName - Name of the S3 bucket
   * @param region - Expected region of the bucket
   * @returns Validation result with detailed error messages and remediation steps
   */
  async validateBucket(bucketName: string, region: string): Promise<S3ValidationResult> {
    const result: S3ValidationResult = {
      bucketExists: false,
      hasBucketPolicy: false,
      policyIsValid: false,
    };

    try {
      // Step 1: Check if bucket exists
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      result.bucketExists = true;

      // Step 2: Verify bucket location matches expected region
      const locationResponse = await this.s3Client.send(
        new GetBucketLocationCommand({ Bucket: bucketName })
      );
      
      // Note: us-east-1 returns null for LocationConstraint
      const bucketRegion = locationResponse.LocationConstraint || 'us-east-1';
      
      if (bucketRegion !== region) {
        result.errorMessage = `Bucket region mismatch: bucket is in ${bucketRegion}, but configuration specifies ${region}`;
        result.remediationSteps = [
          `Update the configuration to use region: ${bucketRegion}`,
          `Or create a new bucket in region: ${region}`,
        ];
        return result;
      }

      // Step 3: Check if bucket policy exists
      let policyDocument: string | undefined;
      try {
        const policyResponse = await this.s3Client.send(
          new GetBucketPolicyCommand({ Bucket: bucketName })
        );
        policyDocument = policyResponse.Policy;
        result.hasBucketPolicy = !!policyDocument;
      } catch (error: any) {
        if (error.name === 'NoSuchBucketPolicy') {
          result.hasBucketPolicy = false;
          result.errorMessage = 'Bucket policy is missing';
          result.remediationSteps = this.generateBucketPolicyRemediationSteps(bucketName);
          return result;
        }
        throw error;
      }

      // Step 4: Validate bucket policy for Legacy CUR API permissions
      if (policyDocument) {
        const isValid = this.validateLegacyCURPolicy(policyDocument);
        result.policyIsValid = isValid;

        if (!isValid) {
          result.errorMessage = 'Bucket policy does not grant required permissions for Legacy CUR API';
          result.remediationSteps = this.generateBucketPolicyRemediationSteps(bucketName);
        }
      }

      return result;
    } catch (error: any) {
      // Handle bucket not found
      if (error.name === 'NotFound' || error.name === 'NoSuchBucket') {
        result.bucketExists = false;
        result.errorMessage = `S3 bucket '${bucketName}' does not exist`;
        result.remediationSteps = [
          `Create the S3 bucket: aws s3 mb s3://${bucketName} --region ${region}`,
          'Apply the required bucket policy (see documentation)',
          'Ensure the bucket is in the correct region',
        ];
        return result;
      }

      // Handle access denied
      if (error.name === 'Forbidden' || error.name === 'AccessDenied') {
        result.errorMessage = `Access denied to S3 bucket '${bucketName}'`;
        result.remediationSteps = [
          'Verify the Lambda execution role has s3:GetBucketPolicy and s3:GetBucketLocation permissions',
          'Check the bucket policy allows access from this account',
          'Ensure the bucket is not in a different AWS account without proper cross-account permissions',
        ];
        return result;
      }

      // Handle other errors
      result.errorMessage = `Failed to validate S3 bucket: ${error.message || error.name || 'UnknownError'}`;
      result.remediationSteps = [
        'Check CloudWatch Logs for detailed error information',
        'Verify AWS credentials and permissions',
        'Ensure the bucket name is correct',
        `Error details: ${JSON.stringify(error, null, 2)}`,
      ];
      return result;
    }
  }

  /**
   * Validates that the bucket policy grants required permissions for Legacy CUR API
   * 
   * @param policyDocument - JSON string of the bucket policy
   * @returns True if policy is valid for Legacy CUR API
   */
  private validateLegacyCURPolicy(policyDocument: string): boolean {
    try {
      const policy = JSON.parse(policyDocument);

      if (!policy.Statement || !Array.isArray(policy.Statement)) {
        return false;
      }

      // Check for required permissions for Legacy CUR API across all statements
      // The policy may have permissions split across multiple statements
      let hasPutObject = false;
      let hasGetBucketPolicy = false;

      for (const statement of policy.Statement) {
        // Only check Allow statements with billingreports.amazonaws.com principal
        if (statement.Effect !== 'Allow') {
          continue;
        }

        const principal = statement.Principal;
        const services = Array.isArray(principal?.Service) ? principal.Service : [principal?.Service];
        const hasCURPrincipal = services.some((service: string) => 
          service === 'billingreports.amazonaws.com'
        );

        if (!hasCURPrincipal) {
          continue;
        }

        // Check actions in this statement
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        
        if (actions.some((action: string) => action === 's3:PutObject' || action === 's3:*')) {
          hasPutObject = true;
        }
        
        if (actions.some((action: string) => action === 's3:GetBucketPolicy' || action === 's3:*')) {
          hasGetBucketPolicy = true;
        }
      }

      // Both permissions must be present (can be in different statements)
      return hasPutObject && hasGetBucketPolicy;
    } catch (error) {
      // If we can't parse the policy, consider it invalid
      return false;
    }
  }

  /**
   * Generates remediation steps for bucket policy issues
   * 
   * @param bucketName - Name of the S3 bucket
   * @returns Array of remediation steps
   */
  private generateBucketPolicyRemediationSteps(bucketName: string): string[] {
    return [
      'Add the following bucket policy to allow Legacy CUR API delivery:',
      JSON.stringify(
        {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'EnableAWSDataExportsToWriteToS3AndCheckPolicy',
              Effect: 'Allow',
              Principal: {
                Service: [
                  'bcm-data-exports.amazonaws.com',
                  'billingreports.amazonaws.com',
                ],
              },
              Action: ['s3:PutObject', 's3:GetBucketPolicy'],
              Resource: [
                `arn:aws:s3:::${bucketName}`,
                `arn:aws:s3:::${bucketName}/*`,
              ],
              Condition: {
                StringLike: {
                  'aws:SourceArn': [
                    'arn:aws:cur:us-east-1:<YOUR_ACCOUNT_ID>:definition/*',
                    'arn:aws:bcm-data-exports:us-east-1:<YOUR_ACCOUNT_ID>:export/*',
                  ],
                  'aws:SourceAccount': '<YOUR_ACCOUNT_ID>',
                },
              },
            },
          ],
        },
        null,
        2
      ),
      'Replace <YOUR_ACCOUNT_ID> with your AWS account ID',
      'Apply the policy using: aws s3api put-bucket-policy --bucket ' + bucketName + ' --policy file://policy.json',
    ];
  }
}
