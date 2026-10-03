/** @jest-config-loader ts-node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const swcJestConfig = JSON.parse(
  readFileSync(join(__dirname, '.spec.swcrc'), 'utf-8'),
) as Record<string, unknown>;
swcJestConfig.swcrc = false;

export default {
  displayName: '@wsa/agent-anthropic',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: { '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig] },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
