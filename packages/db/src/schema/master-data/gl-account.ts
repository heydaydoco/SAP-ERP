import { boolean, char, pgEnum, pgTable, unique, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/** GL account classification — drives the normal balance (asset/expense = debit; the rest = credit). */
export const glAccountType = pgEnum('gl_account_type', [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
]);

/**
 * General-ledger account master (master-data.gl-account = 계정과목) — the chart of accounts every FI
 * posting hits (root CLAUDE.md §3.2). `account_determination` (admin-config) maps transaction keys to
 * these account numbers; the number is unique within its chart of accounts.
 */
export const glAccount = pgTable(
  'gl_account',
  {
    id: pk(),
    chartOfAccounts: varchar('chart_of_accounts', { length: 16 }).notNull(),
    accountNumber: varchar('account_number', { length: 16 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    accountType: glAccountType('account_type').notNull(),
    /** Account currency (ISO-4217); null = postable in any / the local currency. */
    currency: char('currency', { length: 3 }),
    /** Reconciliation account (AR/AP control) — posted via its subledger, never directly. */
    isReconciliation: boolean('is_reconciliation').notNull().default(false),
    ...auditColumns(),
  },
  (t) => [unique('gl_account_uq').on(t.chartOfAccounts, t.accountNumber)],
);
