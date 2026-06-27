// Per-project Jest config for the @aegis/access-control lib. Resolves @aegis/* path aliases so specs
// can import across libs under ts-jest, and picks up the PDP/PEP/enforcer specs under a `test/`
// folder mirroring `src/`. Runnable both via the nx `test` target (`nx test access-control`) and the
// root jest (`npx jest libs/access-control`).
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'access-control',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // Mirror of tsconfig.base.json `paths` so cross-lib imports resolve under ts-jest.
  moduleNameMapper: {
    '^@aegis/access-control$': `${root}/libs/access-control/src/index.ts`,
    '^@aegis/service-core$': `${root}/libs/service-core/src/index.ts`,
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
