import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money, type PostingLine } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { DOC_TYPE_AP_INVOICE, JournalService } from '../general-ledger/journal.service.js';
import { buildTaxLines, type TaxCodeInfo } from '../invoice-posting/tax-line-builder.js';
import { deriveDueDate } from '../invoice-posting/due-date.js';
import type { ApOpenItemQuery, CreateApInvoiceDto } from './ap-invoice.dto.js';

/**
 * Accounts-payable invoice posting (finance-accounting.accounts-payable ≈ SAP FB60). A vendor invoice
 * is a `KR` document raised through the SAME `JournalService.post()` (root CLAUDE.md §3.2, D4 — no
 * ap_invoice table) — the mirror of AR:
 *
 *   Dr  expense/inventory account(s) from the DTO (net, per line)  ← D: account from the document
 *   Dr  input VAT account(s) (Σ per-line tax, per tax code)        ← from the tax-line builder (D1/D2)
 *   Cr  AP reconciliation account (gross, + vendor partner)        ← recon substitution from the role
 *
 * Open items are the recon lines filtered by partner; the due date is derived from the invoice date
 * + the vendor's payment terms.
 */
@Injectable()
export class ApInvoiceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly journals: JournalService,
    private readonly partners: BusinessPartnerService,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  /** Post a vendor invoice; idempotent on `postingKey` like every posting (§5.2). */
  async postApInvoice(dto: CreateApInvoiceDto, actor = 'system') {
    const bp = await this.partners.getBp(dto.partnerId);
    if (!bp.vendor) {
      throw new BadRequestException(`business partner ${dto.partnerId} has no vendor (AP) role`);
    }
    const reconAccount = bp.vendor.apReconAccount;

    const taxCodes = await this.resolveTaxCodes(dto.lines, 'INPUT');

    // The expense/inventory account comes straight from the document (D — not VKOA). post() validates
    // existence and recon-safety; the account *type* is intentionally caller-chosen — an AP invoice
    // legitimately debits either an EXPENSE or an inventory ASSET — so it is deliberately not gated here.
    let nets: {
      glAccount: string;
      net: Money;
      taxCode?: string;
      costCenterId?: string;
      lineText?: string;
    }[];
    try {
      nets = dto.lines.map((l) => ({
        glAccount: l.expenseAccount,
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
      // D2: kernel-default half-away rounding; the per-counterparty 절사 flag (later) would pass 'TRUNCATE'.
      'HALF_UP',
    );

    // Dr expense (per line) / Dr input VAT (per tax code) / Cr AP recon (gross, with partner).
    const lines: PostingLine[] = [
      ...nets.map(
        (n): PostingLine => ({
          glAccount: n.glAccount,
          drCr: 'D',
          money: n.net,
          costCenterId: n.costCenterId,
          taxCode: n.taxCode,
          lineText: n.lineText,
        }),
      ),
      ...tax.taxLines
        .filter((t) => !t.tax.isZero())
        .map(
          (t): PostingLine => ({
            glAccount: t.glAccount,
            drCr: 'D',
            money: t.tax,
            taxCode: t.taxCode,
          }),
        ),
      { glAccount: reconAccount, drCr: 'C', money: tax.grandTotal, partnerId: dto.partnerId },
    ];

    const posted = await this.journals.post(
      {
        postingKey: dto.postingKey ?? `ap:${randomUUID()}`,
        companyCodeId: dto.companyCodeId,
        postingDate: dto.postingDate,
        documentDate: dto.documentDate,
        docType: DOC_TYPE_AP_INVOICE,
        currency: dto.currency,
        reference: dto.reference,
        headerText: dto.headerText,
        lines,
      },
      actor,
    );

    return {
      ...posted,
      docType: DOC_TYPE_AP_INVOICE,
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
   * Open payables for a vendor: the AP recon-account lines carrying this partner. A recon line drops
   * out once it is settled by a LIVE clearing — its journal is the source OR target of a `CLEARS`
   * doc_flow edge whose clearing document is still POSTED — which hides BOTH the cleared invoice line
   * and the clearing's own offsetting line (a fully-cleared item shows zero open lines); a RESET
   * re-opens it. Each remaining row gets a derived due date and the balance nets credits − debits (so
   * an unpaid payable reads positive; a reversal cancels its original to zero).
   */
  async listOpenItems(q: ApOpenItemQuery) {
    const bp = await this.partners.getBp(q.partnerId);
    if (!bp.vendor) {
      throw new BadRequestException(`business partner ${q.partnerId} has no vendor (AP) role`);
    }
    const reconAccount = bp.vendor.apReconAccount;
    const termsDays = bp.vendor.paymentTermsDays ?? null;

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

    let balance: { amount: string; currency: string } | null = null;
    const [head] = items;
    if (head) {
      let bal = Money.zero(head.currency, this.registry);
      for (const it of items) {
        if (it.currency !== head.currency) {
          throw new ConflictException('open items span multiple currencies');
        }
        const m = Money.fromNumeric(it.amount, it.currency, this.registry);
        // Credits raise a payable; debits (payments/reversals) reduce it.
        bal = it.drCr === 'C' ? bal.add(m) : bal.subtract(m);
      }
      balance = { amount: bal.toNumeric(), currency: head.currency };
    }

    return { partnerId: q.partnerId, reconAccount, paymentTermsDays: termsDays, balance, items };
  }

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
          `tax code ${code} is ${tc.kind}; an AP (vendor) invoice needs ${expectedKind} VAT`,
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
