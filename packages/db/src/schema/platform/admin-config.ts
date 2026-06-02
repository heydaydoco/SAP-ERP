import { date, integer, pgEnum, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';
import { companyCode } from './org-structure';

/**
 * Admin-config (platform.admin-config = SAP IMG). Two Phase-0 concerns the kernel spine depends on:
 *
 *  1. Fiscal year / period control — period locking (root CLAUDE.md §5.1). A posting is only allowed
 *     into an OPEN period of an OPEN year; closed periods reject new postings. Periods are per
 *     company code (a calendar-month layout by default).
 *  2. Account determination (§4.5) — the (transaction key · chart of accounts · discriminators) →
 *     GL account mapping, editable by accounting without code changes. Backs the kernel
 *     `AccountDeterminationResolver`; fi-posting never hard-codes GL accounts.
 */

/** OPEN allows posting; CLOSED locks the year/period (correct only via reversal — §5.1). */
export const fiscalStatus = pgEnum('fiscal_status', ['OPEN', 'CLOSED']);

/** Fiscal year per company code (calendar year by default). */
export const fiscalYear = pgTable(
  'fiscal_year',
  {
    id: pk(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** Calendar year, e.g. 2026. */
    year: integer('year').notNull(),
    status: fiscalStatus('status').notNull().default('OPEN'),
    ...auditColumns(),
  },
  (t) => [unique('fiscal_year_uq').on(t.companyCodeId, t.year)],
);

/** Posting period within a fiscal year (period_no 1–12 for a calendar layout). */
export const fiscalPeriod = pgTable(
  'fiscal_period',
  {
    id: pk(),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYear.id),
    periodNo: integer('period_no').notNull(),
    /** Inclusive date range the period covers (YYYY-MM-DD). */
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    status: fiscalStatus('status').notNull().default('OPEN'),
    ...auditColumns(),
  },
  (t) => [unique('fiscal_period_uq').on(t.fiscalYearId, t.periodNo)],
);

/**
 * Account determination rules (§4.5). Discriminator columns are NOT NULL with default '' meaning
 * "any" (wildcard); resolution prefers the most specific matching rule. The full key is unique so a
 * given combination maps to exactly one GL account.
 */
export const accountDetermination = pgTable(
  'account_determination',
  {
    id: pk(),
    chartOfAccounts: varchar('chart_of_accounts', { length: 16 }).notNull(),
    /** e.g. 'SALES_REVENUE', 'AR', 'OUTPUT_VAT', 'INVENTORY'. */
    transactionKey: varchar('transaction_key', { length: 32 }).notNull(),
    valuationClass: varchar('valuation_class', { length: 16 }).notNull().default(''),
    materialGroup: varchar('material_group', { length: 16 }).notNull().default(''),
    taxCode: varchar('tax_code', { length: 16 }).notNull().default(''),
    /** Company-code business key ('' = applies to every company code in the chart). */
    companyCode: varchar('company_code', { length: 8 }).notNull().default(''),
    /** The resolved GL account number. */
    glAccount: varchar('gl_account', { length: 16 }).notNull(),
    ...auditColumns(),
  },
  (t) => [
    unique('account_determination_uq').on(
      t.chartOfAccounts,
      t.transactionKey,
      t.valuationClass,
      t.materialGroup,
      t.taxCode,
      t.companyCode,
    ),
  ],
);
