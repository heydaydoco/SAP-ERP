CREATE TABLE "landed_cost" (
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
	"import_declaration_no" varchar(64),
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"exchange_rate" numeric(18, 6),
	"cost_amount" numeric(18, 4) NOT NULL,
	"import_vat_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"vat_tax_code" varchar(16),
	"header_text" varchar(256),
	CONSTRAINT "landed_cost_posting_key_uq" UNIQUE("company_code_id","posting_key"),
	CONSTRAINT "landed_cost_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "landed_cost_status_ck" CHECK ("landed_cost"."status" = 'POSTED'),
	CONSTRAINT "landed_cost_cost_amount_nonneg_ck" CHECK ("landed_cost"."cost_amount" >= 0),
	CONSTRAINT "landed_cost_import_vat_nonneg_ck" CHECK ("landed_cost"."import_vat_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "landed_cost_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"landed_cost_id" uuid NOT NULL,
	"purchase_order_item_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"received_functional_value" numeric(18, 4) NOT NULL,
	"capitalized_share" numeric(18, 4) NOT NULL,
	"covered_share" numeric(18, 4) NOT NULL,
	"prd_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "landed_cost_item_no_uq" UNIQUE("landed_cost_id","line_no"),
	CONSTRAINT "landed_cost_item_basis_nonneg_ck" CHECK ("landed_cost_item"."received_functional_value" >= 0),
	CONSTRAINT "landed_cost_item_share_nonneg_ck" CHECK ("landed_cost_item"."capitalized_share" >= 0),
	CONSTRAINT "landed_cost_item_covered_nonneg_ck" CHECK ("landed_cost_item"."covered_share" >= 0),
	CONSTRAINT "landed_cost_item_prd_nonneg_ck" CHECK ("landed_cost_item"."prd_amount" >= 0),
	CONSTRAINT "landed_cost_item_split_ck" CHECK ("landed_cost_item"."capitalized_share" = "landed_cost_item"."covered_share" + "landed_cost_item"."prd_amount")
);
--> statement-breakpoint
ALTER TABLE "landed_cost" ADD CONSTRAINT "landed_cost_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost" ADD CONSTRAINT "landed_cost_vendor_bp_id_business_partner_id_fk" FOREIGN KEY ("vendor_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost" ADD CONSTRAINT "landed_cost_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_item" ADD CONSTRAINT "landed_cost_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_item" ADD CONSTRAINT "landed_cost_item_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_item" ADD CONSTRAINT "landed_cost_item_lc_fk" FOREIGN KEY ("landed_cost_id") REFERENCES "public"."landed_cost"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_item" ADD CONSTRAINT "landed_cost_item_po_item_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landed_cost_po_idx" ON "landed_cost" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "landed_cost_vendor_idx" ON "landed_cost" USING btree ("vendor_bp_id");--> statement-breakpoint
CREATE INDEX "landed_cost_item_lc_idx" ON "landed_cost_item" USING btree ("landed_cost_id");--> statement-breakpoint
CREATE INDEX "landed_cost_item_po_item_idx" ON "landed_cost_item" USING btree ("purchase_order_item_id");--> statement-breakpoint
CREATE INDEX "landed_cost_item_material_idx" ON "landed_cost_item" USING btree ("material_id");