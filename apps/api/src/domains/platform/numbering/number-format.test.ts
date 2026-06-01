import { describe, it, expect } from 'vitest';
import { formatDocNo } from './number-format';

describe('formatDocNo', () => {
  it('zero-pads to the configured width with prefix/suffix', () => {
    expect(formatDocNo({ prefix: 'SO-2026-', suffix: '', padding: 6 }, 123n)).toBe('SO-2026-000123');
    expect(formatDocNo({ prefix: 'PO', suffix: '', padding: 8 }, 1n)).toBe('PO00000001');
  });

  it('does not truncate values wider than the padding', () => {
    expect(formatDocNo({ prefix: '', suffix: '', padding: 4 }, 1234567n)).toBe('1234567');
  });
});
