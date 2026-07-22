/**
 * deduplication.test.ts
 *
 * Verifies that processing the same on-chain event twice:
 *   1. Produces exactly one MarketplaceEvent row in the database
 *   2. Increments elcarehub_duplicate_events_total once
 *
 * Dedupe is keyed on the globally unique eventId (RPC id, or the eventHash
 * surrogate) and enforced by createMany({ skipDuplicates }) against the DB
 * unique constraint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import client from 'prom-client';

// ── Mock Prisma ───────────────────────────────────────────────────────────────
// In-memory MarketplaceEvent store keyed on eventId, mimicking the DB unique
// constraint semantics of createMany({ skipDuplicates }).

const storedEvents: Map<string, any> = new Map();

const mockTx = {
  marketplaceEvent: {
    findMany: vi.fn(async ({ where }: { where: any }) => {
      const ids: string[] = where?.OR?.[0]?.eventId?.in ?? [];
      const hashes: string[] = where?.OR?.[1]?.eventHash?.in ?? [];
      return [...storedEvents.values()].filter(
        (row) => ids.includes(row.eventId) || hashes.includes(row.eventHash)
      );
    }),
    createMany: vi.fn(async ({ data }: { data: any[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (!storedEvents.has(row.eventId)) {
          storedEvents.set(row.eventId, row);
          count++;
        }
      }
      return { count };
    }),
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  listing: {
    upsert:      vi.fn().mockResolvedValue({}),
    updateMany:  vi.fn().mockResolvedValue({ count: 1 }),
    findMany:    vi.fn().mockResolvedValue([]),
  },
  auction: {
    upsert:      vi.fn().mockResolvedValue({}),
    updateMany:  vi.fn().mockResolvedValue({ count: 1 }),
  },
  offer: {
    upsert:      vi.fn().mockResolvedValue({}),
    updateMany:  vi.fn().mockResolvedValue({ count: 1 }),
  },
  bid: {
    upsert: vi.fn().mockResolvedValue({}),
  },
  priceHistory: {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  protocolFee: {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  collection: {
    upsert: vi.fn().mockResolvedValue({}),
  },
};

const mockPrisma = vi.hoisted(() => ({
  marketplaceEvent: {
    findUnique: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  },
  listing: {
    upsert:     vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany:   vi.fn().mockResolvedValue([]),
  },
  auction:    { upsert: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  offer:      { upsert: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  bid:        { upsert: vi.fn().mockResolvedValue({}) },
  priceHistory: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  protocolFee:  { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  collection: { upsert: vi.fn().mockResolvedValue({}) },
  $transaction: vi.fn(),
}));

const mockRedis = vi.hoisted(() => ({
  isOpen:  false,
  isReady: false,
  get:     vi.fn().mockResolvedValue(null),
  set:     vi.fn().mockResolvedValue(undefined),
  setEx:   vi.fn().mockResolvedValue(undefined),
  on:      vi.fn(),
  connect: vi.fn().mockRejectedValue(new Error('no redis')),
}));

vi.mock('../db', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({ default: mockRedis }));

import { applyDecodedEvents } from '../poller';
import { computeEventHash } from '../parser';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<any> = {}) {
  const contractId    = 'CONTRACT_A';
  const ledger        = 1000;
  const txHash        = 'txabc123';
  const eventIndex    = 0;
  const eventHash     = computeEventHash(contractId, ledger, txHash, eventIndex);

  return {
    eventType:      'LISTING_CREATED',
    listingId:      BigInt(42),
    actor:          'GARTIST',
    ledgerSequence: ledger,
    data:           { artist: 'GARTIST', price: '100', currency: 'XLM', collection: 'COL', token_id: 1, token: 'CTOKEN' },
    eventHash,
    eventId:        `${ledger}-1-${eventIndex}`,
    contractId,
    txHash,
    txIndex:        1,
    eventIndex,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Idempotent event processing — deduplication via eventId', () => {
  beforeEach(() => {
    storedEvents.clear();
    vi.clearAllMocks();
  });

  it('inserts exactly one row when the same event is processed twice', async () => {
    const event = makeEvent();

    // First pass
    const first = await applyDecodedEvents([event], mockTx as any);
    // Second pass — same event, same eventId
    const second = await applyDecodedEvents([event], mockTx as any);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);  // duplicate skipped

    expect(storedEvents.size).toBe(1);
  });

  it('increments duplicate_events_total counter exactly once on second pass', async () => {
    // Read the counter value before the test
    const registry = client.register;
    const getCount = async () => {
      const metrics = await registry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'elcarehub_duplicate_events_total');
      if (!counter) return 0;
      const values = (counter as any).values as Array<{ value: number }>;
      return values.reduce((sum, v) => sum + v.value, 0);
    };

    const before = await getCount();
    const event = makeEvent();

    await applyDecodedEvents([event], mockTx as any);  // first — inserts
    await applyDecodedEvents([event], mockTx as any);  // second — duplicate

    const after = await getCount();
    expect(after - before).toBe(1);
  });

  it('inserts two distinct rows when events have different eventIds', async () => {
    const e1 = makeEvent({ eventIndex: 0 });
    const e2 = makeEvent({
      eventIndex: 1,
      listingId: BigInt(99),
      eventId: '1000-1-1',
      eventHash: computeEventHash('CONTRACT_A', 1000, 'txabc123', 1),
    });

    await applyDecodedEvents([e1, e2], mockTx as any);

    expect(storedEvents.size).toBe(2);
  });

  it('a full replay of a mixed batch performs zero state changes', async () => {
    const events = [
      makeEvent({ eventIndex: 0, eventId: '1000-1-0' }),
      makeEvent({
        eventType: 'BID_PLACED',
        listingId: 7n,
        eventIndex: 1,
        eventId: '1000-2-0',
        txIndex: 2,
        eventHash: computeEventHash('CONTRACT_A', 1000, 'txabc123', 1),
        data: { bidder: 'GBIDDER', bid_amount: '100' },
      }),
    ];

    await applyDecodedEvents(events, mockTx as any);
    vi.clearAllMocks();

    const replay = await applyDecodedEvents(events, mockTx as any);

    expect(replay).toHaveLength(0);
    expect(storedEvents.size).toBe(2);
    expect(mockTx.marketplaceEvent.createMany).not.toHaveBeenCalled();
    expect(mockTx.listing.upsert).not.toHaveBeenCalled();
    expect(mockTx.listing.updateMany).not.toHaveBeenCalled();
    expect(mockTx.auction.updateMany).not.toHaveBeenCalled();
    expect(mockTx.bid.upsert).not.toHaveBeenCalled();
  });

  it('concurrent skipDuplicates race: raced rows do not double-insert', async () => {
    const event = makeEvent();

    // Simulate another writer inserting the row between findMany and
    // createMany: findMany sees nothing, but createMany reports 0 inserts.
    mockTx.marketplaceEvent.findMany.mockResolvedValueOnce([]);
    mockTx.marketplaceEvent.createMany.mockImplementationOnce(async ({ data }: any) => {
      // the concurrent writer got there first
      for (const row of data) storedEvents.set(row.eventId, row);
      return { count: 0 };
    });

    await applyDecodedEvents([event], mockTx as any);
    expect(storedEvents.size).toBe(1);

    // A subsequent replay is fully skipped
    const replay = await applyDecodedEvents([event], mockTx as any);
    expect(replay).toHaveLength(0);
  });

  it('computeEventHash produces a 64-char hex string', () => {
    const hash = computeEventHash('C_ID', 500, 'txhash', 3);
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('computeEventHash is deterministic for the same inputs', () => {
    const a = computeEventHash('C', 1, 'tx', 0);
    const b = computeEventHash('C', 1, 'tx', 0);
    expect(a).toBe(b);
  });

  it('computeEventHash differs when any input changes', () => {
    const base = computeEventHash('C', 1, 'tx', 0);
    expect(computeEventHash('X', 1, 'tx', 0)).not.toBe(base);  // contractId
    expect(computeEventHash('C', 2, 'tx', 0)).not.toBe(base);  // ledger
    expect(computeEventHash('C', 1, 'xy', 0)).not.toBe(base);  // txHash
    expect(computeEventHash('C', 1, 'tx', 1)).not.toBe(base);  // eventIndex
  });
});
