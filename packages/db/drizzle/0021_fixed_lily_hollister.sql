CREATE TABLE "shipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(32) NOT NULL,
	"doc_no" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'PLANNED' NOT NULL,
	"posting_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"transport_mode" varchar(8) NOT NULL,
	"carrier" varchar(128),
	"vessel_flight_no" varchar(64),
	"transport_doc_no" varchar(35),
	"port_of_loading" varchar(64),
	"port_of_discharge" varchar(64),
	"etd" date,
	"eta" date,
	"header_text" varchar(256),
	CONSTRAINT "shipment_doc_no_uq" UNIQUE("doc_no"),
	CONSTRAINT "shipment_status_ck" CHECK ("shipment"."status" in ('PLANNED', 'BOOKED', 'DEPARTED', 'ARRIVED')),
	CONSTRAINT "shipment_transport_mode_ck" CHECK ("shipment"."transport_mode" in ('SEA', 'AIR', 'RAIL', 'TRUCK'))
);
--> statement-breakpoint
CREATE TABLE "shipment_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"shipment_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	CONSTRAINT "shipment_item_no_uq" UNIQUE("shipment_id","line_no"),
	CONSTRAINT "shipment_item_delivery_uq" UNIQUE("shipment_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_item" ADD CONSTRAINT "shipment_item_shipment_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_company_idx" ON "shipment" USING btree ("company_code_id");--> statement-breakpoint
CREATE INDEX "shipment_status_idx" ON "shipment" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipment_item_shipment_idx" ON "shipment_item" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_item_delivery_idx" ON "shipment_item" USING btree ("delivery_id");