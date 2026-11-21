/**
 * deduplication.test.ts
 *
 * Verifies that processing the same on-chain event twice:
 *   1. Produces exactly one MarketplaceEvent row in the database
 *   2. Increments elcarehub_duplicate_events_total once
 *
 * Dedupe matches event-idempotency.ts (Issue #284, documented in
 * docs/guides/event-deduplication.md, Issue #1071): upsertEvent() issues one
 * marketplaceEvent.create() per event and treats a Prisma P2002 unique-
 * constraint violation as a benign replay. The canonical key is eventHash =
 * sha256(contractId:ledger:txHash:eventIndex); the secondary composite key is
 * (listingId, eventType, ledgerSequence) for non-null listingId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import client from 'prom-client';

// ── Mock Prisma ───────────────────────────────────────────────────────────────
// In-memory MarketplaceEvent store that enforces the same two unique keys as
// the current database (see indexer/prisma/schema.prisma and migration
// 20260827000005_ledger_range_partitioning) and rejects conflicts the way
// Prisma does — by throwing a PrismaClientKnownRequestError-shaped P2002.

const storedEvents: Map<string, any> = new Map();

function compositeKey(row: any): string | null {
  return row.listingId == null
    ? null
    : `${String(row.listingId)}|${row.eventType}|${row.ledgerSequence}`;
}

function uniqueViolation(target: string): Error {
  const err: any = new Error(`Unique constraint failed on the fields: (${target})`);
  err.code = 'P2002';
  err.meta = { target };
  return err;
}

function insertOrThrow(row: any) {
  if (row.eventHash && storedEvents.has(row.eventHash)) {
    throw uniqueViolation('`eventHash`');
  }
  const ck = compositeKey(row);
  if (ck && [...storedEvents.values()].some((r) => compositeKey(r) === ck)) {
    throw uniqueViolation('`listingId`,`eventType`,`ledgerSequence`');
  }
  storedEvents.set(row.eventHash ?? `nohash-${storedEvents.size}`, row);
  return { id: storedEvents.size, ...row };
}

const mockTx = {
  marketplaceEvent: {
    create: vi.fn(async ({ data }: { data: any }) => insertOrThrow(data)),
    // Not used by the idempotent write path; asserted as untouched below.
    createMany: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
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
// poller.ts imports from prisma-write; alias so applyDecodedEvents sees the same mock
vi.mock('../prisma-write', () => ({ default: mockPrisma }));
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

describe('Idempotent event processing — deduplication via eventHash', () => {
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

  it('inserts two distinct rows when events have different eventHashes', async () => {
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
    // Each replayed event is attempted once via create() and rejected (P2002)
    expect(mockTx.marketplaceEvent.create).toHaveBeenCalledTimes(2);
    expect(mockTx.marketplaceEvent.createMany).not.toHaveBeenCalled();
    expect(mockTx.listing.upsert).not.toHaveBeenCalled();
    expect(mockTx.listing.updateMany).not.toHaveBeenCalled();
    expect(mockTx.auction.updateMany).not.toHaveBeenCalled();
    expect(mockTx.bid.upsert).not.toHaveBeenCalled();
  });

  it('concurrent insert race: the losing writer gets P2002 and does not double-insert', async () => {
    const event = makeEvent();

    // Simulate another worker committing the same row first: our create()
    // then hits the unique index and Prisma raises P2002.
    mockTx.marketplaceEvent.create.mockImplementationOnce(async ({ data }: any) => {
      storedEvents.set(data.eventHash, data); // the concurrent writer won
      throw uniqueViolation('`eventHash`');
    });

    const first = await applyDecodedEvents([event], mockTx as any);
    expect(first).toHaveLength(0);          // our attempt counted as a replay
    expect(storedEvents.size).toBe(1);
    expect(mockTx.listing.upsert).not.toHaveBeenCalled();

    // A subsequent replay is fully skipped
    const replay = await applyDecodedEvents([event], mockTx as any);
    expect(replay).toHaveLength(0);
  });

  it('characterization: composite key (listingId, eventType, ledgerSequence) collapses two same-type events in one ledger', async () => {
    // Known limitation tracked in docs/guides/event-deduplication.md §6.3.
    // Two distinct on-chain events (different eventIndex → different
    // eventHash) for the same listing, same type, same ledger collide on the
    // secondary composite unique index; the second is skipped as a duplicate.
    // (Realistic case: two OFFER_MADE from different users in one ledger.)
    // Update this test intentionally if the composite key is changed.
    const e1 = makeEvent({ eventIndex: 0 });
    const e2 = makeEvent({
      eventIndex: 1,
      eventId: '1000-1-1',
      eventHash: computeEventHash('CONTRACT_A', 1000, 'txabc123', 1),
    });

    const inserted = await applyDecodedEvents([e1, e2], mockTx as any);

    expect(inserted).toHaveLength(1);
    expect(storedEvents.size).toBe(1);
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
