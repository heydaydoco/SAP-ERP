CREATE TABLE "unipass_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"declaration_type" varchar(16) NOT NULL,
	"declaration_id" uuid NOT NULL,
	"direction" varchar(8) NOT NULL,
	"message_type" varchar(16) NOT NULL,
	"result" varchar(16),
	"mrn" varchar(35),
	"response_message" varchar(512),
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "unipass_message_declaration_type_ck" CHECK ("unipass_message"."declaration_type" in ('EXPORT', 'IMPORT')),
	CONSTRAINT "unipass_message_direction_ck" CHECK ("unipass_message"."direction" in ('OUTBOUND', 'INBOUND')),
	CONSTRAINT "unipass_message_message_type_ck" CHECK ("unipass_message"."message_type" in ('DECLARATION', 'RESPONSE')),
	CONSTRAINT "unipass_message_result_ck" CHECK ("unipass_message"."result" is null or "unipass_message"."result" in ('ACCEPTED', 'REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "export_declaration" DROP CONSTRAINT "export_declaration_status_ck";--> statement-breakpoint
ALTER TABLE "import_declaration" DROP CONSTRAINT "import_declaration_status_ck";--> statement-breakpoint
CREATE INDEX "unipass_message_declaration_idx" ON "unipass_message" USING btree ("declaration_type","declaration_id");--> statement-breakpoint
ALTER TABLE "export_declaration" ADD CONSTRAINT "export_declaration_status_ck" CHECK ("export_declaration"."status" in ('SUBMITTED', 'ACCEPTED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "import_declaration" ADD CONSTRAINT "import_declaration_status_ck" CHECK ("import_declaration"."status" in ('SUBMITTED', 'ACCEPTED', 'REJECTED'));