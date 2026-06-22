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
import { PhysicalInventoryService } from '../../src/domains/inventory-warehouse/physical-inventory/physical-inventory.service.js';
import { DOC_FLOW_TYPE_PI } from '../../src/domains/inventory-warehouse/physical-inventory/physical-inventory.constants.js';

/**
 * Physical-inventory (재고 실사) integration over a real PostgreSQL 16 (Testcontainers, §5.4). Proves the
 * count slice end-to-end against the goods-movement engine: a stock GAIN (701, Dr BSX / Cr IDI) and LOSS
 * (702, Dr IDI / Cr BSX) valued at the CURRENT MAP, a zero-difference count posting NOTHING, the engine's
 * over-issue / empty-stock guards inherited by the 702/701 paths, idempotent replay on the count's
 * posting key, exact valuation (= |diff| × MAP), and the inventory↔GL reconciliation invariant (delta ==
 * '0.0000' after EVERY step — the BSX leg amount IS the stock_value delta; IDI 5910 is not a BSX account).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('physical-inventory (재고 실사) adjustments (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let movements: GoodsMovementService;
  let valuations: MaterialValuationService;
  let recon: InventoryReconciliationService;
  let physicalInventory: PhysicalInventoryService;
  let companyCodeId: string;
  let plantId: string;
  let slocA: string;
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

  /** Seed stock + MAP for a material via a priced 101 receipt into sloc A. */
  const load = (alias: string, postingKey: string, qty: string, unitPrice: string, postingDate = '2026-04-01') =>
    movements.post({
      plantId,
      movementType: '101',
      postingDate,
      postingKey,
      items: [{ materialId: mat[alias]!, storageLocationId: slocA, qty, unitPrice }],
    });

  /** A single-line physical count of `alias` at sloc A. */
  const count = (alias: string, postingKey: string, physicalQty: string, postingDate = '2026-04-05') =>
    physicalInventory.count({
      plantId,
      postingDate,
      postingKey,
      items: [{ materialId: mat[alias]!, storageLocationId: slocA, physicalQty }],
    });

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
    physicalInventory = new PhysicalInventoryService(db, numbering, movements);

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

    await numbering.defineRange({ object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-', padding: 6 });
    await numbering.defineRange({ object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-', padding: 6 });
    // The count document's own global-scoped range (PI-NNNNNN).
    await numbering.defineRange({ object: 'inventory.physical_inventory', prefix: 'PI-', padding: 6 });

    for (const acc of [
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      // 재고조정손익 (IDI) — the 실사 adjustment offset, both directions.
      { accountNumber: '5910', name: '재고조정손익', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      // IDI: a single WILDCARD rule (no valuation class) → 5910, for both 701 and 702.
      { transactionKey: 'IDI', glAccount: '5910' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

    for (const [alias, code] of [
      ['gain', 'RM-PG100'],
      ['loss', 'RM-PL200'],
      ['zero', 'RM-PZ300'],
      ['evalv', 'RM-PE400'],
      ['inter', 'RM-PI500'],
      ['replay', 'RM-PR600'],
      ['over', 'RM-PO700'],
      ['empty', 'RM-PM800'],
    ] as const) {
      mat[alias] = await materials.ensureMaterial({
        code,
        name: code,
        materialType: 'RAW',
        baseUom: 'KG',
      });
      await valuations.ensureValuation({ materialId: mat[alias]!, plantId, valuationClass: '3000' });
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — 재고이익(physical > book): 701, stock_value↑, Dr BSX / Cr IDI, delta 0
  it('posts a 701 stock gain at the current MAP: Dr BSX / Cr IDI, stock_value up, delta 0', async () => {
    await load('gain', 'pi:gain:load', '10', '1000'); // 10 @ 1000 → MAP 1000, value 10000
    const posted = await count('gain', 'pi:gain', '14'); // count 14 → +4 gain

    expect(posted.status).toBe('POSTED');
    expect(posted.docNo).toMatch(/^PI-\d{6}$/);
    expect(posted.adjustments).toHaveLength(1);
    const adj = posted.adjustments[0]!;
    expect(adj.movementType).toBe('701');
    expect(adj.journalId).toBeTruthy();

    const val = await valuationOf(mat.gain!);
    expect(val).toMatchObject({
      valuationQty: '14.000000',
      movingAvgPrice: '1000.000000', // MAP-neutral gain
      stockValue: '14000.0000', // +4 × 1000
    });
    expect((await stockOf(mat.gain!, slocA))?.qty).toBe('14.000000');

    const entry = await journals.getJournal(adj.journalId!);
    expect(entry.docType).toBe('WE'); // a receipt-style gain
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toMatchObject({ glAccount: '1300', drCr: 'D', amount: '4000.0000' }); // BSX
    expect(entry.lines[1]).toMatchObject({ glAccount: '5910', drCr: 'C', amount: '4000.0000' }); // IDI

    // The ADJUSTS lineage: the goods movement ADJUSTS the count document.
    const [edge] = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.targetType, DOC_FLOW_TYPE_PI),
          eq(schema.docFlow.targetId, posted.physicalInventoryId),
          eq(schema.docFlow.relType, 'ADJUSTS'),
        ),
      );
    expect(edge).toMatchObject({ sourceType: DOC_FLOW_TYPE, sourceId: adj.goodsMovementId });

    await expectDelta0();
  });

  // 2 — 재고손실(physical < book): 702, stock_value↓, Dr IDI / Cr BSX, delta 0
  it('posts a 702 stock loss at the current MAP: Dr IDI / Cr BSX, stock_value down, delta 0', async () => {
    await load('loss', 'pi:loss:load', '10', '1000'); // value 10000
    const posted = await count('loss', 'pi:loss', '6'); // count 6 → −4 loss

    expect(posted.adjustments).toHaveLength(1);
    const adj = posted.adjustments[0]!;
    expect(adj.movementType).toBe('702');

    const val = await valuationOf(mat.loss!);
    expect(val).toMatchObject({
      valuationQty: '6.000000',
      movingAvgPrice: '1000.000000', // MAP invariant on a loss
      stockValue: '6000.0000', // −4 × 1000
    });
    expect((await stockOf(mat.loss!, slocA))?.qty).toBe('6.000000');

    const entry = await journals.getJournal(adj.journalId!);
    expect(entry.docType).toBe('WA'); // an issue-style loss
    // The BSX (stock) line is always line 1; on a loss (issue) it is the CREDIT side.
    expect(entry.lines[0]).toMatchObject({ glAccount: '1300', drCr: 'C', amount: '4000.0000' }); // BSX
    expect(entry.lines[1]).toMatchObject({ glAccount: '5910', drCr: 'D', amount: '4000.0000' }); // IDI
    await expectDelta0();
  });

  // 3 — 차이 0: movement/journal 미생성, 재고 불변, 그래도 POSTED
  it('a zero-difference count posts NO movement/journal but finalizes POSTED', async () => {
    await load('zero', 'pi:zero:load', '8', '1000');
    const before = await valuationOf(mat.zero!);
    const posted = await count('zero', 'pi:zero', '8'); // count matches book exactly

    expect(posted.status).toBe('POSTED');
    expect(posted.adjustments).toHaveLength(0);
    // No goods movement was created for this material by the count.
    const gms = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, `pi:${posted.physicalInventoryId}:701`));
    expect(gms).toHaveLength(0);
    expect(await valuationOf(mat.zero!)).toEqual(before); // untouched
    await expectDelta0();
  });

  // 4 — 평가 정확성: 조정 가치 == |diff| × 현재 MAP (이동평균 1500에서 검증)
  it('values the adjustment at exactly |diff| × current MAP', async () => {
    await load('evalv', 'pi:eval:a', '10', '1000'); // 10 @ 1000
    await load('evalv', 'pi:eval:b', '10', '2000', '2026-04-02'); // +10 @ 2000 → MAP 1500, value 30000
    const posted = await count('evalv', 'pi:eval', '24', '2026-04-06'); // +4 gain @ MAP 1500

    const adj = posted.adjustments[0]!;
    const entry = await journals.getJournal(adj.journalId!);
    // 4 × 1500 = 6000 — the exact proportional share, not 4 × a rounded stored price.
    expect(entry.lines[0]).toMatchObject({ glAccount: '1300', drCr: 'D', amount: '6000.0000' });
    expect(entry.lines[1]).toMatchObject({ glAccount: '5910', drCr: 'C', amount: '6000.0000' });
    expect(await valuationOf(mat.evalv!)).toMatchObject({
      valuationQty: '24.000000',
      stockValue: '36000.0000', // 30000 + 6000
      movingAvgPrice: '1500.000000',
    });
    await expectDelta0();
  });

  // 5 — replay 멱등: 같은 postingKey 2회 → stock 불변, PI doc 1건, journal 1건
  it('replays idempotently on the count posting key: state unchanged, one doc, one journal', async () => {
    await load('replay', 'pi:replay:load', '10', '1000');
    const first = await count('replay', 'pi:replay', '13'); // +3 gain
    const afterFirst = await valuationOf(mat.replay!);

    const replay = await count('replay', 'pi:replay', '13');
    expect(replay.replayed).toBe(true);
    expect(replay.physicalInventoryId).toBe(first.physicalInventoryId);
    expect(replay.adjustments[0]!.goodsMovementId).toBe(first.adjustments[0]!.goodsMovementId);
    expect(await valuationOf(mat.replay!)).toEqual(afterFirst); // no double application

    const docs = await db
      .select()
      .from(schema.physicalInventoryDoc)
      .where(eq(schema.physicalInventoryDoc.postingKey, 'pi:replay'));
    expect(docs).toHaveLength(1);
    const journalRows = await db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.postingKey, `gm:${first.adjustments[0]!.goodsMovementId}`));
    expect(journalRows).toHaveLength(1);
    await expectDelta0();
  });

  // 6 — GR/GI 인터리브 후 실사: 기존 거래 + 실사 조정이 섞여도 정합 유지
  it('keeps delta 0 when normal movements (101/201) interleave with a 701 count adjustment', async () => {
    await load('inter', 'pi:inter:load', '10', '1000'); // stock 10, value 10000
    await expectDelta0();
    await movements.post({
      plantId,
      movementType: '201',
      postingDate: '2026-04-02',
      postingKey: 'pi:inter:issue',
      items: [{ materialId: mat.inter!, storageLocationId: slocA, qty: '3' }],
    }); // stock 7, value 7000
    await expectDelta0();
    await count('inter', 'pi:inter', '9', '2026-04-05'); // +2 gain @ 1000 → stock 9, value 9000
    expect(await valuationOf(mat.inter!)).toMatchObject({ valuationQty: '9.000000', stockValue: '9000.0000' });
    await movements.post({
      plantId,
      movementType: '201',
      postingDate: '2026-04-06',
      postingKey: 'pi:inter:issue2',
      items: [{ materialId: mat.inter!, storageLocationId: slocA, qty: '1' }],
    }); // stock 8, value 8000
    expect(await valuationOf(mat.inter!)).toMatchObject({ valuationQty: '8.000000', stockValue: '8000.0000' });
    await expectDelta0();
  });

  // 7 — 음수 가드: 702 손실 조정은 재고를 음수로 만들 수 없다 (엔진 over-issue 가드 상속)
  it('rejects a 702 loss adjustment that would drive stock negative (over-issue guard, nothing written)', async () => {
    await load('over', 'pi:over:load', '10', '1000'); // stock 10
    const before = await valuationOf(mat.over!);
    // The 702 path the PI loss uses (offset IDI) cannot issue more than is on stock.
    await expect(
      movements.post(
        {
          plantId,
          movementType: '702',
          postingDate: '2026-04-05',
          postingKey: 'pi:over:bad',
          items: [{ materialId: mat.over!, storageLocationId: slocA, qty: '15' }],
        },
        'system',
        { offsetKey: 'IDI' },
      ),
    ).rejects.toThrow(/over-issue/);
    expect(await valuationOf(mat.over!)).toEqual(before);
    const ghost = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, 'pi:over:bad'));
    expect(ghost).toHaveLength(0);
    await expectDelta0();
  });

  // 8 — 빈 재고 이익 거부: 평가수량 0(=MAP 없음)인 자재의 701 이익은 평가 불가 → 거부
  it('rejects a 701 gain on a material with no on-hand stock (no MAP); the count stays COUNTED, delta 0', async () => {
    // mat.empty has a valuation view but never received stock (valuation_qty 0, no MAP).
    await expect(count('empty', 'pi:empty', '5')).rejects.toThrow(/no stock at this plant/);
    // The adjustment movement rolled back atomically; no stock change.
    expect((await valuationOf(mat.empty!)).valuationQty).toBe('0.000000');
    // The count document was snapshotted (doc-first) but never flipped to POSTED — an honest
    // "counted, adjustment failed" record (a re-count with the same key re-attempts the posting).
    const [doc] = await db
      .select()
      .from(schema.physicalInventoryDoc)
      .where(eq(schema.physicalInventoryDoc.postingKey, 'pi:empty'));
    expect(doc?.status).toBe('COUNTED');
    // No 701 adjustment movement materialized for this count.
    const gms = await db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.postingKey, `pi:${doc!.id}:701`));
    expect(gms).toHaveLength(0);
    await expectDelta0();
  });
});
