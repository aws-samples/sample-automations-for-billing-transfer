---
inclusion: manual
---

# Billing Conductor Guide

## Critical: Billing Transfer vs Regular Billing Groups

### ✅ Billing Transfer (Use ResponsibilityTransferArn)

```typescript
await billingConductor.createBillingGroup({
  Name: `bg-${billSourceAccountId}`,
  PricingPlanArn: pricingPlanArn,
  AccountGrouping: {
    ResponsibilityTransferArn: transferArn  // ⚠️ REQUIRED for billing transfers
  },
  PrimaryAccountId: billSourceAccountId
});
```

**Where to get ResponsibilityTransferArn:**
- From `Arn` field in `ListInboundResponsibilityTransfers` response
- From `arn` field in EventBridge event `serviceEventDetails`

### ❌ Regular Billing Groups (Use LinkedAccountIds)

```typescript
await billingConductor.createBillingGroup({
  Name: `bg-regular`,
  PricingPlanArn: pricingPlanArn,
  AccountGrouping: {
    LinkedAccountIds: [accountId1, accountId2]  // For non-transfer groups
  },
  PrimaryAccountId: accountId1
});
```

## Pricing Plans

**Use AWS managed `BasicPricingPlan`:**

```typescript
const plans = await billingConductor.listPricingPlans({});
const basicPlan = plans.PricingPlans?.find(p => p.Name === 'BasicPricingPlan');
const pricingPlanArn = basicPlan?.Arn;
```

## Organizations API Pagination

### Direct Transfers (No Id)
```typescript
let response = await client.send(new ListInboundResponsibilityTransfersCommand({ Type: 'BILLING' }));
while (response.NextToken) {
  response = await client.send(new ListInboundResponsibilityTransfersCommand({
    Type: 'BILLING',
    NextToken: response.NextToken
  }));
}
```

### Indirect Transfers (With Id)
```typescript
let response = await client.send(new ListInboundResponsibilityTransfersCommand({
  Type: 'BILLING',
  Id: 'rt-abc123'
}));
while (response.NextToken) {
  response = await client.send(new ListInboundResponsibilityTransfersCommand({
    Type: 'BILLING',
    Id: 'rt-abc123',  // Keep same Id
    NextToken: response.NextToken
  }));
}
```

## Event Structure

```typescript
interface BillingTransferEvent {
  source: 'aws.organizations';
  'detail-type': 'AWS Service Event via CloudTrail';
  detail: {
    eventName: 'ResponsibilityTransferAccepted' | 'ResponsibilityTransferTerminated';
    serviceEventDetails: {
      id: string;                    // Transfer ID
      arn: string;                   // ⚠️ REQUIRED for CreateBillingGroup
      status: 'ACCEPTED' | 'WITHDRAWN' | 'DECLINED' | 'EXPIRED' | 'CANCELED';
      source: { managementAccountId: string };  // Bill-source
      target: { managementAccountId: string };  // Bill-transfer
    };
  };
}
```

## Idempotency Pattern

```typescript
async function ensureBillingGroup(accountId: string, transferArn: string): Promise<string> {
  // Check if exists
  const existing = await findBillingGroupByAccount(accountId);
  if (existing) return existing.Arn;
  
  // Create if not exists
  return await createBillingGroup(accountId, transferArn);
}
```

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Accounts are not in CB family" | Used `LinkedAccountIds` for transfer | Use `ResponsibilityTransferArn` |
| ResourceNotFoundException | Pricing plan doesn't exist | Get `BasicPricingPlan` ARN first |
| ConflictException | Resource already exists | Implement idempotency check |
| ThrottlingException | Rate limit exceeded | Use `retryWithBackoff` |

## Best Practices

1. ✅ **Use ResponsibilityTransferArn** for billing transfers (NOT LinkedAccountIds)
2. ✅ **Extract ARN from events** - Get `arn` field from `serviceEventDetails`
3. ✅ **Bundle AWS SDK** - Set `externalModules: []` in Lambda config
4. ✅ **Implement idempotency** - Check before creating
5. ✅ **Use BasicPricingPlan** - AWS managed, always available
6. ✅ **Handle pagination** - Use NextToken for all list operations
