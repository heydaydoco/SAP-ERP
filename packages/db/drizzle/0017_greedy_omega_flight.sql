CREATE TABLE "import_declaration" (
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
	"supplier_bp_id" uuid NOT NULL,
	"broker_bp_id" uuid,
	"source_goods_movement_id" uuid NOT NULL,
	"declaration_no" varchar(35),
	"declaration_date" date NOT NULL,
	"acceptance_date" date,
	"incoterm" varchar(8),
	"trade_direction" char(3),
	"origin_country" char(2),
	"customs_office" varchar(16),
	"currency" char(3) NOT NULL,
	"exchange_rate" numeric(18, 6),
	"customs_value" numeric(18, 4) NOT NULL,
	"duty_amount" numeric(18, 4) NOT NULL,
	"import_vat_amount" numeric(18, 4) NOT NULL,
	"header_text" varchar(256),
	CONSTRAINT "import_declaration_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "import_declaration_status_ck" CHECK ("import_declaration"."status" in ('SUBMITTED', 'ACCEPTED')),
	CONSTRAINT "import_declaration_customs_value_nonneg_ck" CHECK ("import_declaration"."customs_value" >= 0),
	CONSTRAINT "import_declaration_duty_nonneg_ck" CHECK ("import_declaration"."duty_amount" >= 0),
	CONSTRAINT "import_declaration_vat_nonneg_ck" CHECK ("import_declaration"."import_vat_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_declaration_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"declaration_id" uuid NOT NULL,
	"source_gr_item_ref" uuid,
	"material_id" uuid NOT NULL,
	"hs_code" varchar(16),
	"origin_country" char(2),
	"qty" numeric(18, 6) NOT NULL,
	"uom" varchar(8) NOT NULL,
	"customs_value" numeric(18, 4) NOT NULL,
	"duty_rate" numeric(7, 4),
	"currency" char(3) NOT NULL,
	CONSTRAINT "import_declaration_item_no_uq" UNIQUE("declaration_id","line_no"),
	CONSTRAINT "import_declaration_item_qty_pos_ck" CHECK ("import_declaration_item"."qty" > 0),
	CONSTRAINT "import_declaration_item_customs_value_nonneg_ck" CHECK ("import_declaration_item"."customs_value" >= 0),
	CONSTRAINT "import_declaration_item_duty_rate_nonneg_ck" CHECK ("import_declaration_item"."duty_rate" is null or "import_declaration_item"."duty_rate" >= 0)
);
--> statement-breakpoint
ALTER TABLE "import_declaration" ADD CONSTRAINT "import_declaration_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_declaration" ADD CONSTRAINT "import_declaration_supplier_bp_id_business_partner_id_fk" FOREIGN KEY ("supplier_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_declaration" ADD CONSTRAINT "import_declaration_broker_bp_id_business_partner_id_fk" FOREIGN KEY ("broker_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_declaration_item" ADD CONSTRAINT "import_declaration_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_declaration_item" ADD CONSTRAINT "import_declaration_item_decl_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."import_declaration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_declaration_company_idx" ON "import_declaration" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "import_declaration_supplier_idx" ON "import_declaration" USING btree ("supplier_bp_id");--> statement-breakpoint
CREATE INDEX "import_declaration_gr_idx" ON "import_declaration" USING btree ("source_goods_movement_id");--> statement-breakpoint
CREATE INDEX "import_declaration_decl_no_idx" ON "import_declaration" USING btree ("declaration_no");--> statement-breakpoint
CREATE INDEX "import_declaration_item_decl_idx" ON "import_declaration_item" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "import_declaration_item_material_idx" ON "import_declaration_item" USING btree ("material_id");