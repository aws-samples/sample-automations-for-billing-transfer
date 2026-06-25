// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tracer Utility using AWS Lambda Powertools
 *
 * Provides distributed tracing with AWS X-Ray integration,
 * automatic AWS SDK instrumentation, and subsegment creation.
 *
 * Features:
 * - Automatic X-Ray trace capture
 * - AWS SDK v3 client instrumentation
 * - Custom subsegment creation for business logic
 * - Annotation and metadata support
 *
 * Usage:
 * ```typescript
 * import { tracer } from '../common/utils/tracer.js';
 *
 * // Wrap SDK clients for automatic tracing
 * const client = tracer.captureAWSv3Client(new OrganizationsClient({}));
 *
 * // Create custom subsegments
 * const subsegment = tracer.getSegment()?.addNewSubsegment('myOperation');
 * try {
 *   await doWork();
 *   subsegment?.close();
 * } catch (error) {
 *   subsegment?.addError(error as Error);
 *   subsegment?.close();
 *   throw error;
 * }
 * ```
 *
 * @module tracer
 */

import { Tracer } from '@aws-lambda-powertools/tracer';

const SERVICE_NAME = 'sample-bt-automation';

/**
 * Pre-configured Powertools Tracer instance
 *
 * Configuration is read from environment variables:
 * - POWERTOOLS_SERVICE_NAME: Service name for traces (default: sample-bt-automation)
 * - POWERTOOLS_TRACER_CAPTURE_RESPONSE: Capture response in traces (default: true)
 * - POWERTOOLS_TRACER_CAPTURE_ERROR: Capture errors in traces (default: true)
 */
export const tracer = new Tracer({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME || SERVICE_NAME,
});

export { Tracer };
