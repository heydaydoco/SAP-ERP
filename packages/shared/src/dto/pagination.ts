import { z } from 'zod';

/** Standard paging/filter query shared by the common base controller. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  sort: z.string().optional(), // e.g. "created_at:desc"
  q: z.string().optional(), // free-text search
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Standard paged response envelope. */
export const paginatedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}
