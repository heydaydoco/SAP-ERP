CREATE TABLE "tracking_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	"shipment_id" uuid NOT NULL,
	"event_type" varchar(16) NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"location" varchar(128),
	"description" varchar(256),
	CONSTRAINT "tracking_event_no_uq" UNIQUE("shipment_id","line_no"),
	CONSTRAINT "tracking_event_type_ck" CHECK ("tracking_event"."event_type" in ('GATE_IN', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'DISCHARGED', 'GATE_OUT', 'DELIVERED'))
);
--> statement-breakpoint
CREATE INDEX "tracking_event_time_idx" ON "tracking_event" USING btree ("shipment_id","event_time");