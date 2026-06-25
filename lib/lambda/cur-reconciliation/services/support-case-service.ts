// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Service for creating AWS Support cases for historical data backfill
 */

import {
  SupportClient,
  CreateCaseCommand,
  CreateCaseRequest,
} from '@aws-sdk/client-support';
import { BackfillRequest, SupportCaseResult } from '../models/support-case.js';

export class SupportCaseService {
  private readonly supportClient: SupportClient;

  constructor(supportClient?: SupportClient) {
    this.supportClient = supportClient || new SupportClient({ region: 'us-east-1' });
  }

  /**
   * Creates an AWS Support case for historical data backfill
   * 
   * @param request - Backfill request details
   * @returns Support case creation result
   */
  async createBackfillCase(request: BackfillRequest): Promise<SupportCaseResult> {
    try {
      // Format subject with export name and backfill request
      const subject = `Data Export Backfill Request - ${request.exportName}`;

      // Format communication body with export name, billing view ARN, and billing period range
      const communicationBody = this.formatCommunicationBody(request);

      // Create case request with appropriate service code and category code for Data Exports
      const createCaseRequest: CreateCaseRequest = {
        subject,
        communicationBody,
        serviceCode: 'billing', // Service code for Data Exports
        categoryCode: 'data-exports', // Category code for Data Exports
        severityCode: request.severityCode,
        issueType: 'customer-service',
        language: 'en',
      };

      const response = await this.supportClient.send(
        new CreateCaseCommand(createCaseRequest)
      );

      return {
        caseId: response.caseId,
        created: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        created: false,
        errorMessage,
      };
    }
  }

  /**
   * Formats the communication body for the support case
   * 
   * @param request - Backfill request details
   * @returns Formatted communication body
   */
  private formatCommunicationBody(request: BackfillRequest): string {
    return `Hello AWS Support,

I would like to request a historical data backfill for the following Data Export:

Export Name: ${request.exportName}
Billing View ARN: ${request.billingViewArn}
Requested Billing Period Range: ${request.billingPeriodRange.start} to ${request.billingPeriodRange.end}

Please backfill the historical cost and usage data for this export covering the specified billing period range.

Thank you for your assistance.`;
  }
}
