// Per-project Jest config for cli (migrations/seeders). Tests live in a per-project `test/` folder
// mirroring `src/`. Resolves @aegis/* path aliases so migration specs can import the shared enums
// and db helpers the migrations themselves use. Runnable via the nx `test` target (`nx test cli`)
// and the root jest (`npx jest apps/cli`).
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'cli',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // Mirror of tsconfig.base.json `paths` so cross-lib imports resolve under ts-jest.
  moduleNameMapper: {
    '^@aegis/shared-enums$': `${root}/libs/shared/enums/src/index.ts`,
    '^@aegis/shared-types$': `${root}/libs/shared/types/src/index.ts`,
    '^@aegis/shared-constants$': `${root}/libs/shared/constants/src/index.ts`,
    '^@aegis/db$': `${root}/libs/db/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, declaration: false } }],
  },
};

export default config;
