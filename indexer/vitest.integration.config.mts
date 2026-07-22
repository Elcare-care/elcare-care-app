import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/integration/**/*.integration.test.ts'],
    globalSetup: ['./src/__tests__/integration/globalSetup.ts'],
    setupFiles: ['./src/__tests__/integration/setup-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
