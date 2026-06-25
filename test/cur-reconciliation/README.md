# CUR Reconciliation Tests

This directory contains tests for the CUR (Cost and Usage Report) reconciliation feature.

## Test Structure

- **unit/**: Unit tests for individual components and services
- **property/**: Property-based tests using fast-check (minimum 100 iterations per test)
- **integration/**: Integration tests with actual AWS services (run in test account)

## Running Tests

### All Tests
```bash
npm test
```

### Unit Tests Only
```bash
npm test -- test/cur-reconciliation/unit
```

### Property-Based Tests Only
```bash
npm test -- test/cur-reconciliation/property
```

### Integration Tests Only
```bash
npm test -- test/cur-reconciliation/integration
```

### With Coverage
```bash
npm run test:coverage
```

## Property-Based Testing

Property-based tests verify universal properties across many randomly generated inputs using fast-check.

**Configuration:**
- Minimum 100 iterations per property test
- Random data generation for all inputs
- Automatic shrinking to find minimal failing cases

**Test Tagging:**
Each property-based test must include a comment referencing the correctness property from the design document:

```typescript
// Feature: cur-reconciliation, Property 1: All billing transfers are discovered
it('should discover all billing transfers', () => {
  fc.assert(
    fc.property(/* ... */),
    { numRuns: 100 }
  );
});
```

## Test Data Generators

Property-based tests define their `fast-check` arbitraries (generators) inline within
each test file. For example, `property/configuration-service.property.test.ts` declares
its `validConfigTemplateArb` and `viewReportConfigArb` arbitraries at the top of the file.

When generators become shared across multiple property test files, extract them into a
local `generators` module within `property/` and import from there.
