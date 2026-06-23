import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ExportDeclarationService } from './export-declaration.service.js';
import {
  acceptExportDeclarationSchema,
  createExportDeclarationSchema,
  exportDeclarationQuerySchema,
  type AcceptExportDeclarationDto,
  type CreateExportDeclarationDto,
  type ExportDeclarationQuery,
} from './export-declaration.dto.js';

@Controller('trade-compliance')
export class ExportDeclarationController {
  constructor(private readonly exportDeclarations: ExportDeclarationService) {}

  @RequirePermissions('trade_compliance:export_declaration:create')
  @Post('export-declarations')
  create(
    @Body(new ZodValidationPipe(createExportDeclarationSchema)) dto: CreateExportDeclarationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exportDeclarations.create(dto, user.username);
  }

  /** 수리: stamp the 수출신고번호 (MRN) and flip SUBMITTED → ACCEPTED. */
  @RequirePermissions('trade_compliance:export_declaration:accept')
  @Post('export-declarations/:id/accept')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(acceptExportDeclarationSchema)) dto: AcceptExportDeclarationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exportDeclarations.accept(id, dto, user.username);
  }

  @RequirePermissions('trade_compliance:export_declaration:read')
  @Get('export-declarations')
  async list(@Query(new ZodValidationPipe(exportDeclarationQuerySchema)) q: ExportDeclarationQuery) {
    const [rows, total] = await Promise.all([
      this.exportDeclarations.listExportDeclarations(q, q.pageSize, toOffset(q)),
      this.exportDeclarations.countExportDeclarations(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('trade_compliance:export_declaration:read')
  @Get('export-declarations/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.exportDeclarations.getExportDeclaration(id);
  }
}
