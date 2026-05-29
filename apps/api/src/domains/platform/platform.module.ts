import { Module } from '@nestjs/common';
import { InProcessEventBus } from '../../common/events/event-bus.service.js';
import { DocFlowService } from './doc-flow/doc-flow.service.js';
import { OutboxService } from './outbox/outbox.service.js';

/**
 * Platform domain module (Phase 0). Hosts the cross-cutting infrastructure every other domain
 * depends on. This PR ships the spine — document flow, the in-process event bus, and the
 * transactional outbox; auth/rbac/numbering/etc. land in later Phase-0 PRs.
 */
@Module({
  providers: [DocFlowService, OutboxService, InProcessEventBus],
  exports: [DocFlowService, OutboxService, InProcessEventBus],
})
export class PlatformModule {}
