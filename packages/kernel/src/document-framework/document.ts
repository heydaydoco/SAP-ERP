import type { DocStatus } from '@erp/shared';

/**
 * Common document framework (root CLAUDE.md §4.2).
 *
 * Every transaction document in every domain shares this shape:
 * `header + item + status + numbering + audit-4 + attachments + partner-ref + FI-posting hook`.
 * Defined once here; domains EXTEND these, never re-implement.
 *
 * NOTE: interface stubs only — concrete Drizzle base tables + Nest base entities land in Phase 0.
 */

/** The audit-4 columns mandated on every table (root CLAUDE.md §3.4). */
export interface AuditColumns {
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

/** Reference to a business partner playing some role on a document. */
export interface PartnerRef {
  partnerId: string;
  role: string; // e.g. 'SOLD_TO' | 'SHIP_TO' | 'VENDOR' | 'CARRIER'
}

/** Base for any document header. `docType` + `docNo` come from the numbering domain. */
export interface DocumentHeader extends AuditColumns {
  id: string;
  docType: string;
  docNo: string;
  status: DocStatus;
  partners: PartnerRef[];
  /** Idempotency key carried into fi-posting to guarantee exactly-once journals (§5.2). */
  postingKey?: string;
}

/** Base for any document line item. */
export interface DocumentItem extends AuditColumns {
  id: string;
  headerId: string;
  lineNo: number;
}

/** A document that knows how to produce its FI journal (the FI-posting hook, §3.2). */
export interface PostableDocument {
  /** Stable key used as the idempotency key for the resulting journal entry. */
  postingKey(): string;
}
