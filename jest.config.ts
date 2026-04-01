import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        rootDir: '.',
        isolatedModules: true,
      },
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/types.ts',
    '!src/main.ts',
  ],
};

export default config;
