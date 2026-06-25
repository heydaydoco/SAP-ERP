import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { UnipassService } from './unipass.service.js';
import { submitDeclarationSchema, type SubmitDeclarationDto } from './unipass.dto.js';

/**
 * UNI-PASS connector controller (관세청 전자통관). The polymorphic declaration reference is carried in the path:
 * `:declarationType` (EXPORT|IMPORT, validated in the service) + `:declarationId`. `submit` transmits a
 * declaration to 관세청 (stub) and records the 수리/반려 verdict; `messages` returns its transmission log. No FI.
 */
@Controller('trade-compliance')
export class UnipassController {
  constructor(private readonly unipass: UnipassService) {}

  /** Transmit a SUBMITTED declaration to UNI-PASS (stub) → 수리(ACCEPTED, MRN stamp) or 반려(REJECTED). */
  @RequirePermissions('trade_compliance:unipass:submit')
  @Post('unipass/:declarationType/:declarationId/submit')
  submit(
    @Param('declarationType') declarationType: string,
    @Param('declarationId', ParseUUIDPipe) declarationId: string,
    @Body(new ZodValidationPipe(submitDeclarationSchema)) dto: SubmitDeclarationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unipass.submit(declarationType, declarationId, dto, user.username);
  }

  /** The declaration's transmission log (시간순). */
  @RequirePermissions('trade_compliance:unipass:read')
  @Get('unipass/:declarationType/:declarationId/messages')
  messages(
    @Param('declarationType') declarationType: string,
    @Param('declarationId', ParseUUIDPipe) declarationId: string,
  ) {
    return this.unipass.getMessages(declarationType, declarationId);
  }
}
