// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Billing Transfer Termination Handler Lambda Function
 *
 * This Lambda function processes ResponsibilityTransferTerminated events and
 * publishes notifications to an SNS topic for email delivery to stakeholders.
 *
 * Key Features:
 * - Publishes termination notifications to SNS
 * - Human-readable email formatting
 * - Graceful error handling (no EventBridge retries on SNS failures)
 * - Structured logging for observability
 *
 * Environment Variables:
 * - TERMINATION_TOPIC_ARN: SNS topic ARN for termination notifications
 * - LOG_LEVEL: Logging level (INFO, WARN, ERROR, DEBUG)
 *
 * @module billing-transfer-termination-handler
 */

import type { Context } from 'aws-lambda';
import middy from '@middy/core';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { logger } from '../common/utils/logger.js';
import { tracer } from '../common/utils/tracer.js';
import { metrics, MetricUnit } from '../common/utils/metrics.js';
import { powertools } from '../common/utils/middleware.js';
import { toError } from '../common/utils/errors.js';

// Initialize SNS client with X-Ray tracing
const snsClient = tracer.captureAWSv3Client(
  new SNSClient({
    maxAttempts: 3,
    retryMode: 'adaptive',
  })
);

/**
 * Termination status types from Organizations API
 */
export type TerminationStatus = 'WITHDRAWN' | 'EXPIRED' | 'DECLINED' | 'CANCELED';

/**
 * CloudTrail Event for Billing Transfer Termination
 *
 * This event is delivered by AWS Organizations via CloudTrail to EventBridge
 * when a billing transfer relationship is terminated.
 */
export interface TerminationEvent {
  version: string;
  id: string;
  'detail-type': 'AWS Service Event via CloudTrail';
  source: 'aws.organizations';
  account: string;
  time: string;
  region: string;
  resources?: string[];
  detail: {
    eventVersion: string;
    eventTime: string;
    eventName: 'ResponsibilityTransferTerminated';
    eventSource: 'organizations.amazonaws.com';
    eventType: 'AwsServiceEvent';
    serviceEventDetails: {
      id: string;
      arn?: string;
      transferChain?: string[];
      type: 'BILLING';
      status: TerminationStatus;
      source: {
        managementAccountId: string;
      };
      target: {
        managementAccountId: string;
      };
      requester?: string;
      startTimestamp: number;
      endTimestamp?: number;
    };
  };
}

/**
 * Lambda response interface
 *
 * Standardized response format for termination handler invocations.
 */
export interface HandlerResponse {
  statusCode: number;
  body: {
    message: string;
    accountId: string;
    action: 'notified' | 'skipped';
    messageId?: string;
  };
}

/**
 * Termination notification message structure for SNS
 */
export interface TerminationNotification {
  eventType: 'ResponsibilityTransferTerminated';
  transferId: string;
  billSourceAccountId: string;
  billTransferAccountId: string;
  startDate: string;
  endDate: string;
  status: TerminationStatus;
  timestamp: string;
}


/**
 * Formats a timestamp to ISO 8601 date string
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns ISO 8601 formatted date string or 'N/A' if invalid
 */
export function formatTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined || timestamp === null) {
    return 'N/A';
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return 'N/A';
  }
}

/**
 * Formats the email subject line for termination notifications
 *
 * @param accountId - The bill-source (customer) account ID
 * @returns Formatted email subject
 */
export function formatEmailSubject(accountId: string): string {
  return `Billing Transfer Terminated: Account ${accountId}`;
}

/**
 * Formats the email body for termination notifications
 *
 * @param notification - The termination notification details
 * @returns Human-readable email body
 */
export function formatEmailBody(notification: TerminationNotification): string {
  return `Billing Transfer Termination Notice

A billing transfer relationship has been terminated.

Transfer Details:
- Transfer ID: ${notification.transferId}
- Customer Account: ${notification.billSourceAccountId}
- Payer Account: ${notification.billTransferAccountId}
- Status: ${notification.status}
- Start Date: ${notification.startDate}
- End Date: ${notification.endDate}

Action Required:
- Review billing group configuration
- Update billing documentation
- Notify relevant stakeholders

This is an automated notification from the Billing Transfer Automation system.`;
}

/**
 * Publishes a termination notification to SNS
 *
 * Handles SNS publish errors gracefully - logs errors but does not throw
 * to prevent EventBridge retry mechanism from triggering.
 *
 * @param notification - The termination notification details
 * @returns Object with success status and optional messageId
 */
export async function publishTerminationNotification(
  notification: TerminationNotification
): Promise<{ success: boolean; messageId?: string }> {
  const topicArn = process.env.TERMINATION_TOPIC_ARN;

  if (!topicArn) {
    logger.error('TERMINATION_TOPIC_ARN environment variable not set', {
      error: new Error('Missing topic ARN'),
      transferId: notification.transferId,
    });
    return { success: false };
  }

  const subject = formatEmailSubject(notification.billSourceAccountId);
  const message = formatEmailBody(notification);

  try {
    const command = new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: message,
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: notification.eventType,
        },
        status: {
          DataType: 'String',
          StringValue: notification.status,
        },
        billSourceAccountId: {
          DataType: 'String',
          StringValue: notification.billSourceAccountId,
        },
      },
    });

    const response = await snsClient.send(command);

    logger.info('SNS notification published successfully', {
      messageId: response.MessageId,
      topicArn,
      transferId: notification.transferId,
      billSourceAccountId: notification.billSourceAccountId,
    });

    return { success: true, messageId: response.MessageId };
  } catch (error) {
    const err = toError(error);
    logger.error('Failed to publish SNS notification', {
      error: err,
      topicArn,
      transferId: notification.transferId,
      billSourceAccountId: notification.billSourceAccountId,
    });
    // Return false but don't throw - prevents EventBridge retry
    return { success: false };
  }
}

/**
 * Main Lambda handler
 *
 * Entry point for the Lambda function. Processes ResponsibilityTransferTerminated
 * events and publishes notifications to SNS.
 *
 * Error Handling:
 * - SNS failures are caught and logged but don't trigger retries
 * - Invalid events return 500 status code
 * - All termination events are logged for audit purposes
 *
 * @param event - Lambda event (TerminationEvent)
 * @param context - Lambda context with request ID and function metadata
 * @returns Promise<HandlerResponse> - Standardized response with operation details
 */
const lambdaHandler = async (event: TerminationEvent, context: Context): Promise<HandlerResponse> => {
  logger.info('Termination handler started', {
    eventId: event.id,
    requestId: context.awsRequestId,
  });

  // Track termination event received
  metrics.addMetric('TerminationEventReceived', MetricUnit.Count, 1);

  try {
    // Validate event structure
    if (event.detail?.eventName !== 'ResponsibilityTransferTerminated') {
      logger.error('Invalid event type received', {
        error: new Error('Expected ResponsibilityTransferTerminated'),
        eventName: event.detail?.eventName,
        eventId: event.id,
      });
      metrics.addMetric('TerminationInvalidEvent', MetricUnit.Count, 1);
      return {
        statusCode: 500,
        body: {
          message: 'Invalid event type - expected ResponsibilityTransferTerminated',
          accountId: 'N/A',
          action: 'skipped',
        },
      };
    }

    const { serviceEventDetails } = event.detail;
    const {
      id: transferId,
      status,
      source,
      target,
      startTimestamp,
      endTimestamp,
    } = serviceEventDetails;

    const billSourceAccountId = source.managementAccountId;
    const billTransferAccountId = target.managementAccountId;

    // Log termination details for audit purposes (Requirement 6.3)
    logger.info('Processing billing transfer termination', {
      transferId,
      status,
      billSourceAccountId,
      billTransferAccountId,
      startTimestamp,
      endTimestamp,
    });

    // Track termination by status
    metrics.addMetric(`TerminationStatus_${status}`, MetricUnit.Count, 1);

    // Build notification object
    const notification: TerminationNotification = {
      eventType: 'ResponsibilityTransferTerminated',
      transferId,
      billSourceAccountId,
      billTransferAccountId,
      startDate: formatTimestamp(startTimestamp),
      endDate: formatTimestamp(endTimestamp),
      status,
      timestamp: new Date().toISOString(),
    };

    // Publish to SNS
    const publishResult = await publishTerminationNotification(notification);

    // Track notification result
    if (publishResult.success) {
      metrics.addMetric('TerminationNotificationSent', MetricUnit.Count, 1);
    } else {
      metrics.addMetric('TerminationNotificationFailed', MetricUnit.Count, 1);
    }

    const response: HandlerResponse = {
      statusCode: 200,
      body: {
        message: publishResult.success
          ? `Termination notification sent for account ${billSourceAccountId}`
          : `Termination logged but notification failed for account ${billSourceAccountId}`,
        accountId: billSourceAccountId,
        action: publishResult.success ? 'notified' : 'skipped',
        messageId: publishResult.messageId,
      },
    };

    logger.info('Termination handler completed', {
      statusCode: response.statusCode,
      action: response.body.action,
      transferId,
      billSourceAccountId,
      messageId: publishResult.messageId,
    });

    return response;
  } catch (error) {
    const err = toError(error);
    logger.error('Termination handler failed', {
      error: err,
      eventId: event.id,
      requestId: context.awsRequestId,
    });

    metrics.addMetric('TerminationHandlerFailed', MetricUnit.Count, 1);

    // Return error response but don't throw to prevent EventBridge retry
    return {
      statusCode: 500,
      body: {
        message: `Error processing termination event: ${err.message}`,
        accountId: 'N/A',
        action: 'skipped',
      },
    };
  }
};

// Wrap handler with Powertools middleware
export const handler = middy(lambdaHandler).use(powertools());
