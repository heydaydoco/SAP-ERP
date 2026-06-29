CREATE TABLE "shipping_document_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"set_id" uuid NOT NULL,
	"doc_kind" varchar(2) NOT NULL,
	"doc_number" varchar(64) NOT NULL,
	"issue_date" date,
	"issuer_text" varchar(128),
	CONSTRAINT "shipping_document_item_no_uq" UNIQUE("set_id","line_no"),
	CONSTRAINT "shipping_document_item_kind_number_uq" UNIQUE("set_id","doc_kind","doc_number"),
	CONSTRAINT "shipping_document_item_kind_ck" CHECK ("shipping_document_item"."doc_kind" in ('BL', 'CI', 'PL'))
);
--> statement-breakpoint
CREATE TABLE "shipping_document_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'OPEN' NOT NULL,
	"posting_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"reference" varchar(128),
	"header_text" varchar(256),
	CONSTRAINT "shipping_document_set_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "shipping_document_set_status_ck" CHECK ("shipping_document_set"."status" in ('OPEN'))
);
--> statement-breakpoint
ALTER TABLE "shipping_document_item" ADD CONSTRAINT "shipping_document_item_set_fk" FOREIGN KEY ("set_id") REFERENCES "public"."shipping_document_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_document_set" ADD CONSTRAINT "shipping_document_set_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipping_document_item_set_idx" ON "shipping_document_item" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "shipping_document_set_company_idx" ON "shipping_document_set" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "shipping_document_set_shipment_idx" ON "shipping_document_set" USING btree ("shipment_id");