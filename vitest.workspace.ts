import { defineWorkspace } from 'vitest/config';

// Aggregates per-package unit-test projects so `pnpm test:unit` runs them all.
// Integration tests (Testcontainers) run separately via `turbo run test:integration`.
export default defineWorkspace([
  'packages/*',
  'apps/api/vitest.config.ts',
]);
