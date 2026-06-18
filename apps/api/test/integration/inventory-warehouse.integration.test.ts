import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { MaterialService } from '../../src/domains/master-data/material/material.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { MaterialValuationService } from '../../src/domains/inventory-warehouse/inventory/material-valuation.service.js';
import { InventoryReconciliationService } from '../../src/domains/inventory-warehouse/inventory/reconciliation.service.js';
import {
  DOC_FLOW_TYPE,
  GoodsMovementService,
} from '../../src/domains/inventory-warehouse/goods-movement/goods-movement.service.js';

/**
 * Inventory-warehouse MAP + goods-movement integration over a real PostgreSQL 16 (Testcontainers,
 * root CLAUDE.md §5.4). Proves the slice end-to-end: priced receipts recalculating the moving
 * average, issues at the current average, the inventory↔GL reconciliation invariant (delta == 0
 * after EVERY step — stock update and journal commit in ONE transaction via PostOptions.tx),
 * storage-location/plant quantity consistency, concurrency (no lost update under SELECT FOR
 * UPDATE), idempotent replay, over-issue rejection, the backdating guard, and tx atomicity
 * (a journal-side failure rolls the stock update back).
 *
 * The postgres pool uses max 5 (NOT the usual 1): the concurrency scenarios need parallel
 * transactions on separate connections.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('inventory-warehouse MAP goods movements (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let fiscal: FiscalPeriodService;
  let journals: JournalService;
  let movements: GoodsMovementService;
  let valuations: MaterialValuationService;
  let recon: InventoryReconciliationService;
  let companyCodeId: string;
  let fiscalYearId: string;
  let plantId: string;
  let plant2Id: string;
  let slocA: string;
  let slocB: string;
  let sloc2: string;
  /** material ids by test alias. */
  const mat: Record<string, string> = {};

  const valuationOf = async (materialId: string) => {
    const [row] = await db
      .select()
      .from(schema.materialValuation)
      .where(
        and(
          eq(schema.materialValuation.materialId, materialId),
          eq(schema.materialValuation.plantId, plantId),
        ),
      );
    return row!;
  };

  const stockOf = async (materialId: string, storageLocationId: string) => {
    const [row] = await db
      .select()
      .from(schema.stock)
      .where(
        and(
          eq(schema.stock.materialId, materialId),
          eq(schema.stock.storageLocationId, storageLocationId),
        ),
      );
    return row;
  };

  /** The slice invariant: Σ stock_value == BSX GL balance, after EVERY committed step. */
  const expectDelta0 = async () => {
    const rows = await recon.reconcile(companyCodeId);
    for (const row of rows) {
      expect(row.delta).toBe('0.0000');
    }
  };

  /** Single-item 101 receipt into sloc A on 2026-03-10. */
  const receipt = (alias: string, postingKey: string, qty: string, unitPrice: string) => ({
    plantId,
    movementType: '101' as const,
    postingDate: '2026-03-10',
    postingKey,
    items: [{ materialId: mat[alias]!, storageLocationId: slocA, qty, unitPrice }],
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    // max 5 (not 1): the concurrency tests run parallel transactions.
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    fiscal = new FiscalPeriodService(db);
    const numbering = new NumberingService(db);
    const glAccounts = new GlAccountService(db);
    const registry = new DbCurrencyRegistry(db);
    const currencies = new CurrencyService(db, registry);
    const accountDet = new AccountDeterminationService(db);
    const docFlow = new DocFlowService(db);
    const materials = new MaterialService(db);
    journals = new JournalService(
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
    valuations = new MaterialValuationService(db);
    recon = new InventoryReconciliationService(db, registry);
    movements = new GoodsMovementService(db, fiscal, numbering, docFlow, journals, accountDet, registry);

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
    fiscalYearId = await fiscal.generateYear(companyCodeId, 2026);
    await currencies.ensureCurrency({ code: 'KRW', name: 'South Korean Won', minorUnit: 0 });
    // USD exists only so the USD-pinned BSX account (test 14) is a valid master row.
    await currencies.ensureCurrency({ code: 'USD', name: 'US Dollar', minorUnit: 2 });

    await numbering.defineRange({
      object: 'finance.journal_entry',
      scope: '2026',
      prefix: 'JE-2026-',
      padding: 6,
    });
    await numbering.defineRange({
      object: 'inventory.goods_movement',
      scope: '2026',
      prefix: 'GM-2026-',
      padding: 6,
    });

    for (const acc of [
      { accountNumber: '1000', name: '현금', accountType: 'ASSET' as const },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '1310', name: '제품', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5110', name: '제품재고변동', accountType: 'EXPENSE' as const },
      // A USD-pinned BSX account: a KRW movement resolving to it fails INSIDE journals.post
      // (resolveLines currency check) — AFTER the in-tx stock write, the atomicity probe (test 14).
      { accountNumber: '1399', name: 'USD-pinned stock', accountType: 'ASSET' as const, currency: 'USD' },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'BSX', valuationClass: '7920', glAccount: '1310' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'GBB', valuationClass: '7920', glAccount: '5110' },
      // '9999' BSX points at the USD-pinned account → journal-side failure after stock write.
      { transactionKey: 'BSX', valuationClass: '9999', glAccount: '1399' },
      { transactionKey: 'GBB', valuationClass: '9999', glAccount: '5100' },
      // '8888' deliberately has NO rules — the determination-failure atomicity probe.
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });
    slocB = await org.ensureStorageLocation({ code: '0002', name: 'Annex', plantId });
    // A SECOND plant under the same company — the cross-plant posting-key test (test 15).
    plant2Id = await org.ensurePlant({ code: '1020', name: 'Busan Plant', companyCodeId });
    sloc2 = await org.ensureStorageLocation({ code: '0001', name: 'Busan Main', plantId: plant2Id });

    for (const [alias, code, valuationClass] of [
      ['story', 'RM-A100', '3000'],
      ['split', 'RM-B200', '3000'],
      ['conc', 'RM-C300', '3000'],
      ['idem', 'RM-D400', '3000'],
      ['guard', 'RM-E500', '3000'],
      ['fg', 'FG-X900', '7920'],
      ['surplus', 'RM-G600', '3000'],
      ['xplant', 'RM-H700', '3000'],
      ['atomicfail', 'RM-I900', '9999'],
      ['norule', 'RM-F800', '8888'],
    ] as const) {
      mat[alias] = await materials.ensureMaterial({
        code,
        name: code,
        materialType: code.startsWith('FG') ? 'FINISHED' : 'RAW',
        baseUom: 'KG',
      });
      await valuations.ensureValuation({ materialId: mat[alias]!, plantId, valuationClass });
    }
    // The cross-plant material also needs its accounting view at the SECOND plant.
    await valuations.ensureValuation({ materialId: mat.xplant!, plantId: plant2Id, valuationClass: '3000' });
    // One material WITHOUT an accounting view — movements against it must be rejected.
    mat.noview = await materials.ensureMaterial({
      code: 'NV-Z000',
      name: 'No valuation view',
      materialType: 'RAW',
      baseUom: 'KG',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — 입고(561/101): 평가·재고·분개·문서흐름이 한 번에, delta 0
  it('posts a priced receipt: valuation + stock + balanced WE journal + POSTS edge, delta 0', async () => {
    const posted = await movements.post({
      plantId,
      movementType: '561',
      postingDate: '2026-03-05',
      postingKey: 'itest:story:561',
      items: [{ materialId: mat.story!, storageLocationId: slocA, qty: '10', unitPrice: '1000' }],
    });
    expect(posted).toMatchObject({ docNo: 'GM-2026-000001', status: 'POSTED' });
    expect(posted.journalId).toBeTruthy();

    const val = await valuationOf(mat.story!);
    expect(val).toMatchObject({
      valuationQty: '10.000000',
      movingAvgPrice: '1000.000000',
      stockValue: '10000.0000',
      currency: 'KRW',
      lastMovementDate: '2026-03-05',
    });
    expect((await stockOf(mat.story!, slocA))?.qty).toBe('10.000000');

    const entry = await journals.getJournal(posted.journalId!);
    expect(entry).toMatchObject({
      docType: 'WE',
      status: 'POSTED',
      currency: 'KRW',
      reference: `${DOC_FLOW_TYPE}:GM-2026-000001`,
      // Journal key derives from the movement id (NOT its plant-scoped posting key) — see test 15.
      postingKey: `gm:${posted.goodsMovementId}`,
    });
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toMatchObject({ glAccount: '1300', drCr: 'D', amount: '10000.0000' });
    expect(entry.lines[1]).toMatchObject({ glAccount: '5100', drCr: 'C', amount: '10000.0000' });

    const [edge] = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(eq(schema.docFlow.sourceType, DOC_FLOW_TYPE), eq(schema.docFlow.sourceId, posted.goodsMovementId)),
      );
    expect(edge).toMatchObject({ relType: 'POSTS', targetId: posted.journalId });

    await expectDelta0();
  });

  // 2 — 두 번째 입고: 이동평균 재계산 (new_avg = new_value / new_qty)
  it('recalculates the moving average on the second receipt: 10@1000 + 10@2000 → MAP 1500', async () => {
    await movements.post({
      plantId,
      movementType: '101',
      postingDate: '2026-03-10',
      postingKey: 'itest:story:101',
      items: [{ materialId: mat.story!, storageLocationId: slocA, qty: '10', unitPrice: '2000' }],
    });
    const val = await valuationOf(mat.story!);
    expect(val).toMatchObject({
      valuationQty: '20.000000',
      movingAvgPrice: '1500.000000',
      stockValue: '30000.0000',
    });
    await expectDelta0();
  });

  // 3 — 출고(201): 현재 MAP로 평가, MAP 불변
  it('issues at the current average and leaves the average INVARIANT', async () => {
    const posted = await movements.post({
      plantId,
      movementType: '201',
      postingDate: '2026-03-12',
      postingKey: 'itest:story:201',
      items: [{ materialId: mat.story!, storageLocationId: slocA, qty: '5' }],
    });
    const val = await valuationOf(mat.story!);
    expect(val).toMatchObject({
      valuationQty: '15.000000',
      movingAvgPrice: '1500.000000', // unchanged
      stockValue: '22500.0000', // 30000 − 5×1500
    });
    const entry = await journals.getJournal(posted.journalId!);
    expect(entry.docType).toBe('WA');
    // The BSX (stock) line is always line 1; on an issue it is the CREDIT side.
    expect(entry.lines[0]).toMatchObject({ glAccount: '1300', drCr: 'C', amount: '7500.0000' });
    expect(entry.lines[1]).toMatchObject({ glAccount: '5100', drCr: 'D', amount: '7500.0000' });
    await expectDelta0();
  });

  // 4 — 712 잉여: 현재 MAP로 가산(중립); 빈 재고에는 거부
  it('books a 712 surplus at the current average (MAP-neutral); rejects 712 on empty stock', async () => {
    await movements.post({
      plantId,
      movementType: '712',
      postingDate: '2026-03-15',
      postingKey: 'itest:story:712',
      items: [{ materialId: mat.story!, storageLocationId: slocA, qty: '2' }],
    });
    const val = await valuationOf(mat.story!);
    expect(val).toMatchObject({
      valuationQty: '17.000000',
      movingAvgPrice: '1500.000000',
      stockValue: '25500.0000', // +2×1500
    });

    await expect(
      movements.post({
        plantId,
        movementType: '712',
        postingDate: '2026-03-15',
        postingKey: 'itest:fg:712-empty',
        items: [{ materialId: mat.fg!, storageLocationId: slocA, qty: '1' }],
      }),
    ).rejects.toThrow(/no stock at this plant/);
    await expectDelta0();
  });

  // 5 — 711 전량출고: 가치가 정확히 0으로, MAP은 살아남는다
  it('a full 711 issue empties value to exactly zero; the last average survives', async () => {
    await movements.post({
      plantId,
      movementType: '711',
      postingDate: '2026-03-20',
      postingKey: 'itest:story:711',
      items: [{ materialId: mat.story!, storageLocationId: slocA, qty: '17' }],
    });
    const val = await valuationOf(mat.story!);
    expect(val).toMatchObject({
      valuationQty: '0.000000',
      stockValue: '0.0000', // no orphaned residue (the empty_zero CHECK backs this)
      movingAvgPrice: '1500.000000', // SAP VERPR behavior: the average survives empty stock
    });
    expect((await stockOf(mat.story!, slocA))?.qty).toBe('0.000000');
    await expectDelta0();
  });

  // 6 — 수량일관: Σ 저장위치 qty == 평가수량; 저장위치 부족은 plant 수량이 충분해도 거부
  it('keeps Σ storage-location qty == valuation qty; sloc-level over-issue rejected', async () => {
    await movements.post({
      plantId,
      movementType: '101',
      postingDate: '2026-03-10',
      postingKey: 'itest:split:a',
      items: [
        { materialId: mat.split!, storageLocationId: slocA, qty: '6', unitPrice: '500' },
        { materialId: mat.split!, storageLocationId: slocB, qty: '4', unitPrice: '500' },
      ],
    });
    const val = await valuationOf(mat.split!);
    const a = await stockOf(mat.split!, slocA);
    const b = await stockOf(mat.split!, slocB);
    expect(val.valuationQty).toBe('10.000000');
    expect(a?.qty).toBe('6.000000');
    expect(b?.qty).toBe('4.000000');

    // Plant has 10, but sloc B holds only 4 — issuing 5 THERE must fail (and write nothing).
    await expect(
      movements.post({
        plantId,
        movementType: '201',
        postingDate: '2026-03-11',
        postingKey: 'itest:split:over-sloc',
        items: [{ materialId: mat.split!, storageLocationId: slocB, qty: '5' }],
      }),
    ).rejects.toThrow(/over-issue/);
    expect((await valuationOf(mat.split!)).valuationQty).toBe('10.000000');
    expect((await stockOf(mat.split!, slocB))?.qty).toBe('4.000000');
    await expectDelta0();
  });

  // 7 — 동시성: 병렬 입고에 lost update 0, 동시 동일키는 한 건만
  it('concurrent receipts lose no update (SELECT FOR UPDATE serializes MAP); same-key race posts once', async () => {
    const results = await Promise.all(
      ['1', '2', '3', '4', '5'].map((n) =>
        movements.post(receipt('conc', `itest:conc:${n}`, '1', `${n}000`)),
      ),
    );
    expect(new Set(results.map((r) => r.goodsMovementId)).size).toBe(5);

    const val = await valuationOf(mat.conc!);
    // Σ qty = 5, Σ value = 1000+2000+3000+4000+5000 = 15000 — NOTHING lost.
    expect(val).toMatchObject({
      valuationQty: '5.000000',
      stockValue: '15000.0000',
      movingAvgPrice: '3000.000000',
    });

    // Same-key race: both calls resolve to the SAME document; exactly one row exists.
    const [r1, r2] = await Promise.all([
      movements.post(receipt('conc', 'itest:conc:dup', '1', '9000')),
      movements.post(receipt('conc', 'itest:conc:dup', '1', '9000')),
    ]);
    expect(r1!.goodsMovementId).toBe(r2!.goodsMovementId);
    const rows = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, 'itest:conc:dup'));
    expect(rows).toHaveLength(1);
    expect((await valuationOf(mat.conc!)).valuationQty).toBe('6.000000');
    await expectDelta0();
  });

  // 8 — 멱등 replay: 같은 키 재호출 → 같은 문서/분개, 상태 불변
  it('replays idempotently on the posting key: same document, same journal, state unchanged', async () => {
    const first = await movements.post(receipt('idem', 'itest:idem', '3', '700'));
    const before = await valuationOf(mat.idem!);
    const replay = await movements.post(receipt('idem', 'itest:idem', '3', '700'));
    // Identical to the first post — including perItemConsumed/totalConsumed, which the replay path
    // reconstructs verbatim from the persisted goods_movement_item amounts.
    expect(replay).toEqual(first);
    expect(replay.status).toBe('POSTED');
    expect(await valuationOf(mat.idem!)).toEqual(before); // no double application
    const journalRows = await db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.postingKey, `gm:${first.goodsMovementId}`));
    expect(journalRows).toHaveLength(1);
    await expectDelta0();
  });

  // 9 — 과출고: BadRequest, 아무것도 쓰지 않음
  it('rejects over-issue with 400 and writes nothing', async () => {
    await movements.post(receipt('guard', 'itest:guard:base', '10', '100'));
    const before = await valuationOf(mat.guard!);

    await expect(
      movements.post({
        plantId,
        movementType: '201',
        postingDate: '2026-03-12',
        postingKey: 'itest:guard:over',
        items: [{ materialId: mat.guard!, storageLocationId: slocA, qty: '15' }],
      }),
    ).rejects.toThrow(/over-issue/);

    expect(await valuationOf(mat.guard!)).toEqual(before);
    const ghost = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, 'itest:guard:over'));
    expect(ghost).toHaveLength(0); // header insert rolled back with the rest
    await expectDelta0();
  });

  // 10 — backdating 거부: (material, plant)의 최근 이동일 이전 전기 불가
  it('rejects a movement dated before the pair’s last movement (MAP is order-sensitive)', async () => {
    // mat.guard last moved 2026-03-10 (test 9 base receipt).
    await expect(
      movements.post({
        plantId,
        movementType: '201',
        postingDate: '2026-03-05',
        postingKey: 'itest:guard:backdate',
        items: [{ materialId: mat.guard!, storageLocationId: slocA, qty: '1' }],
      }),
    ).rejects.toThrow(/backdated/);
    expect((await valuationOf(mat.guard!)).valuationQty).toBe('10.000000');
    await expectDelta0();
  });

  // 11 — 사전조건: 평가뷰 없는 자재 거부 · 계정결정 룰 없는 평가클래스는 원자적 롤백
  it('requires the accounting view; a determination-rule miss rolls the whole document back', async () => {
    await expect(
      movements.post(receipt('noview', 'itest:noview', '1', '100')),
    ).rejects.toThrow(/no material valuation/);

    // valuation class '8888' has no BSX/GBB rules → fails AFTER header+stock-ensure inserts.
    await expect(
      movements.post(receipt('norule', 'itest:norule', '1', '100')),
    ).rejects.toThrow(/no account determination rule/);
    const ghost = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, 'itest:norule'));
    expect(ghost).toHaveLength(0);
    expect((await valuationOf(mat.norule!)).valuationQty).toBe('0.000000');
    await expectDelta0();
  });

  // 12 — 712 잉여가 장부수량을 초과해도 정상(현재 MAP 가산, 중립), 500 아님
  it('books a 712 surplus LARGER than book quantity at the current average (delta 0)', async () => {
    // Book 2 @ 1000 = 2000; physical count finds +5 surplus (more than the book qty).
    await movements.post(receipt('surplus', 'itest:surplus:base', '2', '1000'));
    const posted = await movements.post({
      plantId,
      movementType: '712',
      postingDate: '2026-03-12',
      postingKey: 'itest:surplus:over',
      items: [{ materialId: mat.surplus!, storageLocationId: slocA, qty: '5' }],
    });
    const val = await valuationOf(mat.surplus!);
    expect(val).toMatchObject({
      valuationQty: '7.000000',
      movingAvgPrice: '1000.000000', // MAP-neutral
      stockValue: '7000.0000', // 2000 + 5×1000
    });
    const entry = await journals.getJournal(posted.journalId!);
    expect(entry.lines[0]).toMatchObject({ glAccount: '1300', drCr: 'D', amount: '5000.0000' });
    await expectDelta0();
  });

  // 13 — 크로스-플랜트: 같은 회사의 두 플랜트가 같은 클라이언트 키를 합법적으로 재사용
  it('lets two plants of one company reuse the same client posting key (journal key is per-movement)', async () => {
    const atPlant1 = await movements.post({
      plantId,
      movementType: '101',
      postingDate: '2026-03-10',
      postingKey: 'load-01',
      items: [{ materialId: mat.xplant!, storageLocationId: slocA, qty: '3', unitPrice: '100' }],
    });
    // Same client key 'load-01', different plant — must NOT collide at the journal layer.
    const atPlant2 = await movements.post({
      plantId: plant2Id,
      movementType: '101',
      postingDate: '2026-03-10',
      postingKey: 'load-01',
      items: [{ materialId: mat.xplant!, storageLocationId: sloc2, qty: '4', unitPrice: '100' }],
    });
    expect(atPlant2.goodsMovementId).not.toBe(atPlant1.goodsMovementId);
    expect(atPlant1.journalId).toBeTruthy();
    expect(atPlant2.journalId).toBeTruthy();
    expect(atPlant2.journalId).not.toBe(atPlant1.journalId);
    // Each plant carries its own valuation; both posted.
    expect((await valuationOf(mat.xplant!)).valuationQty).toBe('3.000000'); // plant 1
    const [v2] = await db
      .select()
      .from(schema.materialValuation)
      .where(
        and(
          eq(schema.materialValuation.materialId, mat.xplant!),
          eq(schema.materialValuation.plantId, plant2Id),
        ),
      );
    expect(v2?.valuationQty).toBe('4.000000');
    await expectDelta0();
  });

  // 14 — 단일 트랜잭션 증명: 분개쪽 실패(통화-핀 BSX 계정)가 재고 갱신까지 되돌린다
  it('is atomic: a journal-side failure AFTER the stock update rolls everything back', async () => {
    // mat.atomicfail's BSX resolves to '1399' (USD-pinned). A KRW receipt updates stock/valuation
    // in-tx, then JournalService.post() rejects the KRW line against the USD account — all rolls back.
    await expect(
      movements.post(receipt('atomicfail', 'itest:atomic', '1', '100')),
    ).rejects.toThrow(/fixed to USD/);

    expect((await valuationOf(mat.atomicfail!)).valuationQty).toBe('0.000000');
    const stockRow = await stockOf(mat.atomicfail!, slocA);
    expect(stockRow?.qty ?? '0.000000').toBe('0.000000'); // stock update rolled back
    const ghost = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, 'itest:atomic'));
    expect(ghost).toHaveLength(0);
    await expectDelta0();
  });

  // 15 — FI reverse()는 서브원장(POSTS 엣지)에 묶인 WE/WA 분개를 거부 → 정합 불변
  it('FI reverse() refuses a goods-movement journal (POSTS edge), keeping delta 0', async () => {
    const posted = await movements.post(receipt('fg', 'itest:revguard', '5', '2000'));
    expect(posted.journalId).toBeTruthy();

    await expect(journals.reverse(posted.journalId!, 'oops')).rejects.toThrow(/subledger document/);

    const entry = await journals.getJournal(posted.journalId!);
    expect(entry.status).toBe('POSTED'); // untouched
    await expectDelta0();
  });

  // 16 — 기간잠금: 닫힌 기간으로의 이동은 재고를 건드리기 전에 거부
  it('enforces the period lock for movements (closed period → Conflict, nothing written)', async () => {
    const periods = await fiscal.listPeriods(fiscalYearId);
    const august = periods.find((p) => p.periodNo === 8)!;
    await fiscal.closePeriod(august.id);

    await expect(
      movements.post({
        plantId,
        movementType: '101',
        postingDate: '2026-08-10',
        postingKey: 'itest:closed',
        items: [{ materialId: mat.guard!, storageLocationId: slocA, qty: '1', unitPrice: '100' }],
      }),
    ).rejects.toThrow(/closed/);
    expect((await valuationOf(mat.guard!)).valuationQty).toBe('10.000000');
    await expectDelta0();
  });
});
