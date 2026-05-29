import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kernel',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
