CREATE TYPE "public"."dr_cr" AS ENUM('D', 'C');--> statement-breakpoint
CREATE TABLE "journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'POSTED' NOT NULL,
	"posting_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_no" integer NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"functional_currency" char(3) NOT NULL,
	"fx_rate" numeric(18, 6),
	"reference" varchar(128) NOT NULL,
	"header_text" varchar(256),
	"reversal_of_id" uuid,
	"reversed_by_id" uuid,
	"reversal_reason" varchar(256),
	CONSTRAINT "journal_entry_posting_key_uq" UNIQUE("company_code_id","posting_key"),
	CONSTRAINT "journal_entry_doc_no_uq" UNIQUE("company_code_id","fiscal_year","doc_no"),
	CONSTRAINT "journal_entry_reversed_by_uq" UNIQUE("reversed_by_id"),
	CONSTRAINT "journal_entry_status_ck" CHECK ("journal_entry"."status" in ('POSTED', 'REVERSED')),
	CONSTRAINT "journal_entry_period_no_ck" CHECK ("journal_entry"."period_no" between 1 and 12),
	CONSTRAINT "journal_entry_reversal_pair_ck" CHECK (("journal_entry"."reversal_of_id" is null) = ("journal_entry"."reversal_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "journal_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"gl_account" varchar(16) NOT NULL,
	"dr_cr" "dr_cr" NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"functional_amount" numeric(18, 4) NOT NULL,
	"functional_currency" char(3) NOT NULL,
	"is_recon_account" boolean DEFAULT false NOT NULL,
	"partner_id" uuid,
	"cost_center_id" uuid,
	"tax_code" varchar(16),
	"line_text" varchar(256),
	CONSTRAINT "journal_line_no_uq" UNIQUE("journal_entry_id","line_no"),
	CONSTRAINT "journal_line_amount_nonneg_ck" CHECK ("journal_line"."amount" >= 0),
	CONSTRAINT "journal_line_functional_amount_nonneg_ck" CHECK ("journal_line"."functional_amount" >= 0),
	CONSTRAINT "journal_line_recon_partner_ck" CHECK ((not "journal_line"."is_recon_account") or ("journal_line"."partner_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_fiscal_period_id_fiscal_period_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_reversal_of_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_reversed_by_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_cost_center_id_cost_center_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_center"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entry_period_idx" ON "journal_entry" USING btree ("company_code_id","fiscal_year","period_no");--> statement-breakpoint
CREATE INDEX "journal_entry_reference_idx" ON "journal_entry" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "journal_line_entry_idx" ON "journal_line" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "journal_line_gl_idx" ON "journal_line" USING btree ("gl_account","currency");--> statement-breakpoint
CREATE INDEX "journal_line_partner_idx" ON "journal_line" USING btree ("partner_id");--> statement-breakpoint
-- ── Hand-written DB backstops (root CLAUDE.md §5.1/§3.2) — drizzle-kit cannot express these. ──
-- The posting service is the authoritative guard (kernel assertBalanced); these triggers make the
-- invariants hold against ANY writer (seed, psql, a future bug). Kept in the same migration so a
-- fresh migrate 0001..0008 yields the full contract.
--
-- 1) Balance backstop: at COMMIT every touched journal must have Σdebit = Σcredit per DOCUMENT
--    currency, ≥2 lines, and every line in the header's document currency. Document currency is
--    the timeless invariant; the functional-currency tie-out (with its FX rounding line) is
--    layered in the FX slice as service logic.
CREATE FUNCTION "public"."assert_journal_balanced"() RETURNS trigger AS $fn$
DECLARE
  bad record;
  n bigint;
BEGIN
  SELECT jl.currency,
         sum(CASE WHEN jl.dr_cr = 'D' THEN jl.amount ELSE 0 END) AS debit,
         sum(CASE WHEN jl.dr_cr = 'C' THEN jl.amount ELSE 0 END) AS credit
    INTO bad
    FROM "public"."journal_line" jl
   WHERE jl.journal_entry_id = NEW.journal_entry_id
   GROUP BY jl.currency
  HAVING sum(CASE WHEN jl.dr_cr = 'D' THEN jl.amount ELSE 0 END)
      <> sum(CASE WHEN jl.dr_cr = 'C' THEN jl.amount ELSE 0 END)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % is unbalanced in %: debit % <> credit %',
      NEW.journal_entry_id, bad.currency, bad.debit, bad.credit;
  END IF;
  SELECT count(*) INTO n FROM "public"."journal_line" WHERE journal_entry_id = NEW.journal_entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal % needs at least two lines', NEW.journal_entry_id;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "public"."journal_line" jl
      JOIN "public"."journal_entry" je ON je.id = jl.journal_entry_id
     WHERE jl.journal_entry_id = NEW.journal_entry_id
       AND jl.currency <> je.currency
  ) THEN
    RAISE EXCEPTION 'journal % has a line outside its document currency', NEW.journal_entry_id;
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_line_balanced_tg"
AFTER INSERT ON "public"."journal_line"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."assert_journal_balanced"();--> statement-breakpoint
-- 2) Immutability fence on the header: a posted journal is never edited or deleted (§5.1). The one
--    allowed UPDATE is the reversal back-pointer flip POSTED→REVERSED (+ audit columns).
CREATE FUNCTION "public"."fence_journal_entry"() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entry % is immutable: never delete, correct via reversal', OLD.id;
  END IF;
  IF NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.doc_no IS DISTINCT FROM OLD.doc_no
     OR NEW.posting_key IS DISTINCT FROM OLD.posting_key
     OR NEW.company_code_id IS DISTINCT FROM OLD.company_code_id
     OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
     OR NEW.document_date IS DISTINCT FROM OLD.document_date
     OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
     OR NEW.period_no IS DISTINCT FROM OLD.period_no
     OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.functional_currency IS DISTINCT FROM OLD.functional_currency
     OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.header_text IS DISTINCT FROM OLD.header_text
     OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id
     OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'journal_entry % is immutable: only the reversal status flip may change it',
      OLD.id;
  END IF;
  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
          AND OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL) THEN
    RAISE EXCEPTION 'journal_entry % allows only the POSTED -> REVERSED back-pointer flip', OLD.id;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "journal_entry_fence_tg"
BEFORE UPDATE OR DELETE ON "public"."journal_entry"
FOR EACH ROW EXECUTE FUNCTION "public"."fence_journal_entry"();--> statement-breakpoint
-- 3) Immutability fence on lines: write-once, no exceptions — and append-proof: lines may only be
--    inserted in the SAME transaction that created their header (xmin = current xid), so a posted
--    journal can never grow extra (even balanced) lines after the fact.
CREATE FUNCTION "public"."fence_journal_line"() RETURNS trigger AS $fn$
DECLARE
  header_xmin bigint;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'journal_line % is immutable: never edit or delete, correct via reversal',
      OLD.id;
  END IF;
  SELECT je.xmin::text::bigint INTO header_xmin
    FROM "public"."journal_entry" je
   WHERE je.id = NEW.journal_entry_id;
  IF header_xmin IS DISTINCT FROM mod(pg_current_xact_id()::text::bigint, 4294967296) THEN
    RAISE EXCEPTION 'journal % is immutable: lines cannot be appended after posting',
      NEW.journal_entry_id;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "journal_line_fence_tg"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."journal_line"
FOR EACH ROW EXECUTE FUNCTION "public"."fence_journal_line"();
