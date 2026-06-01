import { Module } from '@nestjs/common';
import { CaslAbilityFactory } from './casl-ability.factory.js';
import { PermissionsGuard } from './permissions.guard.js';
import { RbacService } from './rbac.service.js';

@Module({
  providers: [CaslAbilityFactory, RbacService, PermissionsGuard],
  exports: [CaslAbilityFactory, RbacService, PermissionsGuard],
})
export class RbacModule {}
