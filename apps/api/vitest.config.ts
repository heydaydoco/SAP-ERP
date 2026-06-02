import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages publish CommonJS dist for runtime; in tests we alias them to source so the
// suite runs without a prior build.
const alias = {
  '@erp/kernel': fileURLToPath(new URL('../../packages/kernel/src/index.ts', import.meta.url)),
  '@erp/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
  '@erp/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
};

// Unit tests (fast, no infra). Integration tests live in vitest.integration.config.ts.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
