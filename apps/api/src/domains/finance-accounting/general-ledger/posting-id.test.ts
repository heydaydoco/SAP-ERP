import { describe, expect, it } from 'vitest';
import { JOURNAL_EVENT_NAMESPACE, uuidV5 } from './posting-id.js';

const V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the RFC 4122 reference vector (DNS namespace, "python.org")', () => {
    // Well-known v5 test vector (Python uuid docs).
    expect(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('is deterministic — a retried posting key derives the same event id', () => {
    const a = uuidV5('manual:abc', JOURNAL_EVENT_NAMESPACE);
    const b = uuidV5('manual:abc', JOURNAL_EVENT_NAMESPACE);
    expect(a).toBe(b);
    expect(a).toMatch(V5_RE);
  });

  it('distinct names (post vs its reversal) yield distinct ids', () => {
    expect(uuidV5('key', JOURNAL_EVENT_NAMESPACE)).not.toBe(
      uuidV5('key:REV', JOURNAL_EVENT_NAMESPACE),
    );
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow(/invalid namespace/);
  });
});
