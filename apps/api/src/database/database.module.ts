import { Global, Module } from '@nestjs/common';
import { createDb, type Database } from '@erp/db';

/** Injection token for the shared Drizzle client. */
export const DB = 'ERP_DB';

const DEFAULT_URL = 'postgresql://erp:erp@localhost:5432/erp';

/**
 * Global database module — provides one lazy Drizzle client (postgres-js connects on first query,
 * so construction never blocks boot). Inject with `@Inject(DB) private readonly db: Database`.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Database => createDb(process.env.DATABASE_URL ?? DEFAULT_URL),
    },
  ],
  exports: [DB],
})
export class DatabaseModule {}
