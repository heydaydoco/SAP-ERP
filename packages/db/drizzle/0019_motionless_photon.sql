ALTER TABLE "drawback_claim" DROP CONSTRAINT "drawback_claim_status_ck";--> statement-breakpoint
ALTER TABLE "drawback_claim" ADD COLUMN "receipt_date" date;--> statement-breakpoint
ALTER TABLE "drawback_claim" ADD COLUMN "received_amount" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "drawback_claim" ADD COLUMN "received_currency" char(3);--> statement-breakpoint
ALTER TABLE "drawback_claim" ADD CONSTRAINT "drawback_claim_received_amount_nonneg_ck" CHECK ("drawback_claim"."received_amount" is null or "drawback_claim"."received_amount" >= 0);--> statement-breakpoint
ALTER TABLE "drawback_claim" ADD CONSTRAINT "drawback_claim_status_ck" CHECK ("drawback_claim"."status" in ('CLAIMED', 'APPROVED', 'PAID'));