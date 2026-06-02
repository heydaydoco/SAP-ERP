CREATE TYPE "public"."fiscal_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "account_determination" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chart_of_accounts" varchar(16) NOT NULL,
	"transaction_key" varchar(32) NOT NULL,
	"valuation_class" varchar(16) DEFAULT '' NOT NULL,
	"material_group" varchar(16) DEFAULT '' NOT NULL,
	"tax_code" varchar(16) DEFAULT '' NOT NULL,
	"company_code" varchar(8) DEFAULT '' NOT NULL,
	"gl_account" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "account_determination_uq" UNIQUE("chart_of_accounts","transaction_key","valuation_class","material_group","tax_code","company_code")
);
--> statement-breakpoint
CREATE TABLE "fiscal_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"period_no" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "fiscal_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "fiscal_period_uq" UNIQUE("fiscal_year_id","period_no")
);
--> statement-breakpoint
CREATE TABLE "fiscal_year" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_code_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"status" "fiscal_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "fiscal_year_uq" UNIQUE("company_code_id","year")
);
--> statement-breakpoint
ALTER TABLE "fiscal_period" ADD CONSTRAINT "fiscal_period_fiscal_year_id_fiscal_year_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_year"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year" ADD CONSTRAINT "fiscal_year_company_code_id_company_code_id_fk" FOREIGN KEY ("company_code_id") REFERENCES "public"."company_code"("id") ON DELETE no action ON UPDATE no action;