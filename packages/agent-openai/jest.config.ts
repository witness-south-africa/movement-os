/** @jest-config-loader ts-node */
/* eslint-disable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(
  readFileSync(join(__dirname, '.spec.swcrc'), 'utf-8'),
);

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

export default {
  displayName: '@wsa/agent-openai',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  // jose is ESM-only; transform this dependency for Jest's CommonJS runner.
  transformIgnorePatterns: ['node_modules/(?!\\.pnpm/jose@|jose/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
