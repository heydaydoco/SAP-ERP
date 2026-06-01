import { Module } from '@nestjs/common';
import { NumberingService } from './numbering.service.js';

@Module({
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
