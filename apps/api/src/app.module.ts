import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { FinanceAccountingModule } from './domains/finance-accounting/finance-accounting.module.js';
import { MasterDataModule } from './domains/master-data/master-data.module.js';
import { AdminConfigModule } from './domains/platform/admin-config/admin-config.module.js';
import { AuthModule } from './domains/platform/auth/auth.module.js';
import { JwtAuthGuard } from './domains/platform/auth/jwt-auth.guard.js';
import { NumberingModule } from './domains/platform/numbering/numbering.module.js';
import { OrgStructureModule } from './domains/platform/org-structure/org-structure.module.js';
import { PlatformModule } from './domains/platform/platform.module.js';
import { PermissionsGuard } from './domains/platform/rbac/permissions.guard.js';
import { RbacModule } from './domains/platform/rbac/rbac.module.js';
import { HealthController } from './health.controller.js';

/**
 * Root application module — modular monolith (root CLAUDE.md §4.1). Each domain is a feature module
 * under `src/domains/<domain>`. Phase 0 wires the platform spine; business domains attach per phase.
 *
 * Security is secure-by-default: JwtAuthGuard (authn) then PermissionsGuard (authz) run globally;
 * routes opt out with `@Public()` and opt into checks with `@RequirePermissions()`.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    DatabaseModule,
    PlatformModule,
    NumberingModule,
    RbacModule,
    AuthModule,
    OrgStructureModule,
    AdminConfigModule,
    MasterDataModule,
    FinanceAccountingModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
