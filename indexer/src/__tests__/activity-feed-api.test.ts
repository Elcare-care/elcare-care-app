/**
 * activity-feed-api.test.ts
 *
 * Tests for the GET /activity/recent and GET /wallets/:address/activity
 * endpoints to ensure they return correctly shaped data and respect
 * pagination parameters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeMarketplaceEvent, makeArtworkSoldEvent, resetFixtureSequences } from './helpers/fixtures.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  marketplaceEvent: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  listing: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    aggregate: vi.fn(),
  },
  auction: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  offer: { findMany: vi.fn(), count: vi.fn() },
  collection: { findMany: vi.fn(), count: vi.fn() },
  trackedContract: { findMany: vi.fn() },
  ipfsMetadata: { findUnique: vi.fn() },
  backfillJob: { findMany: vi.fn() },
  ledgerGap: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  priceHistory: { findMany: vi.fn() },
  bid: { findMany: vi.fn() },
  royaltyPayment: { findMany: vi.fn(), count: vi.fn() },
  ipfsQueue: { findFirst: vi.fn(), create: vi.fn() },
  voucher: { findMany: vi.fn(), count: vi.fn() },
  $queryRawUnsafe: vi.fn(),
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: {
    isReady: false,
    isOpen: false,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    setEx: vi.fn(),
    on: vi.fn(),
    connect: vi.fn().mockRejectedValue(new Error('No Redis')),
  },
}));
vi.mock('../realtime/index.js', () => ({
  hub: { connectionCount: 0, attachClient: vi.fn() },
  ensureRealtimeStarted: vi.fn(),
  emitSSEEvent: vi.fn(),
  closeSSEClients: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../poller.js', () => ({
  applyDecodedEvents: vi.fn(),
  isPollerHalted: vi.fn(() => false),
  getHaltReason: vi.fn(() => null),
  resumePoller: vi.fn(),
  revertLedgers: vi.fn(),
}));
vi.mock('../event-sync.js', () => ({ collectMarketplaceEvents: vi.fn() }));
vi.mock('../stats.js', () => ({
  getOverviewStats: vi.fn(),
  getDailyStats: vi.fn(),
  getTopCollections: vi.fn(),
  getTopArtists: vi.fn(),
}));
vi.mock('../chain-state.js', () => ({ fetchAuctionConfig: vi.fn() }));
vi.mock('../token-metadata.js', () => ({
  withDecimalAmounts: (_row: any, _fields: any) => _row,
}));
vi.mock('../cache-warmer.js', () => ({ TTL: { ACTIVITY_RECENT: 30 } }));
vi.mock('../metrics.js', () => ({
  sseConnectionsTotal: { inc: vi.fn() },
  sseActiveConnectionsGauge: { set: vi.fn() },
  apiRequestDurationHistogram: { labels: () => ({ observe: vi.fn() }) },
}));
vi.mock('../api/auth-middleware.js', () => ({
  authMiddleware: () => (_: any, __: any, next: any) => next(),
  classifyRoute: () => 'public',
}));
vi.mock('../api/versioning.js', () => ({
  versioningMiddleware: (_: any, __: any, next: any) => next(),
  ok: (res: any, data: any) => res.json(data),
  validateResponse: (_schema: any, data: any) => data,
  ListingResponseV1: { array: () => ({ safeParse: (d: any) => ({ success: true, data: d }) }) },
  AuctionResponseV1: { array: () => ({ safeParse: (d: any) => ({ success: true, data: d }) }) },
  OfferResponseV1: {},
  CollectionResponseV1: {},
}));
vi.mock('../api/etag-middleware.js', () => ({
  etagMiddleware: (_: any, __: any, next: any) => next(),
}));
vi.mock('../api/cache-middleware.js', () => ({
  cacheMiddleware: () => (_: any, __: any, next: any) => next(),
}));
vi.mock('../api/rate-limit-middleware.js', () => ({
  lightRateLimiter:       (_: any, __: any, next: any) => next(),
  mediumRateLimiter:      (_: any, __: any, next: any) => next(),
  heavyRateLimiter:       (_: any, __: any, next: any) => next(),
  strictRateLimiter:      (_: any, __: any, next: any) => next(),
  operationalRateLimiter: (_: any, __: any, next: any) => next(),
  rateLimiter:            (_: any, __: any, next: any) => next(),
  sseConcurrencyGuard:    (_: any, __: any, next: any) => next(),
  sseConnectionsTotal: { inc: vi.fn() },
  sseActiveConnectionsGauge: { set: vi.fn() },
}));
vi.mock('../api/query-schemas.js', () => ({
  validateQuery: () => (_: any, __: any, next: any) => next(),
  listingsQuerySchema: {},
  auctionsQuerySchema: {},
  offersQuerySchema: {},
  walletActivityQuerySchema: {},
  collectionsQuerySchema: {},
  creatorCollectionsQuerySchema: {},
  statsQuerySchema: {},
  syncGapsQuerySchema: {},
  artistMetricsQuerySchema: {},
  royaltyBreakdownQuerySchema: {},
}));
vi.mock('../stellar-address.js', () => ({
  isValidStellarAddress: (addr: string) => /^G[A-Z2-7]{55}$/.test(addr),
  STELLAR_ADDRESS_ERROR: 'Invalid Stellar address',
}));

import router from '../api/routes.js';
import { errorHandler } from '../api/errors.js';

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

const VALID_WALLET = 'G' + 'A'.repeat(55);

// ── GET /activity/recent ──────────────────────────────────────────────────────

describe('GET /activity/recent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixtureSequences();
  });

  it('returns 200 with an array of recent events', async () => {
    const events = [
      makeMarketplaceEvent({ eventType: 'LISTING_CREATED' }),
      makeArtworkSoldEvent(),
    ];
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue(events);

    const res = await request(app).get('/activity/recent').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  it('returns events with the required fields', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      makeMarketplaceEvent({ eventType: 'ARTWORK_SOLD' }),
    ]);

    const res = await request(app).get('/activity/recent').expect(200);
    const event = res.body[0];

    expect(event).toHaveProperty('eventType');
    expect(event).toHaveProperty('actor');
    expect(event).toHaveProperty('ledgerSequence');
    expect(event).toHaveProperty('data');
  });

  it('returns empty array when no recent events exist', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const res = await request(app).get('/activity/recent').expect(200);
    expect(res.body).toEqual([]);
  });

  it('orders events by ledger descending (most recent first)', async () => {
    const events = [
      makeMarketplaceEvent({ ledgerSequence: 2000 }),
      makeMarketplaceEvent({ ledgerSequence: 1500 }),
    ];
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue(events);

    const res = await request(app).get('/activity/recent').expect(200);
    expect(res.body[0].ledgerSequence).toBe(2000);
  });
});

// ── GET /wallets/:address/activity ────────────────────────────────────────────

describe('GET /wallets/:address/activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixtureSequences();
  });

  it('returns 200 with wallet activity for a valid address', async () => {
    const events = [makeArtworkSoldEvent({ actor: VALID_WALLET })];
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue(events);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/activity`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it('sets X-Total-Count header', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(42);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/activity`)
      .expect(200);

    expect(res.header['x-total-count']).toBe('42');
  });

  it('serialises BigInt fields to strings without throwing', async () => {
    const event = makeMarketplaceEvent({
      actor: VALID_WALLET,
      data: { listing_id: 9999n, price: 10_000_000n },
    });
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([event]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/activity`)
      .expect(200);

    // BigInts serialised as strings
    expect(typeof res.body[0].data.listing_id).toBe('string');
  });
});
