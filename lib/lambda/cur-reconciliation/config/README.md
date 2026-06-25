# CUR Automation Configuration

This directory contains the configuration template for CUR (Cost and Usage Report) automation.

## Configuration Template

The `export-configuration-template.json` file defines how CUR reports are created for billing transfer relationships.

> **Placeholders:** the template ships with `s3Bucket` set to
> `cur-reports-{ACCOUNT_ID}-{REGION}`. `{ACCOUNT_ID}` and `{REGION}` are
> substitution variables — replace them with the deploying account's id and
> region (or use the managed bucket name from the stack outputs). No real
> account ids are committed to this template.
>
> Note: when you deploy the CUR Automation stack, it generates this config
> automatically and binds `s3Bucket` to the stack's own CUR destination bucket,
> so manual substitution is only needed if you upload the config out-of-band.

### Using the Managed S3 Bucket

When you deploy the CUR Automation stack, it automatically creates an S3 bucket for CUR report delivery with the correct bucket policy. The bucket name will be:

```
cur-reports-{ACCOUNT_ID}-{REGION}
```

**To use the managed bucket:**

1. After deploying the stack, get the bucket name from the CloudFormation outputs:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name BT-CURReconciliationStack \
     --query 'Stacks[0].Outputs[?OutputKey==`CURDestinationBucketName`].OutputValue' \
     --output text
   ```

2. Update the configuration template with the bucket name:
   ```json
   {
     "myViewReportConfig": {
       "s3Bucket": "cur-reports-123456789012-us-east-1",
       "s3Prefix": "my-view-reports",
       "s3Region": "us-east-1"
     }
   }
   ```

3. Upload the configuration to the config bucket:
   ```bash
   CONFIG_BUCKET=$(aws cloudformation describe-stacks \
     --stack-name BT-CURReconciliationStack \
     --query 'Stacks[0].Outputs[?OutputKey==`ConfigBucketName`].OutputValue' \
     --output text)
   
   aws s3 cp export-configuration-template.json \
     s3://${CONFIG_BUCKET}/export-configuration-template.json
   ```

### Configuration Options

#### My View Report Config
- **enabled**: `true` to create reports for BILLING_TRANSFER view, `false` to skip
- **timeUnit**: `HOURLY`, `DAILY`, or `MONTHLY`
- **format**: `Parquet` (recommended) or `textORcsv`
- **compression**: Must match format (`Parquet` or `GZIP`/`ZIP`)
- **additionalSchemaElements**: Array of `RESOURCES`, `SPLIT_COST_ALLOCATION_DATA`, `MANUAL_DISCOUNT_COMPATIBILITY`
- **s3Bucket**: S3 bucket name for report delivery (use managed bucket)
- **s3Prefix**: Path prefix within the bucket
- **s3Region**: Region of the S3 bucket
- **refreshClosedReports**: `true` to refresh finalized reports
- **reportVersioning**: `OVERWRITE_REPORT` or `CREATE_NEW_REPORT`
- **tags**: Custom tags for the CUR report
- **backfill**: Optional configuration for historical data backfill via AWS Support case

#### Showback View Report Config
Same options as My View, but for BILLING_TRANSFER_SHOWBACK view.

**Important**: Do NOT include `SPLIT_COST_ALLOCATION_DATA` in `additionalSchemaElements` for Showback View reports (AWS requirement).

### Backfill Configuration

To request historical data for existing billing transfers:

```json
{
  "myViewReportConfig": {
    "backfill": {
      "enabled": true,
      "billingPeriodRange": {
        "start": "2024-01",
        "end": "2024-12"
      },
      "severityCode": "normal"
    }
  }
}
```

**Note**: Backfill creates AWS Support cases automatically. Set `enabled: false` to disable this feature (recommended for initial testing).

### Example Configurations

#### Both Views Enabled
```json
{
  "version": "1.0",
  "myViewReportConfig": {
    "enabled": true,
    "s3Bucket": "cur-reports-123456789012-us-east-1"
  },
  "showbackViewReportConfig": {
    "enabled": true,
    "s3Bucket": "cur-reports-123456789012-us-east-1"
  }
}
```

#### My View Only
```json
{
  "version": "1.0",
  "myViewReportConfig": {
    "enabled": true,
    "s3Bucket": "cur-reports-123456789012-us-east-1"
  }
}
```

#### Showback View Only
```json
{
  "version": "1.0",
  "showbackViewReportConfig": {
    "enabled": true,
    "s3Bucket": "cur-reports-123456789012-us-east-1"
  }
}
```

## Deployment Workflow

1. **Deploy the CDK stack** - Creates managed S3 bucket with correct policy
2. **Get bucket name** - From CloudFormation outputs
3. **Update configuration** - Set `s3Bucket` to the managed bucket name
4. **Upload configuration** - To the config bucket
5. **Trigger reconciliation** - Manually or wait for scheduled run

## Troubleshooting

If CUR report creation fails:

1. **Check S3 bucket policy**: The managed bucket should have the correct policy automatically
2. **Verify bucket region**: Must match `s3Region` in configuration
3. **Check Lambda logs**: CloudWatch logs show detailed error messages
4. **Validate configuration**: Ensure JSON is valid and all required fields are present

For more details, see the [Data Exports Guide](../../../../.kiro/steering/data-exports-guide.md).
