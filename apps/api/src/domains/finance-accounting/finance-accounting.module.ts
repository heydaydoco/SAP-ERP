import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ApInvoiceController } from './accounts-payable/ap-invoice.controller.js';
import { ApInvoiceService } from './accounts-payable/ap-invoice.service.js';
import { ArInvoiceController } from './accounts-receivable/ar-invoice.controller.js';
import { ArInvoiceService } from './accounts-receivable/ar-invoice.service.js';
import { JournalController } from './general-ledger/journal.controller.js';
import { JournalService } from './general-ledger/journal.service.js';

/**
 * Finance-accounting domain module (Phase 2). Hosts the concrete fi-posting service the kernel
 * reserved in Phase 0 — `JournalService` is exported so sibling domains (sales/procurement later)
 * post through it (§3.2: every value-moving transaction flows through fi-posting). Slice 2 (PR-B)
 * adds the AR/AP invoice services, which post customer (`DR`) / vendor (`KR`) documents through that
 * same `JournalService.post()` with recon-account substitution and VAT lines.
 */
@Module({
  imports: [PlatformModule, NumberingModule, AdminConfigModule, MasterDataModule],
  providers: [JournalService, ArInvoiceService, ApInvoiceService],
  controllers: [JournalController, ArInvoiceController, ApInvoiceController],
  exports: [JournalService, ArInvoiceService, ApInvoiceService],
})
export class FinanceAccountingModule {}
