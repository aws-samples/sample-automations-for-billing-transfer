// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { describe, it, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  load,
  resolvePath,
  ProfileListError,
} from '../../../cli/lib/profile-loader.js';
import type { GlobalOptions, IoContext } from '../../../cli/lib/io-context.js';

/**
 * Unit tests for Profile_Loader path resolution and `load` error conditions
 * (Requirement 4).
 *
 * Covers:
 *  - {@link resolvePath} precedence `--profiles-file` option →
 *    `$PAYER_PROFILES_FILE` → `<cwd>/payer-profiles.txt` (Req 4.2, 4.3, 4.4),
 *    including relative-vs-absolute anchoring against `ctx.cwd`.
 *  - {@link load} throwing {@link ProfileListError} with the correct `reason`
 *    for not-found (Req 4.7), empty-after-parse (Req 4.8), and unreadable —
 *    explicitly distinct from not-found (Req 4.9).
 *
 * The pure resolver tests use a synthetic `cwd` (no filesystem access). The
 * `load` tests use a real temp directory so the not-found / empty / unreadable
 * branches exercise actual `fs.readFileSync` behavior rather than a mock.
 */

/** Minimal IoContext stub: `resolvePath`/`load` only read `cwd` and `env`. */
function makeCtx(cwd: string, env: NodeJS.ProcessEnv = {}): IoContext {
  return { cwd, env } as unknown as IoContext;
}

/** Build GlobalOptions with sensible defaults; override `profilesFile` per test. */
function makeGlobal(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    scope: { kind: 'ambient' },
    json: false,
    color: false,
    execute: false,
    verbose: false,
    ...overrides,
  };
}

describe('Profile_Loader resolvePath precedence (Req 4.2, 4.3, 4.4)', () => {
  const cwd = path.resolve('/work/dir');

  describe('--profiles-file option takes precedence (Req 4.2)', () => {
    it('uses the option, resolved relative to cwd, when it is a relative path', () => {
      const resolved = resolvePath(
        makeGlobal({ profilesFile: 'custom-profiles.txt' }),
        makeCtx(cwd, { PAYER_PROFILES_FILE: 'env-profiles.txt' }),
      );
      expect(resolved).toBe(path.resolve(cwd, 'custom-profiles.txt'));
    });

    it('honors an absolute option path as-is', () => {
      const absolute = path.resolve('/abs/path/list.txt');
      const resolved = resolvePath(
        makeGlobal({ profilesFile: absolute }),
        makeCtx(cwd, { PAYER_PROFILES_FILE: 'env-profiles.txt' }),
      );
      expect(resolved).toBe(absolute);
    });

    it('wins over $PAYER_PROFILES_FILE when both are set', () => {
      const resolved = resolvePath(
        makeGlobal({ profilesFile: 'option.txt' }),
        makeCtx(cwd, { PAYER_PROFILES_FILE: '/env/wins.txt' }),
      );
      expect(resolved).toBe(path.resolve(cwd, 'option.txt'));
    });
  });

  describe('$PAYER_PROFILES_FILE is used when the option is absent (Req 4.3)', () => {
    it('uses the env var, resolved relative to cwd, when option is undefined', () => {
      const resolved = resolvePath(
        makeGlobal(),
        makeCtx(cwd, { PAYER_PROFILES_FILE: 'env-profiles.txt' }),
      );
      expect(resolved).toBe(path.resolve(cwd, 'env-profiles.txt'));
    });

    it('honors an absolute env path as-is', () => {
      const absolute = path.resolve('/abs/env/list.txt');
      const resolved = resolvePath(
        makeGlobal(),
        makeCtx(cwd, { PAYER_PROFILES_FILE: absolute }),
      );
      expect(resolved).toBe(absolute);
    });

    it('falls through to the env var when the option is an empty string', () => {
      const resolved = resolvePath(
        makeGlobal({ profilesFile: '' }),
        makeCtx(cwd, { PAYER_PROFILES_FILE: 'env-profiles.txt' }),
      );
      expect(resolved).toBe(path.resolve(cwd, 'env-profiles.txt'));
    });
  });

  describe('default <cwd>/payer-profiles.txt when neither is set (Req 4.4)', () => {
    it('uses the default when option is undefined and env is unset', () => {
      const resolved = resolvePath(makeGlobal(), makeCtx(cwd, {}));
      expect(resolved).toBe(path.resolve(cwd, 'payer-profiles.txt'));
    });

    it('uses the default when the env var is an empty string', () => {
      const resolved = resolvePath(
        makeGlobal(),
        makeCtx(cwd, { PAYER_PROFILES_FILE: '' }),
      );
      expect(resolved).toBe(path.resolve(cwd, 'payer-profiles.txt'));
    });

    it('uses the default when both option and env are empty/absent', () => {
      const resolved = resolvePath(
        makeGlobal({ profilesFile: '' }),
        makeCtx(cwd, { PAYER_PROFILES_FILE: '' }),
      );
      expect(resolved).toBe(path.resolve(cwd, 'payer-profiles.txt'));
    });

    it('anchors the default to the provided cwd', () => {
      const otherCwd = path.resolve('/some/other/cwd');
      const resolved = resolvePath(makeGlobal(), makeCtx(otherCwd, {}));
      expect(resolved).toBe(path.resolve(otherCwd, 'payer-profiles.txt'));
    });
  });
});

describe('Profile_Loader load error conditions (Req 4.7, 4.8, 4.9)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-profile-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('happy path (anchors the error cases)', () => {
    it('returns the ordered profiles when the resolved file has profiles', () => {
      const filePath = path.join(tmpDir, 'payer-profiles.txt');
      fs.writeFileSync(filePath, '# header\nalpha\n\nbravo  # inline\n', 'utf8');

      const profiles = load(makeGlobal(), makeCtx(tmpDir, {}));
      expect(profiles).toEqual(['alpha', 'bravo']);
    });
  });

  describe('not-found (Req 4.7)', () => {
    it('throws ProfileListError with reason "not-found" when the file is missing', () => {
      const missing = path.join(tmpDir, 'does-not-exist.txt');

      expect.assertions(4);
      try {
        load(makeGlobal({ profilesFile: missing }), makeCtx(tmpDir, {}));
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileListError);
        const err = error as ProfileListError;
        expect(err.reason).toBe('not-found');
        expect(err.path).toBe(missing);
        // Remediation states how to create the list (Req 4.7).
        expect(err.remediation).toMatch(/profile name|PAYER_PROFILES_FILE/i);
      }
    });
  });

  describe('empty after parse (Req 4.8)', () => {
    it('throws ProfileListError with reason "empty" when only blanks/comments remain', () => {
      const filePath = path.join(tmpDir, 'payer-profiles.txt');
      fs.writeFileSync(filePath, '\n   \n# only a comment\n\t# another\n', 'utf8');

      expect.assertions(3);
      try {
        load(makeGlobal(), makeCtx(tmpDir, {}));
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileListError);
        const err = error as ProfileListError;
        expect(err.reason).toBe('empty');
        expect(err.path).toBe(filePath);
      }
    });
  });

  describe('unreadable, distinct from not-found (Req 4.9)', () => {
    it('throws ProfileListError with reason "unreadable" for a non-ENOENT read error', () => {
      // Point the resolved path at a directory: readFileSync throws EISDIR,
      // an "exists but cannot be read" error that is NOT ENOENT. This proves
      // the loader keeps the read failure distinct from not-found (Req 4.9).
      const dirAsFile = path.join(tmpDir, 'a-directory');
      fs.mkdirSync(dirAsFile);

      expect.assertions(5);
      try {
        load(makeGlobal({ profilesFile: dirAsFile }), makeCtx(tmpDir, {}));
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileListError);
        const err = error as ProfileListError;
        expect(err.reason).toBe('unreadable');
        // Explicitly NOT conflated with not-found (Req 4.9).
        expect(err.reason).not.toBe('not-found');
        expect(err.path).toBe(dirAsFile);
        expect(err.cause).toBeDefined();
      }
    });
  });
});
