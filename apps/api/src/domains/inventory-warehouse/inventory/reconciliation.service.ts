import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';
import { DB } from '../../../database/database.module.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { BSX_KEY } from '../goods-movement/goods-movement.service.js';

export interface ReconciliationRow {
  currency: string;
  /** Σ material_valuation.stock_value over the company's plants — the subledger side. */
  inventoryValue: string;
  /** Σ(debit − credit) on the BSX inventory GL accounts — the GL side. */
  glBalance: string;
  /** inventoryValue − glBalance; the invariant is exactly '0.0000'. */
  delta: string;
}

/**
 * Inventory ↔ GL reconciliation (the slice's integrity proof, in lieu of a DB-trigger backstop):
 * because every journal amount IS a `stock_value` delta committed in the same transaction, the
 * total inventory value must equal the balance of the BSX accounts at ALL times — this endpoint
 * computes both sides and their delta. BSX accounts are read from `account_determination` (§4.5),
 * so the check follows configuration, never a hard-coded account list.
 */
@Injectable()
export class InventoryReconciliationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  async reconcile(companyCodeId: string): Promise<ReconciliationRow[]> {
    // Both aggregates share ONE repeatable-read snapshot: a goods movement committing between the
    // two SELECTs would otherwise land in only one side and report a spurious nonzero delta, even
    // though every movement updates stock + GL atomically (the invariant holds at every commit).
    return this.db.transaction(
      async (tx) => {
        const [company] = await tx
          .select()
          .from(schema.companyCode)
          .where(eq(schema.companyCode.id, companyCodeId));
        if (!company) throw new NotFoundException(`company code ${companyCodeId} not found`);

        // The configured BSX inventory accounts for this chart (any valuation class).
        const bsxRules = await tx
          .select({ glAccount: schema.accountDetermination.glAccount })
          .from(schema.accountDetermination)
          .where(
            and(
              eq(schema.accountDetermination.chartOfAccounts, company.chartOfAccounts ?? ''),
              eq(schema.accountDetermination.transactionKey, BSX_KEY),
            ),
          );
        const bsxAccounts = [...new Set(bsxRules.map((r) => r.glAccount))];

        // Subledger side: Σ stock_value per currency over the company's plants. stock_value is
        // already in the company's functional currency, so it ties to the GL functional balance.
        const inventory = await tx
          .select({
            currency: schema.materialValuation.currency,
            total: sql<string>`coalesce(sum(${schema.materialValuation.stockValue}), 0)`,
          })
          .from(schema.materialValuation)
          .innerJoin(schema.plant, eq(schema.materialValuation.plantId, schema.plant.id))
          .where(eq(schema.plant.companyCodeId, companyCodeId))
          .groupBy(schema.materialValuation.currency);

        // GL side: Σ(debit − credit) of FUNCTIONAL amounts per functional currency on the BSX
        // accounts. functional_amount/functional_currency (not the document amount) is what ties to
        // the functional-currency stock_value — so a future foreign-currency BSX posting still
        // reconciles (today, KRW==KRW, functional == document).
        const gl =
          bsxAccounts.length === 0
            ? []
            : await tx
                .select({
                  currency: schema.journalLine.functionalCurrency,
                  total: sql<string>`coalesce(sum(case when ${schema.journalLine.drCr} = 'D'
                    then ${schema.journalLine.functionalAmount}
                    else -${schema.journalLine.functionalAmount} end), 0)`,
                })
                .from(schema.journalLine)
                .innerJoin(
                  schema.journalEntry,
                  eq(schema.journalLine.journalEntryId, schema.journalEntry.id),
                )
                .where(
                  and(
                    eq(schema.journalEntry.companyCodeId, companyCodeId),
                    inArray(schema.journalLine.glAccount, bsxAccounts),
                  ),
                )
                .groupBy(schema.journalLine.functionalCurrency);

        const currencies = [
          ...new Set([...inventory.map((r) => r.currency), ...gl.map((r) => r.currency)]),
        ].sort();
        return currencies.map((currency) => {
          const inv = this.toMoney(inventory, currency);
          const bal = this.toMoney(gl, currency);
          return {
            currency,
            inventoryValue: inv.toNumeric(),
            glBalance: bal.toNumeric(),
            delta: inv.subtract(bal).toNumeric(),
          };
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /** Exact-Money normalization of a PG SUM() numeric string (never float math, §3.1). */
  private toMoney(rows: { currency: string; total: string }[], currency: string): Money {
    const raw = rows.find((r) => r.currency === currency)?.total ?? '0';
    return Money.fromNumeric(raw, currency as CurrencyCode, this.registry);
  }
}
