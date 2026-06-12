# Domain: Inventory & Warehouse `inventory-warehouse`

> **SAP mapping:** MM-IM + WM/EWM
> Loads automatically when working under `apps/api/src/domains/inventory-warehouse/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/inventory-warehouse.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `inventory` ✅ — `material_valuation` (MAP accounting view, §4.4 extension) + `stock` (qty per
  storage location) + the inventory↔GL `/reconciliation` check
- `goods-movement` ✅ — PO-free direct movements (561/101/201/711/712) posting stock + valuation +
  FI journal in ONE transaction
- `warehouse` · `batch-serial` · `stock-taking` — later

## Status
🟧 **In progress (Phase 3, slice 1 shipped; slice 2 extended it).** Moving-average (MAP) valuation +
goods movements + inventory↔GL reconciliation (migration **0010**). Slice 2 (procurement P2P) added
the **caller-options hook** on `GoodsMovementService.post()` — `offsetKey` (default `GBB`; a
PO-linked GR passes `WRX`) + caller doc_flow links (header / per-item `RECEIVES` edges), all inside
the movement's own tx; the public REST path is unchanged (PO-free movements stay byte-identical).
Slice 3 (import procurement) added PASSTHROUGH import trade-trace columns on `goods_movement_item`
(`document_currency` / `exchange_rate` / `document_amount`, migration **0012**): the engine persists
them but still values stock ONLY in the functional currency — a foreign GR's KRW is pre-translated by
the procurement caller (Option P), so the engine and the `material_valuation` invariant are untouched.
Deferred: PR, landed cost, movement **reversal** (102/202 — the doc framework's reversal-pair
columns are deliberately absent until then), negative stock, FIFO, transfer postings, batch/serial,
physical-inventory documents (711/712 post directly today), UI screens, OpenAPI registry entries
(web client can't see these endpoints yet).

> **Note:** `goods-movement` is the single source of stock changes → FI. MAP only in this slice.

## Domain rules
- **One movement = one transaction.** `GoodsMovementService.post()` updates `stock` +
  `material_valuation` AND posts the journal through `JournalService.post(…, { tx })`
  (`PostOptions.tx`, the §5.2 caller-tx mode) — the journal exists iff the stock change does.
  Never write stock/valuation outside this service; never post inventory GL any other way.
- **`material_valuation` is the reconciliation anchor.** `stock_value` (NUMERIC(18,4), exact
  `Money`) is what sits on the BSX account for that (material, plant); every journal amount IS a
  `stock_value` delta. `moving_avg_price` (scale 6) is DERIVED (`stock_value / valuation_qty`) —
  never recompute value FROM the price. Valuation currency == company functional currency, so
  movements take the KRW==KRW identity path in fi-posting.
- **MAP math lives in `inventory/map.ts`** (pure, §5.4 unit-tested): priced receipts (561/101)
  value at `qty × unitPrice` and recalc the average; issues (201/711) value at the EXACT
  proportional share of `stock_value` (= current MAP without double rounding) and leave the
  average INVARIANT (it survives an emptied stock, SAP VERPR); 712 surplus adds at the current
  average (MAP-neutral; rejected on empty stock). A FULL issue takes the entire remaining value —
  zero qty ⇒ zero value (backed by the `material_valuation_empty_zero_ck` CHECK).
- **Concurrency:** the valuation row is locked with **SELECT FOR UPDATE** (rows pre-ensured via
  `/material-valuations` — the accounting view MUST exist before the first movement); all
  valuation/stock writes happen under that lock (absolute writes of in-tx running state). Lock
  order: number range → movement header → valuation rows in **sorted material order** → stock.
- **Guards (all BadRequest):** over-issue at storage-location AND plant level (plus the DB
  `stock_qty_nonneg_ck` backstop); **backdating** — a movement may not post before the pair's
  `last_movement_date` (MAP is order-sensitive); missing valuation row; 712 on empty stock.
  Period lock enforced via fi-posting (fail-fast pre-check + in-tx re-check).
- **Idempotency (§5.2):** `posting_key` NOT NULL, UNIQUE per **plant**; replay returns the live
  document; concurrent duplicates serialize on the UNIQUE gate. The journal's key is
  `gm:<movement uuid>` — derived from the movement's own id, NOT its (plant-scoped) client key:
  the journal gate is company-scoped, so two plants of one company reusing a client key would
  otherwise collide there (the movement's own per-plant gate is the exactly-once guarantee, so the
  journal key only needs per-movement uniqueness). In caller-tx mode `JournalService.post()`
  REFUSES a pre-existing journal key (Conflict) instead of replaying — pairing new stock state
  with an old journal would drift the subledger; the atomicity test proves the rollback.
- **Goods-movement journals are reversal-protected at the FI layer:** `JournalService.reverse()`
  refuses any journal that is the target of a live `POSTS` doc_flow edge — a WE/WA journal mirrors
  `stock_value`, so reversing it on the GL alone would drift the subledger. Correction is the
  owning movement's (future) reversal, not FI reversal (SAP FB08-refuses-MM-docs semantics).
- **Numbering = a year-scoped serialization point.** `inventory.goods_movement` is allocated as the
  first in-tx statement (gap-free numbering needs an in-tx counter), so movements in the same
  fiscal year effectively serialize on that range row. Correct and deadlock-free (header-first
  also gives the clean idempotency replay); throughput-bounding is acceptable for this slice and
  revisited if movement volume needs it.
- **Account determination (§4.5):** `BSX` (stock) / offset keyed by `valuation_class`
  (lives on `material_valuation`, seeded 3000 raw / 7920 finished → KR01 1300/1310 · 5100/5110).
  The offset key defaults to `GBB`; a caller may pass `GoodsMovementPostOptions.offsetKey`
  (procurement's GR passes `WRX` → GR/IR clearing). No hard-coded accounts; a missing rule aborts
  the whole movement atomically.
- **Caller lineage (slice 2):** `GoodsMovementPostOptions.headerDocFlowLinks` /
  `itemDocFlowLinks[i]` write doc_flow edges from the movement (`inventory.goods_movement`) and its
  lines (`inventory.goods_movement_item`, by input index → line_no) inside the movement tx — the
  engine owns the item ids, so inventory stays PO-agnostic while procurement gets exact lineage.
- **Reconciliation:** `GET /inventory-warehouse/reconciliation?companyCodeId=` returns
  Σ `stock_value` vs BSX GL balance per **functional** currency; **delta must be `0.0000` at all
  times** (the integration suite asserts it after every step). Both aggregates run in ONE
  repeatable-read snapshot (a movement committing between them would otherwise show a spurious
  delta), and the GL side sums `functional_amount`/`functional_currency` (what ties to the
  functional-currency `stock_value`). This is the slice's integrity proof — a DB-trigger backstop
  was deliberately deferred.
- **No movement edits.** Posted movements are immutable (status CHECK allows only POSTED);
  corrections will be reversal movements in a follow-up slice.
- Zero-value movements (e.g. a receipt priced 0) update stock WITHOUT a journal (`journalId`
  null) — nothing moves on the GL, delta stays 0.

## Key tables (migration 0010)
- `material_valuation` — §4.4 extension: (material, plant) UNIQUE; `valuation_class`,
  `valuation_qty` (18,6), `moving_avg_price` (18,6, derived), `stock_value` (18,4, anchor),
  `currency`, `last_movement_date` (backdating guard). CHECKs: qty ≥ 0, value ≥ 0, empty ⇒ zero.
- `stock` — qty only, (material, storage location) UNIQUE + denormalized `plant_id`; CHECK qty ≥ 0.
  A composite FK `(storage_location_id, plant_id) → storage_location(id, plant_id)` pins the
  denormalized plant to the location's own plant at the DB level (a mismatch — which would break
  Σ stock.qty == valuation_qty — is impossible to persist, service bug or not).
- `goods_movement` — §4.2 doc framework, tightened: status POSTED-only, `posting_key` NN, UNIQUE
  (plant, posting_key); `movement_type` CHECK ∈ {561,101,201,711,712}; `doc_no` `GM-<year>-NNNNNN`
  from number range `inventory.goods_movement` (per-fiscal-year scope).
- `goods_movement_item` — qty > 0 (magnitude; direction lives on the header type), `unit_price`
  (receipts, ALWAYS in the functional currency — an import GR's caller pre-translates), `amount` = the
  exact stock_value delta (= journal line amount, functional currency). Import trade trace (0012):
  `document_currency` / `exchange_rate` / `document_amount` (NULL domestic) — PASSTHROUGH audit, never
  valued from.

## FI postings
- `POST /inventory-warehouse/goods-movements` → journal `WE` (receipts 561/101/712:
  **Dr BSX / Cr GBB**) or `WA` (issues 201/711: **Dr GBB / Cr BSX**) — a PO-linked GR (service
  call from procurement, not this endpoint) swaps the offset to **WRX** — one Dr/Cr pair per item,
  amounts in functional currency; `reference` = `inventory.goods_movement:<docNo>`; journal doc_no
  stays on the JE range (movement doc types own no JE range yet). Traceability: doc_flow edge
  `inventory.goods_movement` —`POSTS`→ `finance.journal_entry` (§4.3), same tx.

## Domain events
- None of its own yet: the value-moving fact rides the journal's outbox event
  (`finance.journal.posted`, reference `inventory.goods_movement:<docNo>`, same tx). A dedicated
  movement event + relay consumer is a follow-up.

## Permissions
`inventory:goods_movement:{post,read}` · `inventory:material_valuation:{manage,read}` ·
`inventory:stock:read` (declared on controllers; ADMIN `*` covers them.)
