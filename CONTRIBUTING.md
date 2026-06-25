# Contributing to AWS Billing Transfer Automation

Thank you for your interest in contributing to AWS Billing Transfer Automation! This document provides guidelines for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Process](#development-process)
- [Code Standards](#code-standards)
- [Testing Requirements](#testing-requirements)
- [Submitting Changes](#submitting-changes)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Security Vulnerabilities](#security-vulnerabilities)

## Code of Conduct

This project adheres to the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- Node.js 22.x (pinned in `.nvmrc`)
- npm 10.x or higher
- AWS CLI configured with appropriate credentials
- AWS CDK CLI: `npm install -g aws-cdk`
- Git

### Setting Up Your Development Environment

1. **Fork the repository** (if contributing from outside the organization)

2. **Clone your fork:**
   ```bash
   git clone https://github.com/YOUR-USERNAME/sample-automations-for-billing-transfer.git
   cd sample-automations-for-billing-transfer
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Build the project:**
   ```bash
   npm run build
   ```

5. **Run tests to verify setup:**
   ```bash
   npm test
   ```

6. **Synthesize CDK to verify CDK Nag compliance:**
   ```bash
   npm run cdk:synth
   ```

## Development Process

### Branching Strategy

- `main` - Deploy-ready code
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `docs/*` - Documentation updates

### Making Changes

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the code standards below

3. **Write or update tests** for your changes

4. **Run the test suite:**
   ```bash
   npm test
   npm run build
   npm run cdk:synth
   ```

5. **Commit your changes** with a descriptive commit message:
   ```bash
   git commit -m "feat: add support for custom pricing plans"
   ```

### Commit Message Guidelines

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Adding or updating tests
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks
- `perf:` - Performance improvements

**Examples:**
```
feat: add monthly reconciliation scheduler
fix: handle billing group creation race condition
docs: update README with troubleshooting steps
test: add integration tests for event handler
```

## Code Standards

### TypeScript Guidelines

- **Strict Mode**: All TypeScript must compile with strict mode enabled
- **Type Safety**: Avoid using `any` type; use proper types or `unknown`
- **Naming Conventions**:
  - Classes: `PascalCase`
  - Functions/Variables: `camelCase`
  - Constants: `UPPER_SNAKE_CASE`
  - Interfaces: `PascalCase` (no `I` prefix)
  - Types: `PascalCase`

### CDK Best Practices

- **Follow AWS CDK Best Practices**: See [AWS CDK Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- **Use L2 Constructs**: Prefer L2 constructs over L1 (CloudFormation) constructs
- **Reusable Constructs**: Extract common patterns into reusable L3 constructs in `lib/constructs/`
- **CDK Nag Compliance**: All stacks must pass CDK Nag security checks
  - Document any suppressions with clear justifications
  - See `.kiro/steering/cdk-nag-guide.md` for details

### Lambda Function Standards

- **Runtime**: Use the `NODEJS_22_X` Lambda managed runtime (the latest Node runtime AWS Lambda provides)
- **Architecture**: Use ARM64 (Graviton2) for better performance and cost
- **Bundling**: Use esbuild with ES modules format
- **Error Handling**: Implement proper error handling with structured logging
- **Timeouts**: Set appropriate timeouts (default: 5 minutes for this project)
- **Environment Variables**: Use environment variables for configuration
- **AWS SDK**: Use AWS SDK v3 with modular imports

**Example Lambda Handler:**
```typescript
import { Handler } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'billing-automation' });

export const handler: Handler = async (event, context) => {
  logger.info('Processing event', { event });
  
  try {
    // Your logic here
    return { statusCode: 200, body: 'Success' };
  } catch (error) {
    logger.error('Error processing event', { error });
    throw error;
  }
};
```

### Code Formatting

- **Indentation**: 2 spaces
- **Line Length**: Maximum 100 characters (soft limit)
- **Semicolons**: Required
- **Quotes**: Single quotes for strings
- **Trailing Commas**: Use trailing commas in multi-line objects/arrays

### Documentation

- **JSDoc Comments**: Document all public functions, classes, and interfaces
- **Inline Comments**: Explain complex logic or non-obvious decisions
- **README Updates**: Update README.md when adding new features
- **Architecture Diagrams**: Use Mermaid for diagrams when applicable

**Example JSDoc:**
```typescript
/**
 * Creates a billing group for a billing transfer relationship.
 * 
 * @param transferDetails - Details of the billing transfer
 * @param pricingPlanArn - ARN of the pricing plan to use
 * @returns The ARN of the created or existing billing group
 * @throws {ValidationException} If transfer details are invalid
 */
async function createBillingGroup(
  transferDetails: TransferDetails,
  pricingPlanArn: string
): Promise<string> {
  // Implementation
}
```

## Testing Requirements

### Test Coverage

- **Unit Tests**: Required for all new functions and classes
- **Integration Tests**: Required for new Lambda handlers and CDK stacks
- **Minimum Coverage**: Aim for 80% code coverage
- **Test Location**: Place tests in `test/` directory

### Writing Tests

**Unit Tests (Jest):**
```typescript
import { handler } from '../lib/lambda/billing-group-event-handler';
import { mockClient } from 'aws-sdk-client-mock';
import { BillingConductorClient } from '@aws-sdk/client-billingconductor';

const bcMock = mockClient(BillingConductorClient);

describe('Billing Group Handler', () => {
  beforeEach(() => {
    bcMock.reset();
  });

  it('should create billing group for accepted transfer', async () => {
    // Test implementation
  });
});
```

**CDK Stack Tests:**
```typescript
import { Template } from 'aws-cdk-lib/assertions';
import { BillingGroupEventHandlerStack } from '../lib/stacks/billing-group-event-handler-stack';

test('EventBridge rule created with correct pattern', () => {
  const stack = new BillingGroupEventHandlerStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.organizations'],
      // ... assertions
    }
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- billing-group-handler.test.ts

# Run in watch mode
npm run test:watch
```

### CDK Nag Security Checks

All changes must pass CDK Nag security checks:

```bash
npm run cdk:synth
```

If you need to suppress a rule, document the reason:

```typescript
import { NagSuppressions } from 'cdk-nag';

NagSuppressions.addResourceSuppressions(resource, [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Billing Conductor APIs do not support resource-level permissions',
  },
]);
```

## Submitting Changes

### Pull Request Process

1. **Update documentation** if you've made changes to:
   - Public APIs
   - Configuration options
   - Architecture
   - Dependencies

2. **Ensure all tests pass:**
   ```bash
   npm run build
   npm test
   npm run cdk:synth
   ```

3. **Update CHANGELOG.md** with your changes

4. **Push your branch** and create a pull request

5. **Fill out the pull request template** completely

6. **Request review** from maintainers

### Pull Request Checklist

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex logic
- [ ] Documentation updated (README, inline docs)
- [ ] Tests added/updated and passing
- [ ] CDK Nag checks pass
- [ ] No new warnings generated
- [ ] CHANGELOG.md updated
- [ ] Commit messages follow conventional commits

### Review Process

- All pull requests require at least one approval from a maintainer
- CI/CD pipeline must pass (build, test, security checks)
- Address all review comments before merging
- Maintainers may request changes or additional tests

## Reporting Bugs

### Before Submitting a Bug Report

- Check the [existing issues](https://github.com/aws-samples/sample-automations-for-billing-transfer/issues) to avoid duplicates
- Verify the bug exists in the latest version
- Collect relevant information (logs, error messages, environment details)

### Submitting a Bug Report

Use the bug report template and include:

- **Clear title** describing the issue
- **Steps to reproduce** the bug
- **Expected behavior** vs actual behavior
- **Environment details**:
  - Node.js version
  - AWS CDK version
  - AWS region
  - Operating system
- **Logs and error messages** (sanitize any sensitive information)
- **Screenshots** if applicable

## Requesting Features

### Before Submitting a Feature Request

- Check if the feature already exists
- Review [existing feature requests](https://github.com/aws-samples/sample-automations-for-billing-transfer/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)
- Consider if the feature aligns with project goals

### Submitting a Feature Request

Use the feature request template and include:

- **Clear title** describing the feature
- **Problem statement**: What problem does this solve?
- **Proposed solution**: How should it work?
- **Alternatives considered**: Other approaches you've thought about
- **Use case**: Real-world scenario where this would be useful
- **Additional context**: Any other relevant information

## Security Vulnerabilities

**DO NOT create public GitHub issues for security vulnerabilities.**

Please report security vulnerabilities following the process in [SECURITY.md](SECURITY.md).

For security issues:
- Email security contact (see SECURITY.md)
- Include detailed description of the vulnerability
- Provide steps to reproduce if possible
- Allow time for the issue to be addressed before public disclosure

## Additional Resources

- [Project Documentation](.kiro/steering/) - Detailed guides and standards
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [AWS Billing Conductor Documentation](https://docs.aws.amazon.com/billingconductor/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

## Questions?

If you have questions about contributing:
- Check the [project documentation](.kiro/steering/)
- Review [existing issues and discussions](https://github.com/aws-samples/sample-automations-for-billing-transfer/issues)
- Open a new issue with the `question` label

Thank you for contributing to AWS Billing Transfer Automation!
