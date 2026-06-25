// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeEach } from '@jest/globals';
import { S3ValidationService } from '../../../lib/lambda/cur-reconciliation/services/s3-validation-service.js';
import { S3Client, HeadBucketCommand, GetBucketPolicyCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

const s3Mock = mockClient(S3Client);

describe('S3ValidationService', () => {
  let service: S3ValidationService;

  beforeEach(() => {
    s3Mock.reset();
    service = new S3ValidationService(s3Mock as unknown as S3Client);
  });

  describe('validateBucket', () => {
    it('should return valid result when bucket exists with correct policy', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      // Mock bucket exists
      s3Mock.on(HeadBucketCommand).resolves({});

      // Mock bucket location
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined, // us-east-1 returns undefined
      });

      // Mock bucket policy with Legacy CUR API permissions
      const validPolicy = {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowLegacyCURToWriteToBucket',
            Effect: 'Allow',
            Principal: {
              Service: 'billingreports.amazonaws.com',
            },
            Action: ['s3:PutObject', 's3:GetBucketPolicy'],
            Resource: [
              `arn:aws:s3:::${bucketName}/*`,
              `arn:aws:s3:::${bucketName}`,
            ],
          },
        ],
      };

      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: JSON.stringify(validPolicy),
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(true);
      expect(result.policyIsValid).toBe(true);
      expect(result.errorMessage).toBeUndefined();
      expect(result.remediationSteps).toBeUndefined();
    });

    it('should handle bucket not found error', async () => {
      const bucketName = 'non-existent-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).rejects({
        name: 'NoSuchBucket',
        message: 'The specified bucket does not exist',
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(false);
      expect(result.hasBucketPolicy).toBe(false);
      expect(result.policyIsValid).toBe(false);
      expect(result.errorMessage).toContain('does not exist');
      expect(result.remediationSteps).toBeDefined();
      expect(result.remediationSteps?.length).toBeGreaterThan(0);
    });

    it('should handle missing bucket policy', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined,
      });
      s3Mock.on(GetBucketPolicyCommand).rejects({
        name: 'NoSuchBucketPolicy',
        message: 'The bucket policy does not exist',
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(false);
      expect(result.policyIsValid).toBe(false);
      expect(result.errorMessage).toContain('Bucket policy is missing');
      expect(result.remediationSteps).toBeDefined();
      expect(result.remediationSteps?.some(step => step.includes('billingreports.amazonaws.com'))).toBe(true);
    });

    it('should detect invalid bucket policy', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined,
      });

      // Policy without required permissions
      const invalidPolicy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'lambda.amazonaws.com',
            },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucketName}/*`],
          },
        ],
      };

      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: JSON.stringify(invalidPolicy),
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(true);
      expect(result.policyIsValid).toBe(false);
      expect(result.errorMessage).toContain('does not grant required permissions');
      expect(result.remediationSteps).toBeDefined();
    });

    it('should handle bucket region mismatch', async () => {
      const bucketName = 'test-bucket';
      const expectedRegion = 'us-east-1';
      const actualRegion = 'us-west-2';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: actualRegion,
      });

      const result = await service.validateBucket(bucketName, expectedRegion);

      expect(result.bucketExists).toBe(true);
      expect(result.errorMessage).toContain('region mismatch');
      expect(result.errorMessage).toContain(actualRegion);
      expect(result.errorMessage).toContain(expectedRegion);
      expect(result.remediationSteps).toBeDefined();
    });

    it('should handle access denied error', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).rejects({
        name: 'AccessDenied',
        message: 'Access Denied',
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(false);
      expect(result.errorMessage).toContain('Access denied');
      expect(result.remediationSteps).toBeDefined();
      expect(result.remediationSteps?.some(step => step.includes('Lambda execution role'))).toBe(true);
    });

    it('should validate policy with array of services', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined,
      });

      const policyWithArrayServices = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: ['billingreports.amazonaws.com', 'other.amazonaws.com'],
            },
            Action: ['s3:PutObject', 's3:GetBucketPolicy'],
            Resource: [`arn:aws:s3:::${bucketName}/*`, `arn:aws:s3:::${bucketName}`],
          },
        ],
      };

      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: JSON.stringify(policyWithArrayServices),
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(true);
      expect(result.policyIsValid).toBe(true);
    });

    it('should validate policy with wildcard actions', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined,
      });

      const policyWithWildcard = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'billingreports.amazonaws.com',
            },
            Action: 's3:*',
            Resource: [`arn:aws:s3:::${bucketName}/*`, `arn:aws:s3:::${bucketName}`],
          },
        ],
      };

      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: JSON.stringify(policyWithWildcard),
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(true);
      expect(result.policyIsValid).toBe(true);
    });

    it('should handle malformed policy JSON', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined,
      });
      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: 'invalid json {',
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(true);
      expect(result.policyIsValid).toBe(false);
      expect(result.errorMessage).toContain('does not grant required permissions');
    });

    it('should handle non-us-east-1 regions correctly', async () => {
      const bucketName = 'test-bucket';
      const region = 'eu-west-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: 'eu-west-1',
      });

      const validPolicy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'billingreports.amazonaws.com',
            },
            Action: ['s3:PutObject', 's3:GetBucketPolicy'],
            Resource: [`arn:aws:s3:::${bucketName}/*`, `arn:aws:s3:::${bucketName}`],
          },
        ],
      };

      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: JSON.stringify(validPolicy),
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.bucketExists).toBe(true);
      expect(result.hasBucketPolicy).toBe(true);
      expect(result.policyIsValid).toBe(true);
    });

    it('should include remediation steps with bucket policy template', async () => {
      const bucketName = 'test-bucket';
      const region = 'us-east-1';

      s3Mock.on(HeadBucketCommand).resolves({});
      s3Mock.on(GetBucketLocationCommand).resolves({
        LocationConstraint: undefined,
      });
      s3Mock.on(GetBucketPolicyCommand).rejects({
        name: 'NoSuchBucketPolicy',
        message: 'The bucket policy does not exist',
      });

      const result = await service.validateBucket(bucketName, region);

      expect(result.remediationSteps).toBeDefined();
      const stepsString = result.remediationSteps?.join(' ');
      expect(stepsString).toContain('billingreports.amazonaws.com');
      expect(stepsString).toContain('s3:PutObject');
      expect(stepsString).toContain('s3:GetBucketPolicy');
      expect(stepsString).toContain(bucketName);
    });
  });
});
