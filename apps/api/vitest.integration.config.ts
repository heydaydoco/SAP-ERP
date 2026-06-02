import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages publish CommonJS dist for runtime; in tests we alias them to source so the
// suite runs without a prior build.
const alias = {
  '@erp/kernel': fileURLToPath(new URL('../../packages/kernel/src/index.ts', import.meta.url)),
  '@erp/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
  '@erp/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
};

// Integration tests use Testcontainers (real Postgres in Docker) — slower, isolated, no shared
// state. Required for FI postings and anything touching the DB (root CLAUDE.md §5.4).
export default defineConfig({
  resolve: { alias },
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
