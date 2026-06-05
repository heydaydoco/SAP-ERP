import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { JournalController } from './general-ledger/journal.controller.js';
import { JournalService } from './general-ledger/journal.service.js';

/**
 * Finance-accounting domain module (Phase 2, slice 1: general-ledger). Hosts the concrete
 * fi-posting service the kernel reserved in Phase 0 — `JournalService` is exported so sibling
 * domains (AR/AP in PR-B, sales/procurement later) post through it (§3.2: every value-moving
 * transaction flows through fi-posting).
 */
@Module({
  imports: [PlatformModule, NumberingModule, AdminConfigModule, MasterDataModule],
  providers: [JournalService],
  controllers: [JournalController],
  exports: [JournalService],
})
export class FinanceAccountingModule {}
