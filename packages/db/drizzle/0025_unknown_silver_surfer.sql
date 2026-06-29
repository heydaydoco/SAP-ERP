CREATE TABLE "carrier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bp_id" uuid NOT NULL,
	"scac" varchar(4),
	"iata_code" varchar(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "carrier_bp_id_unique" UNIQUE("bp_id")
);
--> statement-breakpoint
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_bp_id_business_partner_id_fk" FOREIGN KEY ("bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;