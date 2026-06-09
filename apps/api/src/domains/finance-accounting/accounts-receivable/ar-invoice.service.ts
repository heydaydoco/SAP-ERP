import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money, type PostingLine } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { DOC_TYPE_AR_INVOICE, JournalService } from '../general-ledger/journal.service.js';
import { buildTaxLines, type TaxCodeInfo } from '../invoice-posting/tax-line-builder.js';
import { deriveDueDate } from '../invoice-posting/due-date.js';
import type { ArOpenItemQuery, CreateArInvoiceDto } from './ar-invoice.dto.js';

/**
 * Accounts-receivable invoice posting (finance-accounting.accounts-receivable ≈ SAP FB70). A customer
 * invoice is a `DR` document raised through the SAME `JournalService.post()` as every other entry
 * (root CLAUDE.md §3.2 — no second journal writer, D4 — no ar_invoice table):
 *
 *   Dr  AR reconciliation account (gross, + customer partner)   ← recon substitution from the role
 *   Cr  revenue account(s) from the DTO (net, per line)         ← D: account from the document, not VKOA
 *   Cr  output VAT account(s) (Σ per-line tax, per tax code)    ← from the tax-line builder (D1/D2)
 *
 * Open items are the recon lines themselves filtered by partner (D4 — no subledger second store);
 * the due date is derived from the invoice date + the customer's payment terms.
 */
@Injectable()
export class ArInvoiceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly journals: JournalService,
    private readonly partners: BusinessPartnerService,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  /** Post a customer invoice; idempotent on `postingKey` like every posting (§5.2). */
  async postArInvoice(dto: CreateArInvoiceDto, actor = 'system') {
    const bp = await this.partners.getBp(dto.partnerId);
    if (!bp.customer) {
      throw new BadRequestException(`business partner ${dto.partnerId} has no customer (AR) role`);
    }
    const reconAccount = bp.customer.arReconAccount;

    // Output VAT codes resolved up front (kind + VAT GL account validated; the A10-style NULL
    // gl_account that would have no account to post to is rejected here, before any line is built).
    const taxCodes = await this.resolveTaxCodes(dto.lines, 'OUTPUT');

    // The revenue account comes straight from the document (D — not VKOA). post()/resolveLines
    // validates each line's account exists and blocks a reconciliation account on this partner-less
    // line; the P&L-vs-balance-sheet *type* is intentionally caller-chosen (e.g. a credit memo may
    // target a contra-revenue account), so it is deliberately not gated here.
    let nets: {
      glAccount: string;
      net: Money;
      taxCode?: string;
      costCenterId?: string;
      lineText?: string;
    }[];
    try {
      nets = dto.lines.map((l) => ({
        glAccount: l.revenueAccount,
        net: Money.fromNumeric(l.netAmount, dto.currency, this.registry),
        taxCode: l.taxCode,
        costCenterId: l.costCenterId,
        lineText: l.lineText,
      }));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const tax = buildTaxLines(
      nets.map((n) => ({ net: n.net, taxCode: n.taxCode })),
      taxCodes,
      // D2: kernel-default half-away rounding. The per-counterparty 절사 (truncate) flag is a later
      // master-data column; when it lands it selects 'TRUNCATE' here.
      'HALF_UP',
    );

    // Dr AR recon (gross, with partner) / Cr revenue (per line) / Cr output VAT (per tax code).
    const lines: PostingLine[] = [
      { glAccount: reconAccount, drCr: 'D', money: tax.grandTotal, partnerId: dto.partnerId },
      ...nets.map(
        (n): PostingLine => ({
          glAccount: n.glAccount,
          drCr: 'C',
          money: n.net,
          costCenterId: n.costCenterId,
          taxCode: n.taxCode,
          lineText: n.lineText,
        }),
      ),
      // Drop zero-rated (영세율) VAT lines — the base already rides its revenue line; a 0 GL line is noise.
      ...tax.taxLines
        .filter((t) => !t.tax.isZero())
        .map(
          (t): PostingLine => ({
            glAccount: t.glAccount,
            drCr: 'C',
            money: t.tax,
            taxCode: t.taxCode,
          }),
        ),
    ];

    const posted = await this.journals.post(
      {
        postingKey: dto.postingKey ?? `ar:${randomUUID()}`,
        companyCodeId: dto.companyCodeId,
        postingDate: dto.postingDate,
        documentDate: dto.documentDate,
        docType: DOC_TYPE_AR_INVOICE,
        currency: dto.currency,
        reference: dto.reference,
        headerText: dto.headerText,
        lines,
      },
      actor,
    );

    return {
      ...posted,
      docType: DOC_TYPE_AR_INVOICE,
      reconAccount,
      totalNet: tax.totalNet.toNumeric(),
      totalTax: tax.totalTax.toNumeric(),
      grandTotal: tax.grandTotal.toNumeric(),
      taxLines: tax.taxLines.map((t) => ({
        taxCode: t.taxCode,
        glAccount: t.glAccount,
        ratePercent: t.ratePercent,
        base: t.base.toNumeric(),
        tax: t.tax.toNumeric(),
      })),
    };
  }

  /**
   * Open receivables for a customer: the AR recon-account lines carrying this partner (D4 — the
   * subledger IS the recon lines, no second store). A recon line drops out of the open list once it
   * is settled by a LIVE clearing — i.e. its journal is the source OR target of a `CLEARS` doc_flow
   * edge whose clearing document is still POSTED. This excludes BOTH the cleared invoice line and the
   * clearing document's own offsetting recon line, so a fully-cleared item shows zero open lines; a
   * RESET (the clearing reversed) makes the edge non-live and the item re-opens automatically. Each
   * remaining row gets a derived due date and the running balance nets debits − credits (a reversal
   * still cancels its original to zero).
   */
  async listOpenItems(q: ArOpenItemQuery) {
    const bp = await this.partners.getBp(q.partnerId);
    if (!bp.customer) {
      throw new BadRequestException(`business partner ${q.partnerId} has no customer (AR) role`);
    }
    const reconAccount = bp.customer.arReconAccount;
    const termsDays = bp.customer.paymentTermsDays ?? null;

    const rows = await this.db
      .select({
        journalId: schema.journalEntry.id,
        docNo: schema.journalEntry.docNo,
        docType: schema.journalEntry.docType,
        postingDate: schema.journalEntry.postingDate,
        documentDate: schema.journalEntry.documentDate,
        reference: schema.journalEntry.reference,
        drCr: schema.journalLine.drCr,
        amount: schema.journalLine.amount,
        currency: schema.journalLine.currency,
        lineText: schema.journalLine.lineText,
      })
      .from(schema.journalLine)
      .innerJoin(schema.journalEntry, eq(schema.journalLine.journalEntryId, schema.journalEntry.id))
      .where(
        and(
          eq(schema.journalEntry.companyCodeId, q.companyCodeId),
          eq(schema.journalLine.partnerId, q.partnerId),
          eq(schema.journalLine.glAccount, reconAccount),
          eq(schema.journalLine.isReconAccount, true),
          // Exclude lines settled by a live clearing (both the invoice and the clearing's own
          // offsetting line); a reset (clearing REVERSED) makes the CLEARS edge non-live → re-opens.
          sql`not exists (
            select 1 from doc_flow cdf
            join journal_entry clr on clr.id = cdf.source_id
            where cdf.rel_type = 'CLEARS'
              and clr.status = 'POSTED'
              and (cdf.source_id = ${schema.journalEntry.id} or cdf.target_id = ${schema.journalEntry.id})
          )`,
        ),
      )
      .orderBy(asc(schema.journalEntry.docNo));

    const items = rows.map((r) => ({ ...r, dueDate: deriveDueDate(r.documentDate, termsDays) }));

    // Net open balance: debits raise a receivable, credits (payments/reversals) reduce it.
    let balance: { amount: string; currency: string } | null = null;
    const [head] = items;
    if (head) {
      let bal = Money.zero(head.currency, this.registry);
      for (const it of items) {
        if (it.currency !== head.currency) {
          throw new ConflictException('open items span multiple currencies');
        }
        const m = Money.fromNumeric(it.amount, it.currency, this.registry);
        bal = it.drCr === 'D' ? bal.add(m) : bal.subtract(m);
      }
      balance = { amount: bal.toNumeric(), currency: head.currency };
    }

    return { partnerId: q.partnerId, reconAccount, paymentTermsDays: termsDays, balance, items };
  }

  /** Resolve each referenced tax code to its rate + VAT GL account, asserting kind and account. */
  private async resolveTaxCodes(
    lines: readonly { taxCode?: string }[],
    expectedKind: 'OUTPUT' | 'INPUT',
  ): Promise<Map<string, TaxCodeInfo>> {
    const codes = [...new Set(lines.map((l) => l.taxCode).filter((c): c is string => !!c))];
    const resolved = new Map<string, TaxCodeInfo>();
    for (const code of codes) {
      const [tc] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.code, code));
      if (!tc) throw new BadRequestException(`tax code ${code} not found`);
      if (tc.kind !== expectedKind) {
        throw new BadRequestException(
          `tax code ${code} is ${tc.kind}; an AR (customer) invoice needs ${expectedKind} VAT`,
        );
      }
      if (!tc.glAccount) {
        throw new BadRequestException(`tax code ${code} has no VAT GL account configured`);
      }
      resolved.set(code, { code: tc.code, ratePercent: tc.ratePercent, glAccount: tc.glAccount });
    }
    return resolved;
  }
}
