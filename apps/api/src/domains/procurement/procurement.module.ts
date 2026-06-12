import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { FinanceAccountingModule } from '../finance-accounting/finance-accounting.module.js';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module.js';
import { ProcurementQueryService } from './procurement-query.service.js';
import { PurchaseOrderController } from './purchase-order/purchase-order.controller.js';
import { PurchaseOrderService } from './purchase-order/purchase-order.service.js';
import { GoodsReceiptController } from './goods-receipt/goods-receipt.controller.js';
import { GoodsReceiptService } from './goods-receipt/goods-receipt.service.js';
import { InvoiceVerificationController } from './invoice-verification/invoice-verification.controller.js';
import { InvoiceVerificationService } from './invoice-verification/invoice-verification.service.js';

/**
 * Procurement domain module (Phase 3 slice 2: P2P PO→GR→IV + GR/IR clearing). The goods receipt
 * REUSES the inventory goods-movement engine (imported `GoodsMovementService`) with a WRX offset and
 * PO lineage; invoice verification posts the AP open item through the imported `JournalService` and
 * reuses the AR/AP recon substitution + tax-line builder (FinanceAccountingModule / MasterDataModule).
 * GL accounts (WRX) resolve via account_determination (§4.5).
 */
@Module({
  imports: [
    PlatformModule,
    NumberingModule,
    AdminConfigModule,
    MasterDataModule,
    FinanceAccountingModule,
    InventoryWarehouseModule,
  ],
  providers: [
    ProcurementQueryService,
    PurchaseOrderService,
    GoodsReceiptService,
    InvoiceVerificationService,
  ],
  controllers: [
    PurchaseOrderController,
    GoodsReceiptController,
    InvoiceVerificationController,
  ],
  exports: [
    ProcurementQueryService,
    PurchaseOrderService,
    GoodsReceiptService,
    InvoiceVerificationService,
  ],
})
export class ProcurementModule {}
