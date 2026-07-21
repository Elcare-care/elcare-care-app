const path = require('path')

/**
 * Fully explicit jest@30 config — bypasses next/jest's createJestConfig wrapper
 * which has async-resolution incompatibilities with jest@30 when run from a
 * npm workspace root.
 *
 * SWC transform is applied directly via next/jest's own transform package.
 */
module.exports = {
  testEnvironment: 'jest-environment-jsdom',

  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  testPathIgnorePatterns: [
    path.resolve(__dirname, 'e2e'),
    path.resolve(__dirname, 'tests/e2e'),
  ],

  moduleNameMapper: {
    // Path alias
    '^@/(.*)$': '<rootDir>/src/$1',
    // Static file mocks
    '\\.(jpg|jpeg|png|gif|webp|svg|ico)$': '<rootDir>/src/__mocks__/fileMock.js',
    '\\.(css|less|scss|sass)$': '<rootDir>/src/__mocks__/fileMock.js',
  },

  transform: {
    // Use next/babel for tsx/ts/js transformation (avoids needing SWC separately)
    '^.+\\.(js|jsx|ts|tsx)$': ['babel-jest', {
      presets: [
        ['next/babel', { 'preset-env': { targets: { node: 'current' } } }],
      ],
    }],
  },

  transformIgnorePatterns: [
    '/node_modules/(?!(.*\\.mjs$))',
  ],

  collectCoverage: process.env.CI === 'true' || process.env.COLLECT_COVERAGE === 'true',
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/app/**/layout.tsx',
    '!src/app/**/loading.tsx',
    '!src/app/**/error.tsx',
    '!src/app/**/not-found.tsx',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global:                               { statements: 60, branches: 50, functions: 55, lines: 60 },
    './src/components/CheckoutModal.tsx': { statements: 90, branches: 75, functions: 85, lines: 90 },
    './src/components/ListingCard.tsx':   { statements: 90, branches: 75, functions: 85, lines: 90 },
    './src/hooks/useMarketplace.ts':      { statements: 55, branches: 45, functions: 50, lines: 55 },
    './src/lib/contract.ts':              { statements: 15, branches: 10, functions: 10, lines: 15 },
  },
}
