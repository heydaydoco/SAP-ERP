ALTER TABLE "goods_movement_item" ADD COLUMN "document_currency" char(3);--> statement-breakpoint
ALTER TABLE "goods_movement_item" ADD COLUMN "exchange_rate" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "goods_movement_item" ADD COLUMN "document_amount" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "invoice_verification" ADD COLUMN "exchange_rate" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "goods_movement_item" ADD CONSTRAINT "goods_movement_item_doc_amount_nonneg_ck" CHECK ("goods_movement_item"."document_amount" is null or "goods_movement_item"."document_amount" >= 0);