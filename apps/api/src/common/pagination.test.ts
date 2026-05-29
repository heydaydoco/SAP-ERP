import { describe, it, expect } from 'vitest';
import { toOffset, paginated } from './pagination';

describe('pagination helpers', () => {
  it('computes SQL offset from page/pageSize', () => {
    expect(toOffset({ page: 1, pageSize: 20 })).toBe(0);
    expect(toOffset({ page: 3, pageSize: 20 })).toBe(40);
  });

  it('wraps rows into the standard envelope', () => {
    expect(paginated([1, 2], 57, { page: 2, pageSize: 2 })).toEqual({
      data: [1, 2],
      total: 57,
      page: 2,
      pageSize: 2,
    });
  });
});
