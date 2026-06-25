# Security Policy

## Reporting a Vulnerability

We take the security of this project seriously. If you discover a security vulnerability, please follow these steps:

### Do NOT:
- Create a public GitHub issue for security vulnerabilities
- Disclose the vulnerability publicly before it has been addressed
- Test the vulnerability against production systems you do not own

### Do:
1. **Report privately**: For security issues in this sample, notify AWS/Amazon Security via the [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/) or by email to aws-security@amazon.com. Please do **not** create a public GitHub issue.
2. **Provide details**: Include a description of the vulnerability, steps to reproduce, and potential impact
3. **Allow time**: Give the maintainers reasonable time to address the issue before public disclosure
4. **Coordinate disclosure**: Work with maintainers on timing and content of public disclosure

### What to Include in Your Report

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact and severity assessment
- Suggested remediation (if available)
- Your contact information for follow-up questions

### Response Timeline

- **Initial Response**: Within 3 business days of report
- **Status Update**: Within 7 business days with assessment and timeline
- **Resolution**: Varies based on severity and complexity

## Supported Versions

This project follows semantic versioning. Security updates are provided for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

We recommend always using the latest stable release to ensure you have the most recent security patches.

## Security Best Practices for Deployment

When deploying this project, follow these security best practices:

### IAM Permissions

**Principle of Least Privilege:**
- Grant only the minimum permissions required for the Lambda function to operate
- Use resource-specific permissions where possible
- Regularly review and audit IAM policies

**Required Permissions:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "billingconductor:CreateBillingGroup",
        "billingconductor:ListBillingGroups",
        "billingconductor:ListPricingPlans"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/*"
    }
  ]
}
```

**Note**: Billing Conductor APIs do not support resource-level permissions, requiring `Resource: "*"` for billing operations.

### CloudTrail Logging

**Enable CloudTrail:**
- Ensure CloudTrail is enabled in your AWS account
- Configure CloudTrail to log AWS Organizations API calls
- Store CloudTrail logs in a secure S3 bucket with encryption
- Enable log file validation for integrity checking

**Monitor Key Events:**
- `ResponsibilityTransferAccepted`
- `ResponsibilityTransferTerminated`
- `CreateBillingGroup`
- `DeleteBillingGroup`

### CDK Nag Security Checks

**Run CDK Nag Before Deployment:**
```bash
npm run cdk synth
```

This project uses CDK Nag to enforce AWS security best practices. All CDK Nag findings should be addressed before deployment.

**Review Suppressions:**
- All CDK Nag suppressions are documented with clear justifications
- Regularly review suppressions to ensure they remain valid
- See `.kiro/steering/cdk-nag-guide.md` for implementation details

### Secrets Management

**Never Hardcode Secrets:**
- Do not commit AWS credentials, API keys, or secrets to the repository
- Use AWS Secrets Manager or Systems Manager Parameter Store for sensitive data
- Use environment variables for configuration
- Enable secret scanning in your repository

**Git History:**
- Scan git history for accidentally committed secrets using tools like gitleaks
- If secrets are found, rotate them immediately and remove from history

### Network Security

**Lambda Function Security:**
- Deploy Lambda functions in a VPC if accessing private resources
- Use security groups to control inbound/outbound traffic
- Enable VPC Flow Logs for network monitoring

**API Gateway (if applicable):**
- Use AWS WAF to protect against common web exploits
- Enable API Gateway logging
- Implement rate limiting and throttling

### Monitoring and Alerting

**CloudWatch Alarms:**
- Set up alarms for Lambda function errors
- Monitor dead letter queue for failed events
- Alert on unusual billing group creation patterns

**CloudWatch Logs:**
- Enable structured logging for easier analysis
- Set appropriate log retention periods
- Use CloudWatch Logs Insights for security analysis

**Example Query for Security Events:**
```sql
fields @timestamp, level, message, context.accountId
| filter level = "ERROR" or message like /security/
| sort @timestamp desc
```

### Dependency Management

**Keep Dependencies Updated:**
```bash
npm audit                    # Check for vulnerabilities
npm audit fix                # Fix vulnerabilities automatically
npm update                   # Update to latest compatible versions
```

**Automated Scanning:**
- Enable Dependabot alerts in GitHub
- Configure automated dependency updates
- Review and test updates before merging

### Data Protection

**Sensitive Data Handling:**
- Do not log sensitive information (account IDs, ARNs, etc.) in plain text
- Use CloudWatch Logs encryption
- Enable S3 bucket encryption for any stored data
- Implement data retention policies

**Billing Data:**
- Billing group information may contain sensitive organizational data
- Implement appropriate access controls
- Follow your organization's data classification policies

### Incident Response

**If a Security Incident Occurs:**

1. **Contain**: Disable affected resources immediately
   ```bash
   aws events disable-rule --name BillingTransferEventRule
   aws lambda update-function-configuration --function-name <name> --environment Variables={}
   ```

2. **Assess**: Determine scope and impact
   - Review CloudTrail logs
   - Check CloudWatch Logs for suspicious activity
   - Identify affected resources and accounts

3. **Remediate**: Fix the vulnerability
   - Deploy patched code
   - Rotate compromised credentials
   - Update security groups and policies

4. **Recover**: Restore normal operations
   - Re-enable resources after verification
   - Monitor for continued suspicious activity

5. **Learn**: Document and improve
   - Conduct post-incident review
   - Update security controls
   - Share lessons learned with team

### Compliance Considerations

**AWS Well-Architected Framework:**
- Follow the Security Pillar best practices
- Regularly review and update security controls
- Implement defense in depth

**Audit Trail:**
- Maintain comprehensive audit logs
- Implement log aggregation and analysis
- Retain logs according to compliance requirements

**Access Control:**
- Implement multi-factor authentication (MFA) for AWS console access
- Use AWS SSO for centralized identity management
- Regularly review and revoke unnecessary access

## Security Testing

**Before Deployment:**
- Run all unit and integration tests
- Execute CDK Nag security checks
- Scan dependencies for vulnerabilities
- Review IAM policies for least privilege

**Continuous Security:**
- Implement automated security scanning in CI/CD pipeline
- Regularly perform security assessments
- Stay informed about new vulnerabilities and patches

## Additional Resources

- [AWS Security Best Practices](https://aws.amazon.com/security/best-practices/)
- [AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [AWS Billing Conductor Security](https://docs.aws.amazon.com/billingconductor/latest/userguide/security.html)
- [CDK Security Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html#best-practices-security)

## Security Updates

Security updates will be released as patch versions (e.g., 1.0.1) and documented in the [CHANGELOG.md](CHANGELOG.md). Subscribe to repository releases to be notified of security updates.

## Acknowledgments

We appreciate the security research community's efforts in responsibly disclosing vulnerabilities. Contributors who report valid security issues will be acknowledged in release notes (with permission).
