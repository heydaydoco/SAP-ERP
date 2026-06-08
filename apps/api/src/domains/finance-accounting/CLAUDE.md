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
- `fixed-assets` · `tax` · `bank-reconciliation` · `period-close` · `financial-statements` — later

## Status
🟧 **In progress (Phase 2, slices 1–2 shipped).** `general-ledger`: manual journal posting
end-to-end — balanced posting, period lock, idempotency, reversal, trial balance (migration 0008).
`accounts-receivable`/`accounts-payable` (PR-B): customer/vendor invoice posting with VAT + open-item
reads (no migration — journal-only). Deferred: FX/cross-currency translation (needs a kernel
`Money.convert`; columns already stored per line), payment/clearing (open items are all-open until
then), draft/parking, `journal_line` partitioning, the outbox relay worker, the per-counterparty VAT
truncation (절사) flag (builder supports it; no master column yet).

> **Note:** The backbone. Owns journal_entry/journal_line. Enforce immutability + reversal-only +
> period locking (§5.1). Hosts the concrete fi-posting service from the kernel.

## Domain rules
- **`JournalService` is the ONLY writer** of journal tables; it implements the kernel
  `FiPostingService`. Sibling domains import `FinanceAccountingModule` and call `post()` — never
  insert journal rows directly.
- **Balance is enforced in layers:** kernel `assertBalanced` (authoritative, per document currency)
  in the service → row-local CHECKs → 0008 deferred constraint trigger re-checking at COMMIT that
  Σdebit=Σcredit per (journal, currency), ≥2 lines, and every line is in the header's document
  currency → immutability fence triggers (only the POSTED→REVERSED back-pointer flip may UPDATE a
  header; lines are write-once AND append-proof — they insert only in the tx that created their
  header).
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
- Document vs functional currency are BOTH stored per line from day one; this slice requires
  document == functional (KRW). The FX slice adds translation + the functional tie-out/rounding
  line additively — no schema rework.

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

## Domain events
- `finance.journal.posted` / `finance.journal.reversed` — outbox rows written in the SAME
  transaction as the journal (§5.2); the relay worker (Phase-0 follow-up) dispatches them.
  No in-process publish from inside the posting transaction.

## Permissions
`finance:journal:post` · `finance:journal:reverse` · `finance:journal:read` ·
`finance:ar_invoice:{post,read}` · `finance:ap_invoice:{post,read}`
(ADMIN `*` covers them; no seed rows / migration — declared on the controllers.)
