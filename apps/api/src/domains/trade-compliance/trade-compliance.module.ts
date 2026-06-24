import { Module } from '@nestjs/common';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { FinanceAccountingModule } from '../finance-accounting/finance-accounting.module.js';
import { ExportDeclarationController } from './export-declaration/export-declaration.controller.js';
import { ExportDeclarationService } from './export-declaration/export-declaration.service.js';
import { ImportDeclarationController } from './import-declaration/import-declaration.controller.js';
import { ImportDeclarationService } from './import-declaration/import-declaration.service.js';
import { DutyDrawbackController } from './duty-drawback/duty-drawback.controller.js';
import { DutyDrawbackService } from './duty-drawback/duty-drawback.service.js';

/**
 * Trade & compliance domain module (SAP GTS) — Phase 7 `customs-declaration`: `export-declaration` (수출신고,
 * slice 1) + `import-declaration` (수입신고, slice 2), both non-posting; plus `duty-drawback` (관세환급 간이정액,
 * slice 3) — the domain's FIRST POSTING document. The declarations import PlatformModule (DocFlowService),
 * NumberingModule, and MasterDataModule. Duty-drawback additionally needs FinanceAccountingModule
 * (`JournalService` — the approve() journal Dr 관세환급금 미수금 / Cr 관세환급수익) and AdminConfigModule
 * (`AccountDeterminationService` — those GL accounts resolved via §4.5 config, never hard-coded). Cross-domain
 * reads (delivery / billing / goods_movement / export_declaration) go through `@Inject(DB)` directly, READ-ONLY.
 */
@Module({
  imports: [
    PlatformModule,
    NumberingModule,
    AdminConfigModule,
    MasterDataModule,
    FinanceAccountingModule,
  ],
  providers: [ExportDeclarationService, ImportDeclarationService, DutyDrawbackService],
  controllers: [ExportDeclarationController, ImportDeclarationController, DutyDrawbackController],
  exports: [ExportDeclarationService, ImportDeclarationService, DutyDrawbackService],
})
export class TradeComplianceModule {}
