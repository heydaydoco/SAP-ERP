import { Module } from '@nestjs/common';
import { AccountDeterminationService } from './account-determination.service.js';
import { AdminConfigController } from './admin-config.controller.js';
import { FiscalPeriodService } from './fiscal-period.service.js';

/**
 * Admin-config module (platform.admin-config). Exports FiscalPeriodService (period-lock guard) and
 * AccountDeterminationService (kernel AccountDeterminationResolver) so fi-posting and the seed can
 * consume them.
 */
@Module({
  providers: [FiscalPeriodService, AccountDeterminationService],
  controllers: [AdminConfigController],
  exports: [FiscalPeriodService, AccountDeterminationService],
})
export class AdminConfigModule {}
