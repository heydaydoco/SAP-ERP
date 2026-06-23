import { Module } from '@nestjs/common';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ExportDeclarationController } from './export-declaration/export-declaration.controller.js';
import { ExportDeclarationService } from './export-declaration/export-declaration.service.js';

/**
 * Trade & compliance domain module (SAP GTS) — Phase 7, first slice: `export-declaration` (수출신고), the
 * `customs-declaration` module's export leg. A non-posting customs document, so NO FinanceAccountingModule:
 * it imports PlatformModule (DocFlowService — the `DECLARES` lineage onto the delivery's 601 GI),
 * NumberingModule (ED-NNNNNN), and MasterDataModule (BusinessPartnerService / CurrencyService /
 * DbCurrencyRegistry). Cross-domain reads (delivery / sales_order / billing for the 영세율 gate) go through
 * the injected `@Inject(DB)` directly, READ-ONLY — no SalesModule import.
 */
@Module({
  imports: [PlatformModule, NumberingModule, MasterDataModule],
  providers: [ExportDeclarationService],
  controllers: [ExportDeclarationController],
  exports: [ExportDeclarationService],
})
export class TradeComplianceModule {}
