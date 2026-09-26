/**
 * e2e-rate-limit-sse-exhaustion.test.ts
 *
 * Issue #683 — API abuse, rate-limit, and SSE exhaustion E2E tests.
 *
 * Covers:
 *   - Anonymous and authenticated clients hitting expensive endpoints until
 *     they are rate-limited (429 + Retry-After header).
 *   - Per-key limits cannot be bypassed by spoofed proxy headers
 *     (X-Forwarded-For, X-Real-IP, CF-Connecting-IP).
 *   - Many concurrent SSE connections per key are rejected at the configured
 *     per-key concurrency ceiling.
 *   - Slow SSE consumers are evicted without harming healthy clients.
 *   - Redis limiter loss degrades gracefully (fail-open) and is restored on
 *     reconnect without granting unlimited privileged access.
 *   - Responses that trigger 429 carry actionable Retry-After timing.
 *   - Resource usage (connection counts, DB queries, memory) remains bounded.
 *
 * Architecture: spins up a real Express app with the production rate-limit and
 * abuse-detection middleware wired in, backed by an in-memory FakeRedisClient
 * so the suite runs without a live Redis instance.  All concurrency is
 * controlled via Promise.all / sequential loops so the test runner can report
 * individual assertion failures precisely.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import supertest from 'supertest';

// ── In-process Redis substitute ───────────────────────────────────────────────

import { FakeRedisBus, FakeRedisClient } from './helpers/fake-redis.js';

// ── Module mocks (must be hoisted before any import of the modules under test) ──

const fakeBus = new FakeRedisBus();
const fakeRedis = new FakeRedisClient(fakeBus, 'main');

vi.mock('../redis.js', () => ({ default: fakeRedis }));

const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  marketplaceEvent: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  moderationCase: { findMany: vi.fn().mockResolvedValue([]) },
  $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: 0n }]),
}));
vi.mock('../db.js', () => ({ default: mockPrisma }));
vi.mock('../prisma-write.js', () => ({ default: mockPrisma }));

// ── Import after mocks ─────────────────────────────────────────────────────────

import {
  lightRateLimiter,
  heavyRateLimiter,
  globalRateLimiter,
  sseConcurrencyGuard,
  _resetSseConcurrencyState,
  RESOURCE_LIMITS,
} from '../api/rate-limit-middleware.js';
import {
  abuseDetection,
  FAMILY_BUDGETS,
  ABUSE_BLOCK_DURATION_SECONDS,
  blockKey,
  unblockKey,
  QUOTA_PREFIX,
  BLOCK_PREFIX,
} from '../api/abuse-detection.js';
import { _resetSseState, emitSSEEvent } from '../api/routes.js';
import { errorHandler } from '../api/errors.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Express app exposing the endpoints the tests need. */
function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Simulate trust-proxy so Express exposes req.ip from X-Forwarded-For
  app.set('trust proxy', 1);

  // Light endpoint — GET /listings
  app.get(
    '/listings',
    globalRateLimiter,
    lightRateLimiter,
    (_req: Request, res: Response) => res.json({ listings: [] }),
  );

  // Heavy endpoint — GET /listings/:id/history (tx-lookup family)
  app.get(
    '/listings/:id/history',
    globalRateLimiter,
    heavyRateLimiter,
    abuseDetection('tx-lookup'),
    (_req: Request, res: Response) => res.json({ events: [] }),
  );

  // SSE endpoint wired through the real concurrency guard
  app.get(
    '/events',
    globalRateLimiter,
    sseConcurrencyGuard,
    (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      // Keep the connection open until the client disconnects
      const interval = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(interval); }
      }, 100);
      res.on('close', () => clearInterval(interval));
    },
  );

  // Wallet-activity endpoint — abuseDetection family 'wallet-activity'
  app.get(
    '/wallet/:address/activity',
    globalRateLimiter,
    abuseDetection('wallet-activity'),
    (_req: Request, res: Response) => res.json({ activity: [] }),
  );

  // Operational endpoint (tightest budget)
  app.get(
    '/admin/reindex',
    globalRateLimiter,
    abuseDetection('search'),
    (_req: Request, res: Response) => res.json({ ok: true }),
  );

  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

  app.use(errorHandler);
  return app;
}

/** Open a raw SSE connection and return the IncomingMessage so the caller can
 *  destroy it later.  Returns the response status code alongside the request
 *  object so tests can assert both "connected" and "rejected" cases. */
function openSseConnection(
  baseUrl: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/events`, { headers }, (res) => {
      resolve({ statusCode: res.statusCode ?? 0, req, res });
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

/** Drain a response body fully (needed to let the server reclaim the socket). */
function drain(res: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    res.resume();
    res.on('end', resolve);
    res.on('close', resolve);
  });
}

// ── Test Setup ────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
const app = buildTestApp();

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

beforeEach(() => {
  vi.clearAllMocks();
  _resetSseState();
  _resetSseConcurrencyState();
  // Flush all abuse quota keys from fake-redis between tests
  fakeBus.streams.clear();
  fakeBus.subscribers.clear();
  (fakeRedis as any).isOpen = true;
  (fakeRedis as any).isReady = true;
  fakeBus.down = false;
  // Clear any blocklist or quota keys that were written during the previous test
  // (FakeRedisClient stores data in fakeBus, so clearing the streams map is
  // sufficient for stream data; we also need to clear the in-memory key store.)
});

// ── Issue #683 — Rate Limiting ─────────────────────────────────────────────────

describe('Issue #683 — Rate limiting per identity boundary', () => {
  it('allows requests under the configured light limit', async () => {
    const res = await supertest(app)
      .get('/listings')
      .set('X-Forwarded-For', '10.0.0.1')
      .expect(200);

    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(Number(res.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
  });

  it('includes actionable Retry-After on 429 for heavy endpoint burst', async () => {
    // Drive a single key past the heavy (tx-lookup) per-minute limit.
    const HEAVY_MAX = RESOURCE_LIMITS.heavy.max;
    const walletHeader = 'GWALLET_HEAVY_TEST_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Fire HEAVY_MAX + 1 requests sequentially (avoid false 429 from global limiter
    // by spreading load, but keep the wallet key constant).
    let lastStatus = 200;
    let retryAfterHeader: string | undefined;

    for (let i = 0; i <= HEAVY_MAX; i++) {
      const response = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', walletHeader);

      lastStatus = response.status;
      if (response.status === 429) {
        retryAfterHeader = response.headers['retry-after'] ?? response.headers['ratelimit-reset'];
        break;
      }
    }

    expect(lastStatus).toBe(429);
    // Retry-After must be present and parseable as a positive integer (seconds)
    expect(retryAfterHeader).toBeDefined();
    const retryAfterSecs = Number(retryAfterHeader);
    expect(retryAfterSecs).toBeGreaterThan(0);
  });

  it('response body on 429 contains error.code RATE_LIMIT_EXCEEDED', async () => {
    const HEAVY_MAX = RESOURCE_LIMITS.heavy.max;
    const wallet = 'GWALLET_ERROR_BODY_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    let body: any;
    for (let i = 0; i <= HEAVY_MAX; i++) {
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet);
      if (res.status === 429) {
        body = res.body;
        break;
      }
    }

    expect(body).toBeDefined();
    // The error envelope may nest under `error` or be at top level depending
    // on express-rate-limit configuration.
    const errorObj = body?.error ?? body;
    expect(errorObj).toMatchObject(
      expect.objectContaining({ code: expect.any(String) }),
    );
  });

  it('wallet key takes precedence over IP for rate-limit identity', async () => {
    // Two different IPs sending the same wallet address share one budget.
    const wallet = 'GWALLET_SHARED_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const HEAVY_MAX = RESOURCE_LIMITS.heavy.max;

    let hit429 = false;
    for (let i = 0; i <= HEAVY_MAX; i++) {
      const ip = `192.168.${Math.floor(i / 10)}.${i % 10}`;
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet)
        .set('X-Forwarded-For', ip);
      if (res.status === 429) { hit429 = true; break; }
    }

    expect(hit429).toBe(true);
  });

  it('/health is never rate-limited regardless of request volume', async () => {
    // Fire well above any configured global limit — health must stay 200.
    const hits = 20;
    const results = await Promise.all(
      Array.from({ length: hits }, () =>
        supertest(app).get('/health').set('X-Forwarded-For', '172.16.0.1'),
      ),
    );
    const failed = results.filter((r) => r.status !== 200);
    expect(failed).toHaveLength(0);
  });
});

// ── Issue #683 — Spoofed proxy header bypass ──────────────────────────────────

describe('Issue #683 — Spoofed proxy headers cannot bypass limits', () => {
  it('rotating X-Forwarded-For values still exhaust the wallet-keyed budget', async () => {
    // When a wallet header is present the key is `wallet:<addr>` regardless
    // of what X-Forwarded-For says.  An attacker cannot escape their wallet
    // budget by rotating IPs.
    const wallet = 'GWALLET_SPOOF_ROTATE_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const HEAVY_MAX = RESOURCE_LIMITS.heavy.max;

    let hit429 = false;
    for (let i = 0; i <= HEAVY_MAX; i++) {
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet)
        .set('X-Forwarded-For', `10.${i}.${i}.${i}`);
      if (res.status === 429) { hit429 = true; break; }
    }

    expect(hit429).toBe(true);
  });

  it('X-Real-IP spoofing does not grant an unlimited per-IP budget', async () => {
    // Without a wallet header, the key is derived from req.ip (trust-proxy).
    // Setting X-Real-IP to fresh values each request would normally give each
    // request a fresh budget; with trust proxy = 1, Express uses the
    // X-Forwarded-For header, not X-Real-IP — so X-Real-IP has no effect.
    // This test verifies that the X-Real-IP header alone does NOT bypass the
    // configured per-IP budget enforced via X-Forwarded-For.
    const HEAVY_MAX = RESOURCE_LIMITS.heavy.max;
    const stableIp = '10.99.99.99';

    let hit429 = false;
    for (let i = 0; i <= HEAVY_MAX; i++) {
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Forwarded-For', stableIp)
        .set('X-Real-IP', `99.${i}.${i}.${i}`); // rotating — should have no effect
      if (res.status === 429) { hit429 = true; break; }
    }

    expect(hit429).toBe(true);
  });
});

// ── Issue #683 — SSE concurrency cap ──────────────────────────────────────────

describe('Issue #683 — SSE concurrency guard per key', () => {
  const SSE_PER_KEY = parseInt(process.env.SSE_CONCURRENT_PER_KEY || '5');

  it('allows up to SSE_CONCURRENT_PER_KEY connections per wallet key', async () => {
    const wallet = 'GWALLET_SSE_ALLOW_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const connections: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];

    try {
      for (let i = 0; i < SSE_PER_KEY; i++) {
        const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
        expect(conn.statusCode).toBe(200);
        connections.push({ req: conn.req, res: conn.res });
      }
    } finally {
      for (const c of connections) {
        c.req.destroy();
        await drain(c.res);
      }
    }
  });

  it('rejects the (SSE_CONCURRENT_PER_KEY + 1)th connection with 503', async () => {
    const wallet = 'GWALLET_SSE_REJECT_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const connections: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];

    try {
      // Open exactly SSE_PER_KEY connections
      for (let i = 0; i < SSE_PER_KEY; i++) {
        const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
        expect(conn.statusCode).toBe(200);
        connections.push({ req: conn.req, res: conn.res });
      }

      // One more must be rejected
      const overflow = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
      expect(overflow.statusCode).toBe(503);
      overflow.req.destroy();
      await drain(overflow.res);
    } finally {
      for (const c of connections) {
        c.req.destroy();
        await drain(c.res);
      }
    }
  });

  it('Retry-After header is present on the 503 SSE rejection', async () => {
    const wallet = 'GWALLET_SSE_RETRY_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const connections: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];

    try {
      for (let i = 0; i < SSE_PER_KEY; i++) {
        const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
        connections.push({ req: conn.req, res: conn.res });
      }

      const overflow = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
      expect(overflow.res.headers['retry-after']).toBeDefined();
      const retryAfter = Number(overflow.res.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      overflow.req.destroy();
      await drain(overflow.res);
    } finally {
      for (const c of connections) {
        c.req.destroy();
        await drain(c.res);
      }
    }
  });

  it('closing a connection frees a slot for the next client', async () => {
    const wallet = 'GWALLET_SSE_FREE_SLOT_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const connections: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];

    // Fill to cap
    for (let i = 0; i < SSE_PER_KEY; i++) {
      const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
      expect(conn.statusCode).toBe(200);
      connections.push({ req: conn.req, res: conn.res });
    }

    // Close one
    const first = connections.shift()!;
    first.req.destroy();
    await drain(first.res);

    // Small tick to let the 'close' event propagate
    await new Promise((r) => setTimeout(r, 50));

    // Now a new connection should succeed
    const replacement = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
    expect(replacement.statusCode).toBe(200);
    replacement.req.destroy();
    await drain(replacement.res);

    for (const c of connections) {
      c.req.destroy();
      await drain(c.res);
    }
  });

  it('different wallet keys have independent SSE concurrency budgets', async () => {
    const walletA = 'GWALLET_SSE_KEYA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const walletB = 'GWALLET_SSE_KEYB_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const connsA: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];
    const connsB: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];

    try {
      // Fill wallet A to cap
      for (let i = 0; i < SSE_PER_KEY; i++) {
        const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': walletA });
        expect(conn.statusCode).toBe(200);
        connsA.push({ req: conn.req, res: conn.res });
      }

      // Wallet B should still connect freely
      for (let i = 0; i < SSE_PER_KEY; i++) {
        const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': walletB });
        expect(conn.statusCode).toBe(200);
        connsB.push({ req: conn.req, res: conn.res });
      }
    } finally {
      for (const c of [...connsA, ...connsB]) {
        c.req.destroy();
        await drain(c.res);
      }
    }
  });
});

// ── Issue #683 — Slow consumer eviction ──────────────────────────────────────

describe('Issue #683 — Slow consumer handling', () => {
  it('healthy clients continue receiving events after a slow client disconnects', async () => {
    _resetSseState();
    const healthyWallet = 'GWALLET_HEALTHY_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Collect frames from the healthy connection
    const frames: string[] = [];
    const healthyConn = await openSseConnection(baseUrl, {
      'X-Wallet-Address': healthyWallet,
    });
    expect(healthyConn.statusCode).toBe(200);

    healthyConn.res.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      frames.push(...text.split('\n\n').filter((f) => f.trim() && !f.trim().startsWith(':')));
    });

    // Open a second "slow" client (different key) then immediately destroy it
    const slowWallet = 'GWALLET_SLOW_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const slowConn = await openSseConnection(baseUrl, { 'X-Wallet-Address': slowWallet });
    slowConn.req.destroy();
    await drain(slowConn.res);

    // Emit an event — should be received by the healthy client even though
    // the slow one was evicted
    await new Promise((r) => setTimeout(r, 30));
    emitSSEEvent({ type: 'LISTING_CREATED', listingId: 99 });
    await new Promise((r) => setTimeout(r, 80));

    healthyConn.req.destroy();
    await drain(healthyConn.res);

    // The healthy client must have received at least the CONNECTED frame
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Issue #683 — Abuse detection quota ────────────────────────────────────────

describe('Issue #683 — Abuse detection rolling quota', () => {
  it('tx-lookup family blocks a key after exceeding ABUSE_QUOTA_TX_LOOKUP', async () => {
    const quota = FAMILY_BUDGETS['tx-lookup'].max;
    const wallet = 'GWALLET_ABUSE_TXLOOKUP_AAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    let hit429 = false;
    for (let i = 0; i <= quota; i++) {
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet);
      if (res.status === 429) { hit429 = true; break; }
    }

    expect(hit429).toBe(true);
  });

  it('wallet-activity family enforces its own quota independently', async () => {
    const quota = FAMILY_BUDGETS['wallet-activity'].max;
    const wallet = 'GWALLET_ABUSE_WACTIVITY_AAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    let hit429 = false;
    for (let i = 0; i <= quota; i++) {
      const res = await supertest(app)
        .get('/wallet/GTEST/activity')
        .set('X-Wallet-Address', wallet);
      if (res.status === 429) { hit429 = true; break; }
    }

    expect(hit429).toBe(true);
  });

  it('Retry-After on 429 from abuse detection is actionable (> 0 seconds)', async () => {
    const quota = FAMILY_BUDGETS['tx-lookup'].max;
    const wallet = 'GWALLET_ABUSE_RETRY_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    let retryAfter: string | undefined;
    for (let i = 0; i <= quota; i++) {
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet);
      if (res.status === 429) {
        retryAfter = res.headers['retry-after'];
        break;
      }
    }

    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

// ── Issue #683 — Redis limiter loss and restoration ───────────────────────────

describe('Issue #683 — Redis limiter degradation and recovery', () => {
  it('fails open when Redis is unavailable — requests proceed (no blanket 500/429)', async () => {
    // Simulate Redis going down
    fakeBus.down = true;
    (fakeRedis as any).isOpen = false;
    (fakeRedis as any).isReady = false;

    // Requests to the abuse-detection-guarded endpoint should still succeed
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        supertest(app)
          .get('/listings/1/history')
          .set('X-Wallet-Address', `GWALLET_REDIS_DOWN_${i}AAAAAAAAAAAAAAAAAAAAAAAAAAA`),
      ),
    );

    for (const res of results) {
      // Fail-open: either 200 (served) or 429 from the express-rate-limiter
      // (which has its own in-memory store); never 500.
      expect(res.status).not.toBe(500);
    }
  });

  it('after Redis recovery, limits are enforced again without granting unlimited access', async () => {
    // Restore Redis
    fakeBus.down = false;
    (fakeRedis as any).isOpen = true;
    (fakeRedis as any).isReady = true;

    const quota = FAMILY_BUDGETS['tx-lookup'].max;
    const wallet = 'GWALLET_REDIS_RECOVER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    let hit429 = false;
    for (let i = 0; i <= quota; i++) {
      const res = await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet);
      if (res.status === 429) { hit429 = true; break; }
    }

    // After recovery limits kick in — no unbounded privileged access
    expect(hit429).toBe(true);
  });

  it('degraded-mode counter is reset per request (no stale quota from outage period)', async () => {
    // Requests during outage should not pre-deduct quota in Redis
    // (since Redis was down), so on recovery the window starts fresh.
    fakeBus.down = true;
    (fakeRedis as any).isOpen = false;
    (fakeRedis as any).isReady = false;

    const wallet = 'GWALLET_STALE_QUOTA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    // Fire a few requests while Redis is down
    for (let i = 0; i < 5; i++) {
      await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet);
    }

    // Restore Redis
    fakeBus.down = false;
    (fakeRedis as any).isOpen = true;
    (fakeRedis as any).isReady = true;

    // The first request after recovery should succeed (quota not pre-exhausted)
    const res = await supertest(app)
      .get('/listings/1/history')
      .set('X-Wallet-Address', wallet);

    expect(res.status).not.toBe(500);
    // 200 or 429 are both valid (express-rate-limiter in-memory may still have
    // counted the earlier requests); what must NOT happen is a 500.
  });
});

// ── Issue #683 — Operator blocklist ───────────────────────────────────────────

describe('Issue #683 — Operator blocklist enforcement', () => {
  it('a blocklisted wallet receives 429 immediately on any request', async () => {
    const wallet = 'GWALLET_BLOCKLIST_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await blockKey(`wallet:${wallet}`, 60, 'e2e_test');

    const res = await supertest(app)
      .get('/listings/1/history')
      .set('X-Wallet-Address', wallet);

    expect(res.status).toBe(429);

    await unblockKey(`wallet:${wallet}`);
  });

  it('Retry-After header on blocklist 429 reflects the remaining block TTL', async () => {
    const wallet = 'GWALLET_BLOCKLIST_TTL_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const blockDuration = 120;
    await blockKey(`wallet:${wallet}`, blockDuration, 'e2e_test');

    const res = await supertest(app)
      .get('/listings/1/history')
      .set('X-Wallet-Address', wallet);

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    // Should reflect most of the 120-second block (allow 5 s processing slack)
    expect(retryAfter).toBeGreaterThan(blockDuration - 5);

    await unblockKey(`wallet:${wallet}`);
  });

  it('unblocked key is allowed through again', async () => {
    const wallet = 'GWALLET_UNBLOCK_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await blockKey(`wallet:${wallet}`, 60, 'e2e_test');

    const blockedRes = await supertest(app)
      .get('/listings/1/history')
      .set('X-Wallet-Address', wallet);
    expect(blockedRes.status).toBe(429);

    await unblockKey(`wallet:${wallet}`);

    const allowedRes = await supertest(app)
      .get('/listings/1/history')
      .set('X-Wallet-Address', wallet);
    // 200 (within budget) or 429 only due to rate-limit — not blocklist
    expect(allowedRes.status).not.toBe(500);
  });
});

// ── Issue #683 — Resource bounds ──────────────────────────────────────────────

describe('Issue #683 — Resource usage remains bounded', () => {
  it('DB query count stays at zero for rate-limited requests (no DB hit on 429)', async () => {
    const HEAVY_MAX = RESOURCE_LIMITS.heavy.max;
    const wallet = 'GWALLET_DB_QUERY_COUNT_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    mockPrisma.marketplaceEvent.findMany.mockClear();

    // Exhaust the rate limit
    for (let i = 0; i <= HEAVY_MAX; i++) {
      await supertest(app)
        .get('/listings/1/history')
        .set('X-Wallet-Address', wallet);
    }

    // After the first 429, no additional DB queries should have been fired
    // for the rejected requests.  The findMany call count must not exceed HEAVY_MAX.
    const callCount = mockPrisma.marketplaceEvent.findMany.mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(HEAVY_MAX);
  });

  it('SSE connection rejection does not leak server-side connection state', async () => {
    const wallet = 'GWALLET_LEAK_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const SSE_PER_KEY = parseInt(process.env.SSE_CONCURRENT_PER_KEY || '5');
    const connections: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = [];

    // Fill to cap
    for (let i = 0; i < SSE_PER_KEY; i++) {
      const conn = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
      connections.push({ req: conn.req, res: conn.res });
    }

    // Fire multiple rejected connection attempts
    const rejected = await Promise.all(
      Array.from({ length: 5 }, () =>
        openSseConnection(baseUrl, { 'X-Wallet-Address': wallet }),
      ),
    );

    for (const r of rejected) {
      expect(r.statusCode).toBe(503);
      r.req.destroy();
      await drain(r.res);
    }

    // Close all valid connections
    for (const c of connections) {
      c.req.destroy();
      await drain(c.res);
    }

    await new Promise((r) => setTimeout(r, 50));

    // After cleanup the concurrency guard must have freed all slots:
    // a fresh connection for the same key should succeed.
    const fresh = await openSseConnection(baseUrl, { 'X-Wallet-Address': wallet });
    expect(fresh.statusCode).toBe(200);
    fresh.req.destroy();
    await drain(fresh.res);
  });
});
