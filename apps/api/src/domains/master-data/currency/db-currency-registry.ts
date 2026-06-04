import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { schema, type Database } from '@erp/db';
import { MONEY_DB_SCALE, type CurrencyMeta, type CurrencyRegistry } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';

/**
 * DB-backed currency registry (root CLAUDE.md §3.1). Implements the kernel `CurrencyRegistry` that
 * the `Money` value object consumes, sourcing exact minor-unit exponents from the `currency` master
 * instead of a hard-coded "2 cents" table. The kernel interface is synchronous, so rows are cached
 * in memory; `reload()` refreshes the cache after the currency master changes (CurrencyService
 * calls it on every write).
 */
@Injectable()
export class DbCurrencyRegistry implements CurrencyRegistry, OnModuleInit {
  private readonly cache = new Map<string, number>();

  constructor(@Inject(DB) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Reload the minor-unit cache from the currency master. */
  async reload(): Promise<void> {
    const rows = await this.db
      .select({ code: schema.currency.code, minorUnit: schema.currency.minorUnit })
      .from(schema.currency);
    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.code, row.minorUnit);
    }
  }

  has(code: string): boolean {
    return this.cache.has(code);
  }

  get(code: string): CurrencyMeta {
    const minorUnit = this.cache.get(code);
    if (minorUnit === undefined) {
      throw new Error(`unknown currency "${code}" — register it in the currency master`);
    }
    if (minorUnit < 0 || minorUnit > MONEY_DB_SCALE) {
      throw new Error(`currency ${code}: minorUnit ${minorUnit} outside 0..${MONEY_DB_SCALE}`);
    }
    return { code, minorUnit };
  }
}
