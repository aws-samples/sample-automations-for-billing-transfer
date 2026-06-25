// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { RECON_MARKERS } from '../../lib/lambda/common/log-markers.js';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));

/**
 * Unit tests for the shared reconciliation log markers.
 *
 * These tests pin two invariants from the design "Refactor: shared log-marker
 * constants":
 *   1. RECON_MARKERS exposes the exact marker strings the Lambda handlers emit and
 *      the `bt` reconciliation-status command reads. Changing a value here is a
 *      deliberate, reviewed event because CloudWatch Logs queries depend on it.
 *   2. The reconciliation Lambda handlers reference RECON_MARKERS rather than
 *      re-inlining the literal marker strings, so the emitters (handlers) and the
 *      reader (CLI status command) cannot silently drift apart.
 */

// Repo-root-relative paths to the handler sources. The test file lives in
// <root>/test/common, so '../../' resolves to the repository root.
const REPO_ROOT = path.join(__dirname, '..', '..');
const BG_HANDLER_PATH = path.join(
  REPO_ROOT,
  'lib',
  'lambda',
  'billing-group-reconciliation',
  'index.ts'
);
const CUR_HANDLER_PATH = path.join(
  REPO_ROOT,
  'lib',
  'lambda',
  'cur-reconciliation',
  'index.ts'
);

/**
 * Returns true when `value` appears as a quoted string literal (single, double, or
 * template) anywhere in `source`. Used as the anti-drift check: a marker value that
 * shows up as an inlined literal in a handler means the handler has drifted away
 * from the shared constant.
 */
function containsStringLiteral(source: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literalPattern = new RegExp(`['"\`]${escaped}['"\`]`);
  return literalPattern.test(source);
}

describe('RECON_MARKERS shared log markers', () => {
  describe('marker values', () => {
    it('exposes the expected billing-group reconciliation markers', () => {
      expect(RECON_MARKERS.bg.ok).toBe('Reconciliation completed successfully');
      expect(RECON_MARKERS.bg.fail).toBe('Reconciliation failed with critical error');
    });

    it('exposes the expected CUR reconciliation markers', () => {
      expect(RECON_MARKERS.cur.ok).toBe('CUR reconciliation completed successfully');
      expect(RECON_MARKERS.cur.fail).toBe('CUR reconciliation failed');
      expect(RECON_MARKERS.cur.execCompleted).toBe('CUR reconciliation execution completed');
    });

    it('exposes exactly the documented marker keys', () => {
      expect(Object.keys(RECON_MARKERS).sort()).toEqual(['bg', 'cur']);
      expect(Object.keys(RECON_MARKERS.bg).sort()).toEqual(['fail', 'ok']);
      expect(Object.keys(RECON_MARKERS.cur).sort()).toEqual(['execCompleted', 'fail', 'ok']);
    });
  });

  describe('billing-group reconciliation handler references the shared constants', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(BG_HANDLER_PATH, 'utf8');
    });

    it('imports RECON_MARKERS from the shared log-markers module', () => {
      expect(source).toMatch(/import\s*\{[^}]*\bRECON_MARKERS\b[^}]*\}\s*from\s*['"]\.\.\/common\/log-markers(?:\.js)?['"]/);
    });

    it('references RECON_MARKERS.bg.ok and RECON_MARKERS.bg.fail', () => {
      expect(source).toContain('RECON_MARKERS.bg.ok');
      expect(source).toContain('RECON_MARKERS.bg.fail');
    });

    it('does not re-inline the billing-group marker string literals', () => {
      expect(containsStringLiteral(source, RECON_MARKERS.bg.ok)).toBe(false);
      expect(containsStringLiteral(source, RECON_MARKERS.bg.fail)).toBe(false);
    });
  });

  describe('CUR reconciliation handler references the shared constants', () => {
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(CUR_HANDLER_PATH, 'utf8');
    });

    it('imports RECON_MARKERS from the shared log-markers module', () => {
      expect(source).toMatch(/import\s*\{[^}]*\bRECON_MARKERS\b[^}]*\}\s*from\s*['"]\.\.\/common\/log-markers(?:\.js)?['"]/);
    });

    it('references RECON_MARKERS.cur.ok, RECON_MARKERS.cur.fail, and RECON_MARKERS.cur.execCompleted', () => {
      expect(source).toContain('RECON_MARKERS.cur.ok');
      expect(source).toContain('RECON_MARKERS.cur.fail');
      expect(source).toContain('RECON_MARKERS.cur.execCompleted');
    });

    it('does not re-inline the CUR marker string literals', () => {
      expect(containsStringLiteral(source, RECON_MARKERS.cur.ok)).toBe(false);
      expect(containsStringLiteral(source, RECON_MARKERS.cur.fail)).toBe(false);
      expect(containsStringLiteral(source, RECON_MARKERS.cur.execCompleted)).toBe(false);
    });
  });
});
