import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type { CreateGlAccountDto } from './gl-account.dto.js';

/**
 * GL-account master service (master-data.gl-account). The chart of accounts that fi-posting hits
 * (root CLAUDE.md §3.2); account numbers are unique within their chart. `create*` enforces that for
 * the API; idempotent `ensure*` backs the seed.
 */
@Injectable()
export class GlAccountService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async createGlAccount(dto: CreateGlAccountDto, actor = 'system') {
    const dup = await this.db
      .select({ id: schema.glAccount.id })
      .from(schema.glAccount)
      .where(this.key(dto.chartOfAccounts, dto.accountNumber));
    if (dup.length > 0) {
      throw new ConflictException(
        `account ${dto.accountNumber} already exists in chart ${dto.chartOfAccounts}`,
      );
    }

    const [row] = await this.db
      .insert(schema.glAccount)
      .values({
        chartOfAccounts: dto.chartOfAccounts,
        accountNumber: dto.accountNumber,
        name: dto.name,
        accountType: dto.accountType,
        currency: dto.currency ?? null,
        isReconciliation: dto.isReconciliation,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensureGlAccount(dto: CreateGlAccountDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.glAccount)
      .values({
        chartOfAccounts: dto.chartOfAccounts,
        accountNumber: dto.accountNumber,
        name: dto.name,
        accountType: dto.accountType,
        currency: dto.currency ?? null,
        isReconciliation: dto.isReconciliation,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.glAccount.chartOfAccounts, schema.glAccount.accountNumber],
      });
    const [row] = await this.db
      .select({ id: schema.glAccount.id })
      .from(schema.glAccount)
      .where(this.key(dto.chartOfAccounts, dto.accountNumber));
    if (!row) throw new Error(`gl account ${dto.accountNumber} missing after ensure`);
    return row.id;
  }

  async listGlAccounts(chartOfAccounts: string | undefined, limit: number, offset: number) {
    const where = chartOfAccounts
      ? eq(schema.glAccount.chartOfAccounts, chartOfAccounts)
      : undefined;
    return this.db
      .select()
      .from(schema.glAccount)
      .where(where)
      .orderBy(asc(schema.glAccount.accountNumber))
      .limit(limit)
      .offset(offset);
  }

  async countGlAccounts(chartOfAccounts?: string): Promise<number> {
    const where = chartOfAccounts
      ? eq(schema.glAccount.chartOfAccounts, chartOfAccounts)
      : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.glAccount)
      .where(where);
    return row?.count ?? 0;
  }

  async getGlAccount(id: string) {
    const [row] = await this.db.select().from(schema.glAccount).where(eq(schema.glAccount.id, id));
    if (!row) throw new NotFoundException(`gl account ${id} not found`);
    return row;
  }

  private key(chartOfAccounts: string, accountNumber: string) {
    return and(
      eq(schema.glAccount.chartOfAccounts, chartOfAccounts),
      eq(schema.glAccount.accountNumber, accountNumber),
    );
  }
}
