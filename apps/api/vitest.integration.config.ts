import { defineConfig } from 'vitest/config';

// Integration tests use Testcontainers (real Postgres in Docker) — slower, isolated, no shared
// state. Required for FI postings and anything touching the DB (root CLAUDE.md §5.4).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One worker: containers are heavy and tests manage their own lifecycle.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
