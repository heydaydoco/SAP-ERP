CREATE TABLE "freight_settlement" (
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
	"shipment_id" uuid NOT NULL,
	"forwarder_bp_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"exchange_rate" numeric(18, 6),
	"freight_amount" numeric(18, 4) NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"reference" varchar(128),
	"header_text" varchar(256),
	CONSTRAINT "freight_settlement_posting_key_uq" UNIQUE("company_code_id","posting_key"),
	CONSTRAINT "freight_settlement_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "freight_settlement_status_ck" CHECK ("freight_settlement"."status" = 'POSTED'),
	CONSTRAINT "freight_settlement_amount_nonneg_ck" CHECK ("freight_settlement"."freight_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "freight_settlement" ADD CONSTRAINT "freight_settlement_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_settlement" ADD CONSTRAINT "freight_settlement_forwarder_bp_id_business_partner_id_fk" FOREIGN KEY ("forwarder_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "freight_settlement_company_idx" ON "freight_settlement" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "freight_settlement_shipment_idx" ON "freight_settlement" USING btree ("shipment_id");