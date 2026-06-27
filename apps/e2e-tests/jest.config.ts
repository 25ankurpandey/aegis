// Per-project Jest config for the in-process cross-service INTEGRATION HARNESS (the closest thing to
// E2E without Docker). It mirrors an app's config (see apps/expense/jest.config.ts): it resolves the
// `@aegis/*` path aliases so the harness can import across libs AND reach into the specific service
// classes it wires together, and only picks up specs under this project's `test/` directory.
//
// Runnable both via the nx `test` target (`nx test e2e-tests`) and the root jest
// (`npx jest apps/e2e-tests`).
import type { Config } from 'jest';

const root = '<rootDir>/../..';

const config: Config = {
  displayName: 'e2e-tests',
  rootDir: __dirname,
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // Mirror of tsconfig.base.json `paths` so cross-lib + cross-app service imports resolve under
  // ts-jest. The harness imports real service classes from `apps/<svc>/src/...` by relative path
  // (resolved through this project's tsconfig), and the shared libs via these aliases.
  moduleNameMapper: {
    '^@aegis/service-core$': `${root}/libs/service-core/src/index.ts`,
    '^@aegis/access-control$': `${root}/libs/access-control/src/index.ts`,
    '^@aegis/connectors$': `${root}/libs/connectors/src/index.ts`,
    '^@aegis/audit$': `${root}/libs/audit/src/index.ts`,
    '^@aegis/activity$': `${root}/libs/activity/src/index.ts`,
    '^@aegis/approvals$': `${root}/libs/approvals/src/index.ts`,
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
