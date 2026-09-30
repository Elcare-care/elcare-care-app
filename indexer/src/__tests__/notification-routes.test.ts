/**
 * notification-routes.test.ts
 *
 * HTTP-level integration tests for the notification API (Issue #8):
 *   GET /wallets/:address/notifications
 *   GET /notifications/summary
 *   GET /notifications/stream  (SSE handshake only — full fan-out covered by realtime-hub.test.ts)
 *
 * All database and Redis calls are mocked so the suite runs without
 * infrastructure. Uses the same express + supertest pattern as api.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  marketplaceEvent: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: { isReady: false, get: vi.fn(), set: vi.fn(), on: vi.fn() },
}));
vi.mock('../realtime/index.js', () => ({
  hub: {
    connectionCount: 0,
    attachClient: vi.fn(),
  },
  ensureRealtimeStarted: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub auth middleware — all routes pass
vi.mock('../api/auth-middleware.js', () => ({
  authMiddleware: () => (_req: any, _res: any, next: any) => next(),
  classifyRoute: () => 'public',
}));

import notificationRouter from '../api/notification-routes.js';

const app = express();
app.use(express.json());
app.use(notificationRouter);

// ── Test data ─────────────────────────────────────────────────────────────────

const VALID_WALLET = 'GABC1234567890123456789012345678901234567890123456';

const SOLD_EVENT = {
  id: 1,
  eventType: 'ARTWORK_SOLD',
  listingId: '10',
  actor: VALID_WALLET,
  data: { listing_id: '10', price: '10000000', buyer: VALID_WALLET },
  ledgerSequence: 1000,
  ledgerTimestamp: new Date('2025-01-01T12:00:00Z'),
};

const BID_EVENT = {
  id: 2,
  eventType: 'BID_PLACED',
  listingId: null,
  actor: VALID_WALLET,
  data: { auction_id: '5', bid_amount: '5000000', bidder: VALID_WALLET },
  ledgerSequence: 999,
  ledgerTimestamp: new Date('2025-01-01T11:00:00Z'),
};

// ── GET /wallets/:address/notifications ───────────────────────────────────────

describe('GET /wallets/:address/notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with a list of notifications for a valid wallet', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([SOLD_EVENT, BID_EVENT]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(2);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.header['x-total-count']).toBe('2');
  });

  it('returns notifications with the correct shape', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([SOLD_EVENT]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications`)
      .expect(200);

    const notif = res.body[0];
    expect(notif).toMatchObject({
      eventType: 'ARTWORK_SOLD',
      domain: 'listing',
      priority: 'HIGH',
      resourceType: 'listing',
      resourceId: '10',
    });
    expect(typeof notif.summary).toBe('string');
    expect(notif.summary.length).toBeGreaterThan(0);
    expect(typeof notif.id).toBe('string');
  });

  it('returns 400 for a malformed wallet address', async () => {
    const res = await request(app)
      .get('/wallets/not-a-valid-address/notifications')
      .expect(400);

    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it('respects limit and offset query params', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([SOLD_EVENT]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(10);

    await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications?limit=1&offset=5`)
      .expect(200);

    const findCall = mockPrisma.marketplaceEvent.findMany.mock.calls[0][0] as any;
    expect(findCall.take).toBe(1);
    expect(findCall.skip).toBe(5);
  });

  it('caps limit at 100', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(0);

    await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications?limit=999`)
      .expect(200);

    const findCall = mockPrisma.marketplaceEvent.findMany.mock.calls[0][0] as any;
    expect(findCall.take).toBeLessThanOrEqual(100);
  });

  it('filters by domain when ?domain= is provided', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([SOLD_EVENT]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(1);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications?domain=listing`)
      .expect(200);

    // The where clause should only include listing-domain types
    const findCall = mockPrisma.marketplaceEvent.findMany.mock.calls[0][0] as any;
    const types: string[] = findCall.where.eventType.in;
    const allListing = types.every((t) => {
      const { EVENT_CLASSIFICATIONS } = require('../notification/event-priority.js');
      return EVENT_CLASSIFICATIONS[t]?.domain === 'listing';
    });
    expect(allListing).toBe(true);
  });

  it('filters by priority when ?priority=HIGH is provided', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([SOLD_EVENT]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(1);

    await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications?priority=HIGH`)
      .expect(200);

    const findCall = mockPrisma.marketplaceEvent.findMany.mock.calls[0][0] as any;
    const types: string[] = findCall.where.eventType.in;
    const { EVENT_CLASSIFICATIONS } = require('../notification/event-priority.js');
    const allHigh = types.every((t) => EVENT_CLASSIFICATIONS[t]?.priority === 'HIGH');
    expect(allHigh).toBe(true);
  });

  it('returns empty array when no events match', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(0);

    const res = await request(app)
      .get(`/wallets/${VALID_WALLET}/notifications`)
      .expect(200);

    expect(res.body).toEqual([]);
    expect(res.header['x-total-count']).toBe('0');
  });
});

// ── GET /notifications/summary ────────────────────────────────────────────────

describe('GET /notifications/summary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with total, urgentCount, and recent array', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([SOLD_EVENT]);
    mockPrisma.marketplaceEvent.count
      .mockResolvedValueOnce(5)   // total
      .mockResolvedValueOnce(2);  // urgentCount (HIGH priority in last 24h)

    const res = await request(app)
      .get(`/notifications/summary?wallet=${VALID_WALLET}`)
      .expect(200);

    expect(res.body).toMatchObject({
      total: 5,
      urgentCount: 2,
    });
    expect(Array.isArray(res.body.recent)).toBe(true);
    expect(res.body.recent).toHaveLength(1);
  });

  it('returns 400 when wallet param is missing', async () => {
    await request(app)
      .get('/notifications/summary')
      .expect(400);
  });

  it('returns 400 for invalid wallet address', async () => {
    await request(app)
      .get('/notifications/summary?wallet=bad')
      .expect(400);
  });
});

// ── GET /notifications/stream ─────────────────────────────────────────────────

describe('GET /notifications/stream', () => {
  it('returns SSE headers on connection', async () => {
    const { hub } = await import('../realtime/index.js');
    (hub.attachClient as any).mockResolvedValue(undefined);

    const res = await request(app)
      .get('/notifications/stream')
      .timeout({ response: 500 })
      .catch((e: any) => e.response ?? e);

    // Supertest may cut the connection; we just check the response headers
    const headers = (res as any).header ?? (res as any).headers ?? {};
    const status = (res as any).status ?? (res as any).statusCode;

    // Either connected (200) or capacity-exceeded (503)
    expect([200, 503]).toContain(status);
    if (status === 200) {
      expect(headers['content-type']).toContain('text/event-stream');
    }
  });
});
