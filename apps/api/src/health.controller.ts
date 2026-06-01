import { Controller, Get } from '@nestjs/common';
import { Public } from './domains/platform/auth/public.decorator.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): { status: 'ok'; ts: string } {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
