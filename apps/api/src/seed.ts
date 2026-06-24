import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { schema, type Database } from '@erp/db';
import { AppModule } from './app.module.js';
import { DB } from './database/database.module.js';
import { UsersService } from './domains/platform/auth/users.service.js';
import { RbacService } from './domains/platform/rbac/rbac.service.js';
import { NumberingService } from './domains/platform/numbering/numbering.service.js';
import { OrgStructureService } from './domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from './domains/platform/admin-config/fiscal-period.service.js';
import { AccountDeterminationService } from './domains/platform/admin-config/account-determination.service.js';
import { CurrencyService } from './domains/master-data/currency/currency.service.js';
import { GlAccountService } from './domains/master-data/gl-account/gl-account.service.js';
import { TaxCodeService } from './domains/master-data/tax-code/tax-code.service.js';
import { CostCenterService } from './domains/master-data/cost-center/cost-center.service.js';
import { BusinessPartnerService } from './domains/master-data/business-partner/business-partner.service.js';
import { MaterialService } from './domains/master-data/material/material.service.js';
import { MaterialValuationService } from './domains/inventory-warehouse/inventory/material-valuation.service.js';

/**
 * Idempotent dev seed: creates an ADMIN role (permission `*`), an admin user, and a couple of demo
 * number ranges. Run after migrations:  pnpm --filter @erp/api seed
 * Configure via ADMIN_USERNAME / ADMIN_PASSWORD (defaults admin / admin123 — change in real envs).
 */
async function seed(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const users = app.get(UsersService);
    const rbac = app.get(RbacService);
    const numbering = app.get(NumberingService);
    const org = app.get(OrgStructureService);
    const fiscal = app.get(FiscalPeriodService);
    const accounts = app.get(AccountDeterminationService);
    const currencies = app.get(CurrencyService);
    const glAccounts = app.get(GlAccountService);
    const taxCodes = app.get(TaxCodeService);
    const costCenters = app.get(CostCenterService);
    const partners = app.get(BusinessPartnerService);
    const materials = app.get(MaterialService);
    const valuations = app.get(MaterialValuationService);
    const db = app.get<Database>(DB);

    const username = process.env.ADMIN_USERNAME ?? 'admin';
    const password = process.env.ADMIN_PASSWORD ?? 'admin123';

    const userId = await users.createUser({
      username,
      password,
      displayName: 'Administrator',
    });
    const roleId = await rbac.ensureRole('ADMIN', 'Administrator', 'Full system access');
    await rbac.grantPermission(roleId, '*');
    await rbac.assignRole(userId, roleId);

    await numbering.defineRange({
      object: 'sales.sales_order',
      prefix: 'SO-',
      padding: 6,
    });
    await numbering.defineRange({
      object: 'procurement.purchase_order',
      prefix: 'PO-',
      padding: 6,
    });
    // FI journal numbers reset per fiscal year (scope = year; the year also rides the prefix
    // because scope only partitions the counter, it is not rendered). New year → new range.
    await numbering.defineRange({
      object: 'finance.journal_entry',
      scope: '2026',
      prefix: 'JE-2026-',
      padding: 6,
    });
    // AR/AP invoices own their document number ranges (SAP-style per-doc-type), scoped per year.
    await numbering.defineRange({
      object: 'finance.ar_invoice',
      scope: '2026',
      prefix: 'DR-2026-',
      padding: 6,
    });
    await numbering.defineRange({
      object: 'finance.ap_invoice',
      scope: '2026',
      prefix: 'KR-2026-',
      padding: 6,
    });
    // AR/AP clearing (payment) documents own their ranges too (SAP DZ/KZ), scoped per year.
    await numbering.defineRange({
      object: 'finance.ar_clearing',
      scope: '2026',
      prefix: 'DZ-2026-',
      padding: 6,
    });
    await numbering.defineRange({
      object: 'finance.ap_clearing',
      scope: '2026',
      prefix: 'KZ-2026-',
      padding: 6,
    });
    // Goods movements own their document range (SAP material document essence), scoped per year.
    await numbering.defineRange({
      object: 'inventory.goods_movement',
      scope: '2026',
      prefix: 'GM-2026-',
      padding: 6,
    });
    // Invoice-verification (procurement LIV) documents own a range (global-scoped, like the PO range;
    // the AP open item they raise draws the finance.ap_invoice KR range).
    await numbering.defineRange({
      object: 'procurement.invoice_verification',
      prefix: 'IV-',
      padding: 6,
    });
    // Landed-cost (수입 부대비용 재고원가 배부 + 수입부가세) documents own a global-scoped range; the AP
    // open item they raise draws the finance.ap_invoice KR range (docType KR).
    await numbering.defineRange({
      object: 'procurement.landed_cost',
      prefix: 'LC-',
      padding: 6,
    });
    // Sales billing (SD) documents own a global-scoped range (like the SO range); the AR open item they
    // raise draws the finance.ar_invoice DR range (docType DR). The delivery/GI rides the GM-<year>
    // goods-movement range. v1 is 2026-only — a new year needs the DR/JE/GM year ranges (re-)seeded.
    await numbering.defineRange({
      object: 'sales.billing',
      prefix: 'BL-',
      padding: 6,
    });
    // Physical-inventory (재고 실사) count documents own a global-scoped range (like SO-/BL-): the doc
    // is a header counting document. The 701/702 stock adjustment it spawns rides the GM-<year>
    // goods-movement range, so no new GM range is needed.
    await numbering.defineRange({
      object: 'inventory.physical_inventory',
      prefix: 'PI-',
      padding: 6,
    });
    // Export declaration (수출신고) owns a global-scoped range (ED-NNNNNN). The internal doc_no is distinct
    // from the externally-issued 수출신고번호/MRN (UNI-PASS), which is captured as a manual string field.
    await numbering.defineRange({
      object: 'trade.export_declaration',
      prefix: 'ED-',
      padding: 6,
    });
    // Import declaration (수입신고) owns a global-scoped range (IM-NNNNNN), symmetric to ED-. doc_type/prefix
    // stay aligned (IM / IM-); the externally-issued 수입신고번호/MRN is a separate manual string field. The
    // declaration posts NOTHING (landed cost owns import accounting) — only this range is needed.
    await numbering.defineRange({
      object: 'trade.import_declaration',
      prefix: 'IM-',
      padding: 6,
    });
    // Duty-drawback (관세환급, 간이정액) claim owns a global-scoped range (DD-NNNNNN), like ED-/IM-. Unlike the
    // declarations it IS a posting document (approve → Dr 관세환급금 미수금 / Cr 관세환급수익), but the claim
    // number range is identical in shape; the journal draws its own JE- number.
    await numbering.defineRange({
      object: 'trade.drawback_claim',
      prefix: 'DD-',
      padding: 6,
    });

    // Demo enterprise structure: company 1000 (KRW) → plant 1010 → storage location 101A,
    // plus a sales + purchasing org. Idempotent, so the seed stays re-runnable.
    const companyCodeId = await org.ensureCompanyCode({
      code: '1000',
      name: 'Heyday Trading Co., Ltd.',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    const plantId = await org.ensurePlant({
      code: '1010',
      name: 'Seoul Main Plant',
      companyCodeId,
      country: 'KR',
      city: 'Seoul',
    });
    await org.ensureStorageLocation({
      code: '101A',
      name: 'Main Warehouse',
      plantId,
    });
    await org.ensureSalesOrg({
      code: '1000',
      name: 'Domestic Sales',
      companyCodeId,
      currency: 'KRW',
    });
    await org.ensurePurchasingOrg({
      code: '1000',
      name: 'Central Purchasing',
      companyCodeId,
    });

    // Admin-config: fiscal year 2026 (12 OPEN periods) + account-determination rules for the
    // SD-billing posting (AR / sales revenue / output VAT). Idempotent.
    await fiscal.generateYear(companyCodeId, 2026);
    for (const rule of [
      { transactionKey: 'AR', glAccount: '1100' }, // 외상매출금
      { transactionKey: 'SALES_REVENUE', glAccount: '4000' }, // 제품매출
      { transactionKey: 'OUTPUT_VAT', glAccount: '2550' }, // 부가세예수금
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' }, // 외환차손익 (FX 라인별 환산 단수차이 plug)
      // Clearing slice: cash/bank clearing account + REALIZED FX gain/loss (economic, NOT the KDR plug).
      { transactionKey: 'BANK_CLEARING', glAccount: '1010' }, // 현금클리어링 (결제가 닿는 계정)
      { transactionKey: 'REALIZED_FX_GAIN', glAccount: '9810' }, // 외환차익 (실현)
      { transactionKey: 'REALIZED_FX_LOSS', glAccount: '9820' }, // 외환차손 (실현)
      // Inventory slice (§4.5): BSX = stock account / GBB = offsetting account, discriminated by
      // valuation class (3000 raw materials · 7920 finished goods — SAP convention).
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' }, // 원재료
      { transactionKey: 'BSX', valuationClass: '7920', glAccount: '1310' }, // 제품
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' }, // 원재료비(상대)
      { transactionKey: 'GBB', valuationClass: '7920', glAccount: '5110' }, // 제품재고변동(상대)
      // Procurement slice (§4.5): WRX = GR/IR clearing (입고미착). One account (wildcard valuation
      // class) so a GR credit and the matching IV debit hit the SAME account → the pair self-clears.
      { transactionKey: 'WRX', glAccount: '2110' }, // 입고미착 (GR/IR clearing)
      // Landed-cost slice (§4.5): PRD = 재고원가차이. Landed cost arriving after stock was issued
      // capitalizes only the on-hand share onto BSX; the already-issued (uncovered) share is expensed
      // here. The capitalized share itself reuses the BSX determination above (no new stock account).
      { transactionKey: 'PRD', glAccount: '5900' }, // 재고원가차이 (uncovered landed cost / price diff)
      // Sales slice (§4.5): COGS = 매출원가, the GI (delivery 601) offset. A SINGLE WILDCARD rule (no
      // valuation_class) — the COGS account is the same regardless of valuation class this slice; the
      // BSX (stock) leg still resolves per valuation class above. Without it a sales GI throws (no rule).
      { transactionKey: 'COGS', glAccount: '5200' }, // 매출원가 (sales goods-issue offset)
      // Physical-inventory slice (§4.5): IDI = 재고조정손익, the 실사 adjustment (701 gain / 702 loss)
      // offset. A SINGLE WILDCARD rule (no valuation_class) — one account holds both directions
      // (701: Dr BSX / Cr IDI, 702: Dr IDI / Cr BSX); the BSX (stock) leg still resolves per valuation
      // class. Distinct from PRD (5900 재고원가차이): physical-count gain/loss is ledger-separable from
      // landed-cost price differences. Without it a 701/702 with a non-zero diff throws (no rule).
      { transactionKey: 'IDI', glAccount: '5910' }, // 재고조정손익 (physical-inventory adjustment offset)
      // Duty-drawback slice (§4.5): the approve() journal Dr 관세환급금 미수금 / Cr 관세환급수익. The FIRST
      // posting in trade-compliance — both accounts resolved here (never hard-coded, CLAUDE.md §4.5).
      { transactionKey: 'DUTY_DRAWBACK_RECEIVABLE', glAccount: '1140' }, // 관세환급금미수금
      { transactionKey: 'DUTY_DRAWBACK_INCOME', glAccount: '9830' }, // 관세환급수익 (영업외수익)
    ]) {
      await accounts.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    // Master data: currencies (with exact minor units), demo fx rates, the KR01 GL accounts the
    // determination rules above resolve to, VAT codes, and a cost center. Idempotent.
    for (const cur of [
      { code: 'KRW', name: 'South Korean Won', minorUnit: 0, symbol: '₩' },
      { code: 'USD', name: 'US Dollar', minorUnit: 2, symbol: '$' },
      { code: 'EUR', name: 'Euro', minorUnit: 2, symbol: '€' },
      { code: 'CNY', name: 'Chinese Yuan', minorUnit: 2, symbol: '¥' },
      { code: 'JPY', name: 'Japanese Yen', minorUnit: 0, symbol: '¥' },
    ]) {
      await currencies.ensureCurrency(cur);
    }
    // Foreign→KRW only: translation never reciprocates a stored rate, so a KRW→foreign document
    // would need its own directional row added here (none yet — all demo FX documents are into KRW).
    for (const fx of [
      { fromCurrency: 'USD', toCurrency: 'KRW', rate: '1350.000000' },
      { fromCurrency: 'EUR', toCurrency: 'KRW', rate: '1450.000000' },
      { fromCurrency: 'CNY', toCurrency: 'KRW', rate: '190.000000' },
      { fromCurrency: 'JPY', toCurrency: 'KRW', rate: '9.000000' },
    ]) {
      await currencies.ensureFxRate({ rateType: 'M', validFrom: '2026-01-01', ...fx });
    }
    for (const acc of [
      { accountNumber: '1000', name: '현금및현금성자산', accountType: 'ASSET' as const },
      {
        accountNumber: '1100',
        name: '외상매출금',
        accountType: 'ASSET' as const,
        isReconciliation: true,
      },
      // 부가세대급금 (input VAT receivable) — the AP invoice debits this; tax code A10 posts to it.
      { accountNumber: '1350', name: '부가세대급금', accountType: 'ASSET' as const },
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      { accountNumber: '2550', name: '부가세예수금', accountType: 'LIABILITY' as const },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      // 상품매입 — the AP (vendor) invoice debits this expense; AR credits revenue 4000.
      { accountNumber: '5000', name: '상품매입', accountType: 'EXPENSE' as const },
      // 외환차손익 — FX_ROUNDING per-line translation plug. currency intentionally omitted (null =
      // postable in any currency) so the 0-amount foreign line is not rejected (FX caution #1).
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
      // Clearing slice accounts (all currency = null by omission, like 9800): the cash/clearing
      // account the payment hits, and the REALIZED FX gain/loss accounts (their gain/loss line is
      // 0 in the foreign document currency, so a currency-pinned account would reject it).
      { accountNumber: '1010', name: '현금클리어링', accountType: 'ASSET' as const },
      { accountNumber: '9810', name: '외환차익', accountType: 'REVENUE' as const },
      { accountNumber: '9820', name: '외환차손', accountType: 'EXPENSE' as const },
      // Inventory slice: BSX stock accounts + GBB offsets the determination rules resolve to.
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '1310', name: '제품', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5110', name: '제품재고변동', accountType: 'EXPENSE' as const },
      // Procurement slice: GR/IR clearing (입고미착). currency null (omitted) like other clearing
      // accounts — a GR credits it at PO price, the IV debits it; matched on aligned splits it nets
      // to zero (asymmetric partials on a fractional price leave rounding dust — see procurement).
      { accountNumber: '2110', name: '입고미착', accountType: 'LIABILITY' as const },
      // Landed-cost slice: 재고원가차이 (PRD) — the uncovered landed-cost share (stock already issued)
      // is expensed here. currency null (omitted) like the other clearing/diff accounts, so a foreign
      // cost invoice's document-currency PRD line is not rejected.
      { accountNumber: '5900', name: '재고원가차이', accountType: 'EXPENSE' as const },
      // Sales slice: 매출원가 (COGS) — the sales GI (delivery 601) debits this at the current MAP value.
      { accountNumber: '5200', name: '매출원가', accountType: 'EXPENSE' as const },
      // Physical-inventory slice: 재고조정손익 (IDI) — the 실사 adjustment offset, both directions (701
      // gain credits it / 702 loss debits it) at the current MAP. currency null (omitted) like the other
      // diff accounts. Separate from 5900 재고원가차이 (PRD) so count gain/loss is ledger-separable.
      { accountNumber: '5910', name: '재고조정손익', accountType: 'EXPENSE' as const },
      // Duty-drawback slice: 관세환급금미수금 (current-asset receivable, 11xx band) — the approve() Dr leg.
      // NON-reconciliation this slice (관세청 is not a BP; the 입금 클리어링 slice revisits this) so the posting
      // line needs no partner_id.
      { accountNumber: '1140', name: '관세환급금미수금', accountType: 'ASSET' as const },
      // 관세환급수익 (영업외수익, 98xx band beside 9810 외환차익) — the approve() Cr leg.
      { accountNumber: '9830', name: '관세환급수익', accountType: 'REVENUE' as const },
    ]) {
      await glAccounts.ensureGlAccount({
        chartOfAccounts: 'KR01',
        isReconciliation: false,
        ...acc,
      });
    }
    for (const tax of [
      {
        code: 'V10',
        name: '매출 부가세 10%',
        kind: 'OUTPUT' as const,
        ratePercent: '10',
        glAccount: '2550',
      },
      {
        code: 'A10',
        name: '매입 부가세 10%',
        kind: 'INPUT' as const,
        ratePercent: '10',
        glAccount: '1350',
      },
      // Import VAT (수입부가세) — customs-paid on the 수입세금계산서; the amount is supplied directly
      // (base = CIF + 관세), NOT derived from net × rate, but the code carries the 부가세대급금 GL +
      // the 10% classification for 매입세액공제 reporting.
      {
        code: 'I10',
        name: '수입 부가세 (수입세금계산서)',
        kind: 'INPUT' as const,
        ratePercent: '10',
        glAccount: '1350',
      },
      // Sales zero-rate (영세율) — exports AND 내국신용장/구매확인서 domestic supplies. OUTPUT kind, 0% so
      // the VAT journal line drops (the base rides its revenue line). The trade direction never picks it;
      // it is assigned explicitly per SO line (§5). 2550 is carried for 매출처별세금계산서합계표 reporting.
      {
        code: 'V00',
        name: '매출 영세율 (수출/내국신용장)',
        kind: 'OUTPUT' as const,
        ratePercent: '0',
        glAccount: '2550',
      },
    ]) {
      await taxCodes.ensureTaxCode(tax);
    }
    await costCenters.ensureCostCenter({
      code: '1000',
      name: 'Administration',
      companyCodeId,
      validFrom: '2026-01-01',
    });

    // Business partners: a customer (AR recon 1100) and a vendor (AP recon 2100). Idempotent.
    const customerBpId = await partners.ensureBp({
      code: 'C1000',
      name: 'Acme Retail Co., Ltd.',
      bpType: 'ORGANIZATION',
      country: 'KR',
      city: 'Seoul',
    });
    await partners.ensureCustomerRole(customerBpId, {
      arReconAccount: '1100',
      creditLimit: '50000000.0000',
      creditCurrency: 'KRW',
      paymentTermsDays: 30,
      salesBlock: false,
    });
    const vendorBpId = await partners.ensureBp({
      code: 'V2000',
      name: 'Shenzhen Components Ltd.',
      bpType: 'ORGANIZATION',
      country: 'CN',
      city: 'Shenzhen',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 45,
      purchasingBlock: false,
    });

    // Materials: a finished good (with trade/HS data) and a raw material. Idempotent.
    const finishedId = await materials.ensureMaterial({
      code: 'FG-1000',
      name: 'Wireless Keyboard K1',
      materialType: 'FINISHED',
      baseUom: 'EA',
      materialGroup: 'ELEC',
      netWeight: '0.450000',
      weightUnit: 'KG',
    });
    await materials.ensureTradeData(finishedId, {
      hsCode: '8471606000',
      countryOfOrigin: 'KR',
    });
    const rawId = await materials.ensureMaterial({
      code: 'RM-2000',
      name: 'ABS Resin Pellet',
      materialType: 'RAW',
      baseUom: 'KG',
      materialGroup: 'CHEM',
    });

    // Inventory accounting views (§4.4 extension): the valuation row must exist BEFORE the first
    // goods movement (the movement engine locks it to serialize MAP recalculation). Idempotent.
    await valuations.ensureValuation({
      materialId: finishedId,
      plantId,
      valuationClass: '7920',
    });
    await valuations.ensureValuation({
      materialId: rawId,
      plantId,
      valuationClass: '3000',
    });

    // Duty-drawback (간이정액) demo 환급률표: 원 per 10,000원 FOB, effective 2026-01-01 (open-ended). HS
    // 8471606000 matches the seeded FG-1000 so a demo 수출→환급 produces a non-zero refund. Idempotent on
    // (hs_code, valid_from). A second HS demonstrates the lookup; rates are illustrative, not statutory.
    await db
      .insert(schema.drawbackSimplifiedRate)
      .values([
        {
          hsCode: '8471606000',
          ratePer10k: '50.0000',
          validFrom: '2026-01-01',
          createdBy: 'system',
          updatedBy: 'system',
        },
        {
          hsCode: '8517120000',
          ratePer10k: '120.0000',
          validFrom: '2026-01-01',
          createdBy: 'system',
          updatedBy: 'system',
        },
      ])
      .onConflictDoNothing({
        target: [schema.drawbackSimplifiedRate.hsCode, schema.drawbackSimplifiedRate.validFrom],
      });

    console.warn(
      `[seed] admin user '${username}' ready with ADMIN role (*) + demo number ranges (incl. sales ` +
        `SO-/BL- + 실사 PI- + 수출신고 ED- + 수입신고 IM- + 관세환급 DD-) + enterprise structure (company 1000 / plant 1010 / sloc 101A) + ` +
        `fiscal year 2026 (12 open periods) + KR01 account determination (incl. BSX/GBB/WRX/PRD/COGS/IDI/DUTY_DRAWBACK) + ` +
        `master data (5 currencies / 4 fx rates / 17 GL accounts / 4 tax codes / cost center 1000 / ` +
        `2 간이정액환급률 (HS 8471606000 / 8517120000) / ` +
        `2 business partners: customer C1000 + vendor V2000 / 2 materials: FG-1000 + RM-2000 / ` +
        `2 material valuations at plant 1010: FG-1000=7920 + RM-2000=3000)`,
    );
  } finally {
    await app.close();
  }
}

void seed();
