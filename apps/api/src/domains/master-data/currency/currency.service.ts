import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type { CreateCurrencyDto, CreateFxRateDto } from './currency.dto.js';
import { DbCurrencyRegistry } from './db-currency-registry.js';
import { resolveFxRate } from './fx-rate.js';

/**
 * Currency + FX-rate master service (master-data.currency). The currency master is the source of
 * truth for minor-unit exponents (root CLAUDE.md §3.1); every write refreshes the injected
 * `DbCurrencyRegistry` so the kernel `Money` object sees new currencies immediately. `create*`
 * enforces uniqueness for the API; idempotent `ensure*` helpers back the re-runnable seed.
 */
@Injectable()
export class CurrencyService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  // ── currency ─────────────────────────────────────────────────────────────────

  async createCurrency(dto: CreateCurrencyDto, actor = 'system') {
    const existing = await this.db
      .select({ id: schema.currency.id })
      .from(schema.currency)
      .where(eq(schema.currency.code, dto.code));
    if (existing.length > 0) throw new ConflictException(`currency ${dto.code} already exists`);

    const [row] = await this.db
      .insert(schema.currency)
      .values({
        code: dto.code,
        name: dto.name,
        minorUnit: dto.minorUnit,
        symbol: dto.symbol ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    await this.registry.reload();
    return row;
  }

  /** Idempotent: create if absent, return the id either way; refreshes the registry. */
  async ensureCurrency(dto: CreateCurrencyDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.currency)
      .values({
        code: dto.code,
        name: dto.name,
        minorUnit: dto.minorUnit,
        symbol: dto.symbol ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({ target: schema.currency.code });
    await this.registry.reload();
    const [row] = await this.db
      .select({ id: schema.currency.id })
      .from(schema.currency)
      .where(eq(schema.currency.code, dto.code));
    if (!row) throw new Error(`currency ${dto.code} missing after ensure`);
    return row.id;
  }

  async listCurrencies(limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.currency)
      .orderBy(asc(schema.currency.code))
      .limit(limit)
      .offset(offset);
  }

  async countCurrencies(): Promise<number> {
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(schema.currency);
    return row?.count ?? 0;
  }

  async getCurrency(id: string) {
    const [row] = await this.db.select().from(schema.currency).where(eq(schema.currency.id, id));
    if (!row) throw new NotFoundException(`currency ${id} not found`);
    return row;
  }

  // ── fx rate ──────────────────────────────────────────────────────────────────

  async createFxRate(dto: CreateFxRateDto, actor = 'system') {
    await this.assertCurrencyExists(dto.fromCurrency);
    await this.assertCurrencyExists(dto.toCurrency);
    const dup = await this.db
      .select({ id: schema.fxRate.id })
      .from(schema.fxRate)
      .where(this.fxKey(dto));
    if (dup.length > 0) {
      throw new ConflictException(
        `fx rate ${dto.fromCurrency}->${dto.toCurrency} (${dto.rateType}) on ${dto.validFrom} already exists`,
      );
    }

    const [row] = await this.db
      .insert(schema.fxRate)
      .values({
        fromCurrency: dto.fromCurrency,
        toCurrency: dto.toCurrency,
        rateType: dto.rateType,
        validFrom: dto.validFrom,
        rate: dto.rate,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensureFxRate(dto: CreateFxRateDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.fxRate)
      .values({
        fromCurrency: dto.fromCurrency,
        toCurrency: dto.toCurrency,
        rateType: dto.rateType,
        validFrom: dto.validFrom,
        rate: dto.rate,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [
          schema.fxRate.fromCurrency,
          schema.fxRate.toCurrency,
          schema.fxRate.rateType,
          schema.fxRate.validFrom,
        ],
      });
    const [row] = await this.db
      .select({ id: schema.fxRate.id })
      .from(schema.fxRate)
      .where(this.fxKey(dto));
    if (!row) throw new Error(`fx rate missing after ensure`);
    return row.id;
  }

  async listFxRates(
    fromCurrency: string | undefined,
    toCurrency: string | undefined,
    limit: number,
    offset: number,
  ) {
    const filters = [
      fromCurrency ? eq(schema.fxRate.fromCurrency, fromCurrency) : undefined,
      toCurrency ? eq(schema.fxRate.toCurrency, toCurrency) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    return this.db
      .select()
      .from(schema.fxRate)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(schema.fxRate.validFrom))
      .limit(limit)
      .offset(offset);
  }

  async countFxRates(fromCurrency?: string, toCurrency?: string): Promise<number> {
    const filters = [
      fromCurrency ? eq(schema.fxRate.fromCurrency, fromCurrency) : undefined,
      toCurrency ? eq(schema.fxRate.toCurrency, toCurrency) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.fxRate)
      .where(filters.length ? and(...filters) : undefined);
    return row?.count ?? 0;
  }

  /** Resolve the rate effective on `onDate` via the pure helper; 404 when none is effective yet. */
  async resolveRate(fromCurrency: string, toCurrency: string, onDate: string, rateType = 'M') {
    const candidates = await this.db
      .select({ validFrom: schema.fxRate.validFrom, rate: schema.fxRate.rate })
      .from(schema.fxRate)
      .where(
        and(
          eq(schema.fxRate.fromCurrency, fromCurrency),
          eq(schema.fxRate.toCurrency, toCurrency),
          eq(schema.fxRate.rateType, rateType),
        ),
      );
    const resolved = resolveFxRate(candidates, onDate);
    if (!resolved) {
      throw new NotFoundException(
        `no ${rateType} rate for ${fromCurrency}->${toCurrency} effective on ${onDate}`,
      );
    }
    return { fromCurrency, toCurrency, rateType, ...resolved };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private fxKey(dto: CreateFxRateDto) {
    return and(
      eq(schema.fxRate.fromCurrency, dto.fromCurrency),
      eq(schema.fxRate.toCurrency, dto.toCurrency),
      eq(schema.fxRate.rateType, dto.rateType),
      eq(schema.fxRate.validFrom, dto.validFrom),
    );
  }

  private async assertCurrencyExists(code: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.currency.id })
      .from(schema.currency)
      .where(eq(schema.currency.code, code));
    if (!row) throw new NotFoundException(`currency ${code} not found`);
  }
}
