import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
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
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Release the postgres-js connection pool on shutdown. `app.close()` tears NestJS providers down
   * but never closes the underlying socket pool, so a one-shot context (e.g. the seed) would hang on
   * exit with the event loop kept alive by the idle pool. onModuleDestroy fires in reverse-dependency
   * order — this @Global module is destroyed AFTER every consumer — so ending the client here is safe
   * for every process (seed, api, worker) without a process.exit() escape hatch.
   */
  async onModuleDestroy(): Promise<void> {
    await this.db.$client.end();
  }
}
