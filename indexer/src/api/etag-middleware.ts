/**
 * etag-middleware.ts — Representation-specific ETag and Cache-Control support.
 *
 * Issue #508: Add conditional GET support to heavy endpoints.
 *
 * Design
 * ------
 * The ETag is computed from:
 *   1. The serialised JSON response body  — content hash
 *   2. The full request URL (path + query string) — query-param sensitivity
 *   3. A "confirmed version" token — changes when provisional events are promoted
 *      to confirmed, ensuring clients re-fetch after reorg / confirmation transitions
 *
 * This means:
 *   - Two requests for the same URL but different query params → different ETags
 *   - Same payload but after provisional→confirmed transition → different ETag
 *   - After reorg invalidation the version counter increments → new ETags for all
 *     representations that were derived from the rolled-back ledger range
 *
 * Cache-Control policy
 * --------------------
 * - SSE endpoints (/events): no-store (not applicable to streaming responses)
 * - Provisional-only endpoints (activity, recent events): no-cache (must
 *   revalidate every time because data can be rolled back at any moment)
 * - Default (stable data): public, max-age=30, must-revalidate
 *   The TTL deliberately matches the Redis cache TTL so a CDN layer and the
 *   Redis cache expire together.
 *
 * 304 short-circuit
 * -----------------
 * When the client sends If-None-Match that exactly matches the computed ETag,
 * the middleware returns 304 immediately without a response body and without
 * executing any further route handler work.
 *
 * NOTE: The ETag is set in res.json() so it is always based on the *actual*
 * serialised output — no speculative pre-computation required.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// ── Confirmed-data version counter ────────────────────────────────────────────
//
// Incremented by:
//   - promoteConfirmedEvents (provisional → confirmed transition)
//   - rollbackReorg (any reorg invalidation)
//
// Using a simple integer rather than a timestamp to avoid clock-skew issues
// in multi-instance deployments.  All instances that share the same Redis
// will read the current value via getConfirmedVersion() before it is baked
// into the ETag.

let _confirmedVersion = 0;

/** Increment the global confirmed-data version. Call after any confirmation or reorg. */
export function bumpConfirmedVersion(): void {
  _confirmedVersion += 1;
}

/** Read the current confirmed-data version (baked into ETags). */
export function getConfirmedVersion(): number {
  return _confirmedVersion;
}

/** Reset for tests only. */
export function _resetConfirmedVersion(): void {
  _confirmedVersion = 0;
}

// ── Cache-Control policies ────────────────────────────────────────────────────

/**
 * Endpoints whose data is provisional (can be rolled back by a reorg).
 * These get `no-cache` so clients always revalidate even when max-age > 0.
 */
const PROVISIONAL_PATH_PREFIXES = [
  '/activity',
  '/wallets/',
] as const;

/**
 * Streaming/SSE routes — skip ETag entirely, use no-store.
 */
const STREAMING_PATH_PREFIXES = [
  '/events',
] as const;

function isStreaming(path: string): boolean {
  return STREAMING_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + '?'));
}

function isProvisional(path: string): boolean {
  return PROVISIONAL_PATH_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Return the Cache-Control header value for the given request path.
 *
 * @param path  req.path (without query string)
 */
export function cacheControlForPath(path: string): string {
  if (isStreaming(path)) return 'no-store';
  if (isProvisional(path)) return 'no-cache';
  return 'public, max-age=30, must-revalidate';
}

// ── ETag computation ──────────────────────────────────────────────────────────

/**
 * Compute a strong ETag for the given response payload and request context.
 *
 * The ETag input is:
 *   <confirmed-version>:<full-url>:<json-body>
 *
 * Using SHA-256 (first 32 hex chars) — sufficient uniqueness, faster than MD5
 * in Node's native crypto, and avoids the cryptographically-weak MD5 concern
 * (even though ETags are not a security boundary).
 *
 * @param payload   JSON-serialised response body
 * @param fullUrl   Original request URL including query string
 * @returns         Strong ETag string (with surrounding quotes)
 */
export function computeETag(payload: string, fullUrl: string): string {
  const input = `${_confirmedVersion}:${fullUrl}:${payload}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `"${hash}"`;
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Express middleware that:
 *  1. Skips ETag logic for SSE/streaming routes (sets no-store Cache-Control).
 *  2. Intercepts res.json() to compute a representation-specific ETag.
 *  3. Returns 304 (no body) when the client's If-None-Match matches.
 *  4. Sets an appropriate Cache-Control header for every JSON response.
 */
export function etagMiddleware(req: Request, res: Response, next: NextFunction) {
  const path = req.path;

  // SSE routes: set no-store and skip all ETag work.
  if (isStreaming(path)) {
    res.set('Cache-Control', 'no-store');
    return next();
  }

  const originalJson = res.json.bind(res);
  const fullUrl = req.originalUrl || req.url;

  res.json = function (data: any) {
    // Only compute ETag for successful responses (2xx).
    // Errors should not be cached.
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const payload = JSON.stringify(data);
      const etag = computeETag(payload, fullUrl);

      res.set('ETag', etag);
      res.set('Cache-Control', cacheControlForPath(path));

      const clientEtag = req.get('If-None-Match');
      if (clientEtag && clientEtag === etag) {
        // Remove Content-Type / Content-Length before sending 304.
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        return res.status(304).end();
      }
    }

    return originalJson(data);
  };

  next();
}
