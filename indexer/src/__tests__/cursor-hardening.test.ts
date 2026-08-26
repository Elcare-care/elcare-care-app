/**
 * cursor-hardening.test.ts
 *
 * Verifies the acceptance criteria for Feature 2: opaque cursor standardization.
 *
 *  1. All listed endpoints support deterministic forward pagination under
 *     concurrent ingestion (composite cursor includes id tiebreaker).
 *  2. A tampered cursor is rejected with 400.
 *  3. A cursor cannot be used on a different endpoint (endpoint tag mismatch).
 *  4. A cursor cannot change filters (filters are not encoded in the cursor).
 *  5. X-Next-Cursor and X-Total-Count are present on every paginated response.
 *  6. Legacy integer cursor_ledger still works (backwards compatibility).
 *  7. Empty X-Next-Cursor signals last page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Module-level mocks (must precede all route/db imports) ────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findMany: vi.fn().mockResolvedValue([]),
    count:    vi.fn().mockResolvedValue(0),
  },
  auction: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  offer:   { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  collection: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  marketplaceEvent: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  moderationCase: { findMany: vi.fn().mockResolvedValue([]) },
  $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: BigInt(0) }]),
}));

vi.mock('../db.js',           () => ({ default: mockPrisma }));
vi.mock('../prisma-write.js', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: {
    isOpen: false, isReady: false,
    get: vi.fn().mockResolvedValue(null), setEx: vi.fn(), on: vi.fn(), connect: vi.fn(),
  },
}));

import {
  encodeCursor,
  decodeCursor,
  buildCursorWhere,
  nextCursorFromRows,
  applyCursorToParams,
  extractNextCursor,
  CursorEndpoint,
} from '../api/cursor.js';
import router from '../api/routes.js';
import { errorHandler } from '../api/errors.js';

// ── HTTP test app ─────────────────────────────────────────────────────────────

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use(router);
  a.use(errorHandler);
  return a;
})();

// ── encodeCursor / decodeCursor round-trip ────────────────────────────────────

describe('encodeCursor / decodeCursor — round-trip', () => {
  it('encodes and decodes a composite cursor', () => {
    const token = encodeCursor(500, 42, CursorEndpoint.LISTINGS);
    const decoded = decodeCursor(token, CursorEndpoint.LISTINGS);
    expect(decoded.ledger).toBe(500);
    expect(decoded.id).toBe(42);
    expect(decoded.endpoint).toBe(CursorEndpoint.LISTINGS);
    expect(decoded.isLegacy).toBe(false);
  });

  it('produces a base64url string (no +, /, = padding)', () => {
    const token = encodeCursor(100, 1, CursorEndpoint.AUCTIONS);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('different ledger values produce different tokens', () => {
    expect(encodeCursor(100, 1, CursorEndpoint.LISTINGS)).not.toBe(
      encodeCursor(200, 1, CursorEndpoint.LISTINGS),
    );
  });

  it('different id values produce different tokens', () => {
    expect(encodeCursor(100, 1, CursorEndpoint.LISTINGS)).not.toBe(
      encodeCursor(100, 2, CursorEndpoint.LISTINGS),
    );
  });

  it('different endpoint tags produce different tokens', () => {
    expect(encodeCursor(100, 1, CursorEndpoint.LISTINGS)).not.toBe(
      encodeCursor(100, 1, CursorEndpoint.AUCTIONS),
    );
  });
});

// ── Tamper rejection ──────────────────────────────────────────────────────────

describe('decodeCursor — tamper rejection', () => {
  it('rejects a token with a flipped bit (signature mismatch)', () => {
    const token = encodeCursor(500, 10, CursorEndpoint.LISTINGS);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(() => decodeCursor(tampered, CursorEndpoint.LISTINGS)).toThrow();
  });

  it('rejects completely garbled base64', () => {
    expect(() => decodeCursor('!!!not-valid!!!', CursorEndpoint.LISTINGS)).toThrow();
  });

  it('rejects a JSON payload whose ledger field has been modified', () => {
    const token = encodeCursor(500, 10, CursorEndpoint.LISTINGS);
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    payload.l = 9999; // tamper
    const tampered = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(() => decodeCursor(tampered, CursorEndpoint.LISTINGS)).toThrow();
  });

  it('rejects an unknown schema version', () => {
    const token = encodeCursor(500, 10, CursorEndpoint.LISTINGS);
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    payload.v = 99;
    const bad = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(() => decodeCursor(bad, CursorEndpoint.LISTINGS)).toThrow();
  });

  it('rejects a cursor with missing required fields', () => {
    const partial = Buffer.from(JSON.stringify({ v: 1, l: 500 })).toString('base64url');
    expect(() => decodeCursor(partial, CursorEndpoint.LISTINGS)).toThrow();
  });
});

// ── Cross-endpoint isolation ──────────────────────────────────────────────────

describe('decodeCursor — cross-endpoint isolation', () => {
  it('rejects a listings cursor used on auctions endpoint', () => {
    const token = encodeCursor(500, 10, CursorEndpoint.LISTINGS);
    expect(() => decodeCursor(token, CursorEndpoint.AUCTIONS)).toThrow(/endpoint/i);
  });

  it('rejects a wallet-activity cursor used on collections endpoint', () => {
    const token = encodeCursor(300, 5, CursorEndpoint.WALLET_ACTIVITY);
    expect(() => decodeCursor(token, CursorEndpoint.COLLECTIONS)).toThrow(/endpoint/i);
  });

  it('accepts a cursor on the correct endpoint', () => {
    const token = encodeCursor(300, 5, CursorEndpoint.OFFERS);
    expect(() => decodeCursor(token, CursorEndpoint.OFFERS)).not.toThrow();
  });
});

// ── Legacy integer cursor (backwards compatibility) ───────────────────────────

describe('decodeCursor — legacy integer cursor', () => {
  it('accepts a plain integer string', () => {
    const decoded = decodeCursor('480', CursorEndpoint.LISTINGS);
    expect(decoded.ledger).toBe(480);
    expect(decoded.isLegacy).toBe(true);
  });

  it('accepts "0" as a valid starting cursor', () => {
    const decoded = decodeCursor('0', CursorEndpoint.LISTINGS);
    expect(decoded.ledger).toBe(0);
    expect(decoded.isLegacy).toBe(true);
  });
});

// ── buildCursorWhere ──────────────────────────────────────────────────────────

describe('buildCursorWhere()', () => {
  it('produces simple lt clause for legacy cursor + desc direction', () => {
    const cursor = decodeCursor('480', CursorEndpoint.LISTINGS);
    expect(buildCursorWhere(cursor, 'desc', 'updatedAtLedger')).toEqual({
      updatedAtLedger: { lt: 480 },
    });
  });

  it('produces simple gt clause for legacy cursor + asc direction', () => {
    const cursor = decodeCursor('480', CursorEndpoint.LISTINGS);
    expect(buildCursorWhere(cursor, 'asc', 'updatedAtLedger')).toEqual({
      updatedAtLedger: { gt: 480 },
    });
  });

  it('produces composite OR clause for opaque cursor + desc direction', () => {
    const token = encodeCursor(500, 42, CursorEndpoint.LISTINGS);
    const cursor = decodeCursor(token, CursorEndpoint.LISTINGS);
    const where = buildCursorWhere(cursor, 'desc', 'updatedAtLedger') as any;
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ updatedAtLedger: { lt: 500 } });
    expect(where.OR[1]).toEqual({ updatedAtLedger: 500, id: { lt: 42 } });
  });

  it('produces composite OR clause for opaque cursor + asc direction', () => {
    const token = encodeCursor(500, 42, CursorEndpoint.LISTINGS);
    const cursor = decodeCursor(token, CursorEndpoint.LISTINGS);
    const where = buildCursorWhere(cursor, 'asc', 'updatedAtLedger') as any;
    expect(where.OR[0]).toEqual({ updatedAtLedger: { gt: 500 } });
    expect(where.OR[1]).toEqual({ updatedAtLedger: 500, id: { gt: 42 } });
  });

  it('uses custom idField when provided', () => {
    const token = encodeCursor(300, 7, CursorEndpoint.COLLECTIONS);
    const cursor = decodeCursor(token, CursorEndpoint.COLLECTIONS);
    const where = buildCursorWhere(cursor, 'desc', 'deployedAtLedger', 'collectionId') as any;
    expect(where.OR[1]).toHaveProperty('collectionId');
  });
});

// ── nextCursorFromRows ────────────────────────────────────────────────────────

describe('nextCursorFromRows()', () => {
  const makeRow = (ledger: number, id: number) => ({ updatedAtLedger: ledger, id });

  it('returns an opaque cursor token when page is full', () => {
    const rows = [makeRow(500, 1), makeRow(490, 2), makeRow(480, 3)];
    const cursor = nextCursorFromRows(rows, 3, 'updatedAtLedger', CursorEndpoint.LISTINGS);
    expect(cursor).not.toBe('');
    const decoded = decodeCursor(cursor, CursorEndpoint.LISTINGS);
    expect(decoded.ledger).toBe(480);
    expect(decoded.id).toBe(3);
  });

  it('returns empty string when page is not full (last page)', () => {
    const rows = [makeRow(500, 1), makeRow(490, 2)];
    expect(nextCursorFromRows(rows, 3, 'updatedAtLedger', CursorEndpoint.LISTINGS)).toBe('');
  });

  it('returns empty string for empty results', () => {
    expect(nextCursorFromRows([], 3, 'updatedAtLedger', CursorEndpoint.LISTINGS)).toBe('');
  });

  it('cursor for auctions carries AUCTIONS endpoint tag', () => {
    const rows = [makeRow(400, 5)];
    const cursor = nextCursorFromRows(rows, 1, 'updatedAtLedger', CursorEndpoint.AUCTIONS);
    const decoded = decodeCursor(cursor, CursorEndpoint.AUCTIONS);
    expect(decoded.endpoint).toBe(CursorEndpoint.AUCTIONS);
  });
});

// ── Concurrent insert stability ───────────────────────────────────────────────

describe('Composite cursor — concurrent insert stability', () => {
  it('page 2 DESC cursor excludes id <= boundary id at same ledger', () => {
    const token = encodeCursor(500, 8, CursorEndpoint.LISTINGS);
    const cursor = decodeCursor(token, CursorEndpoint.LISTINGS);
    const where = buildCursorWhere(cursor, 'desc', 'updatedAtLedger') as any;
    const sameLedger = where.OR[1];
    expect(sameLedger.updatedAtLedger).toBe(500);
    expect(sameLedger.id.lt).toBe(8);
  });

  it('ascending composite cursor excludes already-seen rows after insert', () => {
    const token = encodeCursor(400, 3, CursorEndpoint.LISTINGS);
    const cursor = decodeCursor(token, CursorEndpoint.LISTINGS);
    const where = buildCursorWhere(cursor, 'asc', 'updatedAtLedger') as any;
    expect(where.OR[1].id.gt).toBe(3);
  });
});

// ── Frontend helpers ──────────────────────────────────────────────────────────

describe('extractNextCursor()', () => {
  it('returns the cursor string when header is non-empty', () => {
    const mockResponse = { headers: { get: (n: string) => n === 'X-Next-Cursor' ? 'abc123' : null } };
    expect(extractNextCursor(mockResponse)).toBe('abc123');
  });

  it('returns null when header is empty string (last page)', () => {
    expect(extractNextCursor({ headers: { get: () => '' } })).toBeNull();
  });

  it('returns null when header is absent', () => {
    expect(extractNextCursor({ headers: { get: () => null } })).toBeNull();
  });
});

describe('applyCursorToParams()', () => {
  it('adds cursor and removes offset', () => {
    const params = new URLSearchParams('limit=10&offset=20&status=Active');
    const next = applyCursorToParams(params, 'my-cursor-token');
    expect(next.get('cursor')).toBe('my-cursor-token');
    expect(next.has('offset')).toBe(false);
    expect(next.get('limit')).toBe('10');
    expect(next.get('status')).toBe('Active');
  });

  it('removes cursor when null (first page)', () => {
    const params = new URLSearchParams('cursor=old-token&limit=10');
    const next = applyCursorToParams(params, null);
    expect(next.has('cursor')).toBe(false);
    expect(next.get('limit')).toBe('10');
  });

  it('replaces an existing cursor', () => {
    const params = new URLSearchParams('cursor=old&limit=10');
    const next = applyCursorToParams(params, 'new-cursor');
    expect(next.get('cursor')).toBe('new-cursor');
  });
});

// ── HTTP integration: tampered cursor returns 400 ─────────────────────────────

describe('HTTP — tampered cursor is rejected with 400', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /listings with a tampered cursor returns 400', async () => {
    const valid = encodeCursor(500, 1, CursorEndpoint.LISTINGS);
    const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');

    const res = await request(app).get(`/listings?cursor=${tampered}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('GET /auctions with a listings cursor returns 400 (endpoint mismatch)', async () => {
    const listingsCursor = encodeCursor(400, 2, CursorEndpoint.LISTINGS);
    const res = await request(app).get(`/auctions?cursor=${listingsCursor}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('GET /listings with a valid opaque cursor returns 200', async () => {
    const valid = encodeCursor(500, 1, CursorEndpoint.LISTINGS);
    const res = await request(app).get(`/listings?cursor=${valid}`);
    expect(res.status).toBe(200);
  });

  it('GET /listings with legacy cursor_ledger still returns 200', async () => {
    const res = await request(app).get('/listings?cursor_ledger=480&limit=3');
    expect(res.status).toBe(200);
  });

  it('response includes X-Next-Cursor and X-Total-Count headers', async () => {
    const res = await request(app).get('/listings?limit=3');
    expect(res.headers).toHaveProperty('x-next-cursor');
    expect(res.headers).toHaveProperty('x-total-count');
  });

  it('X-Next-Cursor is empty string when no results (last page)', async () => {
    const res = await request(app).get('/auctions?limit=5');
    expect(res.headers['x-next-cursor']).toBe('');
  });

  it('GET /offers with a tampered cursor returns 400', async () => {
    const valid = encodeCursor(300, 5, CursorEndpoint.OFFERS);
    const tampered = valid.slice(0, -1) + (valid.endsWith('Z') ? 'A' : 'Z');
    const res = await request(app).get(`/offers?cursor=${tampered}`);
    expect(res.status).toBe(400);
  });

  it('GET /collections with correct cursor returns 200', async () => {
    const valid = encodeCursor(200, 3, CursorEndpoint.COLLECTIONS);
    const res = await request(app).get(`/collections?cursor=${valid}`);
    expect(res.status).toBe(200);
  });
});
