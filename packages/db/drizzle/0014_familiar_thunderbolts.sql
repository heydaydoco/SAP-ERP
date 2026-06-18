CREATE TABLE "sales_order" (
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
	"customer_bp_id" uuid NOT NULL,
	"sales_org_id" uuid,
	"currency" char(3) NOT NULL,
	"order_date" date NOT NULL,
	"incoterm" varchar(8),
	"trade_direction" char(3),
	"ship_to_country" char(2),
	"zero_rate_doc_no" varchar(35),
	"header_text" varchar(256),
	CONSTRAINT "sales_order_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "sales_order_status_ck" CHECK ("sales_order"."status" in ('ORDERED', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "sales_order_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"ordered_qty" numeric(18, 6) NOT NULL,
	"unit_price" numeric(18, 6) NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_code" varchar(16),
	CONSTRAINT "sales_order_item_no_uq" UNIQUE("sales_order_id","line_no"),
	CONSTRAINT "sales_order_item_qty_pos_ck" CHECK ("sales_order_item"."ordered_qty" > 0),
	CONSTRAINT "sales_order_item_price_nonneg_ck" CHECK ("sales_order_item"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'POSTED' NOT NULL,
	"posting_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"goods_movement_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"ship_to_country" char(2),
	"header_text" varchar(256),
	CONSTRAINT "delivery_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "delivery_gm_uq" UNIQUE("goods_movement_id"),
	CONSTRAINT "delivery_status_ck" CHECK ("delivery"."status" = 'POSTED')
);
--> statement-breakpoint
CREATE TABLE "delivery_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"delivery_id" uuid NOT NULL,
	"sales_order_item_id" uuid NOT NULL,
	"qty" numeric(18, 6) NOT NULL,
	CONSTRAINT "delivery_item_no_uq" UNIQUE("delivery_id","line_no"),
	CONSTRAINT "delivery_item_qty_pos_ck" CHECK ("delivery_item"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing" (
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
	"customer_bp_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"reference" varchar(128) NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"exchange_rate" numeric(18, 6),
	"header_text" varchar(256),
	CONSTRAINT "billing_posting_key_uq" UNIQUE("company_code_id","posting_key"),
	CONSTRAINT "billing_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "billing_status_ck" CHECK ("billing"."status" = 'POSTED')
);
--> statement-breakpoint
CREATE TABLE "billing_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"billing_id" uuid NOT NULL,
	"sales_order_item_id" uuid NOT NULL,
	"billed_qty" numeric(18, 6) NOT NULL,
	"unit_price" numeric(18, 6) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"revenue_account" varchar(16) NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_code" varchar(16),
	CONSTRAINT "billing_item_no_uq" UNIQUE("billing_id","line_no"),
	CONSTRAINT "billing_item_qty_pos_ck" CHECK ("billing_item"."billed_qty" > 0),
	CONSTRAINT "billing_item_price_nonneg_ck" CHECK ("billing_item"."unit_price" >= 0),
	CONSTRAINT "billing_item_amount_nonneg_ck" CHECK ("billing_item"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goods_movement" DROP CONSTRAINT "goods_movement_type_ck";--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customer_bp_id_business_partner_id_fk" FOREIGN KEY ("customer_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_sales_org_id_sales_org_id_fk" FOREIGN KEY ("sales_org_id") REFERENCES "public"."sales_org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_so_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_sloc_plant_fk" FOREIGN KEY ("storage_location_id","plant_id") REFERENCES "public"."storage_location"("id","plant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_so_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_gm_fk" FOREIGN KEY ("goods_movement_id") REFERENCES "public"."goods_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_item" ADD CONSTRAINT "delivery_item_delivery_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."delivery"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_item" ADD CONSTRAINT "delivery_item_so_item_fk" FOREIGN KEY ("sales_order_item_id") REFERENCES "public"."sales_order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing" ADD CONSTRAINT "billing_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing" ADD CONSTRAINT "billing_customer_bp_id_business_partner_id_fk" FOREIGN KEY ("customer_bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing" ADD CONSTRAINT "billing_so_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing" ADD CONSTRAINT "billing_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_item" ADD CONSTRAINT "billing_item_billing_fk" FOREIGN KEY ("billing_id") REFERENCES "public"."billing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_item" ADD CONSTRAINT "billing_item_so_item_fk" FOREIGN KEY ("sales_order_item_id") REFERENCES "public"."sales_order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_order_customer_idx" ON "sales_order" USING btree ("customer_bp_id");--> statement-breakpoint
CREATE INDEX "sales_order_company_idx" ON "sales_order" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "sales_order_item_so_idx" ON "sales_order_item" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "sales_order_item_material_idx" ON "sales_order_item" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "delivery_so_idx" ON "delivery" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "delivery_item_delivery_idx" ON "delivery_item" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "delivery_item_so_item_idx" ON "delivery_item" USING btree ("sales_order_item_id");--> statement-breakpoint
CREATE INDEX "billing_so_idx" ON "billing" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "billing_customer_idx" ON "billing" USING btree ("customer_bp_id");--> statement-breakpoint
CREATE INDEX "billing_item_billing_idx" ON "billing_item" USING btree ("billing_id");--> statement-breakpoint
CREATE INDEX "billing_item_so_item_idx" ON "billing_item" USING btree ("sales_order_item_id");--> statement-breakpoint
ALTER TABLE "goods_movement" ADD CONSTRAINT "goods_movement_type_ck" CHECK ("goods_movement"."movement_type" in ('561', '101', '201', '711', '712', '601'));