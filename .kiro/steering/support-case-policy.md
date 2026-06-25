---
inclusion: manual
---

# Support Case Policy

## Critical Rule

⚠️ **Support case functionality MUST NEVER be executed during development or testing with Kiro**

## Requirements

1. **No Support Case Creation** - Never create AWS Support cases in automated workflows
2. **Default Disabled** - All support case features disabled by default (`supportCaseEnabled: false`)
3. **Manual Testing Only** - User will manually test in the future
4. **Configuration Override** - Controlled via config flags defaulting to `false`

## Implementation

```typescript
// ✅ CORRECT: Disabled by default
const config = {
  supportCaseEnabled: false,  // Must default to false
};

async function handleSupportCase() {
  if (!config.supportCaseEnabled) {
    console.log('Support case creation disabled by configuration');
    return { skipped: true, reason: 'disabled' };
  }
  // Support case logic only runs if explicitly enabled
}
```

## Testing

- Unit tests: Mock support case operations
- Integration tests: Skip support case operations by default
- Never make actual AWS Support API calls in automated tests
