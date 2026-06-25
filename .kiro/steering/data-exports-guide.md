---
inclusion: manual
---

# Data Exports Guide

## Critical: Billing Transfer CUR Automation

✅ **CUR reports for billing transfer views can be fully automated.** This sample
uses the **Legacy CUR API**. AWS Data Exports (CUR 2.0) has since added support
for billing transfer views as well — see
[Creating exports with billing views](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-billing-view.html).
Either API works; the guidance below documents the Legacy CUR API approach this
sample implements.

### API Requirements

1. **Use Legacy CUR API** (`@aws-sdk/client-cost-and-usage-report-service`)
2. **Get billing view ARN** from Billing API (`ListBillingViews`)
3. **Set `BillingViewArn` parameter** in `PutReportDefinitionCommand`
4. **Ensure billing group is ACTIVE** before creating CUR

### Workflow Order

```
1. Create billing group (Billing Conductor API)
2. Wait for billing group ACTIVE status
3. Get billing view ARN (Billing API)
4. Create CUR report (Legacy CUR API with BillingViewArn)
```

## Legacy CUR API vs Data Exports API

Both APIs support billing transfer views. This sample uses the Legacy CUR API.

| Feature | Legacy CUR API | Data Exports API |
|---------|---------------|------------------|
| **Billing Views** | ✅ Supported via `BillingViewArn` | ✅ Supported (billing transfer views) |
| **Billing Transfer** | ✅ Supported | ✅ Supported |
| **SDK Package** | `@aws-sdk/client-cost-and-usage-report-service` | `@aws-sdk/client-bcm-data-exports` |
| **Format** | CUR 1.0 | CUR 2.0 |

This sample implements the Legacy CUR API approach. Migrating to Data Exports (CUR 2.0) is a reasonable enhancement.

## Billing View Types

| View Type | ARN Format | Requires Billing Group | API Support |
|-----------|-----------|------------------------|-------------|
| PRIMARY | `arn:aws:billing::{account}:billingview/primary` | No | ✅ Both APIs |
| BILLING_TRANSFER | `arn:aws:billing::{account}:billingview/billing-transfer-{uuid}` | Yes | ✅ Both APIs |
| BILLING_TRANSFER_SHOWBACK | `arn:aws:billing::{account}:billingview/billing-transfer-showback-{uuid}` | Yes | ✅ Both APIs |
| BILLING_GROUP | `arn:aws:billing::{account}:billingview/billing-group-{account}` | Yes | ✅ Both APIs |

## Getting Billing View ARN

```typescript
import { BillingClient, ListBillingViewsCommand } from '@aws-sdk/client-billing';

const billingClient = new BillingClient({ region: 'us-east-1' });

const response = await billingClient.send(
  new ListBillingViewsCommand({
    billingViewTypes: ['BILLING_TRANSFER'],
    sourceAccountId: billSourceAccountId
  })
);

const billingViewArn = response.billingViews?.[0]?.arn;
```

⚠️ **MUST retrieve ARN from API - do not construct manually**

## Creating CUR Report (Legacy API)

```typescript
import { 
  CostAndUsageReportServiceClient, 
  PutReportDefinitionCommand 
} from '@aws-sdk/client-cost-and-usage-report-service';

const curClient = new CostAndUsageReportServiceClient({ region: 'us-east-1' });

await curClient.send(new PutReportDefinitionCommand({
  ReportDefinition: {
    ReportName: `billing-transfer-${billSourceAccountId}-my-view`,
    TimeUnit: 'DAILY',
    Format: 'Parquet',
    Compression: 'Parquet',
    S3Bucket: bucketName,
    S3Prefix: 'my-view-reports',
    S3Region: 'us-east-1',
    BillingViewArn: billingViewArn,  // ⚠️ CRITICAL parameter
    AdditionalSchemaElements: ['RESOURCES']
  }
}));
```

## Check if CUR Exists

```typescript
import { DescribeReportDefinitionsCommand } from '@aws-sdk/client-cost-and-usage-report-service';

const reports = await curClient.send(new DescribeReportDefinitionsCommand({}));
const reportName = `billing-transfer-${billSourceAccountId}-my-view`;
const exists = reports.ReportDefinitions?.find(r => r.ReportName === reportName);
```

## S3 Bucket Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "billingreports.amazonaws.com" },
    "Action": ["s3:PutObject", "s3:GetBucketPolicy"],
    "Resource": [
      "arn:aws:s3:::bucket-name/*",
      "arn:aws:s3:::bucket-name"
    ],
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "123456789012" },
      "ArnLike": { "aws:SourceArn": "arn:aws:cur:us-east-1:123456789012:definition/*" }
    }
  }]
}
```

## IAM Permissions

```typescript
handler.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'cur:PutReportDefinition',
    'cur:DescribeReportDefinitions',
    'billing:ListBillingViews',
    'billing:GetBillingView',
    'billingconductor:ListBillingGroups'
  ],
  resources: ['*']
}));
```

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "No Billing Group assigned" | Billing group not ACTIVE | Wait for billing group to be ACTIVE |
| "Invalid billing view ARN" | ARN malformed or doesn't exist | List billing views to get correct ARN |
| ServiceQuotaExceededException | Too many exports | Delete unused exports or request quota increase |

## Automation Summary

**What Can Be Automated:**
1. ✅ List billing transfers (Organizations API)
2. ✅ Create billing groups (Billing Conductor API)
3. ✅ List billing views (Billing API)
4. ✅ Validate S3 bucket (S3 API)
5. ✅ Check if CUR exists (Legacy CUR API)
6. ✅ Create CUR reports (Legacy CUR API with BillingViewArn)

The full workflow can be automated end to end. This sample uses the Legacy CUR
API; the same flow can be implemented with AWS Data Exports (CUR 2.0).

## Best Practices

1. ✅ **Check billing group ACTIVE** before creating CUR
2. ✅ **Use PARQUET format** for better performance
3. ✅ **Implement idempotency** - Check if CUR exists first
4. ✅ **Use consistent naming** - Include account ID and view type
5. ✅ **Bundle AWS SDK** - Set `externalModules: []`
6. ✅ **Handle errors gracefully** - Continue processing other transfers
7. ✅ **Log comprehensively** - Track all operations
