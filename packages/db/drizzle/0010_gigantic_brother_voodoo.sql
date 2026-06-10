CREATE TABLE "material_valuation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"valuation_class" varchar(16) NOT NULL,
	"valuation_qty" numeric(18, 6) DEFAULT '0' NOT NULL,
	"moving_avg_price" numeric(18, 6) DEFAULT '0' NOT NULL,
	"stock_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" char(3) NOT NULL,
	"last_movement_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "material_valuation_uq" UNIQUE("material_id","plant_id"),
	CONSTRAINT "material_valuation_qty_nonneg_ck" CHECK ("material_valuation"."valuation_qty" >= 0),
	CONSTRAINT "material_valuation_value_nonneg_ck" CHECK ("material_valuation"."stock_value" >= 0),
	CONSTRAINT "material_valuation_empty_zero_ck" CHECK ("material_valuation"."valuation_qty" <> 0 or "material_valuation"."stock_value" = 0)
);
--> statement-breakpoint
CREATE TABLE "stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"qty" numeric(18, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "stock_uq" UNIQUE("material_id","storage_location_id"),
	CONSTRAINT "stock_qty_nonneg_ck" CHECK ("stock"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goods_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'POSTED' NOT NULL,
	"posting_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"movement_type" varchar(3) NOT NULL,
	"plant_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"header_text" varchar(256),
	CONSTRAINT "goods_movement_posting_key_uq" UNIQUE("plant_id","posting_key"),
	CONSTRAINT "goods_movement_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "goods_movement_status_ck" CHECK ("goods_movement"."status" = 'POSTED'),
	CONSTRAINT "goods_movement_type_ck" CHECK ("goods_movement"."movement_type" in ('561', '101', '201', '711', '712'))
);
--> statement-breakpoint
CREATE TABLE "goods_movement_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"goods_movement_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"qty" numeric(18, 6) NOT NULL,
	"unit_price" numeric(18, 6),
	"amount" numeric(18, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "goods_movement_item_no_uq" UNIQUE("goods_movement_id","line_no"),
	CONSTRAINT "goods_movement_item_qty_pos_ck" CHECK ("goods_movement_item"."qty" > 0),
	CONSTRAINT "goods_movement_item_amount_nonneg_ck" CHECK ("goods_movement_item"."amount" >= 0),
	CONSTRAINT "goods_movement_item_unit_price_nonneg_ck" CHECK ("goods_movement_item"."unit_price" is null or "goods_movement_item"."unit_price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "storage_location" ADD CONSTRAINT "storage_location_id_plant_uq" UNIQUE("id","plant_id");--> statement-breakpoint
ALTER TABLE "material_valuation" ADD CONSTRAINT "material_valuation_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_valuation" ADD CONSTRAINT "material_valuation_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_sloc_plant_fk" FOREIGN KEY ("storage_location_id","plant_id") REFERENCES "public"."storage_location"("id","plant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_movement" ADD CONSTRAINT "goods_movement_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_movement_item" ADD CONSTRAINT "goods_movement_item_goods_movement_id_goods_movement_id_fk" FOREIGN KEY ("goods_movement_id") REFERENCES "public"."goods_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_movement_item" ADD CONSTRAINT "goods_movement_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_movement_item" ADD CONSTRAINT "goods_movement_item_storage_location_id_storage_location_id_fk" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_plant_idx" ON "stock" USING btree ("material_id","plant_id");--> statement-breakpoint
CREATE INDEX "goods_movement_plant_date_idx" ON "goods_movement" USING btree ("plant_id","posting_date");--> statement-breakpoint
CREATE INDEX "goods_movement_item_material_idx" ON "goods_movement_item" USING btree ("material_id");