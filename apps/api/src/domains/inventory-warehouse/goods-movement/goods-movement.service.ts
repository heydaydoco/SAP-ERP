import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@erp/db';
import { Money, type PostingLine } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';
import { DB } from '../../../database/database.module.js';
import { FiscalPeriodService } from '../../platform/admin-config/fiscal-period.service.js';
import { AccountDeterminationService } from '../../platform/admin-config/account-determination.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import {
  DOC_FLOW_TYPE as JOURNAL_DOC_FLOW_TYPE,
  JournalService,
} from '../../finance-accounting/general-ledger/journal.service.js';
import {
  averagePrice6,
  formatScaled6,
  parseScaled6,
  receiptValue,
  valueAtAverage,
} from '../inventory/map.js';
import {
  ISSUE_TYPES,
  PRICED_TYPES,
  type CreateGoodsMovementDto,
  type GoodsMovementQuery,
} from './goods-movement.dto.js';

/** Journal doc types (SAP BLART essence): WE = goods receipt, WA = goods issue. */
export const DOC_TYPE_GOODS_RECEIPT = 'WE';
export const DOC_TYPE_GOODS_ISSUE = 'WA';
/** The movement document's own doc_type (header column; one type per document). */
export const DOC_TYPE_GOODS_MOVEMENT = 'GM';
/** doc_flow node type for goods movements; a POSTS edge links the movement to its journal. */
export const DOC_FLOW_TYPE = 'inventory.goods_movement';
export const DOC_FLOW_REL_POSTS = 'POSTS';

/** Number-range object — per-fiscal-year scope, seeded as ('inventory.goods_movement', '2026', 'GM-2026-'). */
const NUMBER_OBJECT = 'inventory.goods_movement';

/**
 * Account-determination transaction keys (§4.5, SAP T030 essence), discriminated by the valuation
 * class on `material_valuation`: BSX = the inventory (stock) account, GBB = the offsetting account
 * (initial-load equity / consumption / inventory gain-loss share one offset per class in this
 * slice — account modifiers come with procurement).
 */
export const BSX_KEY = 'BSX';
export const GBB_KEY = 'GBB';

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}

/** NUMERIC(18,6) quantity: ≤12 integer digits, so the scale-6 value is < 10^18. */
const QTY_MAX_SCALED = 10n ** 18n;
/** NUMERIC(18,4) value: ≤14 integer digits, expressed in the currency's minor units. */
const VALUE_MAX_MINOR = (minorUnit: number): bigint => 10n ** BigInt(14 + minorUnit);

function assertFitsQty(qty6: bigint, code: string): void {
  if (qty6 >= QTY_MAX_SCALED) {
    throw new BadRequestException(`quantity for ${code} exceeds the storable range (NUMERIC(18,6))`);
  }
}

function assertFitsValue(value: Money, code: string): void {
  const abs = value.minorUnits < 0n ? -value.minorUnits : value.minorUnits;
  if (abs >= VALUE_MAX_MINOR(value.minorUnit)) {
    throw new BadRequestException(`value for ${code} exceeds the storable range (NUMERIC(18,4))`);
  }
}

export interface PostedGoodsMovement {
  goodsMovementId: string;
  docNo: string;
  status: string;
  /** NULL only for a zero-value movement (no GL impact — e.g. a receipt priced at 0). */
  journalId: string | null;
}

/** In-tx running valuation state per material (the SELECT FOR UPDATE snapshot + applied items). */
interface ValuationState {
  rowId: string;
  valuationClass: string;
  qty6: bigint;
  value: Money;
  /** Stored scale-6 price; recomputed on quantity-increasing movements, kept on issues. */
  avgPrice6: bigint;
  lastMovementDate: string | null;
}

/** In-tx running storage-location stock state. */
interface StockState {
  qty6: bigint;
}

/**
 * Goods movement engine (inventory-warehouse.goods-movement) — the SINGLE source of stock changes
 * → FI (domain CLAUDE.md). One movement document = stock update + valuation (MAP) update + the
 * balanced FI journal, committed ATOMICALLY: the service opens the transaction, locks each touched
 * `material_valuation` row with SELECT FOR UPDATE (serializing MAP recalculation per
 * material×plant — the §3-C concurrency guarantee), and hands its tx to `JournalService.post()`
 * (`PostOptions.tx`), so the journal exists iff the stock change does (§5.2).
 *
 * Valuation rules (MAP):
 *  - 561/101 priced receipts: value = qty × unitPrice (exact `Money`, half-away); the moving
 *    average becomes new_value / new_qty.
 *  - 201/711 issues: valued at the CURRENT average — the exact proportional share of
 *    `stock_value`, so a full issue empties the value to zero; the average price is INVARIANT.
 *  - 712 surplus: quantity in at the current average (MAP-neutral); rejected on empty stock
 *    (no average to value it at).
 * Every journal amount IS a `stock_value` delta, so Σ stock_value == BSX GL balance at all times
 * (the /reconciliation invariant). GL accounts come from account_determination (BSX/GBB by
 * valuation class) — never hard-coded (§4.5).
 *
 * Guards: over-issue (storage-location and plant level) → 400; backdating before the pair's last
 * movement → 400 (MAP is order-sensitive); missing valuation row (the "accounting view",
 * pre-ensured via /material-valuations) → 400. Idempotent on `postingKey` per plant — a replay
 * returns the existing document; the UNIQUE gate serializes concurrent duplicates.
 */
@Injectable()
export class GoodsMovementService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly fiscal: FiscalPeriodService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly journals: JournalService,
    private readonly accountDetermination: AccountDeterminationService,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  async post(dto: CreateGoodsMovementDto, actor = 'system'): Promise<PostedGoodsMovement> {
    const postingKey = dto.postingKey ?? `gm:${randomUUID()}`;

    // Idempotency (§5.2): a replay returns the existing document's live state.
    const existing = await this.findByPostingKey(dto.plantId, postingKey);
    if (existing) return this.toPosted(existing);

    const company = await this.getPlantCompany(dto.plantId);
    const currency = company.currency as CurrencyCode;
    const zero = Money.zero(currency, this.registry);

    // Fail fast on the period lock (post() re-checks in-tx); the fiscal year scopes the number range.
    const period = await this.fiscal.resolveOpenPeriod(company.companyCodeId, dto.postingDate);

    await this.getStorageLocations(dto); // existence + plant-membership validation
    const materials = await this.getMaterials(dto);

    const movementType = dto.movementType;
    const priced = PRICED_TYPES.has(movementType);
    const isIssue = ISSUE_TYPES.has(movementType);
    const documentDate = dto.documentDate ?? dto.postingDate;

    try {
      return await this.db.transaction(async (tx) => {
        // 1) Header first — the (plant, posting_key) UNIQUE gate serializes duplicate posts ASAP.
        const docNo = await this.numbering.next(NUMBER_OBJECT, String(period.fiscalYear), tx);
        const [header] = await tx
          .insert(schema.goodsMovement)
          .values({
            docType: DOC_TYPE_GOODS_MOVEMENT,
            docNo,
            status: 'POSTED',
            postingKey,
            movementType,
            plantId: dto.plantId,
            postingDate: dto.postingDate,
            documentDate,
            currency,
            headerText: dto.headerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.goodsMovement.id });
        if (!header) throw new Error('goods_movement insert returned no row');

        // 2) Lock every touched valuation row in SORTED material order (deadlock-free across
        //    concurrent multi-item movements), snapshot state, and run the guards that need it.
        const states = new Map<string, ValuationState>();
        const materialIds = [...new Set(dto.items.map((i) => i.materialId))].sort();
        for (const materialId of materialIds) {
          const [row] = await tx
            .select()
            .from(schema.materialValuation)
            .where(
              and(
                eq(schema.materialValuation.materialId, materialId),
                eq(schema.materialValuation.plantId, dto.plantId),
              ),
            )
            .for('update');
          if (!row) {
            throw new BadRequestException(
              `no material valuation (accounting view) for material ${this.materialCode(
                materials,
                materialId,
              )} at this plant — ensure it via /inventory-warehouse/material-valuations first`,
            );
          }
          if (row.currency !== currency) {
            throw new ConflictException(
              `material valuation currency ${row.currency} differs from the company's functional ` +
                `currency ${currency}`,
            );
          }
          // Backdating guard: MAP is order-sensitive — a movement may never post before the
          // pair's latest movement (it would rewrite a history the average already consumed).
          if (row.lastMovementDate && dto.postingDate < row.lastMovementDate) {
            throw new BadRequestException(
              `posting date ${dto.postingDate} is before the last movement ` +
                `(${row.lastMovementDate}) for material ${this.materialCode(materials, materialId)} ` +
                `at this plant — backdated movements are not allowed`,
            );
          }
          states.set(materialId, {
            rowId: row.id,
            valuationClass: row.valuationClass,
            qty6: parseScaled6(row.valuationQty),
            value: Money.fromNumeric(row.stockValue, currency, this.registry),
            avgPrice6: parseScaled6(row.movingAvgPrice),
            lastMovementDate: row.lastMovementDate,
          });
        }

        // 3) Storage-location stock rows — ensured (idempotent) then read UNDER the valuation
        //    lock (every movement of the pair holds it, so plain reads are race-free).
        const stockStates = new Map<string, StockState>();
        const stockKey = (materialId: string, slocId: string): string => `${materialId}:${slocId}`;
        for (const item of dto.items) {
          const key = stockKey(item.materialId, item.storageLocationId);
          if (stockStates.has(key)) continue;
          await tx
            .insert(schema.stock)
            .values({
              materialId: item.materialId,
              plantId: dto.plantId,
              storageLocationId: item.storageLocationId,
              qty: '0',
              createdBy: actor,
              updatedBy: actor,
            })
            .onConflictDoNothing({
              target: [schema.stock.materialId, schema.stock.storageLocationId],
            });
          const [row] = await tx
            .select()
            .from(schema.stock)
            .where(
              and(
                eq(schema.stock.materialId, item.materialId),
                eq(schema.stock.storageLocationId, item.storageLocationId),
              ),
            );
          if (!row) throw new Error('stock row missing after ensure');
          stockStates.set(key, { qty6: parseScaled6(row.qty) });
        }

        // 4) Value each item in line order against the RUNNING state (duplicate materials in one
        //    document compound correctly), apply the §3.1 exact-Money math from map.ts.
        const accounts = new Map<string, { bsx: string; gbb: string }>();
        const lines: PostingLine[] = [];
        const itemRows: (typeof schema.goodsMovementItem.$inferInsert)[] = [];
        for (const [i, item] of dto.items.entries()) {
          const state = states.get(item.materialId);
          if (!state) throw new Error('valuation state missing'); // unreachable
          const stockState = stockStates.get(stockKey(item.materialId, item.storageLocationId));
          if (!stockState) throw new Error('stock state missing'); // unreachable
          const qty6 = parseScaled6(item.qty);
          const code = this.materialCode(materials, item.materialId);

          let amount: Money;
          if (priced) {
            // 561/101: externally priced receipt — recalculates the moving average.
            amount = receiptValue(qty6, parseScaled6(item.unitPrice ?? '0'), zero);
            state.qty6 += qty6;
            state.value = state.value.add(amount);
            state.avgPrice6 = averagePrice6(state.qty6, state.value);
            stockState.qty6 += qty6;
          } else if (isIssue) {
            // 201/711: issue at the current average; the average itself is INVARIANT.
            if (qty6 > stockState.qty6) {
              throw new BadRequestException(
                `over-issue: item ${i + 1} takes ${item.qty} of ${code} but only ` +
                  `${formatScaled6(stockState.qty6)} is on stock at the storage location`,
              );
            }
            if (qty6 > state.qty6) {
              // Unreachable while Σ sloc == plant qty holds; kept as an explicit guard.
              throw new BadRequestException(
                `over-issue: item ${i + 1} takes ${item.qty} of ${code} but only ` +
                  `${formatScaled6(state.qty6)} is valuated at the plant`,
              );
            }
            amount = valueAtAverage(qty6, state.qty6, state.value);
            state.qty6 -= qty6;
            state.value = state.value.subtract(amount);
            stockState.qty6 -= qty6;
          } else {
            // 712 surplus: quantity in at the current average (MAP-neutral) — needs an average.
            if (state.qty6 <= 0n) {
              throw new BadRequestException(
                `movement type 712 values the surplus at the current moving average, but material ` +
                  `${code} has no stock at this plant — post a priced receipt (561/101) instead`,
              );
            }
            // allowExceed: a surplus may legitimately exceed the book quantity (count > book).
            amount = valueAtAverage(qty6, state.qty6, state.value, true);
            state.qty6 += qty6;
            state.value = state.value.add(amount);
            state.avgPrice6 = averagePrice6(state.qty6, state.value);
            stockState.qty6 += qty6;
          }

          // Column-fit guard (§3.1): the DTO caps each input at NUMERIC(18,6), but a qty × price
          // product — or accumulation across items/documents — can still exceed the persisted
          // NUMERIC(18,4) value / NUMERIC(18,6) qty columns. Catch it as a 400 here instead of
          // letting the INSERT raise a raw Postgres 22003 (which would surface as a 500).
          assertFitsValue(amount, code);
          assertFitsValue(state.value, code);
          assertFitsQty(state.qty6, code);
          assertFitsQty(stockState.qty6, code);

          itemRows.push({
            goodsMovementId: header.id,
            lineNo: i + 1,
            materialId: item.materialId,
            storageLocationId: item.storageLocationId,
            qty: formatScaled6(qty6),
            unitPrice: priced ? formatScaled6(parseScaled6(item.unitPrice ?? '0')) : null,
            amount: amount.toNumeric(),
            currency,
            createdBy: actor,
            updatedBy: actor,
          });

          // Journal lines: receipt Dr BSX / Cr GBB · issue Dr GBB / Cr BSX — amounts ARE the
          // stock_value deltas, so GL and valuation cannot drift. Zero-value items post nothing.
          if (!amount.isZero()) {
            const acct = await this.resolveAccounts(accounts, state.valuationClass, company, tx);
            const lineText = `${movementType} ${code} x ${formatScaled6(qty6)}`;
            const stockSide = isIssue ? ('C' as const) : ('D' as const);
            const offsetSide = isIssue ? ('D' as const) : ('C' as const);
            lines.push(
              { glAccount: acct.bsx, drCr: stockSide, money: amount, lineText },
              { glAccount: acct.gbb, drCr: offsetSide, money: amount, lineText },
            );
          }
        }

        // 5) Persist the running states: absolute writes, safe under the valuation row lock.
        for (const state of states.values()) {
          await tx
            .update(schema.materialValuation)
            .set({
              valuationQty: formatScaled6(state.qty6),
              stockValue: state.value.toNumeric(),
              movingAvgPrice: formatScaled6(state.avgPrice6),
              lastMovementDate: dto.postingDate,
              updatedAt: new Date(),
              updatedBy: actor,
            })
            .where(eq(schema.materialValuation.id, state.rowId));
        }
        for (const [key, stockState] of stockStates) {
          const [materialId, storageLocationId] = key.split(':') as [string, string];
          await tx
            .update(schema.stock)
            .set({
              qty: formatScaled6(stockState.qty6),
              updatedAt: new Date(),
              updatedBy: actor,
            })
            .where(
              and(
                eq(schema.stock.materialId, materialId),
                eq(schema.stock.storageLocationId, storageLocationId),
              ),
            );
        }
        await tx.insert(schema.goodsMovementItem).values(itemRows);

        // 6) The FI journal — through the ONE writer (§3.2), joining THIS tx (§5.2): the journal
        //    commits iff the stock update does. A zero-value movement has no GL impact (no lines).
        let journalId: string | null = null;
        if (lines.length > 0) {
          // Journal key derives from the movement's OWN id, not its (plant-scoped) posting key:
          // the journal gate is company-scoped, so a client reusing a key across two plants of one
          // company would otherwise collide there and make the second movement unpostable. The
          // movement's exactly-once guarantee lives at its UNIQUE(plant, posting_key) header gate
          // (inserted in step 1, before this), so the journal key only needs per-movement
          // uniqueness — header.id (a fresh uuid) provides it.
          const journalKey = `gm:${header.id}`;
          const posted = await this.journals.post(
            {
              postingKey: journalKey,
              companyCodeId: company.companyCodeId,
              postingDate: dto.postingDate,
              documentDate,
              docType: isIssue ? DOC_TYPE_GOODS_ISSUE : DOC_TYPE_GOODS_RECEIPT,
              currency,
              reference: `${DOC_FLOW_TYPE}:${docNo}`,
              headerText: dto.headerText,
              lines,
            },
            actor,
            { tx },
          );
          journalId = posted.journalId;
          // §4.3 traceability: movement → journal, in the SAME tx (lineage exists iff both do).
          await this.docFlow.link(
            {
              sourceType: DOC_FLOW_TYPE,
              sourceId: header.id,
              targetType: JOURNAL_DOC_FLOW_TYPE,
              targetId: journalId,
              relType: DOC_FLOW_REL_POSTS,
            },
            tx,
          );
        } else {
          // Zero-value movement (e.g. a receipt priced at 0): no journal, so the in-tx period
          // re-check that `post()` would run never fires. Re-resolve here on `tx` for parity, so a
          // period closing between the fail-fast check and COMMIT still blocks the stock change.
          await this.fiscal.resolveOpenPeriod(company.companyCodeId, dto.postingDate, tx);
        }

        return { goodsMovementId: header.id, docNo, status: 'POSTED', journalId };
      });
    } catch (e) {
      // Concurrent duplicate post: the UNIQUE(plant, posting_key) gate fired — replay the winner.
      if (isUniqueViolation(e, 'goods_movement_posting_key_uq')) {
        const winner = await this.findByPostingKey(dto.plantId, postingKey);
        if (winner) return this.toPosted(winner);
      }
      throw e;
    }
  }

  /** Header + items (line order), or 404. `journalId` from the POSTS doc_flow edge. */
  async getMovement(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.id, id));
    if (!header) throw new NotFoundException(`goods movement ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.goodsMovementItem)
      .where(eq(schema.goodsMovementItem.goodsMovementId, id))
      .orderBy(asc(schema.goodsMovementItem.lineNo));
    return { ...header, items, journalId: await this.journalIdOf(id) };
  }

  async listMovements(q: GoodsMovementQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.goodsMovement)
      .where(this.listWhere(q))
      .orderBy(desc(schema.goodsMovement.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countMovements(q: GoodsMovementQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.goodsMovement)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: GoodsMovementQuery) {
    return and(
      q.plantId ? eq(schema.goodsMovement.plantId, q.plantId) : undefined,
      q.movementType ? eq(schema.goodsMovement.movementType, q.movementType) : undefined,
    );
  }

  private async getPlantCompany(plantId: string) {
    const [row] = await this.db
      .select({
        plantId: schema.plant.id,
        companyCodeId: schema.companyCode.id,
        companyCode: schema.companyCode.code,
        currency: schema.companyCode.currency,
        chartOfAccounts: schema.companyCode.chartOfAccounts,
      })
      .from(schema.plant)
      .innerJoin(schema.companyCode, eq(schema.plant.companyCodeId, schema.companyCode.id))
      .where(eq(schema.plant.id, plantId));
    if (!row) throw new NotFoundException(`plant ${plantId} not found`);
    if (!row.chartOfAccounts) {
      throw new ConflictException(`company code ${row.companyCode} has no chart of accounts`);
    }
    return { ...row, chartOfAccounts: row.chartOfAccounts };
  }

  /** Validate every item storage location exists AND belongs to the header plant. */
  private async getStorageLocations(dto: CreateGoodsMovementDto) {
    const ids = [...new Set(dto.items.map((i) => i.storageLocationId))];
    const rows = await this.db
      .select()
      .from(schema.storageLocation)
      .where(inArray(schema.storageLocation.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const sloc = byId.get(id);
      if (!sloc) throw new NotFoundException(`storage location ${id} not found`);
      if (sloc.plantId !== dto.plantId) {
        throw new BadRequestException(
          `storage location ${sloc.code} belongs to another plant than the document's`,
        );
      }
    }
    return byId;
  }

  private async getMaterials(dto: CreateGoodsMovementDto) {
    const ids = [...new Set(dto.items.map((i) => i.materialId))];
    const rows = await this.db
      .select({ id: schema.material.id, code: schema.material.code })
      .from(schema.material)
      .where(inArray(schema.material.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      if (!byId.has(id)) throw new NotFoundException(`material ${id} not found`);
    }
    return byId;
  }

  private materialCode(materials: Map<string, { code: string }>, id: string): string {
    return materials.get(id)?.code ?? id;
  }

  /**
   * Resolve + memoize the BSX/GBB pair for a valuation class (§4.5 — config, never hard-coded).
   * Reads ride the movement tx (sequentially — a tx connection runs one query at a time), so a
   * full pool of concurrent movements cannot starve the lookup.
   */
  private async resolveAccounts(
    cache: Map<string, { bsx: string; gbb: string }>,
    valuationClass: string,
    company: { companyCode: string; chartOfAccounts: string },
    tx: Transaction,
  ): Promise<{ bsx: string; gbb: string }> {
    const cached = cache.get(valuationClass);
    if (cached) return cached;
    const key = {
      chartOfAccounts: company.chartOfAccounts,
      valuationClass,
      companyCode: company.companyCode,
    };
    const bsx = await this.accountDetermination.resolve({ transactionKey: BSX_KEY, ...key }, tx);
    const gbb = await this.accountDetermination.resolve({ transactionKey: GBB_KEY, ...key }, tx);
    const pair = { bsx, gbb };
    cache.set(valuationClass, pair);
    return pair;
  }

  private async journalIdOf(goodsMovementId: string): Promise<string | null> {
    const edges = await this.docFlow.forward(DOC_FLOW_TYPE, goodsMovementId);
    return edges.find((e) => e.relType === DOC_FLOW_REL_POSTS)?.targetId ?? null;
  }

  private async findByPostingKey(plantId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.goodsMovement)
      .where(
        and(
          eq(schema.goodsMovement.plantId, plantId),
          eq(schema.goodsMovement.postingKey, postingKey),
        ),
      );
    return row;
  }

  private async toPosted(row: {
    id: string;
    docNo: string;
    status: string;
  }): Promise<PostedGoodsMovement> {
    return {
      goodsMovementId: row.id,
      docNo: row.docNo,
      status: row.status,
      journalId: await this.journalIdOf(row.id),
    };
  }
}
