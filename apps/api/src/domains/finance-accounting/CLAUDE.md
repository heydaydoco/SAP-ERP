# Domain: Finance & Accounting `finance-accounting`

> **SAP mapping:** FI
> Loads automatically when working under `apps/api/src/domains/finance-accounting/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/finance-accounting.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `general-ledger` ✅ — journal_entry/journal_line + the concrete fi-posting service
- `accounts-receivable` ✅ · `accounts-payable` ✅ — AR (`DR`) / AP (`KR`) invoices post through the
  same `JournalService.post()` with recon-account substitution + VAT lines (`invoice-posting/`
  holds the shared, unit-tested tax-line builder). **No `ar_invoice`/`ap_invoice` tables (D4)** —
  the journal IS the document; open items are the recon lines filtered by partner.
- `clearing` ✅ — manual full clearing of open AR/AP items (`DZ`/`KZ`) through the same
  `JournalService.post()`, recognizing realized FX gain/loss; reset via `reverse()`.
- `fixed-assets` · `tax` · `bank-reconciliation` · `period-close` · `financial-statements` — later

## Status
🟧 **In progress (Phase 2, slices 1–3 shipped).** `general-ledger`: manual journal posting
end-to-end — balanced posting, period lock, idempotency, reversal, trial balance (migration 0008).
`accounts-receivable`/`accounts-payable` (PR-B): customer/vendor invoice posting with VAT + open-item
reads (no migration — journal-only). **FX slice:** cross-currency translation through the same
`post()` — kernel `Money.convert`, per-line translation on the document date, an FX_ROUNDING plug for
the functional tie-out, optional manual-GL rate override, and the migration-**0009** functional-balance
backstop trigger. **Clearing slice:** manual FULL clearing of open AR/AP items through the same
`post()` — a `DZ`/`KZ` document moves the open item's gross against a determination-resolved cash
account and recognizes **realized** FX gain/loss (recon closes at the original invoice-date functional
value, cash at the settlement-date rate, the difference to `REALIZED_FX_GAIN`/`LOSS`); "open" stays
derived via a `CLEARS` doc_flow edge; reset = `reverse()` of the clearing. **No migration** (doc_flow
rel-type, account-determination keys, doc types, and `functional_amount` all already exist). Deferred:
**unrealized** period-end revaluation (needs period-close + auto-reversal); **partial** clearing
(residual item) and the **payment-run** batch; **bank-master / bank-reconciliation** (clearing hits a
plain cash GL for now); draft/parking, `journal_line` partitioning, the outbox relay worker, the
per-counterparty VAT truncation (절사) flag (builder supports it; no master column yet); full Korean
세금계산서 공급가액 KRW statutory conversion (per-line translation approximates it).

> **Note:** The backbone. Owns journal_entry/journal_line. Enforce immutability + reversal-only +
> period locking (§5.1). Hosts the concrete fi-posting service from the kernel.

## Domain rules
- **`JournalService` is the ONLY writer** of journal tables; it implements the kernel
  `FiPostingService`. Sibling domains import `FinanceAccountingModule` and call `post()` — never
  insert journal rows directly.
- **Balance is enforced in layers:** kernel `assertBalanced` (authoritative, per document currency)
  + `assertFunctionalBalanced` (per functional currency, FX entries) in the service → row-local
  CHECKs → 0008 deferred constraint trigger re-checking at COMMIT that Σdebit=Σcredit per (journal,
  document currency), ≥2 lines, and every line is in the header's document currency → **0009** deferred
  trigger re-checking Σdebit=Σcredit per (journal, **functional** currency) → immutability fence
  triggers (only the POSTED→REVERSED back-pointer flip may UPDATE a header; lines are write-once AND
  append-proof — they insert only in the tx that created their header).
- **Idempotency (§5.2):** `posting_key` is NOT NULL, UNIQUE **per company code** (so one tenant
  cannot probe or hijack another's keys); a replayed `post()` returns the live state of the
  existing entry. Outbox event ids are UUIDv5 of `companyCodeId:postingKey` (`posting-id.ts`), so
  retries enqueue the same event. A reversal's key is `<original>:REV` — deterministic, so
  concurrent double-reverses serialize on the UNIQUE constraint.
- **Reversal (§5.1):** posts into the CURRENT open period (default today; original period stays
  closed), passes the period lock like any posting, swaps Dr/Cr, and copies `functional_amount`
  VERBATIM — a reversal never re-translates FX.
- **Reconciliation accounts are subledger-only:** a line hitting `is_reconciliation = true` must
  carry `partner_id` (app-layer block for manual entries; `journal_line_recon_partner_ck` backs it
  at the DB). The subledger balance is BY DEFINITION the recon-account lines filtered by partner —
  there is no second store to drift.
- **`normalBalance` is NOT a posting gate** — crediting an asset is how it decreases. It is used on
  the reporting side only.
- **Sign convention:** amounts are non-negative magnitudes; the sign lives in `dr_cr` (SAP SHKZG).
- **Document numbers:** number ranges are per-fiscal-year scope; a new year needs its range
  seeded/defined before posting. Each posted doc type owns its range (SAP-style): manual `SA` + `AB`
  reversals → `finance.journal_entry` (`JE-<year>-NNNNNN`); AR `DR` → `finance.ar_invoice`
  (`DR-<year>-`); AP `KR` → `finance.ap_invoice` (`KR-<year>-`). `post()` selects by `docType`;
  `reverse()` stays on the JE range, so an AB reversing a DR/KR still gets a `JE-` number.
- **AR/AP invoices (PR-B):** the customer/vendor is sent as a BP **UUID**; the recon account is
  **substituted** from its `customer.ar_recon_account` / `vendor.ap_recon_account` role (never sent),
  and the revenue/expense account comes from the **DTO** (not VKOA account-determination). Net
  (exclusive) input; VAT is built **per line then aggregated per tax code** (D1 — equals the itemised
  세금계산서 합계세액, not a doc-total round), half-away rounded (D2). A tax code with a NULL
  `gl_account`, or of the wrong `kind` for the side (OUTPUT for AR / INPUT for AP), is rejected. The
  due date is **derived** (document_date + `payment_terms_days`), never stored.
- **FX / cross-currency (FX slice):** when the document currency ≠ the company's functional currency,
  `post()` translates each line into the functional currency with the kernel `Money.convert`
  (half-away, scale-6 rate), keyed on the **document date** (SAP WWERT/BLDAT — same rate that states
  AR/revenue; never the posting date). The rate is the `fx_rate` master 'M' rate on that date, or an
  optional **manual-GL** `fxRate` override (`JournalEntryInput.fxRate`; AR/AP never override). An
  override on a functional-currency entry is rejected. Per-line rounding leaves a few-minor-unit
  functional residue: `post()` injects ONE **FX_ROUNDING** line — `amount` 0 in the document currency,
  the residue in the functional currency, on the short side — whose GL comes from
  `account_determination` (`transactionKey: 'FX_ROUNDING'`); that account **must be `currency = null`**
  (else the 0-amount foreign line is rejected against a currency-pinned account). It is a technical
  rounding plug (SAP KDR), NOT economic FX gain/loss. Rates are **never reciprocated** — a KRW→foreign
  document needs its own directional `fx_rate` row. The header stamps `fx_rate` (NULL when doc ==
  functional). `reverse()` is unchanged: it copies `functional_amount` (and the rounding line)
  verbatim with Dr/Cr swapped, so original + reversal net to zero in both currencies; 0009 guarantees
  every posted FX entry — and thus every reversal — is functionally balanced.
- Document vs functional currency are BOTH stored per line; a functional-currency (KRW==KRW) entry is
  byte-identical to the pre-FX path (`fx_rate` NULL, `functional_amount` == `amount`).
- **Clearing / payment (clearing slice):** a clearing is a NEW journal posted through the same
  `JournalService.post()` (the only writer; D4 — no second store): AR receipt `DZ` = Dr cash / Cr AR
  recon (+partner); AP payment `KZ` = Dr AP recon (+partner) / Cr cash. The cash/clearing account
  comes from `account_determination` (`BANK_CLEARING`, currency = null; a plain GL — bank-master is
  later). The cash leg is always the open item's currency (no separate payment currency in v1, so cash
  and recon never differ); a currency-PINNED cash account of another currency is rejected
  (cross-currency payment is out of scope). **"Open" is DERIVED, never a flag on the immutable recon line:** the clearing links a
  `CLEARS` doc_flow edge (clearing → invoice) in the posting tx, and an open item is a recon line
  whose journal is NOT a participant in a LIVE `CLEARS` edge (its clearing not REVERSED) —
  `listOpenItems` excludes BOTH the cleared invoice line and the clearing's own offsetting recon line,
  so a fully-cleared item shows zero open lines. **Realized FX (foreign items):** the recon leg closes
  at the open item's ORIGINAL `functional_amount` (carried via the kernel `PostingLine.functionalAmount`
  override, since `post()` otherwise translates every line at one document rate), the cash leg sits at
  the **settlement-date** 'M' rate (a second `resolveRate` on the clearing date), and the functional
  residue posts to `REALIZED_FX_GAIN` (credit) / `REALIZED_FX_LOSS` (debit) from `account_determination`
  (currency = null — the gain/loss line is 0 in the foreign document currency). This is **economic**
  gain/loss, distinct from the `FX_ROUNDING` (SAP KDR) technical plug; the clearing service hands
  `post()` already-functionally-balanced lines so the auto-plug never fires. v1 is FULL clearing only
  (amount ≠ gross ⇒ rejected) and MANUAL single-item (payment-run later). **Reset-clearing (SAP FBRA)**
  = `reverse()` the clearing document: it copies `functional_amount` verbatim (the realized gain/loss
  reverses exactly, no re-translation), nets to zero in both currencies, and makes the `CLEARS` edge
  non-live ⇒ the item re-opens automatically (the AB reset draws the JE range). Idempotent on the
  clearing key (`clr:<invoiceJournalId>` default); re-clearing a reset item needs a fresh key.

## Key tables
- `journal_entry` — extends `documentHeaderColumns()` (§4.2); tightened: `status` ∈ POSTED/REVERSED
  (no DRAFT — parking belongs to source documents), `posting_key` NOT NULL UNIQUE. Stamped
  `fiscal_year`/`period_no` + `fiscal_period_id` from the period lock. Self-FK reversal lineage
  (`reversal_of_id`/`reversed_by_id`, the latter UNIQUE = at most one reversal).
- `journal_line` — extends `documentItemColumns()`; `gl_account` (number string), `dr_cr` enum,
  `amount`/`currency` + `functional_amount`/`functional_currency`, `is_recon_account` snapshot,
  optional `partner_id`/`cost_center_id`/`tax_code`. High-volume: time-partitioning deferred (§5).

## FI postings
- `POST /finance-accounting/journal-entries` → manual `SA` document (Dr/Cr free within the rules).
- `reverse()` → `AB` document mirroring the original.
- `POST /finance-accounting/ar-invoices` → `DR`: Dr AR recon (gross, +partner) / Cr revenue (per
  line) / Cr output VAT (Σ per tax code). `GET .../ar-invoices/open-items?companyCodeId&partnerId`.
- `POST /finance-accounting/ap-invoices` → `KR`: Dr expense (per line) / Dr input VAT / Cr AP recon
  (gross, +partner). `GET .../ap-invoices/open-items?companyCodeId&partnerId`.
- `POST /finance-accounting/clearings` → `DZ`/`KZ`: clears one open AR/AP invoice in full against the
  `BANK_CLEARING` cash account, books realized FX gain/loss on foreign items, links a `CLEARS` edge.
- `POST /finance-accounting/clearings/:id/reset` → reset-clearing: `reverse()` of the clearing
  document (`AB`, JE range), re-opening the item.

## Domain events
- `finance.journal.posted` / `finance.journal.reversed` / `finance.journal.cleared` — outbox rows
  written in the SAME transaction as the journal (§5.2); the relay worker (Phase-0 follow-up)
  dispatches them. No in-process publish from inside the posting transaction. (A clearing emits
  `finance.journal.cleared`; its reset emits `finance.journal.reversed` like any reversal.)

## Permissions
`finance:journal:post` · `finance:journal:reverse` · `finance:journal:read` ·
`finance:ar_invoice:{post,read}` · `finance:ap_invoice:{post,read}` ·
`finance:clearing:{post,reset}`
(ADMIN `*` covers them; no seed rows / migration — declared on the controllers.)
