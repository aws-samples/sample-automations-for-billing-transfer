// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Jest config for an ESM ("type": "module") project.
 *
 * Uses ts-jest's ESM preset so TypeScript test sources are transformed to ES
 * modules. Run with the Node flag that enables Jest's ESM module runner:
 *   NODE_OPTIONS=--experimental-vm-modules jest
 * (wired into the npm "test" scripts).
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Runs before the test framework is set up (and before any `new cdk.App()`),
  // so the bundling-skip context is in place for every synthesizing test.
  setupFiles: ['<rootDir>/test/jest.setup.cjs'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/test/integration/' // Exclude integration tests from default test run
  ],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }]
  },
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/**/index.ts'
  ],
  coverageReporters: ['text', 'lcov', 'cobertura'],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Under ESM the source uses explicit ".js" specifiers that resolve to ".ts"
  // sources at test time; strip the extension so Jest's resolver finds them.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testTimeout: 30000,
  maxWorkers: '50%',
  cache: true,
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
  silent: true,
};
