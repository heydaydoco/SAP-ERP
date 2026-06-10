import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { MaterialValuationService } from './material-valuation.service.js';
import { InventoryReconciliationService } from './reconciliation.service.js';
import {
  ensureMaterialValuationSchema,
  materialValuationQuerySchema,
  reconciliationQuerySchema,
  type EnsureMaterialValuationDto,
  type MaterialValuationQuery,
  type ReconciliationQuery,
} from './material-valuation.dto.js';

@Controller('inventory-warehouse')
export class MaterialValuationController {
  constructor(
    private readonly valuations: MaterialValuationService,
    private readonly reconciliation: InventoryReconciliationService,
  ) {}

  @RequirePermissions('inventory:material_valuation:manage')
  @Post('material-valuations')
  ensureValuation(
    @Body(new ZodValidationPipe(ensureMaterialValuationSchema)) dto: EnsureMaterialValuationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.valuations.ensureValuation(dto, user.username);
  }

  @RequirePermissions('inventory:material_valuation:read')
  @Get('material-valuations')
  async listValuations(
    @Query(new ZodValidationPipe(materialValuationQuerySchema)) q: MaterialValuationQuery,
  ) {
    const [rows, total] = await Promise.all([
      this.valuations.listValuations(q, q.pageSize, toOffset(q)),
      this.valuations.countValuations(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('inventory:stock:read')
  @Get('materials/:materialId/plants/:plantId/stock')
  listStock(
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Param('plantId', ParseUUIDPipe) plantId: string,
  ) {
    return this.valuations.listStock(materialId, plantId);
  }

  /** Inventory ↔ GL tie-out: Σ stock_value vs the BSX account balance; delta must be 0. */
  @RequirePermissions('inventory:material_valuation:read')
  @Get('reconciliation')
  reconcile(@Query(new ZodValidationPipe(reconciliationQuerySchema)) q: ReconciliationQuery) {
    return this.reconciliation.reconcile(q.companyCodeId);
  }
}
