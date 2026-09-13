import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ── In-Memory Redis Mock ───────────────────────────────────────────────────────
const mockRedisData = new Map<string, string>();
const mockRedisTtl = new Map<string, number>();
let mockRedisReady = true;

const mockRedis = {
  get isReady() {
    return mockRedisReady;
  },
  get: vi.fn(async (key: string) => mockRedisData.get(key) ?? null),
  set: vi.fn(async (key: string, val: string, opts?: { EX?: number }) => {
    mockRedisData.set(key, val);
    if (opts?.EX) mockRedisTtl.set(key, opts.EX);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => {
    mockRedisData.delete(key);
    mockRedisTtl.delete(key);
    return 1;
  }),
  ttl: vi.fn(async (key: string) => mockRedisTtl.get(key) ?? -2),
  keys: vi.fn(async (pattern: string) => {
    const prefix = pattern.replace(':*', '');
    return Array.from(mockRedisData.keys()).filter((k) => k.startsWith(prefix));
  }),
  incr: vi.fn(async (key: string) => {
    const curr = parseInt(mockRedisData.get(key) || '0', 10);
    const next = curr + 1;
    mockRedisData.set(key, String(next));
    return next;
  }),
  expire: vi.fn(async (key: string, seconds: number) => {
    mockRedisTtl.set(key, seconds);
    return 1;
  }),
};

vi.mock('../redis.js', () => ({ default: mockRedis }));
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockInc = vi.fn();
const mockSet = vi.fn();
vi.mock('../metrics.js', () => ({
  abuseQuotaExceededTotal: { labels: () => ({ inc: mockInc }) },
  abuseAnomalyDetectedTotal: { labels: () => ({ inc: mockInc }) },
  abuseBlockedRequestsTotal: { labels: () => ({ inc: mockInc }) },
  abuseBlocklistActiveGauge: { set: mockSet },
  abuseDetectionRedisFailureTotal: { labels: () => ({ inc: mockInc }) },
}));

import {
  hashIp,
  getAbuseKey,
  blockKey,
  unblockKey,
  isBlocked,
  listBlocklist,
  abuseDetection,
  FAMILY_BUDGETS,
  BLOCK_PREFIX,
  QUOTA_PREFIX,
} from '../src/api/abuse-detection.js';

describe('Abuse Detection Module (Issue #539 / #655)', () => {
  beforeEach(() => {
    mockRedisData.clear();
    mockRedisTtl.clear();
    mockRedisReady = true;
    vi.clearAllMocks();
  });

  describe('1. Key Derivation & IP Hashing', () => {
    it('hashIp should produce deterministic 16-character hex hash', () => {
      const hash1 = hashIp('192.168.1.1');
      const hash2 = hashIp('192.168.1.1');
      const hash3 = hashIp('10.0.0.1');

      expect(hash1).toHaveLength(16);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('getAbuseKey should prioritize x-wallet-address header over query and IP', () => {
      const req = {
        headers: { 'x-wallet-address': '0xAlphaWallet123' },
        query: { wallet: '0xBetaWallet456' },
        ip: '127.0.0.1',
      } as unknown as Request;

      const key = getAbuseKey(req);
      expect(key.keyType).toBe('wallet');
      expect(key.key).toBe('wallet:0xAlphaWallet123');
    });

    it('getAbuseKey should fallback to query param wallet if header is missing', () => {
      const req = {
        headers: {},
        query: { wallet: '0xBetaWallet456' },
        ip: '127.0.0.1',
      } as unknown as Request;

      const key = getAbuseKey(req);
      expect(key.keyType).toBe('wallet');
      expect(key.key).toBe('wallet:0xBetaWallet456');
    });

    it('getAbuseKey should fallback to hashed IP when no wallet is supplied', () => {
      const req = {
        headers: {},
        query: {},
        ip: '203.0.113.195',
      } as unknown as Request;

      const key = getAbuseKey(req);
      expect(key.keyType).toBe('ip_hash');
      expect(key.key.startsWith('ip:')).toBe(true);
      expect(key.key).toBe(`ip:${hashIp('203.0.113.195')}`);
    });
  });

  describe('2. Operator Blocklist Workflow', () => {
    it('blockKey should store key in Redis with TTL and update blocklist gauge', async () => {
      await blockKey('wallet:0xAbuser', 600, 'spamming_tx');

      expect(mockRedisData.get(`${BLOCK_PREFIX}:wallet:0xAbuser`)).toBe('spamming_tx');
      expect(mockRedisTtl.get(`${BLOCK_PREFIX}:wallet:0xAbuser`)).toBe(600);
      expect(mockSet).toHaveBeenCalledWith(1);
    });

    it('unblockKey should remove key from Redis and refresh gauge', async () => {
      await blockKey('wallet:0xAbuser', 600, 'spamming_tx');
      expect(mockRedisData.has(`${BLOCK_PREFIX}:wallet:0xAbuser`)).toBe(true);

      await unblockKey('wallet:0xAbuser');
      expect(mockRedisData.has(`${BLOCK_PREFIX}:wallet:0xAbuser`)).toBe(false);
      expect(mockSet).toHaveBeenCalledWith(0);
    });

    it('isBlocked should return true and remaining TTL when key is active', async () => {
      mockRedisData.set(`${BLOCK_PREFIX}:wallet:0xBad`, 'malicious');
      mockRedisTtl.set(`${BLOCK_PREFIX}:wallet:0xBad`, 420);

      const res = await isBlocked('wallet:0xBad');
      expect(res.blocked).toBe(true);
      expect(res.ttlSeconds).toBe(420);
    });

    it('isBlocked should return false when key does not exist', async () => {
      const res = await isBlocked('wallet:0xClean');
      expect(res.blocked).toBe(false);
      expect(res.ttlSeconds).toBe(0);
    });

    it('listBlocklist should enumerate all active blocked entries', async () => {
      mockRedisData.set(`${BLOCK_PREFIX}:wallet:0x1`, 'bot_activity');
      mockRedisTtl.set(`${BLOCK_PREFIX}:wallet:0x1`, 300);
      mockRedisData.set(`${BLOCK_PREFIX}:ip:abcdef1234567890`, 'ddos');
      mockRedisTtl.set(`${BLOCK_PREFIX}:ip:abcdef1234567890`, 150);

      const list = await listBlocklist();
      expect(list).toHaveLength(2);
      expect(list).toEqual(
        expect.arrayContaining([
          { key: 'wallet:0x1', reason: 'bot_activity', ttlSeconds: 300 },
          { key: 'ip:abcdef1234567890', reason: 'ddos', ttlSeconds: 150 },
        ]),
      );
    });
  });

  describe('3. Abuse Detection Middleware', () => {
    const createMockReqRes = (headers = {}, query = {}, ip = '127.0.0.1') => {
      const req = { headers, query, ip } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        setHeader: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;
      return { req, res, next };
    };

    it('should call next() when request is within family quota', async () => {
      const mw = abuseDetection('search');
      const { req, res, next } = createMockReqRes({ 'x-wallet-address': '0xGoodUser' });

      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 429 when client is blocklisted', async () => {
      mockRedisData.set(`${BLOCK_PREFIX}:wallet:0xBlocked`, 'banned');
      mockRedisTtl.set(`${BLOCK_PREFIX}:wallet:0xBlocked`, 180);

      const mw = abuseDetection('search');
      const { req, res, next } = createMockReqRes({ 'x-wallet-address': '0xBlocked' });

      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '180');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'RATE_LIMIT_EXCEEDED',
            class: 'CLIENT_ERROR',
          }),
        }),
      );
    });

    it('should return 429 when route family quota is exceeded', async () => {
      const mw = abuseDetection('sse'); // sse budget max is 30
      const key = 'wallet:0xHeavyCaller';
      const redisKey = `${QUOTA_PREFIX}:sse:${key}`;
      mockRedisData.set(redisKey, '31'); // exceed budget
      mockRedisTtl.set(redisKey, 45);

      const { req, res, next } = createMockReqRes({ 'x-wallet-address': '0xHeavyCaller' });
      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '45');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'RATE_LIMIT_EXCEEDED',
            message: expect.stringContaining('Too many sse requests'),
          }),
        }),
      );
    });

    it('should fail-open and call next() when Redis is unavailable', async () => {
      mockRedisReady = false; // Redis outage simulation

      const mw = abuseDetection('search');
      const { req, res, next } = createMockReqRes({ 'x-wallet-address': '0xAnyUser' });

      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
