# Domain: Sales `sales`

> **SAP mapping:** SD
> Loads automatically when working under `apps/api/src/domains/sales/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/sales.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `sales-order` ✅ — SO header+items (selling commitment, no FI) — the MIRROR of `purchase_order`
- `delivery` ✅ — GI against a SO, REUSING the inventory goods-movement engine (601 → COGS)
- `billing` ✅ — bills delivered qty → AR open item + revenue + output VAT — the MIRROR of `invoice_verification`
- `inquiry-quotation` · `pricing` · `credit-management` · `returns` — later

## Status
🟧 **In progress (Phase 3 slice 5 shipped: O2C SO→Delivery/GI→Billing, migration 0014).** The O2C
slice mirrors P2P (PO→GR→IV). A SO is the selling commitment (no FI). A delivery's goods issue is NOT a
new engine — it REUSES the goods-movement engine (movement type **601**, the single source of stock
changes → FI) with the offset routed to **COGS (매출원가)** and `DELIVERS` lineage onto the SO, so stock
decrement + the WA journal (**Dr COGS / Cr BSX**, both at the current MAP) + lineage commit in ONE engine
transaction; a thin `delivery` wrapper (출고전표 + ship-to) adopts the GI's `GM-<year>` doc number.
Billing bills DELIVERED quantities (open-to-bill = Σdelivered − Σbilled), posting a `DR` AR journal
(**Dr AR / Cr revenue / Cr output VAT**) through the same `JournalService.post(…,{tx})` and reusing the
AR recon substitution + tax-line builder; a foreign (export) billing translates every line at its own
document-date 'M' rate (single rate per billing). **Deferred:** returns / credit memo, ATP, pricing-
condition reuse (v1 takes the SALES price from the DTO, P-A), contract/SLA, delivery/GI/billing
**cancel/reversal** (billing is FI-reversible via `JournalService.reverse()`; delivery reversal waits on
the engine's 602/movement reversal slice), **unrealized FX**, the outbox relay, customer sales-area, a
real VKOA (revenue accounts come from the DTO), L/C 분할네고, and an `export_declaration` table.

> **Note:** billing → FI: (Dr) AR / (Cr) revenue + output VAT. COGS recognition rides the GI (601), not
> billing — revenue (billing) and COGS (delivery) are decoupled, exactly like SAP.

## Domain rules
- **A SO posts NOTHING to FI.** It is the selling commitment; value moves at delivery/GI (COGS + stock)
  and billing (AR + revenue + VAT). A SO may be FOREIGN-currency (export) — the currency only has to
  exist in the master (validated at SO creation); billing resolves the document-date rate per invoice.
  All lines of a SO carry the header currency (§11, service-enforced).
- **Delivery is not a new engine.** `DeliveryService` builds a movement-type-**601** document (UNPRICED
  — the engine values it at the current MAP) and calls `GoodsMovementService.post(dto, actor, opts)` with
  `opts.offsetKey = 'COGS'` — so stock + valuation + the WA journal (**Dr COGS / Cr BSX**, both legs at
  `valueAtAverage`, MAP unchanged) + SO lineage commit in ONE transaction. Never write a parallel GI
  store. The thin `delivery`/`delivery_item` wrapper is written right after, idempotent on
  `goods_movement_id` (one delivery per GI) so a replayed GI self-heals it; it ADOPTS the GI's
  `GM-<year>` doc number (§10 — no separate range). **601 is an ISSUE** (like 201/711): it is in
  `ISSUE_TYPES`, never in `PRICED_TYPES` (it carries no unit price — `unitPrice` is rejected on it).
- **Delivery/billing progress is DERIVED, never a stored flag (D4).** Delivered qty = the `DELIVERS`
  doc_flow edges (`inventory.goods_movement_item` → `sales.sales_order_item`) joined to
  `goods_movement_item.qty`; billed qty = the linked `billing_item` rows whose AR journal is NOT REVERSED
  (reversal-aware). open-to-deliver = ordered − delivered; open-to-bill = delivered − billed
  (`GET /sales/sales-orders/:id/o2c`). No counters to drift — `delivery_item.qty` is only this delivery
  note's own shipped line, never the open-qty source.
- **COGS (§4.5).** The GI offset resolves via `account_determination` `transactionKey: 'COGS'` — a SINGLE
  WILDCARD rule (no valuation class) → 5200 매출원가; the BSX (stock) leg still resolves per valuation
  class. Never hard-coded; a missing COGS rule aborts the whole GI atomically (Σ COGS == Σ BSX ==
  stock_value delta, so inventory↔GL recon stays 0 even interleaved with landed-cost revaluation).
- **Tax codes are explicit per SO line (§5).** `trade_direction` (EXP/DOM/IMP) is STORED ONLY — it NEVER
  determines the rate. A line's OUTPUT VAT code is validated at SO creation; a zero-rate (영세율) sale
  uses **V00** (OUTPUT, 0%) and its VAT journal line DROPS (the base rides its revenue line). DOM + V00
  (내국신용장/구매확인서) is legitimate and never blocked; only EXP + a taxable code raises a SOFT warning
  (in the SO create response `warnings[]`), never a block.
- **Billing posts through `JournalService.post(…,{ tx })`** — billing header/items + the `DR` journal +
  BILLS doc_flow edges commit atomically. It REUSES the AR primitives: recon-account substitution from
  the customer role (`customer.ar_recon_account`), the shared tax-line builder (D1/D2, OUTPUT VAT), and
  the open-item model — **the AR open item IS the DR journal** (D4, no second store), so clearing #13
  collects it unchanged. The revenue account comes from the DTO (D — not VKOA); the net is billed qty ×
  the SO line's SALES unit price.
- **Billing journals are FI-reversible (NOT subledger-fenced).** Unlike a GI/IV journal, a billing writes
  **no POSTS edge** onto its journal — the link is the `billing.journal_entry_id` FK — so
  `JournalService.reverse()` can correct it; `billedBySoItem` excludes REVERSED journals, so a reversal
  re-opens the billed quantity. (Delivery/GI journals stay reversal-fenced via the engine's POSTS edge.)
- **Foreign (export) billing → single document-date rate.** A foreign billing passes only `currency` +
  `documentDate` to `post()`, which translates every line at that date's 'M' rate (no per-line
  `functionalAmount` override). Multiple billings of one SO each translate at their own document date,
  so partial billings legitimately differ in KRW. **Realized FX (9810/9820) is 0 at billing** — it
  arises only at customer-payment clearing (DZ). `exchange_rate` stamps the applied rate (NULL domestic).
- **Idempotency (§5.2).** SO create is not idempotent (no posting; retries are visible duplicates by
  docNo). Delivery rides the movement's (plant, posting_key) gate — the over-delivery pre-check is
  SKIPPED on a replayed key (the derived delivered qty already includes that issue); the wrapper
  self-heals on `goods_movement_id`. Billing has its own NOT NULL `posting_key`, UNIQUE per company; a
  replay returns the stored billing; the journal key is `bl:<header uuid>` (per-document).
- **Over-delivery / over-billing guards.** Σdelivered + this delivery ≤ ordered per SO item; Σbilled +
  this billing ≤ Σdelivered per SO item — best-effort pre-checks (advisory; FI/stock integrity never
  depends on them — the engine's sloc over-issue guard does). A delivery issues lines of ONE plant.

## Key tables (migration 0014)
- `sales_order` — §4.2 header; status ∈ ORDERED/CLOSED; customer_bp_id; `currency` (functional OR a
  foreign export currency); trade hooks `incoterm`/`trade_direction`/`ship_to_country`/`zero_rate_doc_no`
  (additive nullable, Zod-validated, NO DB CHECK — §12); `doc_no` `SO-NNNNNN` (range `sales.sales_order`,
  GLOBAL scope).
- `sales_order_item` — material, plant + storage location (composite FK pins sloc→plant), ordered_qty
  (18,6) > 0, unit_price (18,6) ≥ 0 (SALES price, SO currency), optional OUTPUT tax_code.
- `delivery` — §4.2 header, POSTED-only; `sales_order_id`; `goods_movement_id` UNIQUE (the GI it wraps,
  idempotency); `doc_no` = the GI's `GM-<year>` number (adopted, no own range). `ship_to_country` snapshot.
- `delivery_item` — sales_order_item + this delivery's `qty` (NOT a cumulative counter). Explicit FK names.
- `billing` — §4.2 header, POSTED-only, posting_key NN UNIQUE(company); one SO per billing;
  `journal_entry_id` FK (the DR journal — NOT a POSTS edge, so FI reverse stays allowed); `exchange_rate`
  (18,6, NULL domestic); `doc_no` `BL-NNNNNN` (range `sales.billing`, GLOBAL). The AR open item it raises
  is the DR journal (D4), collected by clearing #13.
- `billing_item` — sales_order_item FK, billed_qty (18,6) > 0, unit_price (18,6), amount (18,4) = billed
  net (document currency), revenue_account, optional tax_code. Explicit FK names.
- No GI table — a delivery's GI IS a `goods_movement` (+ DELIVERS doc_flow lineage).
- `goods_movement_type_ck` widened to include `'601'` (the only non-additive ALTER — IN-list widen).

## FI postings
- SO → none.
- Delivery / GI → `WA` via the goods-movement engine: **Dr COGS (매출원가) / Cr BSX (stock)**, qty × the
  current MAP, functional currency; lineage `goods_movement` —DELIVERS→ `sales_order` (+ per-item edges),
  `goods_movement` —POSTS→ journal (engine-written, subledger-fenced).
- Billing → `DR` via fi-posting (caller-tx): **Dr AR recon (gross, +customer) / Cr revenue (per line,
  DTO account) / Cr output VAT (Σ per tax code; zero-rated drops)**; net = billed qty × SO price; lineage
  billing —BILLS→ SO (+ per-item edges); the journal link is the `journal_entry_id` FK (NO POSTS edge →
  FI-reversible). A foreign billing translates every line at the billing document-date rate; realized FX
  is 0 here.
- Customer payment — NOT here: clearing #13 (`DZ`) settles the billing's AR open item and recognizes
  realized FX at the settlement rate.

## Domain events
- None of its own yet: the GI rides the movement path; billing's value-moving fact rides the journal
  outbox event (`finance.journal.posted`, reference `sales.billing:<docNo>`, same tx).

## Permissions
`sales:sales_order:{create,read}` · `sales:delivery:{post,read}` · `sales:billing:{post,read}`
(declared on controllers; ADMIN `*` covers them.)
