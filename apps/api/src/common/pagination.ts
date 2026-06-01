import type { Paginated, PaginationQuery } from '@erp/shared';

/** SQL OFFSET for a paging query. */
export const toOffset = (q: PaginationQuery): number => (q.page - 1) * q.pageSize;

/** Wrap rows + total into the standard paged envelope (root CLAUDE.md §4: unified paging). */
export function paginated<T>(data: T[], total: number, q: PaginationQuery): Paginated<T> {
  return { data, total, page: q.page, pageSize: q.pageSize };
}
