import { Module } from '@nestjs/common';
import { OrgStructureController } from './org-structure.controller.js';
import { OrgStructureService } from './org-structure.service.js';

@Module({
  providers: [OrgStructureService],
  controllers: [OrgStructureController],
  exports: [OrgStructureService],
})
export class OrgStructureModule {}
