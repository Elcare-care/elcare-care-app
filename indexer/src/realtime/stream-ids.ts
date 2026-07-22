/**
 * Helpers for SSE event ids.
 *
 * Two id families coexist:
 *  - Redis Stream ids: "<ms>-<seq>" (e.g. "1710000000000-2"), assigned by XADD.
 *  - Local (degraded-mode) ids: plain integers ("1", "2", …) assigned by the
 *    in-process counter when Redis is unavailable.
 *
 * Comparison treats a plain integer N as "0-N", which keeps local ids ordered
 * among themselves and always below any real stream id.
 */

export interface ParsedStreamId {
  ms: number;
  seq: number;
}

/** Parses either id family; returns null when the string is not an id. */
export function parseStreamId(id: string): ParsedStreamId | null {
  if (/^\d+$/.test(id)) return { ms: 0, seq: Number(id) };
  const m = /^(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { ms: Number(m[1]), seq: Number(m[2]) };
}

/** True when the string is a valid stream or local id. */
export function isValidEventId(id: string): boolean {
  return parseStreamId(id) !== null;
}

/**
 * Total order over event ids: negative when a < b, 0 when equal, positive
 * when a > b. Invalid ids sort lowest so they never suppress delivery.
 */
export function compareEventIds(a: string, b: string): number {
  const pa = parseStreamId(a);
  const pb = parseStreamId(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return pa.ms - pb.ms || pa.seq - pb.seq;
}

/**
 * The XRANGE start argument for resuming after `lastEventId`: Redis's
 * exclusive-range syntax. Returns null for invalid ids (no replay possible).
 */
export function exclusiveRangeStart(lastEventId: string): string | null {
  if (!isValidEventId(lastEventId)) return null;
  // Local ids cannot address a Redis Stream position — replay from the
  // beginning of the retained window instead ("-" is the stream minimum);
  // the id-skip rule during replay prevents duplicates.
  if (/^\d+$/.test(lastEventId)) return '-';
  return `(${lastEventId}`;
}
