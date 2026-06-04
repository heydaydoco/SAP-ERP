import { boolean, char, integer, pgEnum, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, currencyCol, moneyCol, pk } from '../_shared/columns';

/**
 * Business partner master (master-data.business-partner = SAP BP). One core partner record carries
 * any number of **roles** as separate 1:1 extension tables (§4.4): customer (AR), vendor (AP), and
 * later carrier/bank/broker. Neither a giant single table nor copies — the role tables hold only what
 * that relationship needs. `code` is the partner number (natural key) other domains reference.
 */

/** ORGANIZATION = a company; PERSON = an individual. Mirrors the shared `bpTypeSchema`. */
export const bpType = pgEnum('bp_type', ['ORGANIZATION', 'PERSON']);

export const businessPartner = pgTable('business_partner', {
  id: pk(),
  /** Partner number (business key), e.g. 'C1000' / 'V2000'. */
  code: varchar('code', { length: 16 }).notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(),
  bpType: bpType('bp_type').notNull(),
  /** 사업자등록번호 / tax registration id (not personal data — corporate identifier). */
  taxId: varchar('tax_id', { length: 32 }),
  country: char('country', { length: 2 }),
  city: varchar('city', { length: 128 }),
  addressLine: varchar('address_line', { length: 256 }),
  ...auditColumns(),
});

/**
 * Customer role (AR side). The receivables reconciliation account and credit terms FI/SD read when a
 * partner sells. 1:1 with the core partner (`bp_id` unique).
 */
export const customer = pgTable('customer', {
  id: pk(),
  bpId: uuid('bp_id')
    .notNull()
    .unique()
    .references(() => businessPartner.id),
  /** AR reconciliation GL account (외상매출금, e.g. '1100'); postings hit this, never directly. */
  arReconAccount: varchar('ar_recon_account', { length: 16 }).notNull(),
  creditLimit: moneyCol('credit_limit'),
  creditCurrency: currencyCol('credit_currency'),
  paymentTermsDays: integer('payment_terms_days'),
  salesBlock: boolean('sales_block').notNull().default(false),
  ...auditColumns(),
});

/**
 * Vendor role (AP side). The payables reconciliation account and payment terms FI/MM read when a
 * partner supplies. 1:1 with the core partner (`bp_id` unique). Bank details live in bank-master
 * (later) so PIPA-sensitive data is not duplicated here (§5.3).
 */
export const vendor = pgTable('vendor', {
  id: pk(),
  bpId: uuid('bp_id')
    .notNull()
    .unique()
    .references(() => businessPartner.id),
  /** AP reconciliation GL account (외상매입금, e.g. '2100'). */
  apReconAccount: varchar('ap_recon_account', { length: 16 }).notNull(),
  paymentTermsDays: integer('payment_terms_days'),
  purchasingBlock: boolean('purchasing_block').notNull().default(false),
  ...auditColumns(),
});
