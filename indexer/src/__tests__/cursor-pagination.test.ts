/**
 * cursor-pagination.test.ts
 *
 * Verifies cursor-based pagination for all list endpoints:
 *   GET /listings, /auctions, /offers, /collections, /wallets/:address/activity
 *
 * Tests:
 *   - cursor_ledger param generates correct WHERE clause
 *   - X-Next-Cursor header is set to last item's ledger
 *   - X-Total-Count header is set
 *   - offset pagination still works (backwards compatibility)
 *   - cursor and offset can coexist in the schema
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(50),
    aggregate: vi.fn().mockResolvedValue({ _sum: { price: '0' } }),
  },
  auction: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(10),
  },
  offer: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(5),
  },
  collection: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(8),
  },
  marketplaceEvent: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(20),
  },
}));

const mockRedis = vi.hoisted(() => ({
  isOpen: false,
  isReady: false,
  get: vi.fn().mockResolvedValue(null),
  setEx: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../db',           () => ({ default: mockPrisma }));
vi.mock('../prisma-write', () => ({ default: mockPrisma }));
vi.mock('../redis.js',     () => ({ default: mockRedis  }));

import router from '../api/routes';
import { errorHandler } from '../api/errors';

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

// Sample fixtures
const makeListing = (id: number, ledger: number) => ({
  listingId: BigInt(id),
  artist: `G${id}`,
  owner: null,
  price: '100.0000000',
  currency: 'XLM',
  token: 'T',
  status: 'Active',
  collection: 'C',
  nftTokenId: BigInt(id),
  createdAtLedger: ledger,
  updatedAtLedger: ledger,
});

const makeAuction = (id: number, ledger: number) => ({
  auctionId: BigInt(id),
  creator: `G${id}`,
  collection: 'C',
  nftTokenId: BigInt(id),
  token: 'XLM',
  reservePrice: '100.0000000',
  highestBid: '0.0000000',
  highestBidder: null,
  endTime: BigInt(9999999),
  status: 'Active',
  createdAtLedger: ledger,
  updatedAtLedger: ledger,
});

// ── GET /listings cursor pagination ──────────────────────────────────────────

describe('GET /listings — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns X-Next-Cursor header set to last item updatedAtLedger', async () => {
    const listings = [makeListing(1, 500), makeListing(2, 490), makeListing(3, 480)];
    mockPrisma.listing.findMany.mockResolvedValue(listings);
    mockPrisma.listing.count.mockResolvedValue(50);

    const res = await request(app).get('/listings?limit=3');
    expect(res.status).toBe(200);
    expect(res.headers['x-next-cursor']).toBe('480');
    expect(res.headers['x-total-count']).toBe('50');
  });

  it('uses WHERE updatedAtLedger < cursor when cursor_ledger provided (desc)', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing(4, 300)]);
    mockPrisma.listing.count.mockResolvedValue(30);

    await request(app).get('/listings?cursor_ledger=480&limit=3');

    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { lt: 480 } }),
        orderBy: { updatedAtLedger: 'desc' },
      })
    );
  });

  it('uses WHERE updatedAtLedger > cursor when cursor_direction=asc', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing(5, 600)]);
    mockPrisma.listing.count.mockResolvedValue(20);

    await request(app).get('/listings?cursor_ledger=480&cursor_direction=asc&limit=3');

    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { gt: 480 } }),
        orderBy: { updatedAtLedger: 'asc' },
      })
    );
  });

  it('sets X-Next-Cursor to empty string on last page (fewer items than limit)', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing(1, 100), makeListing(2, 90)]);
    mockPrisma.listing.count.mockResolvedValue(2);

    const res = await request(app).get('/listings?limit=3');
    expect(res.headers['x-next-cursor']).toBe('');
  });

  it('backwards compat: offset pagination still works', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing(1, 500)]);
    mockPrisma.listing.count.mockResolvedValue(50);

    await request(app).get('/listings?limit=1&offset=5');

    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 1 })
    );
  });

  it('rejects offset > 10000', async () => {
    const res = await request(app).get('/listings?offset=50000');
    expect(res.status).toBe(400);
  });
});

// ── GET /auctions cursor pagination ──────────────────────────────────────────

describe('GET /auctions — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns X-Next-Cursor and X-Total-Count headers', async () => {
    mockPrisma.auction.findMany.mockResolvedValue([makeAuction(1, 400), makeAuction(2, 390)]);
    mockPrisma.auction.count.mockResolvedValue(10);

    const res = await request(app).get('/auctions?limit=2');
    expect(res.status).toBe(200);
    expect(res.headers['x-next-cursor']).toBe('390');
    expect(res.headers['x-total-count']).toBe('10');
  });

  it('uses cursor WHERE clause when cursor_ledger provided', async () => {
    mockPrisma.auction.findMany.mockResolvedValue([makeAuction(3, 300)]);
    mockPrisma.auction.count.mockResolvedValue(5);

    await request(app).get('/auctions?cursor_ledger=390&limit=2');

    expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { lt: 390 } }),
      })
    );
  });
});

// ── GET /offers cursor pagination ─────────────────────────────────────────────

describe('GET /offers — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  const makeOffer = (id: number, ledger: number) => ({
    offerId: BigInt(id),
    listingId: BigInt(1),
    offerer: 'GO',
    amount: '50.0000000',
    token: 'XLM',
    status: 'Pending',
    createdAtLedger: ledger,
    updatedAtLedger: ledger,
  });

  it('returns X-Next-Cursor for offers endpoint', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([makeOffer(1, 200), makeOffer(2, 190)]);
    mockPrisma.offer.count.mockResolvedValue(5);

    const res = await request(app).get('/offers?limit=2');
    expect(res.status).toBe(200);
    expect(res.headers['x-next-cursor']).toBe('190');
  });

  it('filters by cursor when cursor_ledger provided', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([makeOffer(3, 180)]);
    mockPrisma.offer.count.mockResolvedValue(3);

    await request(app).get('/offers?cursor_ledger=190&limit=2');

    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { lt: 190 } }),
      })
    );
  });
});

// ── GET /collections cursor pagination ────────────────────────────────────────

describe('GET /collections — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  const makeCollection = (id: number, ledger: number) => ({
    id,
    contractAddress: `CA${id}`,
    kind: 'normal_721',
    creator: 'GC',
    deployedAtLedger: ledger,
  });

  it('returns X-Next-Cursor for collections endpoint', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([makeCollection(1, 300), makeCollection(2, 290)]);
    mockPrisma.collection.count.mockResolvedValue(8);

    const res = await request(app).get('/collections?limit=2');
    expect(res.status).toBe(200);
    expect(res.headers['x-next-cursor']).toBe('290');
    expect(res.headers['x-total-count']).toBe('8');
  });

  it('filters by deployedAtLedger cursor', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([makeCollection(3, 280)]);
    mockPrisma.collection.count.mockResolvedValue(6);

    await request(app).get('/collections?cursor_ledger=290&limit=2');

    expect(mockPrisma.collection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deployedAtLedger: { lt: 290 } }),
      })
    );
  });
});

// ── GET /wallets/:address/activity cursor pagination ──────────────────────────

describe('GET /wallets/:address/activity — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  const makeEvent = (ledger: number) => ({
    id: ledger,
    listingId: null,
    eventType: 'LISTING_CREATED',
    actor: 'GTEST',
    data: {},
    ledgerSequence: ledger,
    ledgerTimestamp: new Date(),
    eventHash: `h${ledger}`,
    contractId: 'C',
  });

  it('returns X-Next-Cursor for wallet activity', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([makeEvent(500), makeEvent(490)]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(20);

    const res = await request(app).get('/wallets/GTEST/activity?limit=2');
    expect(res.status).toBe(200);
    expect(res.headers['x-next-cursor']).toBe('490');
    expect(res.headers['x-total-count']).toBe('20');
  });

  it('applies cursor WHERE on ledgerSequence', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([makeEvent(480)]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(18);

    await request(app).get('/wallets/GTEST/activity?cursor_ledger=490&limit=2');

    const call = mockPrisma.marketplaceEvent.findMany.mock.calls[0][0] as any;
    expect(call.where.ledgerSequence).toEqual({ lt: 490 });
  });
});

// ── GET /creators/:address/collections cursor pagination ──────────────────────

const VALID_CREATOR = 'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F';

describe('GET /creators/:address/collections — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  const makeCreatorCollection = (id: number, ledger: number) => ({
    id,
    contractAddress: `CA${id}`,
    kind: 'normal_721',
    creator: VALID_CREATOR,
    deployedAtLedger: ledger,
  });

  it('returns X-Next-Cursor and X-Total-Count headers', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([
      makeCreatorCollection(1, 400),
      makeCreatorCollection(2, 390),
    ]);
    mockPrisma.collection.count.mockResolvedValue(5);

    const res = await request(app).get(`/creators/${VALID_CREATOR}/collections?limit=2`);
    expect(res.status).toBe(200);
    expect(res.headers['x-next-cursor']).toBe('390');
    expect(res.headers['x-total-count']).toBe('5');
  });

  it('applies cursor WHERE on deployedAtLedger', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([makeCreatorCollection(3, 380)]);
    mockPrisma.collection.count.mockResolvedValue(3);

    await request(app).get(`/creators/${VALID_CREATOR}/collections?cursor_ledger=390&limit=2`);

    expect(mockPrisma.collection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deployedAtLedger: { lt: 390 } }),
      })
    );
  });

  it('returns 400 for an invalid creator address', async () => {
    const res = await request(app).get('/creators/not-valid-address/collections');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('sets X-Next-Cursor to empty string on last page', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([makeCreatorCollection(1, 300)]);
    mockPrisma.collection.count.mockResolvedValue(1);

    const res = await request(app).get(`/creators/${VALID_CREATOR}/collections?limit=2`);
    expect(res.headers['x-next-cursor']).toBe('');
  });

  it('rejects offset > 10000', async () => {
    const res = await request(app).get(`/creators/${VALID_CREATOR}/collections?offset=20000`);
    expect(res.status).toBe(400);
  });
});

// ── Server-side page size enforcement ────────────────────────────────────────

describe('Server-side page size limits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects limit > 100 for /listings (enforced server-side)', async () => {
    const res = await request(app).get('/listings?limit=101');
    expect(res.status).toBe(400);
  });

  it('rejects limit > 100 for /auctions', async () => {
    const res = await request(app).get('/auctions?limit=200');
    expect(res.status).toBe(400);
  });

  it('rejects limit > 200 for /wallets/:address/activity', async () => {
    const res = await request(app).get(`/wallets/${VALID_CREATOR}/activity?limit=201`);
    expect(res.status).toBe(400);
  });
});

// ── Inserted-row stability ────────────────────────────────────────────────────
//
// When new events arrive between page 1 and page 2 requests, cursor pagination
// guarantees stability: page 2 (WHERE updatedAtLedger < cursor) never includes
// items that were on page 1 (ledger >= cursor).

describe('Cursor stability across inserts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('page 2 with cursor_ledger=480 excludes any item with ledger >= 480', async () => {
    // Simulate new items at ledger 495 were inserted after page 1 was fetched
    mockPrisma.listing.findMany.mockResolvedValue([
      makeListing(6, 460),
      makeListing(7, 450),
    ]);
    mockPrisma.listing.count.mockResolvedValue(55);

    await request(app).get('/listings?cursor_ledger=480&limit=3');

    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { lt: 480 } }),
        orderBy: { updatedAtLedger: 'desc' },
      })
    );
  });

  it('ascending cursor guarantees no duplicate on insert (gt boundary)', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing(8, 510), makeListing(9, 520)]);
    mockPrisma.listing.count.mockResolvedValue(30);

    await request(app).get('/listings?cursor_ledger=500&cursor_direction=asc&limit=2');

    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { gt: 500 } }),
        orderBy: { updatedAtLedger: 'asc' },
      })
    );
  });
});
