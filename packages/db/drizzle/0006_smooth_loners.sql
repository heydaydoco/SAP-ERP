CREATE TYPE "public"."material_type" AS ENUM('FINISHED', 'SEMI_FINISHED', 'RAW', 'TRADING', 'SERVICE');--> statement-breakpoint
CREATE TABLE "material" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" varchar(256) NOT NULL,
	"material_type" "material_type" NOT NULL,
	"base_uom" varchar(8) NOT NULL,
	"material_group" varchar(16),
	"net_weight" numeric(18, 6),
	"weight_unit" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "material_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "material_trade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"hs_code" varchar(16) NOT NULL,
	"country_of_origin" char(2),
	"export_control_class" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "material_trade_material_id_unique" UNIQUE("material_id")
);
--> statement-breakpoint
ALTER TABLE "material_trade" ADD CONSTRAINT "material_trade_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE no action ON UPDATE no action;