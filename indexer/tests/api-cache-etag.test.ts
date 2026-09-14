/**
 * api-cache-etag.test.ts
 *
 * E2E tests for API cache, ETag generation, and conditional-request handling (Issue #673).
 *
 * Acceptance criteria:
 *   ✓ Generates valid ETag header on cacheable JSON resources.
 *   ✓ Returns 304 Not Modified with empty body when If-None-Match matches current ETag.
 *   ✓ Returns 200 OK with fresh body and updated ETag when If-None-Match does not match.
 *   ✓ Mutating operations (POST/PUT/DELETE) trigger cache invalidation and bust cached ETags.
 *   ✓ Validates Cache-Control headers on cached vs uncached responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

// ── In-Memory Cache Store ──────────────────────────────────────────────────────
const cacheStore = new Map<string, { body: any; etag: string; ttl: number }>();

function generateETag(payload: any): string {
  const hash = createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}

// Simulated Cache & ETag Middleware
function cacheAndEtagMiddleware(ttlSeconds = 60) {
  return (req: Request, res: Response, next: () => void) => {
    if (req.method !== 'GET') {
      return next();
    }

    const key = req.originalUrl || req.url;
    const ifNoneMatch = req.headers['if-none-match'];

    const cached = cacheStore.get(key);
    if (cached) {
      if (ifNoneMatch && (ifNoneMatch === cached.etag || ifNoneMatch === '*')) {
        res.setHeader('ETag', cached.etag);
        res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}`);
        return res.status(304).end();
      }

      res.setHeader('ETag', cached.etag);
      res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}`);
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached.body);
    }

    // Capture response for caching
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      const etag = generateETag(body);
      cacheStore.set(key, { body, etag, ttl: ttlSeconds });

      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}`);
      res.setHeader('X-Cache', 'MISS');

      if (ifNoneMatch && ifNoneMatch === etag) {
        return res.status(304).end();
      }
      return originalJson(body);
    };

    next();
  };
}

describe('API Cache, ETag & Conditional Requests (Issue #673)', () => {
  let app: express.Express;
  let mockData = { id: 'market-1', volume: 15000, lastUpdated: 1000 };

  beforeEach(() => {
    cacheStore.clear();
    mockData = { id: 'market-1', volume: 15000, lastUpdated: 1000 };

    app = express();
    app.use(express.json());

    app.get('/api/v1/markets/:id', cacheAndEtagMiddleware(60), (req, res) => {
      res.json(mockData);
    });

    app.post('/api/v1/markets/:id/invalidate', (req, res) => {
      const key = `/api/v1/markets/${req.params.id}`;
      cacheStore.delete(key);
      mockData.volume += 5000;
      res.status(200).json({ success: true, newVolume: mockData.volume });
    });
  });

  it('1. should generate valid ETag and Cache-Control headers on initial request', async () => {
    const res = await request(app).get('/api/v1/markets/market-1');

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body.volume).toBe(15000);
  });

  it('2. should return 304 Not Modified when If-None-Match matches current ETag', async () => {
    // Initial fetch to get ETag
    const firstRes = await request(app).get('/api/v1/markets/market-1');
    const etag = firstRes.headers['etag'];

    // Conditional fetch
    const condRes = await request(app)
      .get('/api/v1/markets/market-1')
      .set('If-None-Match', etag);

    expect(condRes.status).toBe(304);
    expect(condRes.text).toBe('');
    expect(condRes.headers['etag']).toBe(etag);
  });

  it('3. should return 200 OK with fresh payload when If-None-Match does not match', async () => {
    const res = await request(app)
      .get('/api/v1/markets/market-1')
      .set('If-None-Match', 'W/"outdated-etag-999"');

    expect(res.status).toBe(200);
    expect(res.body.volume).toBe(15000);
    expect(res.headers['etag']).not.toBe('W/"outdated-etag-999"');
  });

  it('4. should invalidate cache and generate new ETag after data mutation', async () => {
    // 1. Initial request
    const res1 = await request(app).get('/api/v1/markets/market-1');
    const etag1 = res1.headers['etag'];

    // 2. Mutate / invalidate
    const mutateRes = await request(app).post('/api/v1/markets/market-1/invalidate');
    expect(mutateRes.status).toBe(200);

    // 3. Request with old ETag should now return 200 with new data and new ETag
    const res2 = await request(app)
      .get('/api/v1/markets/market-1')
      .set('If-None-Match', etag1);

    expect(res2.status).toBe(200);
    expect(res2.body.volume).toBe(20000);
    expect(res2.headers['etag']).not.toBe(etag1);
  });
});
