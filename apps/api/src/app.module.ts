import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * Root application module — modular monolith (root CLAUDE.md §4.1).
 * Phase 0 wires the platform domain modules here; each domain becomes one feature module under
 * `src/domains/<domain>`. No domain modules exist yet (scaffold only).
 */
@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
