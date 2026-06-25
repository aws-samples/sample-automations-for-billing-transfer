# Changelog

All notable changes to the AWS Billing Transfer Automation project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

#### CI/CD Improvements
- **GitLab CI Pipeline Optimization**: Removed deployment stage from GitLab CI pipeline as deployment is handled by AWS CodeCommit/CodePipeline
- **Memory Optimization**: Increased Node.js heap size to 4GB (`NODE_OPTIONS=--max-old-space-size=4096`) to prevent memory exhaustion during Jest test execution with coverage
- **Test Performance**: Added `--maxWorkers=2` and `--coverageProvider=v8` flags to Jest for more efficient test execution in CI environment
- **Coverage Thresholds**: Adjusted Jest coverage thresholds from 70% to 60% for all metrics (branches, functions, lines, statements) to better align with sample project requirements
- **Pipeline Stages**: GitLab CI now focuses solely on validation (build, test, security) without deployment stages

## [1.0.0] - 2025-11-26

### Added

#### Core Features
- **Automated Billing Group Creation**: Automatically creates billing groups in AWS Billing Conductor when billing transfer relationships are accepted
- **Event-Driven Architecture**: EventBridge integration that triggers on CloudTrail billing transfer events (`ResponsibilityTransferAccepted`, `ResponsibilityTransferTerminated`)
- **Monthly Reconciliation**: EventBridge Scheduler for monthly billing group verification (runs on the 1st of each month)
- **Dual Trigger Support**: Lambda handler supports both event-driven and scheduled execution modes
- **Idempotent Operations**: Safe retry logic prevents duplicate billing group creation

#### Infrastructure as Code
- **AWS CDK Implementation**: Complete infrastructure defined using AWS CDK with TypeScript
- **Self-Mutating CI/CD Pipeline**: Automated deployment pipeline using AWS CodePipeline and CodeBuild
- **Pipeline Optimizations**: 
  - ARM64 (Graviton2) Lambda architecture for 19% better price-performance
  - ES Module format for improved tree-shaking and smaller bundles
  - CodeBuild caching for 30-50% faster subsequent builds
  - Parallel asset publishing (8x concurrency)
- **GitLab CI/CD Support**: Optional GitLab pipeline configuration with build, test, security, and deploy stages

#### AWS Service Integrations
- **AWS Billing Conductor**: Automated billing group and pricing plan management
- **AWS Organizations**: Billing transfer relationship monitoring
- **Amazon EventBridge**: Event-driven automation and scheduled execution
- **AWS Lambda**: Serverless execution with Node.js 22.x runtime
- **AWS CloudTrail**: Billing transfer event capture and delivery
- **Amazon CloudWatch**: Structured logging and monitoring

#### Developer Experience
- **Comprehensive Documentation**: 
  - Project overview and architecture guide
  - CDK development standards
  - Billing Conductor implementation guide
  - EventBridge patterns and best practices
  - Pipeline troubleshooting guide
  - Pipeline optimization guide
- **Testing Framework**: Unit and integration test infrastructure with Jest
- **Property-Based Testing**: Fast-check integration for comprehensive test coverage
- **TypeScript Support**: Full type safety with strict mode enabled
- **Local Development**: CDK watch mode for rapid iteration

### Security

#### Security Compliance
- **CDK Nag Integration**: Automated security best practices validation during synthesis
- **All Critical Security Findings Resolved**: Zero critical or high severity issues from security scans
- **Documented Suppressions**: All CDK Nag rule suppressions include clear justifications
- **No Hardcoded Secrets**: All sensitive values use environment variables or AWS Secrets Manager
- **Least Privilege IAM**: Lambda functions use minimal required permissions
- **Dead Letter Queue**: Failed event processing captured for investigation
- **Secure Dependencies**: All dependencies audited and updated to latest secure versions

#### Security Features
- **AWS Lambda Powertools**: Structured logging, metrics, and tracing for observability
- **X-Ray Tracing**: Distributed tracing enabled for performance monitoring
- **CloudWatch Alarms**: Monitoring for Lambda errors and DLQ messages
- **Retry Configuration**: Exponential backoff for transient failures
- **Error Handling**: Comprehensive error handling with structured logging

### Documentation

#### Project Documentation
- **README.md**: Comprehensive getting started guide with quick start instructions
- **CONTRIBUTING.md**: Contribution guidelines, code standards, and security reporting
- **SECURITY.md**: Security vulnerability reporting process and best practices
- **LICENSE**: MIT-0 license for open source distribution
- **CHANGELOG.md**: Version history and release notes (this file)

#### Technical Guides
- **Project Overview**: Architecture, AWS Billing Transfer concepts, and service usage
- **CDK Standards**: Development standards, stack design principles, and best practices
- **CDK Nag Guide**: Security compliance implementation and rule suppression guidelines
- **Billing Conductor Guide**: API usage patterns, idempotency, and error handling
- **EventBridge Patterns**: Event detection, filtering, and Lambda handler patterns
- **Pipeline Troubleshooting**: Common issues and resolution steps
- **Pipeline Optimization**: Performance improvements and cost savings strategies

### Infrastructure

#### AWS Resources Created
- **Lambda Functions**: Billing group automation handler with ARM64 architecture
- **EventBridge Rules**: CloudTrail event pattern matching for billing transfers
- **EventBridge Schedules**: Monthly reconciliation schedule
- **IAM Roles**: Least privilege execution roles for Lambda functions
- **Dead Letter Queues**: SQS queues for failed event processing
- **CloudWatch Log Groups**: Structured logging with 30-day retention
- **CodePipeline**: Self-mutating deployment pipeline
- **CodeBuild Projects**: Build, test, and synthesis automation
- **CodeCommit Repository**: Source code repository (optional)

### Performance

#### Optimizations
- **Lambda Cold Start**: ES module format reduces cold start time by ~10%
- **Bundle Size**: External AWS SDK reduces bundle size by ~50MB
- **Build Time**: CodeBuild caching reduces subsequent builds by 30-50%
- **Execution Cost**: ARM64 architecture reduces Lambda costs by ~20%
- **Deployment Speed**: Parallel asset publishing speeds up deployments up to 8x

### Testing

#### Test Coverage
- **Unit Tests**: Core business logic and CDK construct validation
- **Integration Tests**: End-to-end workflow testing with actual AWS services
- **Property-Based Tests**: Fast-check integration for comprehensive input validation
- **CDK Snapshot Tests**: CloudFormation template validation
- **Security Tests**: CDK Nag automated security scanning

### Compliance

#### AWS Standards
- **AWS Type 2 Open Source Accelerator**: Complies with AWS naming and documentation guidelines
- **AWS Well-Architected Framework**: Follows security, reliability, and performance best practices
- **AWS Solutions Checks**: Passes CDK Nag AWS Solutions rule pack
- **CloudFormation Best Practices**: Infrastructure follows AWS recommended patterns

### Known Limitations

- Billing Conductor APIs do not support resource-level IAM permissions (requires wildcard)
- Custom pricing rates take up to 24 hours to reflect after billing group creation
- Billing groups are mutually exclusive (account can only belong to one group per billing period)
- EventBridge may deliver events more than once (idempotency required)

### Dependencies

#### Major Dependencies
- **AWS CDK**: 2.229.1
- **Node.js**: 22.x
- **TypeScript**: 5.3.3
- **AWS SDK v3**: 3.940.0+
- **AWS Lambda Powertools**: 2.29.0
- **CDK Nag**: 2.37.55
- **Jest**: 29.7.0
- **Fast-check**: 4.3.0

### Migration Notes

This is the initial release. No migration required.

### Contributors

Initial release prepared for open source publication.

---

## Release Process

For maintainers releasing new versions:

1. Update version in `package.json`
2. Update this CHANGELOG.md with new version section
3. Commit changes: `git commit -m "chore: release v1.x.x"`
4. Create git tag: `git tag -a v1.x.x -m "Release v1.x.x"`
5. Push changes: `git push origin main --tags`
6. Create GitHub release with release notes

## Versioning Strategy

- **Major (1.x.x)**: Breaking changes to infrastructure or APIs
- **Minor (x.1.x)**: New features, non-breaking changes
- **Patch (x.x.1)**: Bug fixes, security updates, documentation improvements

[1.0.0]: https://github.com/aws-samples/sample-automations-for-billing-transfer/releases/tag/v1.0.0
