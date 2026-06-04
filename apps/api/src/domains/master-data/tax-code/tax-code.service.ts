import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import { DbCurrencyRegistry } from '../currency/db-currency-registry.js';
import type { CreateTaxCodeDto } from './tax-code.dto.js';
import { computeTax } from './tax-calc.js';

/**
 * Tax-code master service (master-data.tax-code). CRUD over VAT codes plus `quote`, which computes a
 * tax amount through the kernel `Money` rounding fed by the DB currency master (root CLAUDE.md §3.1,
 * §5.4) — proving the calc path end-to-end. `create*`/`ensure*` mirror the other masters.
 */
@Injectable()
export class TaxCodeService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  async createTaxCode(dto: CreateTaxCodeDto, actor = 'system') {
    const existing = await this.db
      .select({ id: schema.taxCode.id })
      .from(schema.taxCode)
      .where(eq(schema.taxCode.code, dto.code));
    if (existing.length > 0) throw new ConflictException(`tax code ${dto.code} already exists`);

    const [row] = await this.db
      .insert(schema.taxCode)
      .values({
        code: dto.code,
        name: dto.name,
        kind: dto.kind,
        ratePercent: dto.ratePercent,
        glAccount: dto.glAccount ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensureTaxCode(dto: CreateTaxCodeDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.taxCode)
      .values({
        code: dto.code,
        name: dto.name,
        kind: dto.kind,
        ratePercent: dto.ratePercent,
        glAccount: dto.glAccount ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({ target: schema.taxCode.code });
    const [row] = await this.db
      .select({ id: schema.taxCode.id })
      .from(schema.taxCode)
      .where(eq(schema.taxCode.code, dto.code));
    if (!row) throw new Error(`tax code ${dto.code} missing after ensure`);
    return row.id;
  }

  async listTaxCodes(kind: 'OUTPUT' | 'INPUT' | undefined, limit: number, offset: number) {
    const where = kind ? eq(schema.taxCode.kind, kind) : undefined;
    return this.db
      .select()
      .from(schema.taxCode)
      .where(where)
      .orderBy(asc(schema.taxCode.code))
      .limit(limit)
      .offset(offset);
  }

  async countTaxCodes(kind?: 'OUTPUT' | 'INPUT'): Promise<number> {
    const where = kind ? eq(schema.taxCode.kind, kind) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.taxCode)
      .where(where);
    return row?.count ?? 0;
  }

  async getTaxCode(id: string) {
    const [row] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.id, id));
    if (!row) throw new NotFoundException(`tax code ${id} not found`);
    return row;
  }

  /** Quote the tax for `baseAmount` in `currency` under tax code `code`, currency-aware rounded. */
  async quote(code: string, baseAmount: string, currency: string) {
    const [tc] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.code, code));
    if (!tc) throw new NotFoundException(`tax code ${code} not found`);
    if (!this.registry.has(currency)) {
      throw new NotFoundException(`currency ${currency} not found`);
    }
    const base = Money.of(baseAmount, currency, this.registry);
    const tax = computeTax(base, tc.ratePercent);
    return {
      code: tc.code,
      kind: tc.kind,
      ratePercent: tc.ratePercent,
      currency,
      base: base.toNumeric(),
      tax: tax.toNumeric(),
    };
  }
}
