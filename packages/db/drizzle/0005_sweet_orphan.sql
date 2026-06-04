CREATE TYPE "public"."bp_type" AS ENUM('ORGANIZATION', 'PERSON');--> statement-breakpoint
CREATE TABLE "business_partner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(200) NOT NULL,
	"bp_type" "bp_type" NOT NULL,
	"tax_id" varchar(32),
	"country" char(2),
	"city" varchar(128),
	"address_line" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "business_partner_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bp_id" uuid NOT NULL,
	"ar_recon_account" varchar(16) NOT NULL,
	"credit_limit" numeric(18, 4),
	"credit_currency" char(3),
	"payment_terms_days" integer,
	"sales_block" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "customer_bp_id_unique" UNIQUE("bp_id")
);
--> statement-breakpoint
CREATE TABLE "vendor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bp_id" uuid NOT NULL,
	"ap_recon_account" varchar(16) NOT NULL,
	"payment_terms_days" integer,
	"purchasing_block" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "vendor_bp_id_unique" UNIQUE("bp_id")
);
--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_bp_id_business_partner_id_fk" FOREIGN KEY ("bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_bp_id_business_partner_id_fk" FOREIGN KEY ("bp_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;