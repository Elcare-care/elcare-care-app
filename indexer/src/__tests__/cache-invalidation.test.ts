/**
 * cache-invalidation.test.ts
 *
 * Verifies that event-driven cache invalidation fires correctly from processEvent()
 * when listing/auction/offer events are processed, and that cache-warmer pre-populates
 * common keys on startup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(10),
    findMany: vi.fn().mockResolvedValue([{ listingId: 1n, updatedAtLedger: 100 }]),
  },
  auction: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(3),
    findMany: vi.fn().mockResolvedValue([{ auctionId: 1n, updatedAtLedger: 100 }]),
  },
  offer: {
    upsert: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
  collection: {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
  },
  marketplaceEvent: {
    create: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
  },
  syncState: { findUnique: vi.fn().mockResolvedValue({ id: 1, lastLedger: 100 }) },
}));

const mockInvalidatePattern = vi.fn().mockResolvedValue(undefined);
const mockInvalidateKey = vi.fn().mockResolvedValue(undefined);
const mockSetEx = vi.fn().mockResolvedValue(undefined);

vi.mock('../db', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: {
    isReady: true,
    get: vi.fn().mockResolvedValue(null),
    setEx: mockSetEx,
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(0),
  },
  invalidatePattern: mockInvalidatePattern,
  invalidateKey: mockInvalidateKey,
}));

// Silence SSE emits
vi.mock('../api/routes.js', () => ({ emitSSEEvent: vi.fn() }));
vi.mock('../ipfs-cache.js', () => ({ enqueueIpfsFetch: vi.fn().mockResolvedValue(undefined) }));

import { processEvent } from '../poller';
import { warmCache } from '../cache-warmer';

// ── processEvent cache invalidation ──────────────────────────────────────────

describe('processEvent — cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.listing.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.auction.updateMany.mockResolvedValue({ count: 1 });
  });

  it('invalidates listings:* pattern on LISTING_CREATED', async () => {
    await processEvent({
      eventType: 'LISTING_CREATED',
      listingId: BigInt(42),
      actor: 'GTEST',
      ledgerSequence: 100,
      data: { artist: 'GTEST', price: '100', currency: 'XLM', collection: 'COL', token_id: 1, token: 'CID1' },
      eventHash: 'hash1',
      contractId: 'CONTRACT',
      txHash: 'TX1',
      eventIndex: 0,
    }, undefined, true);

    expect(mockInvalidatePattern).toHaveBeenCalledWith(expect.stringContaining('/listings'));
    expect(mockInvalidateKey).toHaveBeenCalledWith('cache:/listings/42');
  });

  it('invalidates listings on ARTWORK_SOLD', async () => {
    await processEvent({
      eventType: 'ARTWORK_SOLD',
      listingId: BigInt(42),
      actor: 'GARTIST',
      ledgerSequence: 101,
      data: { buyer: 'GBUYER', token: 'XLM' },
      eventHash: 'hash2',
      contractId: 'CONTRACT',
      txHash: 'TX2',
      eventIndex: 1,
    }, undefined, true);

    expect(mockInvalidatePattern).toHaveBeenCalledWith(expect.stringContaining('/listings'));
    expect(mockInvalidateKey).toHaveBeenCalledWith('cache:/listings/42');
  });

  it('invalidates listings on LISTING_CANCELLED', async () => {
    await processEvent({
      eventType: 'LISTING_CANCELLED',
      listingId: BigInt(99),
      actor: 'GTEST',
      ledgerSequence: 102,
      data: {},
      eventHash: 'hash3',
      contractId: 'CONTRACT',
      txHash: 'TX3',
      eventIndex: 2,
    }, undefined, true);

    expect(mockInvalidatePattern).toHaveBeenCalledWith(expect.stringContaining('/listings'));
    expect(mockInvalidateKey).toHaveBeenCalledWith('cache:/listings/99');
  });

  it('invalidates listings on LISTING_UPDATED', async () => {
    await processEvent({
      eventType: 'LISTING_UPDATED',
      listingId: BigInt(7),
      actor: 'GTEST',
      ledgerSequence: 103,
      data: { new_price: '200', collection: 'COL', token_id: 1 },
      eventHash: 'hash4',
      contractId: 'CONTRACT',
      txHash: 'TX4',
      eventIndex: 3,
    }, undefined, true);

    expect(mockInvalidatePattern).toHaveBeenCalledWith(expect.stringContaining('/listings'));
    expect(mockInvalidateKey).toHaveBeenCalledWith('cache:/listings/7');
  });

  it('invalidates auctions on AUCTION_RESOLVED', async () => {
    await processEvent({
      eventType: 'AUCTION_RESOLVED',
      listingId: BigInt(5),
      actor: 'GCREATOR',
      ledgerSequence: 104,
      data: { amount: '500', winner: 'GWINNER' },
      eventHash: 'hash5',
      contractId: 'CONTRACT',
      txHash: 'TX5',
      eventIndex: 4,
    }, undefined, true);

    expect(mockInvalidatePattern).toHaveBeenCalledWith(expect.stringContaining('/auctions'));
    expect(mockInvalidateKey).toHaveBeenCalledWith('cache:/auctions/5');
  });

  it('invalidates offers on OFFER_MADE', async () => {
    await processEvent({
      eventType: 'OFFER_MADE',
      listingId: BigInt(3),
      actor: 'GOFFERER',
      ledgerSequence: 105,
      data: { offer_id: 10, listing_id: 3, offerer: 'GOFFERER', amount: '50', token: 'XLM' },
      eventHash: 'hash6',
      contractId: 'CONTRACT',
      txHash: 'TX6',
      eventIndex: 5,
    }, undefined, true);

    expect(mockInvalidatePattern).toHaveBeenCalledWith(expect.stringContaining('offers'));
  });

  it('invalidates offers AND listings on OFFER_ACCEPTED', async () => {
    await processEvent({
      eventType: 'OFFER_ACCEPTED',
      listingId: BigInt(3),
      actor: 'GOWNER',
      ledgerSequence: 106,
      data: { offer_id: 10, listing_id: 3, offerer: 'GOFFERER', token: 'XLM' },
      eventHash: 'hash7',
      contractId: 'CONTRACT',
      txHash: 'TX7',
      eventIndex: 6,
    }, undefined, true);

    const patterns = mockInvalidatePattern.mock.calls.map(([p]: [string]) => p);
    expect(patterns.some(p => p.includes('offers'))).toBe(true);
    expect(patterns.some(p => p.includes('listings'))).toBe(true);
  });
});

// ── Cache warmer ──────────────────────────────────────────────────────────────

describe('warmCache()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.listing.findMany.mockResolvedValue([
      { listingId: 1n, artist: 'G1', status: 'Active', updatedAtLedger: 100 },
      { listingId: 2n, artist: 'G2', status: 'Active', updatedAtLedger: 99 },
    ]);
    mockPrisma.listing.count.mockResolvedValue(2);
    mockPrisma.auction.findMany.mockResolvedValue([
      { auctionId: 1n, creator: 'G1', status: 'Active', updatedAtLedger: 100 },
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
  });

  it('populates first-page listings cache key on startup', async () => {
    await warmCache();
    const calledKeys = mockSetEx.mock.calls.map(([k]: [string]) => k);
    const hasListingKey = calledKeys.some((k: string) => k.includes('/listings'));
    expect(hasListingKey).toBe(true);
  });

  it('populates first-page auctions cache key on startup', async () => {
    await warmCache();
    const calledKeys = mockSetEx.mock.calls.map(([k]: [string]) => k);
    const hasAuctionKey = calledKeys.some((k: string) => k.includes('/auctions'));
    expect(hasAuctionKey).toBe(true);
  });

  it('does not throw when Redis is disconnected', async () => {
    const redisModule = await import('../redis.js');
    (redisModule.default as any).isReady = false;
    await expect(warmCache()).resolves.toBeUndefined();
    (redisModule.default as any).isReady = true;
  });
});
