// Per-project Jest config for reporting (SPEC §11.1 — tests live in a per-project `test/` folder
// mirroring `src/`). Resolves @aegis/* path aliases so tests can import across libs, and only picks
// up specs under this project's `test/` directory. Runnable both via the nx `test` target
// (`nx test reporting`) and the root jest (`npx jest apps/reporting`).
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'reporting',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // Mirror of tsconfig.base.json `paths` so cross-lib imports resolve under ts-jest.
  moduleNameMapper: {
    '^@aegis/service-core$': `${root}/libs/service-core/src/index.ts`,
    '^@aegis/access-control$': `${root}/libs/access-control/src/index.ts`,
    '^@aegis/connectors$': `${root}/libs/connectors/src/index.ts`,
    '^@aegis/audit$': `${root}/libs/audit/src/index.ts`,
    '^@aegis/activity$': `${root}/libs/activity/src/index.ts`,
    '^@aegis/shared-enums$': `${root}/libs/shared/enums/src/index.ts`,
    '^@aegis/shared-types$': `${root}/libs/shared/types/src/index.ts`,
    '^@aegis/shared-constants$': `${root}/libs/shared/constants/src/index.ts`,
    '^@aegis/db$': `${root}/libs/db/src/index.ts`,
    '^@aegis/events$': `${root}/libs/events/src/index.ts`,
    '^@aegis/testing$': `${root}/libs/testing/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, declaration: false } }],
  },
};

export default config;
