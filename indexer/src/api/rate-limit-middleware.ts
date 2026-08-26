import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import {
  sseConnectionsTotal,
  sseActiveConnectionsGauge,
} from '../metrics.js';

// ── Resource cost classes ──────────────────────────────────────────────────────
//
// Each route is assigned a cost class that determines its token-bucket budget.
// Expensive endpoints (history, backfill, SSE) get tighter limits than simple
// reads (listings, collections).

export type ResourceCost = 'light' | 'medium' | 'heavy' | 'operational';

export const RESOURCE_LIMITS: Record<ResourceCost, { windowMs: number; max: number }> = {
  light:      { windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_LIGHT      || '200') },
  medium:     { windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_MEDIUM     || '100') },
  heavy:      { windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_HEAVY      || '20')  },
  operational:{ windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_OPERATIONAL || '10')  },
};

// ── Key extractors ─────────────────────────────────────────────────────────────
//
// Primary key: wallet address (when present in X-Wallet-Address header or ?wallet= query).
// Fallback key: IP address.
// This ensures one abusive wallet cannot evade limits by rotating IPs, and
// legitimate shared-network users retain their own per-wallet budget.

function getRateLimitKey(req: Request): string {
  const wallet = req.headers['x-wallet-address'];
  if (typeof wallet === 'string' && wallet.length > 0) {
    return `wallet:${wallet}`;
  }
  const queryWallet = req.query.wallet;
  if (typeof queryWallet === 'string' && queryWallet.length > 0) {
    return `wallet:${queryWallet}`;
  }
  // Use ipKeyGenerator for correct IPv6 normalisation
  return `ip:${ipKeyGenerator(req)}`;
}

// ── Shared rate-limit options factory ─────────────────────────────────────────

function baseOptions(cost: ResourceCost, message?: string) {
  const limits = RESOURCE_LIMITS[cost];
  return {
    windowMs: limits.windowMs,
    max: limits.max,
    keyGenerator: getRateLimitKey,
    standardHeaders: 'draft-6' as const,
    legacyHeaders: false,
    message: {
      error: message || 'Rate limit exceeded',
      retryAfter: '1 minute',
      limit: limits.max,
      windowMs: limits.windowMs,
    },
    skip: (req: Request) => req.path === '/health' || req.path === '/readyz',
  };
}

// ── Limiters ───────────────────────────────────────────────────────────────────

export const lightRateLimiter = rateLimit(baseOptions('light',     'Too many requests, please slow down.'));
export const mediumRateLimiter = rateLimit(baseOptions('medium',    'Too many requests to this endpoint, please try again later.'));
export const heavyRateLimiter = rateLimit(baseOptions('heavy',     'Heavy endpoint rate limit exceeded, please retry later.'));
export const operationalRateLimiter = rateLimit(baseOptions('operational', 'Operator endpoint rate limit exceeded.'));

// Global baseline limiter — applies to all public endpoints
const GLOBAL_LIMIT = parseInt(process.env.RATE_LIMIT_GLOBAL || '500');
export const globalRateLimiter = rateLimit({
  windowMs: 60_000,
  max: GLOBAL_LIMIT,
  keyGenerator: getRateLimitKey,
  standardHeaders: 'draft-6' as const,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: '1 minute',
    limit: GLOBAL_LIMIT,
    windowMs: 60_000,
  },
  skip: (req) => req.path === '/health' || req.path === '/readyz',
});

// Legacy aliases for routes that already import these names
export const rateLimiter = mediumRateLimiter;
export const strictRateLimiter = heavyRateLimiter;

// ── SSE concurrency guard ──────────────────────────────────────────────────────
//
// Tracks active SSE connections per key (wallet or IP) and rejects new
// connections when the per-key concurrency limit is reached. Operates
// independently of the token-bucket rate limiter — this is a hard cap on
// simultaneous long-lived connections, not a request rate.
//
// The guard emits SSE connection metrics so Grafana dashboards track
// per-key usage alongside the global active connection count.

const SSE_CONCURRENT_PER_KEY = parseInt(process.env.SSE_CONCURRENT_PER_KEY || '5');
const sseConnectionCounts = new Map<string, number>();

export function sseConcurrencyGuard(req: Request, res: Response, next: NextFunction): void {
  const key = getRateLimitKey(req);
  const current = sseConnectionCounts.get(key) ?? 0;

  if (current >= SSE_CONCURRENT_PER_KEY) {
    res.setHeader('Retry-After', '30');
    res.status(503).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `SSE connection limit reached (${SSE_CONCURRENT_PER_KEY} concurrent per key). Retry later.`,
        class: 'CLIENT_ERROR',
        details: { limit: SSE_CONCURRENT_PER_KEY, key },
      },
    });
    return;
  }

  sseConnectionCounts.set(key, current + 1);
  sseConnectionsTotal.inc();

  res.on('close', () => {
    const updated = (sseConnectionCounts.get(key) ?? 1) - 1;
    if (updated <= 0) {
      sseConnectionCounts.delete(key);
    } else {
      sseConnectionCounts.set(key, updated);
    }
  });

  next();
}

// Exposed for testing — lets tests reset per-key counters between runs.
export function _resetSseConcurrencyState(): void {
  sseConnectionCounts.clear();
}

export { sseConnectionsTotal, sseActiveConnectionsGauge };

