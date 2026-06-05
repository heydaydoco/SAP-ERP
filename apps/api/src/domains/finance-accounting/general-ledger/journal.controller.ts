import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { JournalService } from './journal.service.js';
import {
  createManualJournalSchema,
  journalQuerySchema,
  reverseJournalSchema,
  trialBalanceQuerySchema,
  type CreateManualJournalDto,
  type JournalQuery,
  type ReverseJournalDto,
  type TrialBalanceQuery,
} from './journal.dto.js';

/**
 * General-ledger journal API (finance-accounting.general-ledger). Write paths are post + reverse
 * only — a posted journal is immutable (§5.1), so there is no PUT/PATCH/DELETE anywhere.
 */
@Controller('finance-accounting')
export class JournalController {
  constructor(private readonly journals: JournalService) {}

  @RequirePermissions('finance:journal:post')
  @Post('journal-entries')
  postManual(
    @Body(new ZodValidationPipe(createManualJournalSchema)) dto: CreateManualJournalDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.journals.postManual(dto, user.username);
  }

  @RequirePermissions('finance:journal:reverse')
  @Post('journal-entries/:id/reverse')
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseJournalSchema)) dto: ReverseJournalDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.journals.reverse(id, dto.reason, dto.postingDate, user.username);
  }

  @RequirePermissions('finance:journal:read')
  @Get('journal-entries')
  async listJournals(@Query(new ZodValidationPipe(journalQuerySchema)) q: JournalQuery) {
    const [rows, total] = await Promise.all([
      this.journals.listJournals(q, q.pageSize, toOffset(q)),
      this.journals.countJournals(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('finance:journal:read')
  @Get('journal-entries/:id')
  getJournal(@Param('id', ParseUUIDPipe) id: string) {
    return this.journals.getJournal(id);
  }

  @RequirePermissions('finance:journal:read')
  @Get('trial-balance')
  trialBalance(@Query(new ZodValidationPipe(trialBalanceQuerySchema)) q: TrialBalanceQuery) {
    return this.journals.trialBalance(q.companyCodeId, q.fiscalYear, q.periodNo);
  }
}
