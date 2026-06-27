// Per-project Jest config for the @aegis/audit lib. Resolves @aegis/* path aliases so specs can
// import across libs under ts-jest, and picks up the audit-logger + hash specs under a `test/` folder
// mirroring `src/`.
// Runnable both via the nx `test` target (`nx test audit`) and the root jest (`npx jest libs/audit`).
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'audit',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // Mirror of tsconfig.base.json `paths` so cross-lib imports resolve under ts-jest.
  moduleNameMapper: {
    '^@aegis/service-core$': `${root}/libs/service-core/src/index.ts`,
    '^@aegis/shared-enums$': `${root}/libs/shared/enums/src/index.ts`,
    '^@aegis/db$': `${root}/libs/db/src/index.ts`,
    '^@aegis/audit$': `${root}/libs/audit/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, declaration: false } }],
  },
};

export default config;
