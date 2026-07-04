// Per-project Jest config for @aegis/ai-core. Resolves @aegis/* path aliases so the prototype spec can
// import the real authorize()/validate()/Permission from across libs under ts-jest.
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'ai-core',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  moduleNameMapper: {
    '^@aegis/ai-core$': `${root}/libs/ai-core/src/index.ts`,
    '^@aegis/service-core$': `${root}/libs/service-core/src/index.ts`,
    '^@aegis/access-control$': `${root}/libs/access-control/src/index.ts`,
    '^@aegis/shared-enums$': `${root}/libs/shared/enums/src/index.ts`,
    '^@aegis/shared-types$': `${root}/libs/shared/types/src/index.ts`,
    '^@aegis/shared-constants$': `${root}/libs/shared/constants/src/index.ts`,
    '^@aegis/db$': `${root}/libs/db/src/index.ts`,
    '^@aegis/events$': `${root}/libs/events/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, declaration: false } }],
  },
};

export default config;
