import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { schema, type Database, type DbExecutor } from '@erp/db';
import type { AccountDeterminationKey, AccountDeterminationResolver } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import type { CreateAccountDeterminationDto } from './admin-config.dto.js';

const blank = (s?: string): string => s ?? '';

/**
 * Account determination (platform.admin-config, §4.5). Implements the kernel
 * `AccountDeterminationResolver`: maps a (chart of accounts · transaction key · discriminators) key
 * to a GL account from the config table, so fi-posting never hard-codes accounts. Discriminators
 * stored as '' are wildcards; `resolve` returns the most specific matching rule.
 */
@Injectable()
export class AccountDeterminationService implements AccountDeterminationResolver {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Create or update a rule (accounting maintains these without code changes). Returns the row. */
  async defineRule(dto: CreateAccountDeterminationDto, actor = 'system') {
    const values = {
      chartOfAccounts: dto.chartOfAccounts,
      transactionKey: dto.transactionKey,
      valuationClass: blank(dto.valuationClass),
      materialGroup: blank(dto.materialGroup),
      taxCode: blank(dto.taxCode),
      companyCode: blank(dto.companyCode),
      glAccount: dto.glAccount,
      createdBy: actor,
      updatedBy: actor,
    };
    const [row] = await this.db
      .insert(schema.accountDetermination)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.accountDetermination.chartOfAccounts,
          schema.accountDetermination.transactionKey,
          schema.accountDetermination.valuationClass,
          schema.accountDetermination.materialGroup,
          schema.accountDetermination.taxCode,
          schema.accountDetermination.companyCode,
        ],
        set: { glAccount: dto.glAccount, updatedAt: new Date(), updatedBy: actor },
      })
      .returning();
    return row;
  }

  /**
   * Resolve a key to its GL account. A rule matches when its discriminators equal the key's value or
   * are '' (wildcard); the most specific match (most non-wildcard discriminators) wins. Throws if no
   * rule matches (§4.5 — no hard-coded fallback).
   */
  // The optional executor widens the kernel interface (like DocFlowService.link): in-tx posting
  // paths pass their transaction so the lookup rides that connection (pool-starvation-safe).
  async resolve(key: AccountDeterminationKey, db: DbExecutor = this.db): Promise<string> {
    const t = schema.accountDetermination;
    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.chartOfAccounts, key.chartOfAccounts),
          eq(t.transactionKey, key.transactionKey),
          or(eq(t.valuationClass, blank(key.valuationClass)), eq(t.valuationClass, '')),
          or(eq(t.materialGroup, blank(key.materialGroup)), eq(t.materialGroup, '')),
          or(eq(t.taxCode, blank(key.taxCode)), eq(t.taxCode, '')),
          or(eq(t.companyCode, blank(key.companyCode)), eq(t.companyCode, '')),
        ),
      );

    const specificity = (r: (typeof rows)[number]): number =>
      [r.valuationClass, r.materialGroup, r.taxCode, r.companyCode].filter((x) => x !== '').length;
    const [best] = [...rows].sort((a, b) => specificity(b) - specificity(a));
    if (!best) {
      throw new NotFoundException(
        `no account determination rule for '${key.transactionKey}' in chart '${key.chartOfAccounts}'`,
      );
    }
    return best.glAccount;
  }

  async list(chartOfAccounts: string | undefined, limit: number, offset: number) {
    const where = chartOfAccounts
      ? eq(schema.accountDetermination.chartOfAccounts, chartOfAccounts)
      : undefined;
    return this.db
      .select()
      .from(schema.accountDetermination)
      .where(where)
      .orderBy(
        asc(schema.accountDetermination.chartOfAccounts),
        asc(schema.accountDetermination.transactionKey),
      )
      .limit(limit)
      .offset(offset);
  }

  async count(chartOfAccounts?: string): Promise<number> {
    const where = chartOfAccounts
      ? eq(schema.accountDetermination.chartOfAccounts, chartOfAccounts)
      : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.accountDetermination)
      .where(where);
    return row?.count ?? 0;
  }
}
