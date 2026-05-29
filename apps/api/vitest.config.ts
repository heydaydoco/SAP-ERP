import { defineConfig } from 'vitest/config';

// Unit tests (fast, no infra). Integration tests live in vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
