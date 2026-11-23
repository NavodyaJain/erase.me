import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // Creates the cluster-wide database roles once, before the parallel test files start (see test/global-setup.ts).
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
