import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money, type PostingLine } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';
import { DB } from '../../../database/database.module.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DOC_TYPE_AR_INVOICE, JournalService } from '../../finance-accounting/general-ledger/journal.service.js';
import { buildTaxLines, type TaxCodeInfo } from '../../finance-accounting/invoice-posting/tax-line-builder.js';
import { receiptValue, parseScaled6, formatScaled6 } from '../../inventory-warehouse/inventory/map.js';
import { SalesQueryService } from '../sales-query.service.js';
import { exceedsOpen, openQty6 } from '../open-quantity.js';
import {
  DOC_FLOW_TYPE_BILLING,
  DOC_FLOW_TYPE_BILLING_ITEM,
  DOC_FLOW_TYPE_SO,
  DOC_FLOW_TYPE_SO_ITEM,
  DOC_TYPE_BILLING,
  NUMBER_OBJECT_BILLING,
  REL_BILLS,
} from '../sales.constants.js';
import type { CreateBillingDto } from './billing.dto.js';

export interface PostedBilling {
  billingId: string;
  docNo: string;
  status: 'POSTED';
  /** The `DR` AR open item this billing raised (a journal — D4; open items are its recon lines). */
  journalId: string;
  reconAccount: string;
  totalNet: string;
  totalTax: string;
  grandTotal: string;
  replayed?: boolean;
}

/**
 * Billing (sales.billing = SAP VF01 / FB70) — the MIRROR of `InvoiceVerificationService`. It bills
 * DELIVERED quantities of a SO and raises the AR open item, posting in ONE transaction (§5.2) the
 * billing record and a `DR` customer-invoice journal:
 *
 *   Dr AR recon (+customer)   ← recon substitution from the customer role
 *   Cr revenue (per line)     ← account from the DTO (D — not VKOA); net = billed qty × SO unit price
 *   Cr output VAT (per code)  ← shared tax-line builder; a zero-rated (V00) line drops (0 GL noise)
 *
 * It REUSES the AR single-rate journal path (recon substitution, the tax-line builder, the open-item
 * model) but posts through `JournalService.post(..., { tx })` so the record + journal + lineage commit
 * atomically. Unlike IV it writes **no POSTS edge** onto its journal (the link is the `journal_entry_id`
 * FK instead) so `JournalService.reverse()` can correct it; `billedBySoItem` excludes REVERSED billings.
 * Open-to-bill = Σ delivered − Σ billed (qty). A FOREIGN (export) billing carries a SINGLE document-date
 * rate (post() translates every line) — no functionalAmount override, no realized FX (that arises only
 * at customer-payment clearing). Posted-only + idempotent on `posting_key`.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly journals: JournalService,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly query: SalesQueryService,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  async post(dto: CreateBillingDto, actor = 'system'): Promise<PostedBilling> {
    const computedKey = dto.postingKey ?? `bl:${randomUUID()}`;

    // Idempotency (§5.2): a replay of the same key returns the existing billing's live state.
    const existing = await this.findByKey(dto.companyCodeId, computedKey);
    if (existing) return this.toResult(existing, true);

    // Fail fast if the company is unknown / has no chart of accounts (post() re-validates too).
    await this.getCompany(dto.companyCodeId);
    const [so] = await this.db
      .select()
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.id, dto.salesOrderId));
    if (!so) throw new NotFoundException(`sales order ${dto.salesOrderId} not found`);
    if (so.companyCodeId !== dto.companyCodeId) {
      throw new BadRequestException(`sales order ${so.docNo} belongs to another company code`);
    }
    if (dto.currency !== so.currency) {
      throw new BadRequestException(
        `billing currency ${dto.currency} must equal the SO currency ${so.currency}`,
      );
    }

    const bp = await this.partners.getBp(so.customerBpId);
    if (!bp.customer) {
      throw new BadRequestException(`customer ${so.customerBpId} has no customer (AR) role`);
    }
    const reconAccount = bp.customer.arReconAccount;

    // Resolve the referenced SO items and verify they belong to this SO.
    const soItemIds = dto.items.map((i) => i.salesOrderItemId);
    const soItems = await this.db
      .select()
      .from(schema.salesOrderItem)
      .where(inArray(schema.salesOrderItem.id, soItemIds));
    const soItemById = new Map(soItems.map((r) => [r.id, r]));
    for (const id of soItemIds) {
      const item = soItemById.get(id);
      if (!item) throw new NotFoundException(`sales order item ${id} not found`);
      if (item.salesOrderId !== so.id) {
        throw new BadRequestException(`sales order item ${id} belongs to another sales order`);
      }
    }

    // Open-to-bill guard: a line may bill only Σ delivered − Σ billed (qty). The running map accumulates
    // IN-DOCUMENT billed quantities too, so two lines on one SO item cannot over-bill by each checking
    // the pre-document aggregate alone. `billedBySoItem` is reversal-aware (REVERSED billings re-open).
    const [delivered, billed] = await Promise.all([
      this.query.deliveredBySoItem(soItemIds),
      this.query.billedBySoItem(soItemIds),
    ]);
    const running = new Map<string, bigint>();
    for (const line of dto.items) {
      const soItem = soItemById.get(line.salesOrderItemId)!;
      const limit6 = delivered.get(soItem.id)?.qty6 ?? 0n;
      const prior6 = billed.get(soItem.id)?.qty6 ?? 0n;
      const running6 = running.get(soItem.id) ?? 0n;
      const this6 = parseScaled6(line.qty);
      if (exceedsOpen(limit6, prior6, running6, this6)) {
        throw new BadRequestException(
          `over-billing on SO item line ${soItem.lineNo}: billing ${line.qty} on top of ` +
            `${formatScaled6(prior6 + running6)} exceeds the open-to-bill ` +
            `${formatScaled6(openQty6(limit6, prior6, running6))} (delivered ${formatScaled6(limit6)})`,
        );
      }
      running.set(soItem.id, running6 + this6);
    }

    // Build the billing lines: net = billed qty × the SO line's SALES unit price (document currency);
    // the revenue account comes from the DTO; the tax code inherits from the SO line unless overridden.
    const currency = dto.currency as CurrencyCode;
    const zero = Money.zero(currency, this.registry);
    const nets = dto.items.map((line) => {
      const soItem = soItemById.get(line.salesOrderItemId)!;
      const qty6 = parseScaled6(line.qty);
      const price6 = parseScaled6(soItem.unitPrice);
      return {
        soItem,
        qty6,
        price6,
        net: receiptValue(qty6, price6, zero),
        revenueAccount: line.revenueAccount,
        taxCode: line.taxCode ?? soItem.taxCode ?? undefined,
        lineText: line.lineText,
      };
    });

    const taxCodes = await this.resolveOutputTaxCodes(nets.map((n) => n.taxCode));
    const tax = buildTaxLines(
      nets.map((n) => ({ net: n.net, taxCode: n.taxCode })),
      taxCodes,
      'HALF_UP',
    );

    // Dr AR recon (gross, +customer) / Cr revenue (per line) / Cr output VAT (per code; zero-rated drops).
    const lines: PostingLine[] = [
      { glAccount: reconAccount, drCr: 'D', money: tax.grandTotal, partnerId: so.customerBpId },
      ...nets.map(
        (n): PostingLine => ({
          glAccount: n.revenueAccount,
          drCr: 'C',
          money: n.net,
          taxCode: n.taxCode,
          lineText: n.lineText,
        }),
      ),
      // Drop zero-rated (영세율 V00) VAT lines — the base already rides its revenue line; a 0 GL line is noise.
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

    try {
      return await this.db.transaction(async (tx) => {
        const docNo = await this.numbering.next(NUMBER_OBJECT_BILLING, 'GLOBAL', tx);
        const [header] = await tx
          .insert(schema.billing)
          .values({
            docType: DOC_TYPE_BILLING,
            docNo,
            status: 'POSTED',
            postingKey: computedKey,
            companyCodeId: dto.companyCodeId,
            customerBpId: so.customerBpId,
            salesOrderId: so.id,
            // journalEntryId/exchangeRate are set right after the journal posts, in this same tx.
            reference: dto.reference,
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            currency,
            headerText: dto.headerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.billing.id });
        if (!header) throw new Error('billing insert returned no row');

        // The AR open item — a `DR` journal through the ONE writer, joining THIS tx (§5.2). The single
        // document-date rate is resolved inside post() (a foreign billing); no functionalAmount override
        // and no realized FX (realized FX arises only at customer-payment clearing). Key derives from
        // the billing's own id (the billing header gate is the exactly-once guarantee). NO POSTS edge —
        // the link is the journal_entry_id FK below, so JournalService.reverse() can still correct it.
        const posted = await this.journals.post(
          {
            postingKey: `bl:${header.id}`,
            companyCodeId: dto.companyCodeId,
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            docType: DOC_TYPE_AR_INVOICE,
            currency,
            reference: `${DOC_FLOW_TYPE_BILLING}:${docNo}`,
            headerText: dto.headerText,
            lines,
          },
          actor,
          { tx },
        );

        // The applied document→functional rate post() stamped on the journal (NULL for a domestic billing).
        const [je] = await tx
          .select({ fxRate: schema.journalEntry.fxRate })
          .from(schema.journalEntry)
          .where(eq(schema.journalEntry.id, posted.journalId));
        await tx
          .update(schema.billing)
          .set({ journalEntryId: posted.journalId, exchangeRate: je?.fxRate ?? null })
          .where(eq(schema.billing.id, header.id));

        const insertedItems = await tx
          .insert(schema.billingItem)
          .values(
            nets.map((n, i) => ({
              billingId: header.id,
              lineNo: i + 1,
              salesOrderItemId: n.soItem.id,
              billedQty: formatScaled6(n.qty6),
              unitPrice: formatScaled6(n.price6),
              amount: n.net.toNumeric(),
              revenueAccount: n.revenueAccount,
              currency,
              taxCode: n.taxCode ?? null,
              createdBy: actor,
              updatedBy: actor,
            })),
          )
          .returning({ id: schema.billingItem.id, lineNo: schema.billingItem.lineNo });

        // Lineage in the same tx (§4.3): billing BILLS the SO (header) and each line BILLS its SO item
        // (drill-down). NOT a POSTS edge — the journal must stay FI-reversible.
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_BILLING,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE_SO,
            targetId: so.id,
            relType: REL_BILLS,
          },
          tx,
        );
        const itemIdByLineNo = new Map(insertedItems.map((r) => [r.lineNo, r.id]));
        for (const [i, n] of nets.entries()) {
          const itemId = itemIdByLineNo.get(i + 1);
          if (!itemId) throw new Error('billing_item id missing for line edge');
          await this.docFlow.link(
            {
              sourceType: DOC_FLOW_TYPE_BILLING_ITEM,
              sourceId: itemId,
              targetType: DOC_FLOW_TYPE_SO_ITEM,
              targetId: n.soItem.id,
              relType: REL_BILLS,
            },
            tx,
          );
        }

        return {
          billingId: header.id,
          docNo,
          status: 'POSTED' as const,
          journalId: posted.journalId,
          reconAccount,
          totalNet: tax.totalNet.toNumeric(),
          totalTax: tax.totalTax.toNumeric(),
          grandTotal: tax.grandTotal.toNumeric(),
        };
      });
    } catch (e) {
      // Concurrent duplicate post: the UNIQUE(company, posting_key) gate fired — replay the winner.
      if (isUniqueViolation(e, 'billing_posting_key_uq')) {
        const winner = await this.findByKey(dto.companyCodeId, computedKey);
        if (winner) return this.toResult(winner, true);
      }
      throw e;
    }
  }

  /** Header + items (line order), or 404. */
  async getBilling(id: string) {
    const [header] = await this.db.select().from(schema.billing).where(eq(schema.billing.id, id));
    if (!header) throw new NotFoundException(`billing ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.billingItem)
      .where(eq(schema.billingItem.billingId, id))
      .orderBy(asc(schema.billingItem.lineNo));
    return { ...header, items };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async getCompany(companyCodeId: string) {
    const [company] = await this.db
      .select()
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!company) throw new NotFoundException(`company code ${companyCodeId} not found`);
    if (!company.chartOfAccounts) {
      throw new ConflictException(`company code ${company.code} has no chart of accounts assigned`);
    }
    return { ...company, chartOfAccounts: company.chartOfAccounts };
  }

  /** Resolve each referenced tax code → rate + VAT GL account, asserting it exists and is OUTPUT VAT. */
  private async resolveOutputTaxCodes(
    codes: readonly (string | undefined)[],
  ): Promise<Map<string, TaxCodeInfo>> {
    const unique = [...new Set(codes.filter((c): c is string => !!c))];
    const resolved = new Map<string, TaxCodeInfo>();
    for (const code of unique) {
      const [tc] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.code, code));
      if (!tc) throw new BadRequestException(`tax code ${code} not found`);
      if (tc.kind !== 'OUTPUT') {
        throw new BadRequestException(`tax code ${code} is ${tc.kind}; a billing needs OUTPUT VAT`);
      }
      if (!tc.glAccount) {
        throw new BadRequestException(`tax code ${code} has no VAT GL account configured`);
      }
      resolved.set(code, { code: tc.code, ratePercent: tc.ratePercent, glAccount: tc.glAccount });
    }
    return resolved;
  }

  private async findByKey(companyCodeId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.billing)
      .where(
        and(
          eq(schema.billing.companyCodeId, companyCodeId),
          eq(schema.billing.postingKey, postingKey),
        ),
      );
    return row;
  }

  /** Reconstruct the response from a stored billing (idempotent replay) — totals from the AR journal. */
  private async toResult(
    row: typeof schema.billing.$inferSelect,
    replayed = false,
  ): Promise<PostedBilling> {
    const currency = row.currency as CurrencyCode;
    const zero = Money.zero(currency, this.registry);
    const bp = await this.partners.getBp(row.customerBpId);
    const reconAccount = bp.customer?.arReconAccount ?? '';

    const items = await this.db
      .select({ amount: schema.billingItem.amount })
      .from(schema.billingItem)
      .where(eq(schema.billingItem.billingId, row.id));
    const totalNet = items.reduce(
      (sum, it) => sum.add(Money.fromNumeric(it.amount, currency, this.registry)),
      zero,
    );

    // Gross = the AR recon (debit) line on the posted journal; tax = gross − net.
    let grandTotal = zero;
    if (row.journalEntryId) {
      const [recon] = await this.db
        .select({ amount: schema.journalLine.amount })
        .from(schema.journalLine)
        .where(
          and(
            eq(schema.journalLine.journalEntryId, row.journalEntryId),
            eq(schema.journalLine.isReconAccount, true),
          ),
        );
      if (recon) grandTotal = Money.fromNumeric(recon.amount, currency, this.registry);
    }

    return {
      billingId: row.id,
      docNo: row.docNo,
      status: 'POSTED',
      journalId: row.journalEntryId ?? '',
      reconAccount,
      totalNet: totalNet.toNumeric(),
      totalTax: grandTotal.subtract(totalNet).toNumeric(),
      grandTotal: grandTotal.toNumeric(),
      replayed,
    };
  }
}

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}
