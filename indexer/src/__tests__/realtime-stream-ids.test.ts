import { describe, it, expect } from 'vitest';
import {
  parseStreamId,
  isValidEventId,
  compareEventIds,
  exclusiveRangeStart,
} from '../realtime/stream-ids';

describe('parseStreamId', () => {
  it('parses a Redis Stream id "<ms>-<seq>"', () => {
    expect(parseStreamId('1710000000000-2')).toEqual({ ms: 1710000000000, seq: 2 });
  });

  it('parses a bare-integer local id as "0-N"', () => {
    expect(parseStreamId('7')).toEqual({ ms: 0, seq: 7 });
  });

  it('parses "0" as a valid id (initial resume point)', () => {
    expect(parseStreamId('0')).toEqual({ ms: 0, seq: 0 });
  });

  it('returns null for garbage input', () => {
    expect(parseStreamId('not-an-id')).toBeNull();
    expect(parseStreamId('')).toBeNull();
    expect(parseStreamId('12-')).toBeNull();
    expect(parseStreamId('-12')).toBeNull();
  });
});

describe('isValidEventId', () => {
  it('accepts stream ids and local ids', () => {
    expect(isValidEventId('100-1')).toBe(true);
    expect(isValidEventId('42')).toBe(true);
  });

  it('rejects malformed ids', () => {
    expect(isValidEventId('abc')).toBe(false);
    expect(isValidEventId('1-2-3')).toBe(false);
  });
});

describe('compareEventIds — monotonicity', () => {
  it('orders stream ids by (ms, seq)', () => {
    expect(compareEventIds('100-1', '100-2')).toBeLessThan(0);
    expect(compareEventIds('100-2', '100-1')).toBeGreaterThan(0);
    expect(compareEventIds('200-0', '100-999')).toBeGreaterThan(0);
    expect(compareEventIds('100-1', '100-1')).toBe(0);
  });

  it('orders local ids among themselves', () => {
    expect(compareEventIds('1', '2')).toBeLessThan(0);
    expect(compareEventIds('10', '2')).toBeGreaterThan(0);
  });

  it('a local id always sorts below a real stream id', () => {
    expect(compareEventIds('999999', '1-0')).toBeLessThan(0);
  });

  it('invalid ids sort lowest so they never suppress delivery', () => {
    expect(compareEventIds('garbage', '1-0')).toBeLessThan(0);
    expect(compareEventIds('1-0', 'garbage')).toBeGreaterThan(0);
    expect(compareEventIds('garbage', 'also-garbage-1')).toBe(0);
  });

  it('is transitive across a sorted sequence (monotonicity property)', () => {
    const ids = ['1-0', '1-1', '2-0', '2-1', '10-0'];
    const shuffled = [ids[3], ids[0], ids[4], ids[1], ids[2]];
    const sorted = [...shuffled].sort(compareEventIds);
    expect(sorted).toEqual(ids);
  });
});

describe('exclusiveRangeStart', () => {
  it('wraps a stream id in Redis exclusive-range syntax', () => {
    expect(exclusiveRangeStart('100-2')).toBe('(100-2');
  });

  it('replays from stream start for a local (degraded-mode) id', () => {
    // Local ids cannot address a stream position; the caller relies on the
    // id-skip rule during replay to avoid resending events.
    expect(exclusiveRangeStart('5')).toBe('-');
  });

  it('returns null for an invalid id', () => {
    expect(exclusiveRangeStart('not-an-id')).toBeNull();
  });
});
