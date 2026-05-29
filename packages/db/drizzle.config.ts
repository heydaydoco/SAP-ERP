import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config. Schema is split per domain under src/schema/** and re-exported from
 * src/schema/index.ts. Migrations are SQL files in ./drizzle (committed, reviewed, immutable).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp',
  },
  // snake_case in the DB (root CLAUDE.md §3.3); Drizzle maps to camelCase in TS.
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
