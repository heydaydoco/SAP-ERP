import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ImportDeclarationService } from './import-declaration.service.js';
import {
  acceptImportDeclarationSchema,
  createImportDeclarationSchema,
  importDeclarationQuerySchema,
  type AcceptImportDeclarationDto,
  type CreateImportDeclarationDto,
  type ImportDeclarationQuery,
} from './import-declaration.dto.js';

@Controller('trade-compliance')
export class ImportDeclarationController {
  constructor(private readonly importDeclarations: ImportDeclarationService) {}

  @RequirePermissions('trade_compliance:import_declaration:create')
  @Post('import-declarations')
  create(
    @Body(new ZodValidationPipe(createImportDeclarationSchema)) dto: CreateImportDeclarationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.importDeclarations.create(dto, user.username);
  }

  /** 수리: stamp the 수입신고번호 (MRN) + 신고수리일 and flip SUBMITTED → ACCEPTED. */
  @RequirePermissions('trade_compliance:import_declaration:accept')
  @Post('import-declarations/:id/accept')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(acceptImportDeclarationSchema)) dto: AcceptImportDeclarationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.importDeclarations.accept(id, dto, user.username);
  }

  @RequirePermissions('trade_compliance:import_declaration:read')
  @Get('import-declarations')
  async list(@Query(new ZodValidationPipe(importDeclarationQuerySchema)) q: ImportDeclarationQuery) {
    const [rows, total] = await Promise.all([
      this.importDeclarations.listImportDeclarations(q, q.pageSize, toOffset(q)),
      this.importDeclarations.countImportDeclarations(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('trade_compliance:import_declaration:read')
  @Get('import-declarations/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.importDeclarations.getImportDeclaration(id);
  }
}
