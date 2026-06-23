import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { MaterialService } from '../../src/domains/master-data/material/material.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { MaterialValuationService } from '../../src/domains/inventory-warehouse/inventory/material-valuation.service.js';
import { GoodsMovementService } from '../../src/domains/inventory-warehouse/goods-movement/goods-movement.service.js';
import { ImportDeclarationService } from '../../src/domains/trade-compliance/import-declaration/import-declaration.service.js';
import {
  DOC_FLOW_TYPE_GOODS_RECEIPT,
  DOC_FLOW_TYPE_IMPORT_DECLARATION,
  REL_DECLARES,
} from '../../src/domains/trade-compliance/trade-compliance.constants.js';

/**
 * Import-declaration (수입신고) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The slice posts
 * NOTHING to FI (landed cost owns import accounting), so this proves the non-posting customs document
 * end-to-end: it builds a real 수입 GR (a 101 goods_movement, Dr BSX / Cr WRX), then a declaration over it —
 * docNo IM-NNNNNN, the HS/원산지 SNAPSHOT from material_trade, the 과세가격/관세액/부가세액 RECORD fields, the
 * foreign FX stamp, the `DECLARES` doc_flow edge onto the GR (`inventory.goods_movement`), accept() stamping
 * the 수입신고번호 (MRN) + 신고수리일, that NO journal is written by the declaration, and the SOFT gates
 * (G0 거래구분 / G1 HS / G2 원산지 / G3a 과세가격 정합 / G3b 관세액 정합).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('trade-compliance 수입신고 (import declaration) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let movements: GoodsMovementService;
  let importDeclarations: ImportDeclarationService;
  let companyCodeId: string;
  let plantId: string;
  let slocA: string;
  let supplierBpId: string;
  let brokerBpId: string;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };

  let matSeq = 0;
  /** A RAW material (valuation class 3000) with optional trade extension (HS / origin). */
  const newTradeMaterial = async (hsCode: string | null, origin: string | null) => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `IM-MAT-${matSeq}`,
      name: `Import material ${matSeq}`,
      materialType: 'RAW',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({
      materialId: id,
      plantId,
      valuationClass: '3000',
    });
    if (hsCode) {
      await materials.ensureTradeData(id, origin ? { hsCode, countryOfOrigin: origin } : { hsCode });
    }
    return id;
  };

  /** Post a priced 101 GR (Dr BSX / Cr WRX) for `materialId`; returns its goods_movement + first line ids. */
  const receiveImport = async (materialId: string, qty = '10', price = '100') => {
    const gm = await movements.post(
      {
        plantId,
        movementType: '101',
        postingDate: '2026-03-02',
        items: [{ materialId, storageLocationId: slocA, qty, unitPrice: price }],
      },
      'system',
      { offsetKey: 'WRX' },
    );
    const [grItem] = await db
      .select({ id: schema.goodsMovementItem.id })
      .from(schema.goodsMovementItem)
      .where(eq(schema.goodsMovementItem.goodsMovementId, gm.goodsMovementId));
    return { goodsMovementId: gm.goodsMovementId, grItemId: grItem!.id };
  };

  /** Post a 561 initial load (Dr BSX / Cr GBB) — a NON-GR movement, for the "not a 수입 GR" guard. */
  const load561 = async (materialId: string, qty = '10', price = '100') => {
    const gm = await movements.post({
      plantId,
      movementType: '561',
      postingDate: '2026-03-01',
      items: [{ materialId, storageLocationId: slocA, qty, unitPrice: price }],
    });
    return gm.goodsMovementId;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    const fiscal = new FiscalPeriodService(db);
    const numbering = new NumberingService(db);
    const glAccounts = new GlAccountService(db);
    const registry = new DbCurrencyRegistry(db);
    const currencies = new CurrencyService(db, registry);
    const accountDet = new AccountDeterminationService(db);
    const docFlow = new DocFlowService(db);
    const partners = new BusinessPartnerService(db);
    const journals = new JournalService(
      db,
      fiscal,
      numbering,
      new OutboxService(db),
      docFlow,
      glAccounts,
      registry,
      currencies,
      accountDet,
    );
    movements = new GoodsMovementService(db, fiscal, numbering, docFlow, journals, accountDet, registry);
    importDeclarations = new ImportDeclarationService(db, partners, numbering, docFlow, currencies, registry);

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
    await fiscal.generateYear(companyCodeId, 2026);
    await currencies.ensureCurrency({ code: 'KRW', name: 'South Korean Won', minorUnit: 0 });
    await currencies.ensureCurrency({ code: 'USD', name: 'US Dollar', minorUnit: 2 });
    await currencies.ensureFxRate({
      fromCurrency: 'USD',
      toCurrency: 'KRW',
      rateType: 'M',
      validFrom: '2026-03-01',
      rate: '1300.000000',
    });

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'trade.import_declaration', prefix: 'IM-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '2100', name: '외상매입금', accountType: 'LIABILITY' as const, isReconciliation: true },
      { accountNumber: '2110', name: '입고미착', accountType: 'LIABILITY' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'WRX', glAccount: '2110' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

    supplierBpId = await partners.ensureBp({
      code: 'V-OVERSEAS',
      name: 'Shenzhen Components Ltd.',
      bpType: 'ORGANIZATION',
      country: 'CN',
    });
    await partners.ensureVendorRole(supplierBpId, { apReconAccount: '2100', paymentTermsDays: 45, purchasingBlock: false });
    brokerBpId = await partners.ensureBp({ code: 'C-BROKER', name: '관세사 Customs Broker', bpType: 'ORGANIZATION', country: 'KR' });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — full create: IM- doc no, HS/origin snapshot, 과세가격/관세/부가세 record fields, foreign FX stamp,
  //     DECLARES → GR, NO journal by the declaration; then accept() stamps MRN + 신고수리일 (SUBMITTED →
  //     ACCEPTED) and a second accept is rejected.
  it('creates a USD declaration over a 수입 GR (snapshot + FX stamp + DECLARES, no journal) and accepts it', async () => {
    const matId = await newTradeMaterial('8471606000', 'CN');
    const gr = await receiveImport(matId, '10', '100');

    const journalsBefore = await journalCount();
    const created = await importDeclarations.create({
      companyCodeId,
      supplierBpId,
      brokerBpId,
      sourceGoodsMovementId: gr.goodsMovementId,
      declarationDate: '2026-03-04',
      currency: 'USD',
      customsValue: '1000.00',
      dutyAmount: '80.00',
      importVatAmount: '108.00',
      // HS / origin omitted on the line → snapshotted from material_trade. 과세가격 matches the line sum,
      // 관세 80 == 1000 × 8% → clean.
      items: [
        { materialId: matId, sourceGrItemRef: gr.grItemId, qty: '10', uom: 'EA', customsValue: '1000.00', dutyRate: '8' },
      ],
    });

    expect(created.docNo).toMatch(/^IM-\d{6}$/);
    expect(created.status).toBe('SUBMITTED');
    expect(created.warnings).toEqual([]); // HS+origin resolved, IMP default, 과세가격 정합, 관세 정합

    // The declaration posts NOTHING to FI (landed cost owns import accounting).
    expect(await journalCount()).toBe(journalsBefore);

    const full = await importDeclarations.getImportDeclaration(created.importDeclarationId);
    expect(full.customsValue).toBe('1000.0000');
    expect(full.dutyAmount).toBe('80.0000');
    expect(full.importVatAmount).toBe('108.0000');
    expect(full.exchangeRate).toBe('1300.000000'); // foreign → document-date 'M' rate stamped
    expect(full.currency).toBe('USD');
    expect(full.sourceGoodsMovementId).toBe(gr.goodsMovementId);
    expect(full.items).toHaveLength(1);
    expect(full.items[0]).toMatchObject({
      sourceGrItemRef: gr.grItemId,
      hsCode: '8471606000', // snapshot from material_trade
      originCountry: 'CN',
      qty: '10.000000',
      uom: 'EA',
      customsValue: '1000.0000',
      dutyRate: '8.0000',
    });

    // Physical lineage: DECLARES → the 수입 GR (inventory.goods_movement, the same node landed cost owns).
    const edges = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_IMPORT_DECLARATION),
          eq(schema.docFlow.sourceId, created.importDeclarationId),
          eq(schema.docFlow.relType, REL_DECLARES),
        ),
      );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_GOODS_RECEIPT, targetId: gr.goodsMovementId });
    expect(DOC_FLOW_TYPE_GOODS_RECEIPT).toBe('inventory.goods_movement');

    // accept(): stamp the 수입신고번호 + 신고수리일 and flip to ACCEPTED.
    const accepted = await importDeclarations.accept(created.importDeclarationId, {
      declarationNo: '41234-26-100001X',
      acceptanceDate: '2026-03-06',
    });
    expect(accepted).toMatchObject({
      status: 'ACCEPTED',
      declarationNo: '41234-26-100001X',
      acceptanceDate: '2026-03-06',
    });

    // A second accept is rejected (only a SUBMITTED declaration can be accepted).
    await expect(
      importDeclarations.accept(created.importDeclarationId, { declarationNo: 'X' }),
    ).rejects.toThrow(/only a SUBMITTED declaration can be accepted/);
  });

  // 2 — G1: a material with NO trade data → HS_CODE_MISSING (origin supplied on the line, so no G2).
  it('warns (G1) when a line resolves no HS code', async () => {
    const matId = await newTradeMaterial(null, null);
    const gr = await receiveImport(matId);
    const created = await importDeclarations.create({
      companyCodeId,
      supplierBpId,
      sourceGoodsMovementId: gr.goodsMovementId,
      declarationDate: '2026-03-04',
      currency: 'KRW',
      customsValue: '1000',
      dutyAmount: '80',
      importVatAmount: '108',
      items: [{ materialId: matId, originCountry: 'CN', qty: '10', uom: 'EA', customsValue: '1000', dutyRate: '8' }],
    });
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'HS_CODE_MISSING', lineNo: 1 }),
    );
    expect(created.warnings.find((w) => w.code === 'ORIGIN_COUNTRY_MISSING')).toBeUndefined();
    const full = await importDeclarations.getImportDeclaration(created.importDeclarationId);
    expect(full.exchangeRate).toBeNull(); // domestic KRW — no rate stamped
  });

  // 3 — G2: trade data with an HS code but NO origin → ORIGIN_COUNTRY_MISSING (HS resolved, so no G1).
  it('warns (G2) when a line resolves no origin country (import-specific gate)', async () => {
    const matId = await newTradeMaterial('8471606000', null);
    const gr = await receiveImport(matId);
    const created = await importDeclarations.create({
      companyCodeId,
      supplierBpId,
      sourceGoodsMovementId: gr.goodsMovementId,
      declarationDate: '2026-03-04',
      currency: 'KRW',
      customsValue: '1000',
      dutyAmount: '80',
      importVatAmount: '108',
      items: [{ materialId: matId, qty: '10', uom: 'EA', customsValue: '1000', dutyRate: '8' }],
    });
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'ORIGIN_COUNTRY_MISSING', lineNo: 1 }),
    );
    expect(created.warnings.find((w) => w.code === 'HS_CODE_MISSING')).toBeUndefined();
  });

  // 4 — G3a: the declared header 과세가격 ≠ the line sum → CUSTOMS_VALUE_LINE_SUM_MISMATCH.
  it('warns (G3a) when the header 과세가격 disagrees with the line sum', async () => {
    const matId = await newTradeMaterial('8471606000', 'CN');
    const gr = await receiveImport(matId);
    const created = await importDeclarations.create({
      companyCodeId,
      supplierBpId,
      sourceGoodsMovementId: gr.goodsMovementId,
      declarationDate: '2026-03-04',
      currency: 'KRW',
      customsValue: '1000', // header says 1000 …
      dutyAmount: '0',
      importVatAmount: '0',
      items: [{ materialId: matId, qty: '10', uom: 'EA', customsValue: '900' }], // … lines sum to 900
    });
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'CUSTOMS_VALUE_LINE_SUM_MISMATCH' }),
    );
  });

  // 5 — G3b: declared 관세액 deviates from 과세가격 × 관세율 → INFO (참고용, 비차단), not a WARN.
  it('notes INFO (G3b) when the declared 관세액 is far from the 과세가격 × 관세율 estimate', async () => {
    const matId = await newTradeMaterial('8471606000', 'CN');
    const gr = await receiveImport(matId);
    const created = await importDeclarations.create({
      companyCodeId,
      supplierBpId,
      sourceGoodsMovementId: gr.goodsMovementId,
      declarationDate: '2026-03-04',
      currency: 'KRW',
      customsValue: '1000',
      dutyAmount: '200', // declared 200, but 1000 × 8% = 80 → gross deviation
      importVatAmount: '120',
      items: [{ materialId: matId, qty: '10', uom: 'EA', customsValue: '1000', dutyRate: '8' }],
    });
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'INFO', code: 'DUTY_AMOUNT_SANITY' }),
    );
    // 과세가격 정합 + HS/origin present → only the INFO note.
    expect(created.warnings.filter((w) => w.severity === 'WARN')).toEqual([]);
  });

  // 6 — guards: unknown GR (404), a non-101 movement (400), an unknown material (404), and a
  //     source_gr_item_ref that is not a line of the GR (400).
  it('rejects an unknown GR, a non-GR movement, an unknown material, and a foreign GR line', async () => {
    const matId = await newTradeMaterial('8471606000', 'CN');
    const gr = await receiveImport(matId);
    const base = {
      companyCodeId,
      supplierBpId,
      declarationDate: '2026-03-04',
      currency: 'KRW',
      customsValue: '1000',
      dutyAmount: '80',
      importVatAmount: '108',
    } as const;

    // unknown GR → 404
    await expect(
      importDeclarations.create({
        ...base,
        sourceGoodsMovementId: randomUUID(),
        items: [{ materialId: matId, qty: '10', uom: 'EA', customsValue: '1000' }],
      }),
    ).rejects.toThrow(/goods receipt .* not found/);

    // a 561 initial load (on a fresh material, so no backdating clash) is NOT a 수입 GR → 400
    const notGrMat = await newTradeMaterial('8471606000', 'CN');
    const notGr = await load561(notGrMat);
    await expect(
      importDeclarations.create({
        ...base,
        sourceGoodsMovementId: notGr,
        items: [{ materialId: matId, qty: '10', uom: 'EA', customsValue: '1000' }],
      }),
    ).rejects.toThrow(/not a 수입 GR/);

    // unknown material → 404
    await expect(
      importDeclarations.create({
        ...base,
        sourceGoodsMovementId: gr.goodsMovementId,
        items: [{ materialId: randomUUID(), qty: '10', uom: 'EA', customsValue: '1000' }],
      }),
    ).rejects.toThrow(/material .* not found/);

    // a source_gr_item_ref that is not a line of the GR → 400
    await expect(
      importDeclarations.create({
        ...base,
        sourceGoodsMovementId: gr.goodsMovementId,
        items: [
          { materialId: matId, sourceGrItemRef: randomUUID(), qty: '10', uom: 'EA', customsValue: '1000' },
        ],
      }),
    ).rejects.toThrow(/is not a line of goods receipt/);
  });
});
