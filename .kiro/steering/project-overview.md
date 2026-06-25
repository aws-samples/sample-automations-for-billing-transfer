---
inclusion: always
---

# Billing Transfer Automation - Quick Reference

## Architecture

**Five CDK Stacks:**
1. **Event Handler**: Real-time response to billing transfer events (EventBridge + Lambda)
2. **Billing Group Reconciliation**: Scheduled batch processing for billing groups (EventBridge Scheduler + Lambda)
3. **Termination Handler**: Handles billing transfer termination events
4. **CUR Reconciliation**: Automated Cost and Usage Report creation for billing transfers
5. **Pipeline**: CI/CD pipeline for automated deployments

**Key Files:**
- Event Handler: `lib/stacks/billing-group-event-handler-stack.ts`, `lib/lambda/billing-group-event-handler/index.ts`
- Reconciliation: `lib/stacks/billing-group-reconciliation-stack.ts`, `lib/lambda/billing-group-reconciliation/index.ts`
- Termination: `lib/stacks/billing-transfer-termination-stack.ts`, `lib/lambda/billing-transfer-termination-handler/`
- CUR: `lib/stacks/cur-reconciliation-stack.ts`, `lib/lambda/cur-reconciliation/`
- Shared Code: `lib/lambda/common/` (utilities and services)

## Critical Concepts

- **Bill-Transfer Account**: Pays for another org's bill
- **Bill-Source Account**: Customer org generating the bill
- **Billing Group**: Collection of accounts for billing (requires pricing plan)
- **Pricing Plan**: Use AWS managed `BasicPricingPlan` (default)

## Key Events

- `ResponsibilityTransferAccepted`: New transfer accepted
- `ResponsibilityTransferTerminated`: Transfer ended (check `status` field)
- Source: `aws.organizations`, delivered via CloudTrail

## Critical Requirements

- ⚠️ **Bundle AWS SDK dependencies**: Set `externalModules: []` (Organizations & Billing Conductor NOT in Lambda runtime)
- ⚠️ **Use ResponsibilityTransferArn**: Required for billing transfer billing groups (NOT LinkedAccountIds)
- ⚠️ **Extract ARN from events**: Get `arn` field from `serviceEventDetails`
- Billing groups are mutually exclusive per billing period
- 24-hour delay for custom rates to reflect
