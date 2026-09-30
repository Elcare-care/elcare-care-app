/**
 * royalty-breakdown-api.test.ts
 *
 * Tests for GET /wallets/:address/royalty-breakdown (Issue #201): pagination,
 * ledger-sequence window filters, address validation, and serialization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mock Prisma / Redis before importing the router ───────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  marketplaceEvent: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  collection: { findMany: vi.fn() },
  royaltyPayment: { findMany: vi.fn(), count: vi.fn() },
}));

const mockRedis = vi.hoisted(() => ({
  isOpen: false,
  isReady: false,
  get: vi.fn(),
  setEx: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  connect: vi.fn().mockRejectedValue(new Error('No Redis')),
}));

vi.mock('../db', () => ({ default: mockPrisma }));
vi.mock('../prisma-write', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({ default: mockRedis }));

import router from '../api/routes';
import { errorHandler } from '../api/errors';

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_ADDR = 'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F';

const samplePayment = {
  id: 1,
  listingId: BigInt(7),
  auctionId: null,
  recipient: VALID_ADDR,
  amount: '6650000',
  salePrice: '10000000',
  ledgerSequence: 500,
  createdAt: new Date('2026-07-25T00:00:00Z'),
};

describe('GET /wallets/:address/royalty-breakdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([samplePayment]);
    mockPrisma.royaltyPayment.count.mockResolvedValue(1);
  });

  it('returns paginated payments for the recipient', async () => {
    const res = await request(app).get(`/wallets/${VALID_ADDR}/royalty-breakdown`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.payments).toHaveLength(1);
    // BigInt serialized to string
    expect(res.body.payments[0].listingId).toBe('7');
    expect(res.body.payments[0].amount).toBe('6650000');
    expect(res.headers['x-total-count']).toBe('1');

    const args = mockPrisma.royaltyPayment.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ recipient: VALID_ADDR });
    expect(args.orderBy).toEqual({ ledgerSequence: 'desc' });
  });

  it('defaults to limit 50, offset 0', async () => {
    const res = await request(app).get(`/wallets/${VALID_ADDR}/royalty-breakdown`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    const args = mockPrisma.royaltyPayment.findMany.mock.calls[0][0];
    expect(args.take).toBe(50);
    expect(args.skip).toBe(0);
  });

  it('honours limit and offset query params', async () => {
    const res = await request(app).get(
      `/wallets/${VALID_ADDR}/royalty-breakdown?limit=10&offset=20`
    );

    expect(res.status).toBe(200);
    const args = mockPrisma.royaltyPayment.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(20);
  });

  it('applies from/to as an inclusive ledgerSequence window', async () => {
    const res = await request(app).get(
      `/wallets/${VALID_ADDR}/royalty-breakdown?from=100&to=600`
    );

    expect(res.status).toBe(200);
    const args = mockPrisma.royaltyPayment.findMany.mock.calls[0][0];
    expect(args.where.ledgerSequence).toEqual({ gte: 100, lte: 600 });
    // count uses the same filter so total reflects the window
    const countArgs = mockPrisma.royaltyPayment.count.mock.calls[0][0];
    expect(countArgs.where.ledgerSequence).toEqual({ gte: 100, lte: 600 });
  });

  it('supports an open-ended window (from only)', async () => {
    const res = await request(app).get(
      `/wallets/${VALID_ADDR}/royalty-breakdown?from=300`
    );

    expect(res.status).toBe(200);
    const args = mockPrisma.royaltyPayment.findMany.mock.calls[0][0];
    expect(args.where.ledgerSequence).toEqual({ gte: 300 });
  });

  it('rejects an invalid Stellar address with 400', async () => {
    const res = await request(app).get('/wallets/not-an-address/royalty-breakdown');

    expect(res.status).toBe(400);
    expect(mockPrisma.royaltyPayment.findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit with 400', async () => {
    const res = await request(app).get(
      `/wallets/${VALID_ADDR}/royalty-breakdown?limit=abc`
    );

    expect(res.status).toBe(400);
  });

  it('returns an empty page when the recipient has no payments', async () => {
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.royaltyPayment.count.mockResolvedValue(0);

    const res = await request(app).get(`/wallets/${VALID_ADDR}/royalty-breakdown`);

    expect(res.status).toBe(200);
    expect(res.body.payments).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('returns 500 with a friendly message on DB failure', async () => {
    mockPrisma.royaltyPayment.findMany.mockRejectedValue(new Error('boom'));

    const res = await request(app).get(`/wallets/${VALID_ADDR}/royalty-breakdown`);

    expect(res.status).toBe(500);
  });
});
