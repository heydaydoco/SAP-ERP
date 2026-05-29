/**
 * Document Flow (root CLAUDE.md §4.3).
 *
 * Generic graph that traces the whole chain — quote→order→delivery→billing→FI,
 * opportunity→order, etc. — instead of bespoke FK links per relationship.
 *
 * Interface stub; the `doc_flow` table + service land in Phase 0.
 */
export interface DocFlowEdge {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relType: string; // e.g. 'REFERS_TO' | 'COPIED_FROM' | 'REVERSES'
}

export interface DocFlowService {
  link(edge: DocFlowEdge): Promise<void>;
  /** All edges originating from a document. */
  forward(sourceType: string, sourceId: string): Promise<DocFlowEdge[]>;
  /** All edges pointing at a document. */
  backward(targetType: string, targetId: string): Promise<DocFlowEdge[]>;
}
