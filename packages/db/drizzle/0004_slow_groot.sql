CREATE TYPE "public"."gl_account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."tax_kind" AS ENUM('OUTPUT', 'INPUT');--> statement-breakpoint
CREATE TABLE "currency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" char(3) NOT NULL,
	"name" varchar(64) NOT NULL,
	"minor_unit" integer NOT NULL,
	"symbol" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "currency_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "fx_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_currency" char(3) NOT NULL,
	"to_currency" char(3) NOT NULL,
	"rate_type" varchar(4) DEFAULT 'M' NOT NULL,
	"valid_from" date NOT NULL,
	"rate" numeric(18, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "fx_rate_uq" UNIQUE("from_currency","to_currency","rate_type","valid_from")
);
--> statement-breakpoint
CREATE TABLE "gl_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chart_of_accounts" varchar(16) NOT NULL,
	"account_number" varchar(16) NOT NULL,
	"name" varchar(128) NOT NULL,
	"account_type" "gl_account_type" NOT NULL,
	"currency" char(3),
	"is_reconciliation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "gl_account_uq" UNIQUE("chart_of_accounts","account_number")
);
--> statement-breakpoint
CREATE TABLE "tax_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(8) NOT NULL,
	"name" varchar(128) NOT NULL,
	"kind" "tax_kind" NOT NULL,
	"rate_percent" numeric(7, 4) NOT NULL,
	"gl_account" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "tax_code_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "cost_center" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" varchar(128) NOT NULL,
	"company_code_id" uuid NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"responsible" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "cost_center_uq" UNIQUE("company_code_id","code")
);
--> statement-breakpoint
ALTER TABLE "cost_center" ADD CONSTRAINT "cost_center_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;