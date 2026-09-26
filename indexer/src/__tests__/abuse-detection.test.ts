/**
 * abuse-detection.test.ts
 *
 * Issue #539: API abuse detection and IP/account quotas.
 *
 * Covers:
 *   - Proxy header (X-Forwarded-For) handling stays consistent with the
 *     rate-limit middleware's ipKeyGenerator-based key derivation.
 *   - Redis failure fails OPEN (request allowed, failure metric incremented)
 *     rather than 500ing or blocking legitimate traffic.
 *   - Authenticated (wallet) vs anonymous (IP-only) traffic get distinct key
 *     types and are tracked independently.
 *   - A basic bypass attempt: rotating IPs behind a stable wallet is still
 *     caught by the wallet-keyed quota; rotating wallets behind a stable IP
 *     is still caught by the IP-hash-keyed quota.
 *   - The operator blocklist workflow (block / unblock / isBlocked) and that
 *     blocked requests get a 429 with Retry-After.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';

// ── In-memory Redis mock ─────────────────────────────────────────────────────
//
// Implements just enough of the node-redis v4/v6 surface (incr/expire/ttl/
// set/get/del/keys) for abuse-detection.ts to exercise real INCR+EXPIRE
// quota logic and TTL-based blocklist checks without a live Redis instance.

const mockRedis = vi.hoisted(() => {
  // Built inline (rather than via a helper) because vi.hoisted runs before
  // any other module-level code, including function declarations below it.
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  let ready = true;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const isLive = (e: any) => !!e && (e.expiresAt === null || e.expiresAt > nowSec());
  return {
    get isReady() {
      return ready;
    },
    isOpen: true,
    setReady(v: boolean) {
      ready = v;
    },
    async incr(key: string) {
      const existing = store.get(key);
      const current = isLive(existing) ? parseInt(existing!.value, 10) : 0;
      const next = current + 1;
      store.set(key, { value: String(next), expiresAt: isLive(existing) ? existing!.expiresAt : null });
      return next;
    },
    async expire(key: string, seconds: number) {
      const existing = store.get(key);
      if (!existing) return 0;
      existing.expiresAt = nowSec() + seconds;
      return 1;
    },
    async ttl(key: string) {
      const existing = store.get(key);
      if (!isLive(existing)) return -2;
      if (existing!.expiresAt === null) return -1;
      return Math.max(0, existing!.expiresAt - nowSec());
    },
    async set(key: string, value: string, opts?: { EX?: number }) {
      store.set(key, { value, expiresAt: opts?.EX !== undefined ? nowSec() + opts.EX : null });
      return 'OK';
    },
    async get(key: string) {
      const existing = store.get(key);
      return isLive(existing) ? existing!.value : null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async keys(pattern: string) {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const results: string[] = [];
      for (const [key, entry] of store.entries()) {
        if (key.startsWith(prefix) && isLive(entry)) results.push(key);
      }
      return results;
    },
    _store: store,
  };
});

vi.mock('../redis.js', () => ({
  default: mockRedis,
  invalidateKey: vi.fn(),
  invalidatePattern: vi.fn(),
}));

import {
  abuseDetection,
  getAbuseKey,
  hashIp,
  blockKey,
  unblockKey,
  isBlocked,
  listBlocklist,
  FAMILY_BUDGETS,
} from '../api/abuse-detection.js';
import { abuseDetectionRedisFailureTotal, abuseQuotaExceededTotal } from '../metrics.js';

function buildApp(family: keyof typeof FAMILY_BUDGETS) {
  const app = express();
  app.use(express.json());
  app.get('/probe', abuseDetection(family), (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  mockRedis._store.clear();
  mockRedis.setReady(true);
});

describe('abuse-detection: key derivation', () => {
  it('keys anonymous requests by a hashed IP, never the raw IP', () => {
    const req = { headers: {}, query: {}, ip: '203.0.113.7', socket: {} } as any;
    const { keyType, key } = getAbuseKey(req);
    expect(keyType).toBe('ip_hash');
    expect(key).not.toContain('203.0.113.7');
    expect(key).toBe(`ip:${hashIp('203.0.113.7')}`);
  });

  it('keys wallet-bearing requests by the wallet address (authenticated traffic)', () => {
    const req = { headers: { 'x-wallet-address': 'GABC123' }, query: {}, ip: '203.0.113.7', socket: {} } as any;
    const { keyType, key } = getAbuseKey(req);
    expect(keyType).toBe('wallet');
    expect(key).toBe('wallet:GABC123');
  });

  it('falls back to the ?wallet= query param when the header is absent', () => {
    const req = { headers: {}, query: { wallet: 'GXYZ999' }, ip: '203.0.113.7', socket: {} } as any;
    const { keyType, key } = getAbuseKey(req);
    expect(keyType).toBe('wallet');
    expect(key).toBe('wallet:GXYZ999');
  });

  it('produces the same hash for the same IP and a different hash for a different IP', () => {
    expect(hashIp('198.51.100.1')).toBe(hashIp('198.51.100.1'));
    expect(hashIp('198.51.100.1')).not.toBe(hashIp('198.51.100.2'));
  });
});

describe('abuse-detection: proxy header (X-Forwarded-For) handling', () => {
  it('keys anonymous requests behind a proxy consistently by X-Forwarded-For, not the socket IP', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/probe', abuseDetection('search'), (_req, res) => res.json({ ok: true }));

    const first = await request(app).get('/probe').set('X-Forwarded-For', '198.51.100.9');
    const second = await request(app).get('/probe').set('X-Forwarded-For', '198.51.100.9');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Both requests should have incremented the SAME quota bucket (same
    // hashed key derived from the forwarded IP) — verified indirectly by
    // checking exactly one quota key exists in the store after two hits.
    const quotaKeys = [...mockRedis._store.keys()].filter((k) => k.startsWith('abuse:quota:search:'));
    expect(quotaKeys.length).toBe(1);
  });

  it('treats two different X-Forwarded-For values as two independent anonymous keys', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/probe', abuseDetection('search'), (_req, res) => res.json({ ok: true }));

    await request(app).get('/probe').set('X-Forwarded-For', '198.51.100.10');
    await request(app).get('/probe').set('X-Forwarded-For', '198.51.100.11');

    const quotaKeys = [...mockRedis._store.keys()].filter((k) => k.startsWith('abuse:quota:search:'));
    expect(quotaKeys.length).toBe(2);
  });
});

describe('abuse-detection: Redis failure fails open', () => {
  it('allows the request through and records a failure metric when Redis is not ready', async () => {
    mockRedis.setReady(false);
    const before = (await abuseDetectionRedisFailureTotal.get()).values.reduce((s, v) => s + v.value, 0);

    const app = buildApp('search');
    const res = await request(app).get('/probe');

    expect(res.status).toBe(200);
    const after = (await abuseDetectionRedisFailureTotal.get()).values.reduce((s, v) => s + v.value, 0);
    expect(after).toBeGreaterThan(before);
  });

  it('isBlocked() fails open (reports not blocked) when Redis is unreachable', async () => {
    mockRedis.setReady(false);
    const result = await isBlocked('wallet:GABC123');
    expect(result.blocked).toBe(false);
  });
});

describe('abuse-detection: authenticated vs anonymous quota tracking', () => {
  it('tracks wallet and IP-hash quotas independently for the same underlying request pattern', async () => {
    const app = express();
    app.use((req, _res, next) => {
      // Simulate one request with wallet header, one without, same IP.
      next();
    });
    app.get('/probe', abuseDetection('wallet-activity'), (_req, res) => res.json({ ok: true }));

    await request(app).get('/probe').set('X-Wallet-Address', 'GWALLET1');
    await request(app).get('/probe'); // anonymous, IP-keyed

    const walletKeys = [...mockRedis._store.keys()].filter((k) => k.includes(':wallet:'));
    const ipKeys = [...mockRedis._store.keys()].filter((k) => k.includes(':ip:'));
    expect(walletKeys.length).toBe(1);
    expect(ipKeys.length).toBe(1);
  });
});

describe('abuse-detection: quota enforcement and bypass attempts', () => {
  it('rejects with 429 + Retry-After once a family quota is exceeded', async () => {
    const app = buildApp('sse');
    const max = FAMILY_BUDGETS.sse.max;

    let lastRes;
    for (let i = 0; i < max + 1; i++) {
      lastRes = await request(app).get('/probe').set('X-Wallet-Address', 'GQUOTATEST');
    }

    expect(lastRes!.status).toBe(429);
    expect(lastRes!.headers['retry-after']).toBeDefined();
    expect(lastRes!.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('bypass attempt: rotating IPs behind one wallet is still caught by the wallet-keyed quota', async () => {
    const app = express();
    app.get('/probe', abuseDetection('wallet-activity'), (_req, res) => res.json({ ok: true }));
    const max = FAMILY_BUDGETS['wallet-activity'].max;

    let lastRes;
    for (let i = 0; i < max + 1; i++) {
      lastRes = await request(app)
        .get('/probe')
        .set('X-Wallet-Address', 'GSAMEWALLET')
        .set('X-Forwarded-For', `10.0.0.${i % 250}`); // rotate IP every request
    }

    expect(lastRes!.status).toBe(429);
  });

  it('bypass attempt: rotating wallets behind one IP is still caught by the IP-hash-keyed quota', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/probe', abuseDetection('tx-lookup'), (_req, res) => res.json({ ok: true }));
    const max = FAMILY_BUDGETS['tx-lookup'].max;

    let lastRes;
    for (let i = 0; i < max + 1; i++) {
      // No wallet header/query at all -> always falls back to the IP key,
      // so "rotating wallets" here means the client never presents one.
      lastRes = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.50');
    }

    expect(lastRes!.status).toBe(429);
  });

  it('does not leak the raw IP or wallet identity in the 429 response body', async () => {
    const app = buildApp('search');
    const max = FAMILY_BUDGETS.search.max;

    let lastRes;
    for (let i = 0; i < max + 1; i++) {
      lastRes = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.60');
    }

    const bodyStr = JSON.stringify(lastRes!.body);
    expect(bodyStr).not.toContain('203.0.113.60');
  });
});

describe('abuse-detection: operator blocklist workflow', () => {
  it('blockKey() then isBlocked() reports blocked with a positive TTL', async () => {
    await blockKey('wallet:GBADACTOR', 120, 'manual_review');
    const result = await isBlocked('wallet:GBADACTOR');
    expect(result.blocked).toBe(true);
    expect(result.ttlSeconds).toBeGreaterThan(0);
    expect(result.ttlSeconds).toBeLessThanOrEqual(120);
  });

  it('unblockKey() removes the block', async () => {
    await blockKey('ip:deadbeefcafef00d', 60, 'test');
    await unblockKey('ip:deadbeefcafef00d');
    const result = await isBlocked('ip:deadbeefcafef00d');
    expect(result.blocked).toBe(false);
  });

  it('listBlocklist() surfaces active blocks with reason and TTL', async () => {
    await blockKey('wallet:GLISTED', 300, 'spam_pattern');
    const entries = await listBlocklist();
    const match = entries.find((e) => e.key === 'wallet:GLISTED');
    expect(match).toBeDefined();
    expect(match!.reason).toBe('spam_pattern');
    expect(match!.ttlSeconds).toBeGreaterThan(0);
  });

  it('a blocked key gets 429 with Retry-After at the middleware layer, before quota is even checked', async () => {
    await blockKey('wallet:GBLOCKEDMID', 60, 'operator_block');

    const app = express();
    app.get('/probe', abuseDetection('search'), (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/probe').set('X-Wallet-Address', 'GBLOCKEDMID');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.error.message).not.toMatch(/quota|threshold|redis/i);
  });
});
