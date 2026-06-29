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

/**
 * Carrier role (운송인 — 선사/항공사, SAP TM 'Carrier' role). **NON-POSTING**: unlike customer/vendor there is
 * NO reconciliation account — a carrier moves cargo, it raises no AR/AP subledger of its own (forwarder freight
 * AP is a separate vendor role on the forwarder BP, not here). The mere existence of this row flags "this BP is
 * a carrier"; `scac`/`iata_code` are its identity codes only (relational booking attributes — 컷오프/D/O/운임계약
 * — are deferred to the 4PL forwarding slice). 1:1 with the core partner (`bp_id` unique).
 *
 * SAP models the carrier's identification per transport mode, so the two codes are mode-split and each nullable:
 * a 해상/육상 carrier carries only a SCAC, an 항공 carrier only an IATA code.
 */
export const carrier = pgTable('carrier', {
  id: pk(),
  bpId: uuid('bp_id')
    .notNull()
    .unique()
    .references(() => businessPartner.id),
  /**
   * SCAC (Standard Carrier Alpha Code, 2–4 uppercase letters) — the 육상·해상 carrier standard identifier
   * (SAP carrier-role identification BUP006). Nullable: an 항공 carrier has none. No DB format CHECK (외부 표준,
   * Zod-validated, like `trade_direction`); no unique (v1 has no basis to forbid a shared SCAC).
   */
  scac: varchar('scac', { length: 4 }),
  /**
   * IATA airline code (2–3 alphanumeric) — the 항공 carrier identifier (SCAC is 육해상-only, IATA is 항공:
   * SAP splits the code system by mode). Nullable: a 해상 carrier has none.
   */
  iataCode: varchar('iata_code', { length: 3 }),
  ...auditColumns(),
});
