import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { formatDocNo } from './number-format.js';

export interface DefineRangeInput {
  object: string;
  scope?: string;
  prefix?: string;
  suffix?: string;
  padding?: number;
  startValue?: bigint;
  endValue?: bigint;
}

/**
 * Numbering service (platform.numbering = SAP Number Range). `next()` allocates a gap-free document
 * number via an atomic increment + RETURNING, so concurrent callers serialize on the row lock.
 * Ranges are configured up front (later editable through admin-config).
 */
@Injectable()
export class NumberingService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Create a range if absent (idempotent). Does not reset an existing counter. */
  async defineRange(input: DefineRangeInput): Promise<void> {
    await this.db
      .insert(schema.numberRange)
      .values({
        object: input.object,
        scope: input.scope ?? 'GLOBAL',
        prefix: input.prefix ?? '',
        suffix: input.suffix ?? '',
        padding: input.padding ?? 6,
        startValue: input.startValue ?? 1n,
        endValue: input.endValue ?? null,
        createdBy: 'system',
        updatedBy: 'system',
      })
      .onConflictDoNothing({ target: [schema.numberRange.object, schema.numberRange.scope] });
  }

  /** Allocate the next number for (object, scope). Throws if the range is undefined or exhausted. */
  async next(object: string, scope = 'GLOBAL'): Promise<string> {
    const [row] = await this.db
      .update(schema.numberRange)
      .set({
        currentValue: sql`${schema.numberRange.currentValue} + 1`,
        updatedAt: new Date(),
        updatedBy: 'system',
      })
      .where(and(eq(schema.numberRange.object, object), eq(schema.numberRange.scope, scope)))
      .returning();

    if (!row) {
      throw new NotFoundException(`no number range defined for ${object}/${scope}`);
    }
    if (row.endValue !== null && row.currentValue > row.endValue) {
      throw new ConflictException(`number range ${object}/${scope} is exhausted`);
    }
    return formatDocNo(row, row.currentValue);
  }
}
