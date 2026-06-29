CREATE TABLE "carrier_booking" (
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
	"carrier_bp_id" uuid NOT NULL,
	"booking_no" varchar(64) NOT NULL,
	"cargo_cutoff" timestamp with time zone,
	"doc_cutoff" timestamp with time zone,
	"vgm_cutoff" timestamp with time zone,
	"reference" varchar(128),
	"header_text" varchar(256),
	CONSTRAINT "carrier_booking_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "carrier_booking_status_ck" CHECK ("carrier_booking"."status" in ('OPEN'))
);
--> statement-breakpoint
ALTER TABLE "carrier_booking" ADD CONSTRAINT "carrier_booking_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "carrier_booking_company_idx" ON "carrier_booking" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "carrier_booking_shipment_idx" ON "carrier_booking" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "carrier_booking_carrier_idx" ON "carrier_booking" USING btree ("carrier_bp_id");