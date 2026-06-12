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
import { AccountDeterminationService } from '../../platform/admin-config/account-determination.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import {
  DOC_FLOW_TYPE as JOURNAL_DOC_FLOW_TYPE,
  DOC_TYPE_AP_INVOICE,
  JournalService,
} from '../../finance-accounting/general-ledger/journal.service.js';
import {
  buildTaxLines,
  type TaxCodeInfo,
} from '../../finance-accounting/invoice-posting/tax-line-builder.js';
import { receiptValue, parseScaled6, formatScaled6 } from '../../inventory-warehouse/inventory/map.js';
import { ProcurementQueryService } from '../procurement-query.service.js';
import {
  DOC_FLOW_TYPE_IV,
  DOC_FLOW_TYPE_PO,
  DOC_TYPE_INVOICE_VERIFICATION,
  NUMBER_OBJECT_IV,
  REALIZED_FX_GAIN_KEY,
  REALIZED_FX_LOSS_KEY,
  REL_INVOICES,
  REL_POSTS,
  WRX_KEY,
} from '../procurement.constants.js';
import { matchThreeWay } from './three-way-match.js';
import type { CreateInvoiceVerificationDto } from './invoice-verification.dto.js';

export interface PostedInvoiceVerification {
  invoiceVerificationId: string;
  docNo: string;
  status: 'POSTED';
  /** The AP open item this IV raised (a `KR` journal — D4, the journal IS the AP document). */
  journalId: string;
  reconAccount: string;
  grIrAccount: string;
  totalNet: string;
  totalTax: string;
  grandTotal: string;
  replayed?: boolean;
}

/**
 * Invoice verification (procurement.invoice-verification = SAP MM-LIV / MIRO). The 3-way match step:
 * it reconciles a vendor invoice against the PO and the goods received, then posts — in ONE
 * transaction (§5.2) — the IV matching record, the AP open item, and the GR/IR relief.
 *
 *   Dr GR/IR clearing (WRX)   ← relieves the goods-received accrual (the GR credited it)
 *   Dr input VAT (per code)   ← shared tax-line builder (D1/D2), reused from AR/AP
 *   Cr AP recon (+vendor)     ← the gross open payable (recon substitution, reused from AP)
 *
 * The AP open item is the `KR` journal itself (D4 — no second store), so the clearing slice (#13)
 * pays it like any vendor invoice. "Reuse #11 AP" = reuse the recon substitution, the tax-line
 * builder, and the open-item model — but post through `JournalService.post(..., { tx })` directly
 * (not `ApInvoiceService`) so the IV record + journal + lineage commit atomically and the debit can
 * target WRX. A `POSTS` doc_flow edge from the IV onto its journal makes that journal subledger-owned
 * (FI reverse refuses it, SAP MR8M-not-FB08 semantics) — corrections are a future IV-cancel that also
 * unwinds the matching record, never a bare GL reversal that would drift GR/IR.
 *
 * Slice scope (Option A): WRX is relieved at the INVOICED net. An exact price match clears GR/IR to
 * zero only when the GR and IV quantities ALIGN; because each partial GR/IV line is valued and
 * rounded independently to the functional minor unit, asymmetric partial splits on a fractional unit
 * price can leave a GR/IR rounding residue (≈½ a minor unit per partial line — a few units across
 * many partials), and an in-tolerance price variance leaves a larger WRX residue (PRD price-difference
 * posting + stock revaluation are a follow-up that clears both). Every journal stays balanced and
 * inventory↔GL recon stays 0 regardless. Domestic, functional-currency only.
 */
@Injectable()
export class InvoiceVerificationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly journals: JournalService,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly accountDetermination: AccountDeterminationService,
    private readonly query: ProcurementQueryService,
    private readonly registry: DbCurrencyRegistry,
    private readonly currencies: CurrencyService,
  ) {}

  async post(
    dto: CreateInvoiceVerificationDto,
    actor = 'system',
  ): Promise<PostedInvoiceVerification> {
    const computedKey = dto.postingKey ?? `iv:${randomUUID()}`;

    // Idempotency (§5.2): a replay of the same key returns the existing IV's live state.
    const existing = await this.findByKey(dto.companyCodeId, computedKey);
    if (existing) return this.toResult(existing, true);

    const company = await this.getCompany(dto.companyCodeId);
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, dto.purchaseOrderId));
    if (!po) throw new NotFoundException(`purchase order ${dto.purchaseOrderId} not found`);
    if (po.companyCodeId !== dto.companyCodeId) {
      throw new BadRequestException(`purchase order ${po.docNo} belongs to another company code`);
    }
    if (dto.currency !== po.currency) {
      throw new BadRequestException(
        `invoice currency ${dto.currency} must equal the PO currency ${po.currency}`,
      );
    }
    // Foreign (import) invoice: WRX is relieved at the GR-date functional value and the rate
    // difference vs the invoice date posts to realized FX (REUSING the clearing-slice #13 pattern).
    // The 3-way match compares foreign price-to-price (FX-neutral, both in the PO/invoice currency).
    const isFx = dto.currency !== company.currency;

    const bp = await this.partners.getBp(po.vendorBpId);
    if (!bp.vendor) {
      throw new BadRequestException(`vendor ${po.vendorBpId} has no vendor (AP) role`);
    }
    const reconAccount = bp.vendor.apReconAccount;

    // The single GR/IR clearing account (WRX, wildcard valuation class — the same account the GR
    // credited, so the pair self-clears). Per-valuation-class GR/IR is a follow-up.
    const grIrAccount = await this.accountDetermination.resolve({
      transactionKey: WRX_KEY,
      chartOfAccounts: company.chartOfAccounts,
      companyCode: company.code,
    });

    // Resolve the referenced PO items and verify they belong to this PO.
    const poItemIds = dto.items.map((i) => i.purchaseOrderItemId);
    const poItems = await this.db
      .select()
      .from(schema.purchaseOrderItem)
      .where(inArray(schema.purchaseOrderItem.id, poItemIds));
    const poItemById = new Map(poItems.map((r) => [r.id, r]));
    for (const id of poItemIds) {
      const item = poItemById.get(id);
      if (!item) throw new NotFoundException(`purchase order item ${id} not found`);
      if (item.purchaseOrderId !== po.id) {
        throw new BadRequestException(`purchase order item ${id} belongs to another purchase order`);
      }
    }

    // 3-way match each line against the DERIVED received / already-invoiced aggregates. The
    // running map accumulates IN-DOCUMENT invoiced quantities too, so two IV lines on the same PO
    // item cannot over-invoice by each checking the pre-document aggregate alone.
    const [received, invoiced] = await Promise.all([
      this.query.receivedByPoItem(poItemIds),
      this.query.invoicedByPoItem(poItemIds),
    ]);
    const violations: string[] = [];
    const running = new Map<string, bigint>();
    for (const line of dto.items) {
      const poItem = poItemById.get(line.purchaseOrderItemId)!;
      const this6 = parseScaled6(line.invoicedQty);
      const result = matchThreeWay({
        poUnitPrice6: parseScaled6(poItem.unitPrice),
        receivedQty6: received.get(poItem.id)?.qty6 ?? 0n,
        invoicedQty6: (invoiced.get(poItem.id)?.qty6 ?? 0n) + (running.get(poItem.id) ?? 0n),
        thisInvoicedQty6: this6,
        thisInvoiceUnitPrice6: parseScaled6(line.invoiceUnitPrice),
      });
      if (!result.ok) {
        violations.push(`PO item line ${poItem.lineNo}: ${result.reasons.join('; ')}`);
      }
      running.set(poItem.id, (running.get(poItem.id) ?? 0n) + this6);
    }
    if (violations.length > 0) {
      throw new BadRequestException(`3-way match failed — ${violations.join(' | ')}`);
    }

    // Foreign (import) IV v1 = FULL match only: each PO item invoiced once, in full, so the WRX
    // relief is the WHOLE GR-booked functional value (no partial-rate apportioning). Partial /
    // multi-document foreign IV (and the proportional WRX relief it needs) is a later slice.
    if (isFx) {
      if (new Set(poItemIds).size !== poItemIds.length) {
        throw new BadRequestException(
          'a foreign-currency invoice may reference each PO item once (partial/multi-line foreign IV is a later slice)',
        );
      }
      for (const line of dto.items) {
        const poItem = poItemById.get(line.purchaseOrderItemId)!;
        const recv = received.get(poItem.id);
        const prior = invoiced.get(poItem.id);
        if (!recv || recv.qty6 === 0n) {
          throw new BadRequestException(
            `nothing received against PO item line ${poItem.lineNo} to invoice`,
          );
        }
        if (prior && prior.qty6 > 0n) {
          throw new BadRequestException(
            `PO item line ${poItem.lineNo} is already partly invoiced — a foreign-currency IV must ` +
              `fully match in one document (partial foreign IV is a later slice)`,
          );
        }
        if (parseScaled6(line.invoicedQty) !== recv.qty6) {
          throw new BadRequestException(
            `a foreign-currency IV must invoice the full received quantity ` +
              `${formatScaled6(recv.qty6)} on PO item line ${poItem.lineNo} (partial foreign IV is a later slice)`,
          );
        }
      }
    }

    // Build the invoice lines: each invoiced net (qty × invoice price) debits GR/IR; the tax-line
    // builder aggregates input VAT per code; the gross credits the AP recon (with the vendor partner).
    const currency = dto.currency as CurrencyCode;
    const zero = Money.zero(currency, this.registry);
    const nets = dto.items.map((line) => {
      const poItem = poItemById.get(line.purchaseOrderItemId)!;
      const qty6 = parseScaled6(line.invoicedQty);
      const price6 = parseScaled6(line.invoiceUnitPrice);
      return {
        poItem,
        qty6,
        price6,
        net: receiptValue(qty6, price6, zero),
        taxCode: line.taxCode ?? poItem.taxCode ?? undefined,
      };
    });

    const taxCodes = await this.resolveTaxCodes(nets.map((n) => n.taxCode));
    const tax = buildTaxLines(
      nets.map((n) => ({ net: n.net, taxCode: n.taxCode })),
      taxCodes,
      'HALF_UP',
    );

    const wrxLine = (n: (typeof nets)[number], functionalAmount?: Money): PostingLine => ({
      glAccount: grIrAccount,
      drCr: 'D',
      money: n.net,
      functionalAmount,
      taxCode: n.taxCode,
      lineText: `GR/IR ${formatScaled6(n.qty6)} @ ${poItemRef(n.poItem.lineNo)}`,
    });

    // Domestic (KRW==KRW): byte-identical to the pre-FX path (no functional override, rate NULL, no
    // FX line). Foreign (import): relieve WRX at the GR-date functional value, translate VAT + AP at
    // the invoice-date rate, and route the functional residue to realized FX (the clearing #13 pattern).
    let exchangeRate: string | null = null;
    let fxRate: string | undefined;
    let lines: PostingLine[];

    if (!isFx) {
      lines = [
        ...nets.map((n) => wrxLine(n)),
        ...tax.taxLines
          .filter((t) => !t.tax.isZero())
          .map((t): PostingLine => ({ glAccount: t.glAccount, drCr: 'D', money: t.tax, taxCode: t.taxCode })),
        { glAccount: reconAccount, drCr: 'C', money: tax.grandTotal, partnerId: po.vendorBpId },
      ];
    } else {
      const functionalCurrency = company.currency as CurrencyCode;
      const resolved = await this.currencies.resolveRate(currency, functionalCurrency, dto.documentDate, 'M');
      fxRate = resolved.rate;
      exchangeRate = resolved.rate;

      // WRX relief = the WHOLE GR-booked functional value of the received quantity (full match), so GR
      // (credit) and IV (debit) net to exactly zero in the functional currency — the FX delta is
      // isolated outside WRX. VAT + AP translate at the invoice-date rate.
      const businessLines: PostingLine[] = [
        ...nets.map((n) => {
          const recv = received.get(n.poItem.id);
          if (!recv) {
            throw new BadRequestException(
              `nothing received against PO item line ${n.poItem.lineNo} to invoice`,
            );
          }
          return wrxLine(n, Money.fromNumeric(recv.amount, functionalCurrency, this.registry));
        }),
        ...tax.taxLines
          .filter((t) => !t.tax.isZero())
          .map(
            (t): PostingLine => ({
              glAccount: t.glAccount,
              drCr: 'D',
              money: t.tax,
              functionalAmount: t.tax.convert(resolved.rate, functionalCurrency, this.registry),
              taxCode: t.taxCode,
            }),
          ),
        {
          glAccount: reconAccount,
          drCr: 'C',
          money: tax.grandTotal,
          functionalAmount: tax.grandTotal.convert(resolved.rate, functionalCurrency, this.registry),
          partnerId: po.vendorBpId,
        },
      ];

      // Realized FX residue (functional), on the short side → gain (credit) / loss (debit). Computed
      // from the ACTUAL line functional amounts, so the entry ties out in both currencies and post()'s
      // FX_ROUNDING auto-plug never fires (every line carries its functionalAmount override).
      const sideFunc = (drCr: 'D' | 'C'): bigint =>
        businessLines
          .filter((l) => l.drCr === drCr)
          .reduce((sum, l) => sum + (l.functionalAmount?.minorUnits ?? 0n), 0n);
      const residue = sideFunc('D') - sideFunc('C');
      lines = [...businessLines];
      if (residue !== 0n) {
        const realizedAccount = await this.accountDetermination.resolve({
          transactionKey: residue > 0n ? REALIZED_FX_GAIN_KEY : REALIZED_FX_LOSS_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        });
        const magnitude = residue > 0n ? residue : -residue;
        lines.push({
          glAccount: realizedAccount,
          drCr: residue > 0n ? 'C' : 'D',
          money: Money.zero(currency, this.registry),
          functionalAmount: Money.fromMinorUnits(magnitude, functionalCurrency, this.registry),
        });
      }
    }

    try {
      return await this.db.transaction(async (tx) => {
        const docNo = await this.numbering.next(NUMBER_OBJECT_IV, 'GLOBAL', tx);
        const [header] = await tx
          .insert(schema.invoiceVerification)
          .values({
            docType: DOC_TYPE_INVOICE_VERIFICATION,
            docNo,
            status: 'POSTED',
            postingKey: computedKey,
            companyCodeId: dto.companyCodeId,
            vendorBpId: po.vendorBpId,
            purchaseOrderId: po.id,
            reference: dto.reference,
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            currency,
            // Applied document→functional 'M' rate for an import invoice (NULL for domestic).
            exchangeRate,
            headerText: dto.headerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.invoiceVerification.id });
        if (!header) throw new Error('invoice_verification insert returned no row');

        await tx.insert(schema.invoiceVerificationItem).values(
          nets.map((n, i) => ({
            invoiceVerificationId: header.id,
            lineNo: i + 1,
            purchaseOrderItemId: n.poItem.id,
            invoicedQty: formatScaled6(n.qty6),
            invoiceUnitPrice: formatScaled6(n.price6),
            amount: n.net.toNumeric(),
            currency,
            taxCode: n.taxCode ?? null,
            createdBy: actor,
            updatedBy: actor,
          })),
        );

        // The AP open item — a KR journal through the ONE writer, joining THIS tx (§5.2). Its key is
        // derived from the IV's own id (the IV header gate is the exactly-once guarantee).
        const posted = await this.journals.post(
          {
            postingKey: `iv:${header.id}`,
            companyCodeId: dto.companyCodeId,
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            docType: DOC_TYPE_AP_INVOICE,
            currency,
            // Foreign import invoice: the resolved invoice-date rate (undefined ⇒ domestic KRW path).
            fxRate,
            reference: `${DOC_FLOW_TYPE_IV}:${docNo}`,
            headerText: dto.headerText,
            lines,
          },
          actor,
          { tx },
        );

        // Lineage in the same tx: IV INVOICES the PO; IV POSTS its AP journal (the POSTS edge makes
        // that journal subledger-owned → FI reverse refused).
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_IV,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE_PO,
            targetId: po.id,
            relType: REL_INVOICES,
          },
          tx,
        );
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_IV,
            sourceId: header.id,
            targetType: JOURNAL_DOC_FLOW_TYPE,
            targetId: posted.journalId,
            relType: REL_POSTS,
          },
          tx,
        );

        return {
          invoiceVerificationId: header.id,
          docNo,
          status: 'POSTED' as const,
          journalId: posted.journalId,
          reconAccount,
          grIrAccount,
          totalNet: tax.totalNet.toNumeric(),
          totalTax: tax.totalTax.toNumeric(),
          grandTotal: tax.grandTotal.toNumeric(),
        };
      });
    } catch (e) {
      // Concurrent duplicate post: the UNIQUE(company, posting_key) gate fired — replay the winner.
      if (isUniqueViolation(e, 'invoice_verification_posting_key_uq')) {
        const winner = await this.findByKey(dto.companyCodeId, computedKey);
        if (winner) return this.toResult(winner, true);
      }
      throw e;
    }
  }

  /** Header + items (line order), or 404. `journalId` from the POSTS doc_flow edge. */
  async getInvoiceVerification(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.invoiceVerification)
      .where(eq(schema.invoiceVerification.id, id));
    if (!header) throw new NotFoundException(`invoice verification ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.invoiceVerificationItem)
      .where(eq(schema.invoiceVerificationItem.invoiceVerificationId, id))
      .orderBy(asc(schema.invoiceVerificationItem.lineNo));
    return { ...header, items, journalId: await this.journalIdOf(id) };
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

  /** Resolve INPUT VAT codes (vendor invoice) the IV lines reference. */
  private async resolveTaxCodes(
    codes: readonly (string | undefined)[],
  ): Promise<Map<string, TaxCodeInfo>> {
    const unique = [...new Set(codes.filter((c): c is string => !!c))];
    const resolved = new Map<string, TaxCodeInfo>();
    for (const code of unique) {
      const [tc] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.code, code));
      if (!tc) throw new BadRequestException(`tax code ${code} not found`);
      if (tc.kind !== 'INPUT') {
        throw new BadRequestException(`tax code ${code} is ${tc.kind}; invoice verification needs INPUT VAT`);
      }
      if (!tc.glAccount) {
        throw new BadRequestException(`tax code ${code} has no VAT GL account configured`);
      }
      resolved.set(code, { code: tc.code, ratePercent: tc.ratePercent, glAccount: tc.glAccount });
    }
    return resolved;
  }

  private async journalIdOf(invoiceVerificationId: string): Promise<string | null> {
    const edges = await this.docFlow.forward(DOC_FLOW_TYPE_IV, invoiceVerificationId);
    return edges.find((e) => e.relType === REL_POSTS)?.targetId ?? null;
  }

  private async findByKey(companyCodeId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.invoiceVerification)
      .where(
        and(
          eq(schema.invoiceVerification.companyCodeId, companyCodeId),
          eq(schema.invoiceVerification.postingKey, postingKey),
        ),
      );
    return row;
  }

  /** Reconstruct the response from a stored IV (idempotent replay) — totals from the AP journal. */
  private async toResult(
    row: typeof schema.invoiceVerification.$inferSelect,
    replayed = false,
  ): Promise<PostedInvoiceVerification> {
    const currency = row.currency as CurrencyCode;
    const zero = Money.zero(currency, this.registry);
    const journalId = await this.journalIdOf(row.id);

    const items = await this.db
      .select({ amount: schema.invoiceVerificationItem.amount })
      .from(schema.invoiceVerificationItem)
      .where(eq(schema.invoiceVerificationItem.invoiceVerificationId, row.id));
    const totalNet = items.reduce(
      (sum, it) => sum.add(Money.fromNumeric(it.amount, currency, this.registry)),
      zero,
    );

    const company = await this.getCompany(row.companyCodeId);
    const grIrAccount = await this.accountDetermination.resolve({
      transactionKey: WRX_KEY,
      chartOfAccounts: company.chartOfAccounts,
      companyCode: company.code,
    });
    const bp = await this.partners.getBp(row.vendorBpId);
    const reconAccount = bp.vendor?.apReconAccount ?? '';

    // Gross = the AP recon (credit) line on the posted journal; tax = gross − net.
    let grandTotal = zero;
    if (journalId) {
      const [recon] = await this.db
        .select({ amount: schema.journalLine.amount })
        .from(schema.journalLine)
        .where(
          and(
            eq(schema.journalLine.journalEntryId, journalId),
            eq(schema.journalLine.isReconAccount, true),
          ),
        );
      if (recon) grandTotal = Money.fromNumeric(recon.amount, currency, this.registry);
    }

    return {
      invoiceVerificationId: row.id,
      docNo: row.docNo,
      status: 'POSTED',
      journalId: journalId ?? '',
      reconAccount,
      grIrAccount,
      totalNet: totalNet.toNumeric(),
      totalTax: grandTotal.subtract(totalNet).toNumeric(),
      grandTotal: grandTotal.toNumeric(),
      replayed,
    };
  }
}

const poItemRef = (lineNo: number): string => `PO#${lineNo}`;

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}
