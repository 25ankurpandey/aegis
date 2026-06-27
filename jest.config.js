// Root Jest config for the Aegis monorepo. Resolves @aegis/* path aliases from tsconfig.base.json
// so tests can import across libs. Run a single project with: npx jest libs/<name>
const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.base.json');

module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/libs', '<rootDir>/apps'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: { ...compilerOptions, noUnusedLocals: false, declaration: false } },
    ],
  },
};
