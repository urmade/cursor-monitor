import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    environment: 'node',
    env: {
      VITEST: 'true',
    },
    // DB-backed suites share org bootstrap; parallel files race on orgs_slug_key.
    fileParallelism: false,
  },
});
