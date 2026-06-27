// Per-project Jest config for the @aegis/connectors lib. Resolves @aegis/* path aliases so specs can
// import across libs under ts-jest. Runnable via the nx `test` target (`nx test connectors`) and the
// root jest (`npx jest libs/connectors`).
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'connectors',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // Mirror of tsconfig.base.json `paths` so cross-lib imports resolve under ts-jest.
  moduleNameMapper: {
    '^@aegis/service-core$': `${root}/libs/service-core/src/index.ts`,
    '^@aegis/shared-enums$': `${root}/libs/shared/enums/src/index.ts`,
    '^@aegis/connectors$': `${root}/libs/connectors/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, declaration: false } }],
  },
};

export default config;
