-- ── Migration 0009: functional-currency balance backstop (root CLAUDE.md §5.1/§3.2 — FX slice). ──
-- Purely additive. A second DEFERRABLE INITIALLY DEFERRED constraint trigger, the functional-currency
-- twin of 0008's document-currency balance check: at COMMIT every touched journal must have
-- Σdebit = Σcredit per FUNCTIONAL currency (summing functional_amount). The posting service is the
-- authoritative guard (kernel assertFunctionalBalanced + the injected FX_ROUNDING line); this makes
-- the invariant hold against ANY writer, on both post AND reversal (a reversal copies functional
-- amounts verbatim, so the mirror is balanced iff the original was — which 0009 now guarantees).
-- 0008, the tables, columns and constraints are untouched.
CREATE FUNCTION "public"."assert_journal_functionally_balanced"() RETURNS trigger AS $fn$
DECLARE
  bad record;
BEGIN
  SELECT jl.functional_currency,
         sum(CASE WHEN jl.dr_cr = 'D' THEN jl.functional_amount ELSE 0 END) AS debit,
         sum(CASE WHEN jl.dr_cr = 'C' THEN jl.functional_amount ELSE 0 END) AS credit
    INTO bad
    FROM "public"."journal_line" jl
   WHERE jl.journal_entry_id = NEW.journal_entry_id
   GROUP BY jl.functional_currency
  HAVING sum(CASE WHEN jl.dr_cr = 'D' THEN jl.functional_amount ELSE 0 END)
      <> sum(CASE WHEN jl.dr_cr = 'C' THEN jl.functional_amount ELSE 0 END)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % is functionally unbalanced in %: debit % <> credit %',
      NEW.journal_entry_id, bad.functional_currency, bad.debit, bad.credit;
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_line_functionally_balanced_tg"
AFTER INSERT ON "public"."journal_line"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."assert_journal_functionally_balanced"();
