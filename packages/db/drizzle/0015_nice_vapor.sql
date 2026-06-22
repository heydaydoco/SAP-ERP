CREATE TABLE "physical_inventory_doc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'COUNTED' NOT NULL,
	"posting_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"plant_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"header_text" varchar(256),
	CONSTRAINT "physical_inventory_doc_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "physical_inventory_doc_posting_key_uq" UNIQUE("plant_id","posting_key"),
	CONSTRAINT "physical_inventory_doc_status_ck" CHECK ("physical_inventory_doc"."status" in ('COUNTED', 'POSTED'))
);
--> statement-breakpoint
CREATE TABLE "physical_inventory_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"physical_inventory_doc_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"book_qty" numeric(18, 6) NOT NULL,
	"physical_qty" numeric(18, 6) NOT NULL,
	"diff_qty" numeric(18, 6) NOT NULL,
	CONSTRAINT "physical_inventory_item_no_uq" UNIQUE("physical_inventory_doc_id","line_no"),
	CONSTRAINT "physical_inventory_item_book_nonneg_ck" CHECK ("physical_inventory_item"."book_qty" >= 0),
	CONSTRAINT "physical_inventory_item_phys_nonneg_ck" CHECK ("physical_inventory_item"."physical_qty" >= 0),
	CONSTRAINT "physical_inventory_item_diff_ck" CHECK ("physical_inventory_item"."diff_qty" = "physical_inventory_item"."physical_qty" - "physical_inventory_item"."book_qty")
);
--> statement-breakpoint
ALTER TABLE "goods_movement" DROP CONSTRAINT "goods_movement_type_ck";--> statement-breakpoint
ALTER TABLE "physical_inventory_doc" ADD CONSTRAINT "physical_inventory_doc_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_inventory_item" ADD CONSTRAINT "physical_inventory_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_inventory_item" ADD CONSTRAINT "physical_inventory_item_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_inventory_item" ADD CONSTRAINT "physical_inventory_item_doc_fk" FOREIGN KEY ("physical_inventory_doc_id") REFERENCES "public"."physical_inventory_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_inventory_item" ADD CONSTRAINT "physical_inventory_item_sloc_plant_fk" FOREIGN KEY ("storage_location_id","plant_id") REFERENCES "public"."storage_location"("id","plant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "physical_inventory_doc_plant_date_idx" ON "physical_inventory_doc" USING btree ("plant_id","posting_date");--> statement-breakpoint
CREATE INDEX "physical_inventory_item_doc_idx" ON "physical_inventory_item" USING btree ("physical_inventory_doc_id");--> statement-breakpoint
CREATE INDEX "physical_inventory_item_material_idx" ON "physical_inventory_item" USING btree ("material_id");--> statement-breakpoint
ALTER TABLE "goods_movement" ADD CONSTRAINT "goods_movement_type_ck" CHECK ("goods_movement"."movement_type" in ('561', '101', '201', '711', '712', '601', '701', '702'));