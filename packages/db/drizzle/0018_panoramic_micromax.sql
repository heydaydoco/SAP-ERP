CREATE TABLE "drawback_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'CLAIMED' NOT NULL,
	"posting_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"claim_date" date NOT NULL,
	"approval_date" date,
	"claimed_total_amount" numeric(18, 4) NOT NULL,
	"claimed_total_currency" char(3) DEFAULT 'KRW' NOT NULL,
	"approved_total_amount" numeric(18, 4),
	"approved_total_currency" char(3),
	"header_text" varchar(256),
	CONSTRAINT "drawback_claim_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "drawback_claim_status_ck" CHECK ("drawback_claim"."status" in ('CLAIMED', 'APPROVED')),
	CONSTRAINT "drawback_claim_claimed_total_nonneg_ck" CHECK ("drawback_claim"."claimed_total_amount" >= 0),
	CONSTRAINT "drawback_claim_approved_total_nonneg_ck" CHECK ("drawback_claim"."approved_total_amount" is null or "drawback_claim"."approved_total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "drawback_claim_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_export_declaration_id" uuid NOT NULL,
	"source_export_declaration_item_ref" uuid NOT NULL,
	"source_acceptance_date" date NOT NULL,
	"hs_code" varchar(16) NOT NULL,
	"fob_amount" numeric(18, 4) NOT NULL,
	"fob_currency" char(3) NOT NULL,
	"fob_krw_amount" numeric(18, 4) NOT NULL,
	"fx_rate" numeric(18, 6),
	"applied_rate" numeric(18, 4) NOT NULL,
	"line_refund_amount" numeric(18, 4) NOT NULL,
	CONSTRAINT "drawback_claim_item_no_uq" UNIQUE("claim_id","line_no"),
	CONSTRAINT "drawback_claim_item_fob_nonneg_ck" CHECK ("drawback_claim_item"."fob_amount" >= 0),
	CONSTRAINT "drawback_claim_item_fob_krw_nonneg_ck" CHECK ("drawback_claim_item"."fob_krw_amount" >= 0),
	CONSTRAINT "drawback_claim_item_applied_rate_nonneg_ck" CHECK ("drawback_claim_item"."applied_rate" >= 0),
	CONSTRAINT "drawback_claim_item_refund_nonneg_ck" CHECK ("drawback_claim_item"."line_refund_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "drawback_simplified_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hs_code" varchar(16) NOT NULL,
	"rate_per_10k" numeric(18, 4) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "drawback_simplified_rate_hs_from_uq" UNIQUE("hs_code","valid_from"),
	CONSTRAINT "drawback_simplified_rate_per10k_nonneg_ck" CHECK ("drawback_simplified_rate"."rate_per_10k" >= 0),
	CONSTRAINT "drawback_simplified_rate_hs_code_ck" CHECK ("drawback_simplified_rate"."hs_code" ~ '^[0-9]{6,10}$'),
	CONSTRAINT "drawback_simplified_rate_validity_ck" CHECK ("drawback_simplified_rate"."valid_to" is null or "drawback_simplified_rate"."valid_to" >= "drawback_simplified_rate"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "export_declaration" ADD COLUMN "acceptance_date" date;--> statement-breakpoint
ALTER TABLE "drawback_claim" ADD CONSTRAINT "drawback_claim_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawback_claim_item" ADD CONSTRAINT "drawback_claim_item_claim_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."drawback_claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drawback_claim_company_idx" ON "drawback_claim" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "drawback_claim_status_idx" ON "drawback_claim" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drawback_claim_item_claim_idx" ON "drawback_claim_item" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "drawback_claim_item_source_decl_idx" ON "drawback_claim_item" USING btree ("source_export_declaration_id");--> statement-breakpoint
CREATE INDEX "drawback_simplified_rate_lookup_idx" ON "drawback_simplified_rate" USING btree ("hs_code","valid_from");