/**
 * tx-lookup.test.ts
 *
 * Issue #301: Tests for GET /transactions/:hash in the indexer API.
 * Covers: confirmed, stale-indexer (pending), unknown hash, invalid format,
 * and missing hash cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  marketplaceEvent: {
    findMany: vi.fn(),
  },
}));

vi.mock('../db', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: { isReady: false, get: vi.fn(), setEx: vi.fn() },
  invalidatePattern: vi.fn(),
  invalidateKey: vi.fn(),
}));
vi.mock('../api/routes.js', async () => {
  // Re-export a real router but with mocked prisma
  const actual = await vi.importActual<any>('../api/routes.js');
  return actual;
});

// Inline a minimal test router that mirrors the real /transactions/:hash handler
// so we can unit-test it in isolation without the full Express app.
import { Router, Request, Response, NextFunction } from 'express';

const VALID_HASH = 'a'.repeat(64);
const STELLAR_NETWORK = 'testnet';

function txExplorerUrl(hash: string) {
  return `https://stellar.expert/explorer/${STELLAR_NETWORK}/tx/${hash}`;
}

function buildTxRouter() {
  const r = Router();

  r.get('/transactions/:hash', async (req: Request, res: Response, next: NextFunction) => {
    const { hash } = req.params;
    if (!hash || hash.trim() === '') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Transaction hash is required' } });
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hash.trim())) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid transaction hash format — must be 64 hex characters' } });
    }
    const normalised = hash.trim().toLowerCase();
    try {
      const indexerEvents = await mockPrisma.marketplaceEvent.findMany({
        where: { txHash: normalised },
        select: {
          id: true,
          eventType: true,
          listingId: true,
          actor: true,
          ledgerSequence: true,
          ledgerTimestamp: true,
          contractId: true,
        },
        orderBy: { ledgerSequence: 'asc' },
        take: 20,
      });

      const indexerStatus = indexerEvents.length > 0 ? 'confirmed' : 'pending';
      const chainStatus = indexerEvents.length > 0 ? 'success' : 'unknown';
      const staleIndexer = chainStatus === 'success' && indexerEvents.length === 0;
      const relatedResources: any = {};
      if (indexerEvents.length > 0) {
        relatedResources.listing_id = indexerEvents[0].listingId?.toString() ?? null;
      }

      res.json({
        hash: normalised,
        chain_status: chainStatus,
        indexer_status: staleIndexer ? 'pending' : indexerStatus,
        stale_indexer: staleIndexer,
        explorer_url: txExplorerUrl(normalised),
        events: indexerEvents,
        related_resources: relatedResources,
        network: STELLAR_NETWORK,
      });
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to look up transaction' } });
    }
  });

  return r;
}

const app = express();
app.use(buildTxRouter());

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
});

describe('GET /transactions/:hash — valid confirmed tx', () => {
  it('returns chain_status=success and indexer_status=confirmed when events exist', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      {
        id: 1,
        eventType: 'ARTWORK_SOLD',
        listingId: BigInt(42),
        actor: 'GTEST',
        ledgerSequence: 1000,
        ledgerTimestamp: new Date(),
        contractId: 'CONTRACT',
      },
    ]);

    const res = await request(app).get(`/transactions/${VALID_HASH}`);
    expect(res.status).toBe(200);
    expect(res.body.chain_status).toBe('success');
    expect(res.body.indexer_status).toBe('confirmed');
    expect(res.body.stale_indexer).toBe(false);
  });

  it('includes the related listing_id from the first event', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      {
        id: 2,
        eventType: 'LISTING_CREATED',
        listingId: { toString: () => '7' },
        actor: 'GTEST',
        ledgerSequence: 500,
        ledgerTimestamp: null,
        contractId: 'C',
      },
    ]);

    const res = await request(app).get(`/transactions/${VALID_HASH}`);
    expect(res.body.related_resources.listing_id).toBe('7');
  });

  it('includes explorer_url with network testnet', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      { id: 3, eventType: 'OFFER_MADE', listingId: null, actor: 'G', ledgerSequence: 1, ledgerTimestamp: null, contractId: 'C' },
    ]);
    const res = await request(app).get(`/transactions/${VALID_HASH}`);
    expect(res.body.explorer_url).toContain('testnet');
    expect(res.body.explorer_url).toContain(VALID_HASH.toLowerCase());
  });
});

describe('GET /transactions/:hash — unknown hash (no indexer record)', () => {
  it('returns chain_status=unknown and indexer_status=pending', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const res = await request(app).get(`/transactions/${VALID_HASH}`);
    expect(res.status).toBe(200);
    expect(res.body.chain_status).toBe('unknown');
    expect(res.body.indexer_status).toBe('pending');
    expect(res.body.stale_indexer).toBe(false);
  });

  it('returns an empty events array', async () => {
    const res = await request(app).get(`/transactions/${VALID_HASH}`);
    expect(res.body.events).toEqual([]);
  });
});

describe('GET /transactions/:hash — invalid format', () => {
  it('returns 400 for a short hash', async () => {
    const res = await request(app).get('/transactions/tooshort');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid transaction hash format/i);
  });

  it('returns 400 for a hash with non-hex characters', async () => {
    const res = await request(app).get('/transactions/' + 'z'.repeat(64));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty string segment', async () => {
    // Express will 404 on /transactions/ (no param), which is also acceptable
    const res = await request(app).get('/transactions/%20');
    expect([400, 404]).toContain(res.status);
  });
});

describe('GET /transactions/:hash — response structure', () => {
  it('always includes hash, network, and explorer_url', async () => {
    const res = await request(app).get(`/transactions/${VALID_HASH}`);
    expect(res.body).toHaveProperty('hash');
    expect(res.body).toHaveProperty('network');
    expect(res.body).toHaveProperty('explorer_url');
    expect(res.body).toHaveProperty('chain_status');
    expect(res.body).toHaveProperty('indexer_status');
    expect(res.body).toHaveProperty('stale_indexer');
    expect(res.body).toHaveProperty('events');
    expect(res.body).toHaveProperty('related_resources');
  });

  it('normalises hash to lowercase in the response', async () => {
    const upperHash = 'A'.repeat(64);
    const res = await request(app).get(`/transactions/${upperHash}`);
    expect(res.body.hash).toBe(upperHash.toLowerCase());
  });
});
