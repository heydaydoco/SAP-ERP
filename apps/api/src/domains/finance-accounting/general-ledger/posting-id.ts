import { createHash } from 'node:crypto';

/**
 * Deterministic outbox event ids for FI postings (root CLAUDE.md §5.2). The outbox dedupes on its
 * unique `event_id`, so deriving the id from the posting key (instead of a random uuid) makes a
 * retried post enqueue the SAME event — exactly-once end to end. Reversals derive from the
 * reversal's own posting key, so the two events never collide.
 */

/** Fixed namespace for `finance.journal.*` events. Never change it — ids must stay stable. */
export const JOURNAL_EVENT_NAMESPACE = '4a1c9d6e-72b8-4f30-9a5d-08c1e6f2b794';

/** RFC 4122 version-5 (SHA-1, name-based) UUID of `name` within `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  const ns = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(ns)) {
    throw new Error(`invalid namespace uuid: "${namespace}"`);
  }
  const nsBytes = Buffer.from(ns, 'hex');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest()
    .subarray(0, 16);
  const versionByte = hash[6];
  const variantByte = hash[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('sha1 digest shorter than 16 bytes'); // unreachable — sha1 is 20 bytes
  }
  hash[6] = (versionByte & 0x0f) | 0x50; // version 5
  hash[8] = (variantByte & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
