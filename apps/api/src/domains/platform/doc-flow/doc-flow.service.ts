import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import type { DocFlowEdge, DocFlowService as IDocFlowService } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';

type DocFlowRow = typeof schema.docFlow.$inferSelect;

function toEdge(row: DocFlowRow): DocFlowEdge {
  return {
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    targetType: row.targetType,
    targetId: row.targetId,
    relType: row.relType,
  };
}

/**
 * Concrete Document Flow service (root CLAUDE.md §4.3) over the generic `doc_flow` table.
 * Domains call `link()` when one document spawns another; `forward`/`backward` drive SAP-style
 * drill-down. Created internally (actor = 'system') — there is no public write endpoint.
 */
@Injectable()
export class DocFlowService implements IDocFlowService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async link(edge: DocFlowEdge): Promise<void> {
    await this.db.insert(schema.docFlow).values({
      sourceType: edge.sourceType,
      sourceId: edge.sourceId,
      targetType: edge.targetType,
      targetId: edge.targetId,
      relType: edge.relType,
      createdBy: 'system',
      updatedBy: 'system',
    });
  }

  async forward(sourceType: string, sourceId: string): Promise<DocFlowEdge[]> {
    const rows = await this.db
      .select()
      .from(schema.docFlow)
      .where(and(eq(schema.docFlow.sourceType, sourceType), eq(schema.docFlow.sourceId, sourceId)));
    return rows.map(toEdge);
  }

  async backward(targetType: string, targetId: string): Promise<DocFlowEdge[]> {
    const rows = await this.db
      .select()
      .from(schema.docFlow)
      .where(and(eq(schema.docFlow.targetType, targetType), eq(schema.docFlow.targetId, targetId)));
    return rows.map(toEdge);
  }
}
