import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { PlatformModule } from './domains/platform/platform.module.js';
import { HealthController } from './health.controller.js';

/**
 * Root application module — modular monolith (root CLAUDE.md §4.1). Each domain is a feature module
 * under `src/domains/<domain>`. Phase 0 wires the platform spine; business domains attach per phase.
 */
@Module({
  imports: [EventEmitterModule.forRoot(), DatabaseModule, PlatformModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
