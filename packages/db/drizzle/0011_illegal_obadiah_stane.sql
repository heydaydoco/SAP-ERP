CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'ORDERED' NOT NULL,
	"posting_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"vendor_bp_id" uuid NOT NULL,
	"purchasing_org_id" uuid,
	"currency" char(3) NOT NULL,
	"order_date" date NOT NULL,
	"header_text" varchar(256),
	CONSTRAINT "purchase_order_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "purchase_order_status_ck" CHECK ("purchase_order"."status" in ('ORDERED', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"ordered_qty" numeric(18, 6) NOT NULL,
	"unit_price" numeric(18, 6) NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_code" varchar(16),
	CONSTRAINT "purchase_order_item_no_uq" UNIQUE("purchase_order_id","line_no"),
	CONSTRAINT "purchase_order_item_qty_pos_ck" CHECK ("purchase_order_item"."ordered_qty" > 0),
	CONSTRAINT "purchase_order_item_price_nonneg_ck" CHECK ("purchase_order_item"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_verification" (
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
	"vendor_bp_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"reference" varchar(128) NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"header_text" varchar(256),
	CONSTRAINT "invoice_verification_posting_key_uq" UNIQUE("company_code_id","posting_key"),
	CONSTRAINT "invoice_verification_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "invoice_verification_status_ck" CHECK ("invoice_verification"."status" = 'POSTED')
);
--> statement-breakpoint
CREATE TABLE "invoice_verification_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"invoice_verification_id" uuid NOT NULL,
	"purchase_order_item_id" uuid NOT NULL,
	"invoiced_qty" numeric(18, 6) NOT NULL,
	"invoice_unit_price" numeric(18, 6) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_code" varchar(16),
	CONSTRAINT "invoice_verification_item_no_uq" UNIQUE("invoice_verification_id","line_no"),
	CONSTRAINT "invoice_verification_item_qty_pos_ck" CHECK ("invoice_verification_item"."invoiced_qty" > 0),
	CONSTRAINT "invoice_verification_item_price_nonneg_ck" CHECK ("invoice_verification_item"."invoice_unit_price" >= 0),
	CONSTRAINT "invoice_verification_item_amount_nonneg_ck" CHECK ("invoice_verification_item"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_vendor_bp_id_business_partner_id_fk" FOREIGN KEY ("vendor_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_purchasing_org_id_purchasing_org_id_fk" FOREIGN KEY ("purchasing_org_id") REFERENCES "public"."purchasing_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_sloc_plant_fk" FOREIGN KEY ("storage_location_id","plant_id") REFERENCES "public"."storage_location"("id","plant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_verification" ADD CONSTRAINT "invoice_verification_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_verification" ADD CONSTRAINT "invoice_verification_vendor_bp_id_business_partner_id_fk" FOREIGN KEY ("vendor_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_verification" ADD CONSTRAINT "invoice_verification_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_verification_item" ADD CONSTRAINT "invoice_verification_item_iv_fk" FOREIGN KEY ("invoice_verification_id") REFERENCES "public"."invoice_verification"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_verification_item" ADD CONSTRAINT "invoice_verification_item_po_item_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_vendor_idx" ON "purchase_order" USING btree ("vendor_bp_id");--> statement-breakpoint
CREATE INDEX "purchase_order_company_idx" ON "purchase_order" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "purchase_order_item_po_idx" ON "purchase_order_item" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_item_material_idx" ON "purchase_order_item" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "invoice_verification_po_idx" ON "invoice_verification" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "invoice_verification_vendor_idx" ON "invoice_verification" USING btree ("vendor_bp_id");--> statement-breakpoint
CREATE INDEX "invoice_verification_item_iv_idx" ON "invoice_verification_item" USING btree ("invoice_verification_id");--> statement-breakpoint
CREATE INDEX "invoice_verification_item_po_item_idx" ON "invoice_verification_item" USING btree ("purchase_order_item_id");