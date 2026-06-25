// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ResourceRegistry, FEATURE_STACK_COUNT } from '../../../cli/lib/resource-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Smoke test for the Resource_Registry (Requirement 21).
 *
 * Verifies the single in-code source of truth holds its expected constants,
 * derives the feature-stack count instead of hard-coding it, and — critically —
 * that no resource name leaks into any other `cli/` source file (Req 21.6/21.7).
 */
describe('Resource_Registry smoke test', () => {
  // Every AWS resource name the registry owns (Req 21.1). Built from the
  // registry itself so the list cannot drift from the source of truth. The
  // Default_Region is intentionally excluded: it is a region, not a resource
  // name, and is legitimately referenced (via the registry) by the client
  // factory.
  const resourceNames: string[] = [
    ResourceRegistry.pipelineStackName,
    ResourceRegistry.pipelineName,
    ...ResourceRegistry.featureStacks,
    ...Object.values(ResourceRegistry.functions),
    ...Object.values(ResourceRegistry.dlqs),
    ...Object.values(ResourceRegistry.ssmParams),
  ];

  describe('Default_Region (Req 21.2)', () => {
    it('defines defaultRegion as us-east-1', () => {
      expect(ResourceRegistry.defaultRegion).toBe('us-east-1');
    });
  });

  describe('feature stacks (Req 21.1)', () => {
    it('derives FEATURE_STACK_COUNT from the list rather than hard-coding it', () => {
      expect(FEATURE_STACK_COUNT).toBe(ResourceRegistry.featureStacks.length);
    });

    it('lists exactly the five expected feature stacks in order', () => {
      expect([...ResourceRegistry.featureStacks]).toEqual([
        'BT-BillingGroupEventHandlerStack',
        'BT-BillingGroupReconciliationStack',
        'BT-CURReconciliationStack',
        'BT-BillingTransferTerminationStack',
        'BT-PartnerCentralChannelRolesStack',
      ]);
    });

    it('has no duplicate feature stack names', () => {
      const unique = new Set(ResourceRegistry.featureStacks);
      expect(unique.size).toBe(ResourceRegistry.featureStacks.length);
    });
  });

  describe('resource names are the expected constants (Req 21.1)', () => {
    it('defines the pipeline stack and pipeline execution names', () => {
      expect(ResourceRegistry.pipelineStackName).toBe(
        'SampleAutomationsForBillingTransfer-PipelineStack',
      );
      expect(ResourceRegistry.pipelineName).toBe(
        'SampleAutomationsForBillingTransferPipeline',
      );
    });

    it('defines the reconciliation and termination function names', () => {
      expect(ResourceRegistry.functions).toEqual({
        billingGroupReconciliation: 'billing-group-reconciliation',
        curReconciliation: 'cur-reconciliation',
        terminationHandler: 'billing-transfer-termination-handler',
      });
    });

    it('defines the dead-letter-queue names', () => {
      expect(ResourceRegistry.dlqs).toEqual({
        billingGroupReconciliation: 'billing-reconciliation-dlq',
        curReconciliation: 'cur-reconciliation-dlq',
      });
    });

    it('defines the channel-role SSM parameter paths', () => {
      expect(ResourceRegistry.ssmParams).toEqual({
        linkedAccountId: '/billing-transfer/partner-central/linked-account-id',
        enableManagementRole: '/billing-transfer/partner-central/enable-management-role',
      });
    });
  });

  describe('each resource name is defined exactly once (Req 21.1)', () => {
    it('contains no duplicate resource-name values across the registry', () => {
      const unique = new Set(resourceNames);
      expect(unique.size).toBe(resourceNames.length);
    });
  });

  describe('names are not hard-coded elsewhere in cli/ (Req 21.6, 21.7)', () => {
    // Resolve the `cli/` root relative to this test file
    // (test/cli/lib/resource-registry.test.ts -> cli/).
    const cliRoot = path.resolve(__dirname, '../../../cli');

    // The registry source file is the single allowed home for the names.
    const registryFile = path.join(cliRoot, 'lib', 'resource-registry.ts');

    /** Recursively collect every `.ts` source file under `cli/`. */
    const collectTsFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          out.push(...collectTsFiles(full));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          out.push(full);
        }
      }
      return out;
    };

    // Source files to scan: everything under cli/ except the registry itself
    // (the one place each name is allowed) and any test files.
    const scannedFiles = collectTsFiles(cliRoot).filter(
      (file) => file !== registryFile && !file.endsWith('.test.ts'),
    );

    /**
     * Strip module specifiers (the quoted path in `import ... from '<path>'`,
     * bare side-effect `import '<path>'`, and `require('<path>')`) from a source
     * file before scanning.
     *
     * Req 21.7 forbids hard-coding an AWS *resource name* in code; it does not
     * govern source-module paths. A few Lambda source directories legitimately
     * share a segment with a deployed resource name (e.g. the
     * `lib/lambda/cur-reconciliation/` directory vs. the `cur-reconciliation`
     * function name), so a Command that imports a *type* from such a directory
     * is not hard-coding the resource name. Renaming the deployed resource in
     * the registry would not touch these import paths. Excluding module
     * specifiers keeps the scan focused on genuine in-code string literals while
     * avoiding this false positive.
     */
    const stripModuleSpecifiers = (content: string): string =>
      content
        .replace(/\bfrom\s+['"][^'"]*['"]/g, "from ''")
        .replace(/\bimport\s+['"][^'"]*['"]/g, "import ''")
        .replace(/\brequire\(\s*['"][^'"]*['"]\s*\)/g, 'require()');

    it('finds cli/ source files to scan (guards against a no-op test)', () => {
      // The registry is the only allowed home for the names; there must be at
      // least one other cli/ file to make the negative assertion meaningful.
      expect(scannedFiles.length).toBeGreaterThan(0);
    });

    it.each(scannedFiles)('does not hard-code any resource name in %s', (file) => {
      const content = stripModuleSpecifiers(fs.readFileSync(file, 'utf8'));
      const offenders = resourceNames.filter((name) => content.includes(name));
      expect(offenders).toEqual([]);
    });
  });
});
