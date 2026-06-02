import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';

/** Two-digit zero-padded string. */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Fiscal year / period control (platform.admin-config). Enforces period locking (root CLAUDE.md
 * §5.1): a posting is only allowed into an OPEN period of an OPEN year. `assertPeriodOpen` is the
 * guard fi-posting calls before writing a journal; closing a period blocks further postings into it
 * (correct only via reversal). Years are laid out as 12 calendar-month periods.
 */
@Injectable()
export class FiscalPeriodService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Idempotently create a fiscal year and its 12 monthly periods (all OPEN). Returns the year id.
   * Safe to re-run (used by the seed).
   */
  async generateYear(companyCodeId: string, year: number, actor = 'system'): Promise<string> {
    await this.assertCompanyExists(companyCodeId);

    await this.db
      .insert(schema.fiscalYear)
      .values({ companyCodeId, year, createdBy: actor, updatedBy: actor })
      .onConflictDoNothing({ target: [schema.fiscalYear.companyCodeId, schema.fiscalYear.year] });

    const [yearRow] = await this.db
      .select({ id: schema.fiscalYear.id })
      .from(schema.fiscalYear)
      .where(
        and(eq(schema.fiscalYear.companyCodeId, companyCodeId), eq(schema.fiscalYear.year, year)),
      );
    if (!yearRow) throw new Error(`fiscal year ${year} missing after generate`);

    const periods = Array.from({ length: 12 }, (_, i) => {
      const periodNo = i + 1;
      const lastDay = new Date(Date.UTC(year, periodNo, 0)).getUTCDate();
      return {
        fiscalYearId: yearRow.id,
        periodNo,
        startDate: `${year}-${pad2(periodNo)}-01`,
        endDate: `${year}-${pad2(periodNo)}-${pad2(lastDay)}`,
        createdBy: actor,
        updatedBy: actor,
      };
    });
    await this.db
      .insert(schema.fiscalPeriod)
      .values(periods)
      .onConflictDoNothing({
        target: [schema.fiscalPeriod.fiscalYearId, schema.fiscalPeriod.periodNo],
      });

    return yearRow.id;
  }

  async listYears(companyCodeId: string | undefined, limit: number, offset: number) {
    const where = companyCodeId ? eq(schema.fiscalYear.companyCodeId, companyCodeId) : undefined;
    return this.db
      .select()
      .from(schema.fiscalYear)
      .where(where)
      .orderBy(asc(schema.fiscalYear.year))
      .limit(limit)
      .offset(offset);
  }

  async countYears(companyCodeId?: string): Promise<number> {
    const where = companyCodeId ? eq(schema.fiscalYear.companyCodeId, companyCodeId) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.fiscalYear)
      .where(where);
    return row?.count ?? 0;
  }

  async listPeriods(fiscalYearId: string) {
    return this.db
      .select()
      .from(schema.fiscalPeriod)
      .where(eq(schema.fiscalPeriod.fiscalYearId, fiscalYearId))
      .orderBy(asc(schema.fiscalPeriod.periodNo));
  }

  async setPeriodStatus(periodId: string, status: 'OPEN' | 'CLOSED', actor = 'system') {
    const [row] = await this.db
      .update(schema.fiscalPeriod)
      .set({ status, updatedAt: new Date(), updatedBy: actor })
      .where(eq(schema.fiscalPeriod.id, periodId))
      .returning();
    if (!row) throw new NotFoundException(`fiscal period ${periodId} not found`);
    return row;
  }

  closePeriod(periodId: string, actor = 'system') {
    return this.setPeriodStatus(periodId, 'CLOSED', actor);
  }

  openPeriod(periodId: string, actor = 'system') {
    return this.setPeriodStatus(periodId, 'OPEN', actor);
  }

  /** True iff an OPEN period of an OPEN year covers `date` (YYYY-MM-DD) for the company code. */
  async isPeriodOpen(companyCodeId: string, date: string): Promise<boolean> {
    const row = await this.findCoveringPeriod(companyCodeId, date);
    return !!row && row.yearStatus === 'OPEN' && row.periodStatus === 'OPEN';
  }

  /** Throws if no period covers `date`, or the covering period/year is CLOSED (§5.1 period lock). */
  async assertPeriodOpen(companyCodeId: string, date: string): Promise<void> {
    const row = await this.findCoveringPeriod(companyCodeId, date);
    if (!row) {
      throw new NotFoundException(
        `no fiscal period covers ${date} for company code ${companyCodeId}`,
      );
    }
    if (row.yearStatus !== 'OPEN' || row.periodStatus !== 'OPEN') {
      throw new ConflictException(`fiscal period covering ${date} is closed`);
    }
  }

  private async findCoveringPeriod(companyCodeId: string, date: string) {
    const [row] = await this.db
      .select({
        periodId: schema.fiscalPeriod.id,
        periodStatus: schema.fiscalPeriod.status,
        yearStatus: schema.fiscalYear.status,
      })
      .from(schema.fiscalPeriod)
      .innerJoin(schema.fiscalYear, eq(schema.fiscalPeriod.fiscalYearId, schema.fiscalYear.id))
      .where(
        and(
          eq(schema.fiscalYear.companyCodeId, companyCodeId),
          lte(schema.fiscalPeriod.startDate, date),
          gte(schema.fiscalPeriod.endDate, date),
        ),
      );
    return row;
  }

  private async assertCompanyExists(companyCodeId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.companyCode.id })
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!row) throw new NotFoundException(`company code ${companyCodeId} not found`);
  }
}
