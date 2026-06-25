---
inclusion: manual
---

# Testing Guide

## Test Framework: Jest (NOT Vitest)

### ✅ CORRECT Commands

```bash
npm run test:unit                     # ⚡ PREFERRED: Fast unit tests (~6s)
npm test                              # Full suite including CDK stack tests (~18s)
npm test -- path/to/test.test.ts     # Run specific test
npm test -- --watch                   # Watch mode
npm test -- --coverage                # With coverage
```

### ⚡ Always use `npm run test:unit` for quick feedback during development
- Skips CDK stack tests that trigger slow Lambda bundling
- Use `npm test` only when you need to verify stack synthesis

### ❌ NEVER use `--run` flag (that's Vitest, not Jest)

## Quick Mocking Reference

```typescript
// Mock module
jest.mock('../../path/to/module');

// Mock function
const mockFn = jest.fn().mockReturnValue('value');
mockFn.mockResolvedValue('async value');
mockFn.mockRejectedValue(new Error('error'));

// Spy
const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
spy.mockRestore();
```

## Test Structure

```typescript
describe('Component', () => {
  afterEach(() => jest.clearAllMocks());

  it('should do something', async () => {
    const result = await functionUnderTest();
    expect(result).toBe(expected);
  });
});
```

## Common Assertions

```typescript
expect(value).toBe(expected);              // Strict equality
expect(value).toEqual(expected);           // Deep equality
expect(fn).toHaveBeenCalledWith(arg);      // Function called with
await expect(promise).resolves.toBe(val);  // Promise resolves
await expect(promise).rejects.toThrow();   // Promise rejects
```

## Critical Pitfalls

❌ **Don't** use Vitest syntax (`import { vi } from 'vitest'`)
❌ **Don't** forget to clean up mocks (`afterEach(() => jest.restoreAllMocks())`)
❌ **Don't** forget to await async tests
