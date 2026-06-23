CREATE TABLE "export_declaration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'SUBMITTED' NOT NULL,
	"posting_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"customer_bp_id" uuid NOT NULL,
	"broker_bp_id" uuid,
	"declaration_no" varchar(35),
	"declaration_date" date NOT NULL,
	"incoterm" varchar(8),
	"trade_direction" char(3),
	"ship_to_country" char(2),
	"customs_office" varchar(16),
	"currency" char(3) NOT NULL,
	"exchange_rate" numeric(18, 6),
	"total_fob_amount" numeric(18, 4) NOT NULL,
	"header_text" varchar(256),
	CONSTRAINT "export_declaration_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "export_declaration_status_ck" CHECK ("export_declaration"."status" in ('SUBMITTED', 'ACCEPTED')),
	CONSTRAINT "export_declaration_total_fob_nonneg_ck" CHECK ("export_declaration"."total_fob_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "export_declaration_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"declaration_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"hs_code" varchar(16),
	"origin_country" char(2),
	"qty" numeric(18, 6) NOT NULL,
	"uom" varchar(8) NOT NULL,
	"fob_amount" numeric(18, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"net_weight" numeric(18, 6),
	CONSTRAINT "export_declaration_item_no_uq" UNIQUE("declaration_id","line_no"),
	CONSTRAINT "export_declaration_item_qty_pos_ck" CHECK ("export_declaration_item"."qty" > 0),
	CONSTRAINT "export_declaration_item_fob_nonneg_ck" CHECK ("export_declaration_item"."fob_amount" >= 0),
	CONSTRAINT "export_declaration_item_weight_nonneg_ck" CHECK ("export_declaration_item"."net_weight" is null or "export_declaration_item"."net_weight" >= 0)
);
--> statement-breakpoint
ALTER TABLE "export_declaration" ADD CONSTRAINT "export_declaration_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_declaration" ADD CONSTRAINT "export_declaration_customer_bp_id_business_partner_id_fk" FOREIGN KEY ("customer_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_declaration" ADD CONSTRAINT "export_declaration_broker_bp_id_business_partner_id_fk" FOREIGN KEY ("broker_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_declaration_item" ADD CONSTRAINT "export_declaration_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_declaration_item" ADD CONSTRAINT "export_declaration_item_decl_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."export_declaration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_declaration_company_idx" ON "export_declaration" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "export_declaration_customer_idx" ON "export_declaration" USING btree ("customer_bp_id");--> statement-breakpoint
CREATE INDEX "export_declaration_decl_no_idx" ON "export_declaration" USING btree ("declaration_no");--> statement-breakpoint
CREATE INDEX "export_declaration_item_decl_idx" ON "export_declaration_item" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "export_declaration_item_material_idx" ON "export_declaration_item" USING btree ("material_id");