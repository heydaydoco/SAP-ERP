import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types.js';
import { CaslAbilityFactory, permissionMatches } from './casl-ability.factory.js';
import { PERMISSIONS_KEY } from './permissions.decorator.js';

/**
 * Global guard that enforces `@RequirePermissions(...)`. Routes without the decorator pass through
 * (authn is handled separately by JwtAuthGuard). Builds the CASL ability from `request.user`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly casl: CaslAbilityFactory,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!req.user) throw new ForbiddenException('not authenticated');

    const ability = this.casl.createForUser(req.user);
    for (const perm of required) {
      if (!permissionMatches(ability, perm)) {
        throw new ForbiddenException(`missing permission: ${perm}`);
      }
    }
    return true;
  }
}
