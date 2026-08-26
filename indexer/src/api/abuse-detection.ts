import { createHash } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import redis from '../redis.js';
import { logger } from '../logger.js';
import {
  abuseQuotaExceededTotal,
  abuseAnomalyDetectedTotal,
  abuseBlockedRequestsTotal,
  abuseBlocklistActiveGauge,
  abuseDetectionRedisFailureTotal,
} from '../metrics.js';

// ── Abuse / anomaly detection (Issue #539) ───────────────────────────────────
//
// The token-bucket rate limiter in ./rate-limit-middleware.ts protects a
// single client from hammering a single endpoint. It does not, by itself,
// stop a *distributed* client — many IPs, or many freshly-generated wallet
// addresses — from concentrating load on a small set of expensive route
// families (search, SSE, wallet activity, transaction lookup). This module
// adds a second, coarser layer on top: a rolling per-key-per-family request
// budget, a temporary operator-controlled blocklist, and Prometheus signals
// that make abuse patterns visible without persisting anything that would
// let an operator (or a metrics scrape) reconstruct a user's browsing
// history from labels alone.
//
// Privacy stance:
//   - A wallet address is a PUBLIC blockchain identifier. Anyone can look up
//     a wallet's on-chain activity already, so it is safe to use directly as
//     a tracking key. It is NOT proof of who is behind it — one person can
//     hold many wallets, and a wallet can be shared/rotated. Treat wallet
//     keys as "this on-chain identity", never as "this person".
//   - An IP address is not published in the same way and can identify a
//     household or device. IPs are never stored or logged in raw form here:
//     they are hashed (sha256, truncated) before use as a Redis key or a
//     metric label, and the hash is short-lived (expires with the rolling
//     window / blocklist TTL — nothing persists indefinitely).
//   - Metric labels only ever carry the *kind* of key ('wallet' | 'ip_hash'),
//     never the key value itself, so Prometheus/Grafana never accumulate a
//     per-identity request log.

export type RouteFamily = 'search' | 'sse' | 'wallet-activity' | 'tx-lookup';
export type AbuseKeyType = 'wallet' | 'ip_hash';

// ── Configuration ─────────────────────────────────────────────────────────────

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() !== 'false' && raw !== '0';
}

function envInt(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const ABUSE_DETECTION_ENABLED = envBool('ABUSE_DETECTION_ENABLED', true);
export const ABUSE_BLOCK_DURATION_SECONDS = envInt('ABUSE_BLOCK_DURATION_SECONDS', 900); // 15 min default

interface FamilyBudget {
  windowSeconds: number;
  max: number;
}

// Per-route-family rolling budgets, keyed by wallet or hashed-IP. These are
// intentionally coarser than the per-endpoint rate limiter — they exist to
// catch distributed abuse across many IPs/wallets hitting the *same*
// expensive family, not to replace the existing per-endpoint limits.
export const FAMILY_BUDGETS: Record<RouteFamily, FamilyBudget> = {
  search:            { windowSeconds: 60, max: envInt('ABUSE_QUOTA_SEARCH', 60) },
  sse:               { windowSeconds: 60, max: envInt('ABUSE_QUOTA_SSE', 30) },
  'wallet-activity': { windowSeconds: 60, max: envInt('ABUSE_QUOTA_WALLET_ACTIVITY', 40) },
  'tx-lookup':       { windowSeconds: 60, max: envInt('ABUSE_QUOTA_TX_LOOKUP', 40) },
};

// ── Redis key namespace ───────────────────────────────────────────────────────

const QUOTA_PREFIX = 'abuse:quota';
const BLOCK_PREFIX = 'abuse:block';

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Hash an IP address before it is ever used as a Redis key or metric label.
 * Truncated to 16 hex chars (64 bits) — plenty of collision resistance for
 * abuse-tracking purposes while keeping keys short. Not reversible in
 * practice, and not intended as a cryptographic identity — just a way to
 * avoid persisting raw IPs anywhere.
 */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export interface AbuseKey {
  keyType: AbuseKeyType;
  /** Stable identifier used for the Redis quota/blocklist key. Never a raw IP. */
  key: string;
}

/**
 * Mirrors the key precedence used by rate-limit-middleware.ts: wallet header
 * / query param first (this is a self-declared on-chain identity, not proof
 * of the caller), falling back to a hashed client IP.
 */
export function getAbuseKey(req: Request): AbuseKey {
  const wallet = req.headers['x-wallet-address'];
  if (typeof wallet === 'string' && wallet.length > 0) {
    return { keyType: 'wallet', key: `wallet:${wallet}` };
  }
  const queryWallet = req.query.wallet;
  if (typeof queryWallet === 'string' && queryWallet.length > 0) {
    return { keyType: 'wallet', key: `wallet:${queryWallet}` };
  }
  // ipKeyGenerator normalizes IPv6 and respects Express's trust-proxy
  // handling of X-Forwarded-For, matching the rate limiter's behavior.
  const ip = ipKeyGenerator(req);
  return { keyType: 'ip_hash', key: `ip:${hashIp(ip)}` };
}

// ── Redis readiness (matches the pattern used elsewhere: redis.ts, cache-middleware.ts) ──

function isRedisReady(client: any): boolean {
  if (typeof client?.isReady === 'boolean') return client.isReady;
  if (typeof client?.status === 'string') return client.status === 'ready';
  return Boolean(client?.isOpen);
}

function failOpen(operation: string, err: unknown): void {
  abuseDetectionRedisFailureTotal.labels(operation).inc();
  logger.warn('abuse_detection.redis_unavailable', {
    event: 'abuse_detection.redis_unavailable',
    operation,
    error: err instanceof Error ? err.message : String(err),
  });
}

// ── Blocklist (operator workflow) ─────────────────────────────────────────────

export interface BlockEntry {
  key: string;
  reason: string;
  ttlSeconds: number;
}

/**
 * Add a key to the temporary blocklist. Fails open (throws are swallowed by
 * the caller in the admin route, which reports a 5xx) — an admin action is
 * expected to be attended, unlike the passive per-request check.
 */
export async function blockKey(
  key: string,
  durationSeconds: number = ABUSE_BLOCK_DURATION_SECONDS,
  reason = 'operator_block',
): Promise<void> {
  const client = redis as any;
  if (!isRedisReady(client)) {
    throw new Error('Redis unavailable — cannot add blocklist entry');
  }
  await client.set(`${BLOCK_PREFIX}:${key}`, reason, { EX: durationSeconds });
  await refreshBlocklistGauge();
}

export async function unblockKey(key: string): Promise<void> {
  const client = redis as any;
  if (!isRedisReady(client)) {
    throw new Error('Redis unavailable — cannot remove blocklist entry');
  }
  await client.del(`${BLOCK_PREFIX}:${key}`);
  await refreshBlocklistGauge();
}

/**
 * Checks the blocklist. Fails open — if Redis is unreachable, the request is
 * allowed through rather than blocked, and a metric/log line records the
 * degraded state so operators can investigate.
 */
export async function isBlocked(key: string): Promise<{ blocked: boolean; ttlSeconds: number }> {
  const client = redis as any;
  if (!isRedisReady(client)) {
    failOpen('is_blocked', new Error('redis not ready'));
    return { blocked: false, ttlSeconds: 0 };
  }
  try {
    const ttl = await client.ttl(`${BLOCK_PREFIX}:${key}`);
    // node-redis returns -2 if the key doesn't exist, -1 if it exists with no TTL.
    if (typeof ttl === 'number' && ttl > 0) {
      return { blocked: true, ttlSeconds: ttl };
    }
    return { blocked: false, ttlSeconds: 0 };
  } catch (err) {
    failOpen('is_blocked', err);
    return { blocked: false, ttlSeconds: 0 };
  }
}

export async function listBlocklist(): Promise<BlockEntry[]> {
  const client = redis as any;
  if (!isRedisReady(client)) {
    failOpen('list_blocklist', new Error('redis not ready'));
    return [];
  }
  try {
    const keys: string[] = await client.keys(`${BLOCK_PREFIX}:*`);
    const entries = await Promise.all(
      keys.map(async (fullKey) => {
        const [reason, ttlSeconds] = await Promise.all([
          client.get(fullKey),
          client.ttl(fullKey),
        ]);
        return {
          key: fullKey.slice(BLOCK_PREFIX.length + 1),
          reason: reason ?? 'unknown',
          ttlSeconds: typeof ttlSeconds === 'number' && ttlSeconds > 0 ? ttlSeconds : 0,
        };
      }),
    );
    return entries;
  } catch (err) {
    failOpen('list_blocklist', err);
    return [];
  }
}

async function refreshBlocklistGauge(): Promise<void> {
  try {
    const client = redis as any;
    if (!isRedisReady(client)) return;
    const keys: string[] = await client.keys(`${BLOCK_PREFIX}:*`);
    abuseBlocklistActiveGauge.set(keys.length);
  } catch {
    // Best-effort — the gauge simply won't update this cycle.
  }
}

// ── Route-family quota tracking ───────────────────────────────────────────────

/**
 * Increments the rolling counter for (family, key) and returns the current
 * count plus remaining TTL on the window. Uses INCR + EXPIRE (set only on
 * the first increment of a window) rather than a sorted set — cheap, O(1),
 * and precise enough for abuse *signal*, which doesn't need exact sliding-
 * window accuracy the way billing would.
 */
async function incrementQuota(
  family: RouteFamily,
  key: string,
  windowSeconds: number,
): Promise<{ count: number; ttlSeconds: number }> {
  const client = redis as any;
  const redisKey = `${QUOTA_PREFIX}:${family}:${key}`;
  const count = await client.incr(redisKey);
  if (count === 1) {
    await client.expire(redisKey, windowSeconds);
    return { count, ttlSeconds: windowSeconds };
  }
  const ttl = await client.ttl(redisKey);
  return { count, ttlSeconds: typeof ttl === 'number' && ttl > 0 ? ttl : windowSeconds };
}

// ── Middleware ─────────────────────────────────────────────────────────────────

function sendTooManyRequests(res: Response, retryAfterSeconds: number, message: string): void {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.status(429).json({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message,
      class: 'CLIENT_ERROR',
      details: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) },
    },
  });
}

/**
 * Abuse-detection middleware for a given route family. Applied ALONGSIDE the
 * existing resource-cost rate limiters (light/medium/heavy/operational), not
 * instead of them — this layer catches distributed patterns across many
 * keys/IPs hitting the same expensive family, and enforces the operator
 * blocklist.
 *
 * Fail-open: any Redis error is treated as "cannot evaluate abuse signal
 * right now" and the request proceeds, so a Redis outage never turns into a
 * blanket 500/429 for legitimate traffic. Failures are counted and logged.
 */
export function abuseDetection(family: RouteFamily) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!ABUSE_DETECTION_ENABLED) {
      return next();
    }

    const { keyType, key } = getAbuseKey(req);

    const client = redis as any;
    if (!isRedisReady(client)) {
      failOpen('quota_check', new Error('redis not ready'));
      return next();
    }

    try {
      const block = await isBlocked(key);
      if (block.blocked) {
        abuseBlockedRequestsTotal.labels(family, keyType).inc();
        abuseAnomalyDetectedTotal.labels(family, keyType, 'blocklisted').inc();
        sendTooManyRequests(
          res,
          block.ttlSeconds,
          'This client is temporarily blocked due to abusive request patterns. Please try again later.',
        );
        return;
      }

      const budget = FAMILY_BUDGETS[family];
      const { count, ttlSeconds } = await incrementQuota(family, key, budget.windowSeconds);

      if (count > budget.max) {
        abuseQuotaExceededTotal.labels(family, keyType).inc();
        abuseAnomalyDetectedTotal.labels(family, keyType, 'quota_exceeded').inc();
        sendTooManyRequests(
          res,
          ttlSeconds,
          `Too many ${family} requests from this client. Please slow down and retry after the window resets.`,
        );
        return;
      }

      next();
    } catch (err) {
      failOpen('quota_check', err);
      next();
    }
  };
}

// Exposed for tests.
export { QUOTA_PREFIX, BLOCK_PREFIX };
