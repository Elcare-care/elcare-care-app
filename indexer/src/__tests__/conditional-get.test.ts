/**
 * conditional-get.test.ts
 *
 * Issue #508 — Conditional GET support for heavy endpoints.
 *
 * Test coverage:
 *  1. Unchanged representation → 304, no body, no unnecessary DB work
 *  2. Changed data → new ETag, 200 with body
 *  3. Query-parameter change → new ETag (same data, different URL)
 *  4. Confirmed-version bump (reorg) → new ETag even for identical payload
 *  5. Provisional→confirmed transition → bumpConfirmedVersion produces new ETag
 *  6. Cache-Control policy: provisional paths get no-cache
 *  7. Cache-Control policy: stable paths get public, max-age=30
 *  8. SSE route → no-store, no ETag
 *  9. cache-middleware: 304 short-circuit on Redis cache hit (skips handler)
 * 10. cache-middleware: cache miss → normal 200, handler runs
 * 11. Mismatched If-None-Match → 200 with body
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRedis = vi.hoisted(() => ({
  isReady: true,
  isOpen: true,
  get: vi.fn<() => Promise<string | null>>(),
  setEx: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  keys: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
  del: vi.fn<() => Promise<number>>().mockResolvedValue(0),
  on: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../redis.js', () => ({ default: mockRedis }));

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn(),
  },
  marketplaceEvent: {
    findMany: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    updateMany: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));
vi.mock('../prisma-write.js', () => ({ default: mockPrisma }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  etagMiddleware,
  computeETag,
  cacheControlForPath,
  bumpConfirmedVersion,
  getConfirmedVersion,
  _resetConfirmedVersion,
} from '../api/etag-middleware.js';
import { cacheMiddleware } from '../api/cache-middleware.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(...middlewares: any[]) {
  const app = express();
  app.use(express.json());
  middlewares.forEach((m) => app.use(m));
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–3, 11: ETag middleware unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('etagMiddleware — ETag generation and conditional GET', () => {
  beforeEach(() => {
    _resetConfirmedVersion();
    vi.clearAllMocks();
  });

  it('sets an ETag header on a 200 response', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/test', (_req: Request, res: Response) => res.json({ hello: 'world' }));

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^"[a-f0-9]+"$/);
  });

  it('returns 304 with no body when If-None-Match matches', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/test', (_req: Request, res: Response) => res.json({ stable: true }));

    // First request — grab the ETag
    const first = await request(app).get('/test');
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    // Second request — conditional GET
    const second = await request(app).get('/test').set('If-None-Match', etag);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns 200 when data changes (new ETag)', async () => {
    let counter = 0;
    const app = buildApp(etagMiddleware);
    app.get('/test', (_req: Request, res: Response) => res.json({ counter: ++counter }));

    const first = await request(app).get('/test');
    const etag1 = first.headers['etag'];

    const second = await request(app).get('/test').set('If-None-Match', etag1);
    // Data changed, so ETag differs → 200, not 304
    expect(second.status).toBe(200);
    expect(second.body.counter).toBe(2);
    expect(second.headers['etag']).not.toBe(etag1);
  });

  it('produces a different ETag when the query string changes (same body)', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/search', (_req: Request, res: Response) => res.json({ results: [] }));

    const res1 = await request(app).get('/search?q=cats');
    const res2 = await request(app).get('/search?q=dogs');

    expect(res1.headers['etag']).toBeDefined();
    expect(res2.headers['etag']).toBeDefined();
    // Both responses have the same body but different URLs → different ETags
    expect(res1.headers['etag']).not.toBe(res2.headers['etag']);
  });

  it('returns 200 for a mismatched If-None-Match (wrong ETag)', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/test', (_req: Request, res: Response) => res.json({ data: 1 }));

    const res = await request(app).get('/test').set('If-None-Match', '"wrong"');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: 1 });
  });

  it('does not set ETag on error responses (4xx/5xx)', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/err', (_req: Request, res: Response) => {
      res.status(404).json({ error: 'not found' });
    });

    const res = await request(app).get('/err');
    expect(res.status).toBe(404);
    expect(res.headers['etag']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4–5: confirmed-version bumps invalidate ETags
// ─────────────────────────────────────────────────────────────────────────────

describe('ETag invalidation — confirmed-version counter', () => {
  beforeEach(() => {
    _resetConfirmedVersion();
  });

  it('produces a different ETag after bumpConfirmedVersion even with identical payload', () => {
    const payload = JSON.stringify({ events: [{ id: 1, confirmed: true }] });
    const url = '/activity/recent';

    const etag1 = computeETag(payload, url);
    bumpConfirmedVersion();
    const etag2 = computeETag(payload, url);

    expect(etag1).not.toBe(etag2);
  });

  it('ETag changes on each successive bump', () => {
    const payload = '{"x":1}';
    const url = '/stats';

    const versions = [0, 1, 2].map((v) => {
      _resetConfirmedVersion();
      for (let i = 0; i < v; i++) bumpConfirmedVersion();
      return computeETag(payload, url);
    });

    // All three must be distinct
    expect(new Set(versions).size).toBe(3);
  });

  it('getConfirmedVersion reflects bump count', () => {
    _resetConfirmedVersion();
    expect(getConfirmedVersion()).toBe(0);
    bumpConfirmedVersion();
    bumpConfirmedVersion();
    expect(getConfirmedVersion()).toBe(2);
  });

  it('simulates reorg: client ETag becomes stale after bumpConfirmedVersion', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/stats', (_req: Request, res: Response) => res.json({ total: 42 }));

    // Client caches the ETag before the reorg
    const before = await request(app).get('/stats');
    const staleEtag = before.headers['etag'];

    // Reorg happens → version bumps
    bumpConfirmedVersion();

    // Same endpoint, same data — but ETag is now different
    const after = await request(app).get('/stats').set('If-None-Match', staleEtag);
    expect(after.status).toBe(200);   // NOT 304 — must refetch
    expect(after.headers['etag']).not.toBe(staleEtag);
  });

  it('simulates provisional→confirmed: bumpConfirmedVersion invalidates cached ETag', async () => {
    const app = buildApp(etagMiddleware);
    // Simulate an endpoint that returns provisional events
    app.get('/activity/recent', (_req: Request, res: Response) =>
      res.json([{ id: 1, confirmed: false }]),
    );

    // Client fetches while event is provisional
    const provisional = await request(app).get('/activity/recent');
    const provisionalEtag = provisional.headers['etag'];

    // Promotion runs → bumpConfirmedVersion()
    bumpConfirmedVersion();

    // Client revalidates — must get 200, not 304, even though body bytes are the same
    const revalidate = await request(app)
      .get('/activity/recent')
      .set('If-None-Match', provisionalEtag);
    expect(revalidate.status).toBe(200);
    expect(revalidate.headers['etag']).not.toBe(provisionalEtag);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6–8: Cache-Control policy
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache-Control policy', () => {
  beforeEach(() => _resetConfirmedVersion());

  it('provisional paths get no-cache', () => {
    expect(cacheControlForPath('/activity/recent')).toBe('no-cache');
    expect(cacheControlForPath('/wallets/GABC/activity')).toBe('no-cache');
  });

  it('SSE path gets no-store', () => {
    expect(cacheControlForPath('/events')).toBe('no-store');
  });

  it('stable paths get public, max-age=30', () => {
    expect(cacheControlForPath('/listings')).toBe('public, max-age=30, must-revalidate');
    expect(cacheControlForPath('/stats')).toBe('public, max-age=30, must-revalidate');
    expect(cacheControlForPath('/search')).toBe('public, max-age=30, must-revalidate');
    expect(cacheControlForPath('/auctions/5')).toBe('public, max-age=30, must-revalidate');
  });

  it('middleware sets no-cache Cache-Control header on provisional routes', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/activity/recent', (_req: Request, res: Response) =>
      res.json([{ id: 1 }]),
    );

    const res = await request(app).get('/activity/recent');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('middleware sets no-store on SSE route and skips ETag', async () => {
    const app = buildApp(etagMiddleware);
    // Simulate an SSE response (just JSON here for testability)
    app.get('/events', (_req: Request, res: Response) => {
      res.set('Content-Type', 'text/event-stream');
      res.end('data: {}\n\n');
    });

    const res = await request(app).get('/events');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['etag']).toBeUndefined();
  });

  it('middleware sets public max-age header on stable routes', async () => {
    const app = buildApp(etagMiddleware);
    app.get('/listings', (_req: Request, res: Response) => res.json([]));

    const res = await request(app).get('/listings');
    expect(res.headers['cache-control']).toBe('public, max-age=30, must-revalidate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9–10: cache-middleware 304 short-circuit
// ─────────────────────────────────────────────────────────────────────────────

describe('cacheMiddleware — conditional GET short-circuit on cache hit', () => {
  beforeEach(() => {
    _resetConfirmedVersion();
    vi.clearAllMocks();
    mockRedis.isReady = true;
  });

  afterEach(() => {
    mockRedis.isReady = true;
  });

  it('returns 304 without body on cache hit when If-None-Match matches', async () => {
    const payload = JSON.stringify({ listings: [], total: 0 });
    mockRedis.get.mockResolvedValue(payload);

    const app = express();
    app.use(express.json());
    app.use(etagMiddleware);

    let handlerCalled = false;
    app.get('/listings', cacheMiddleware(30), (_req: Request, res: Response) => {
      handlerCalled = true;
      res.json({ listings: [], total: 0 });
    });

    // Compute the ETag the client would have stored
    const etag = computeETag(payload, '/listings');

    const res = await request(app)
      .get('/listings')
      .set('If-None-Match', etag);

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
    // Handler must NOT have been called — the short-circuit fired in cache-middleware
    expect(handlerCalled).toBe(false);
  });

  it('returns 200 on cache hit when If-None-Match does not match', async () => {
    const payload = JSON.stringify({ listings: [{ id: 1 }], total: 1 });
    mockRedis.get.mockResolvedValue(payload);

    const app = express();
    app.use(express.json());
    app.use(etagMiddleware);
    app.get('/listings', cacheMiddleware(30), (_req: Request, res: Response) => {
      res.json(JSON.parse(payload));
    });

    const res = await request(app)
      .get('/listings')
      .set('If-None-Match', '"outdated"');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('304 short-circuit is skipped when Redis is not ready', async () => {
    mockRedis.isReady = false;

    const app = express();
    app.use(express.json());
    app.use(etagMiddleware);

    let handlerCalled = false;
    app.get('/listings', cacheMiddleware(30), (_req: Request, res: Response) => {
      handlerCalled = true;
      res.json([]);
    });

    const etag = computeETag('[]', '/listings');
    const res = await request(app)
      .get('/listings')
      .set('If-None-Match', etag);

    // Redis is down → cache middleware bypassed → handler runs → etagMiddleware
    // computes ETag and returns 304 if it matches
    expect(handlerCalled).toBe(true);
  });

  it('cache miss calls the handler and caches the result', async () => {
    mockRedis.get.mockResolvedValue(null);

    const app = express();
    app.use(express.json());
    app.use(etagMiddleware);

    let calls = 0;
    app.get('/stats', cacheMiddleware(30), (_req: Request, res: Response) => {
      calls++;
      res.json({ total: 99 });
    });

    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(99);
    expect(calls).toBe(1);
    expect(mockRedis.setEx).toHaveBeenCalledWith(
      expect.stringContaining('/stats'),
      30,
      expect.any(String),
    );
  });

  it('version bump after cache hit causes different ETag (stale ETag no longer matches)', async () => {
    const payload = JSON.stringify({ total: 5 });
    mockRedis.get.mockResolvedValue(payload);

    // ETag before bump
    const etagBefore = computeETag(payload, '/stats');

    // Reorg / promotion bump
    bumpConfirmedVersion();

    // ETag after bump
    const etagAfter = computeETag(payload, '/stats');

    expect(etagBefore).not.toBe(etagAfter);

    // A request with the old ETag must NOT receive 304
    const app = express();
    app.use(express.json());
    app.use(etagMiddleware);
    app.get('/stats', cacheMiddleware(30), (_req: Request, res: Response) =>
      res.json(JSON.parse(payload)),
    );

    const res = await request(app)
      .get('/stats')
      .set('If-None-Match', etagBefore);

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(etagAfter);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeETag unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('computeETag', () => {
  beforeEach(() => _resetConfirmedVersion());

  it('returns a quoted hex string', () => {
    const etag = computeETag('{}', '/test');
    expect(etag).toMatch(/^"[a-f0-9]+"$/);
  });

  it('different payloads → different ETags', () => {
    expect(computeETag('{"a":1}', '/x')).not.toBe(computeETag('{"a":2}', '/x'));
  });

  it('different URLs → different ETags', () => {
    expect(computeETag('{}', '/a')).not.toBe(computeETag('{}', '/b'));
  });

  it('same payload + URL → deterministic (idempotent)', () => {
    const e1 = computeETag('{"k":"v"}', '/path?q=1');
    const e2 = computeETag('{"k":"v"}', '/path?q=1');
    expect(e1).toBe(e2);
  });
});
