/**
 * Cache key registry and event-driven invalidation.
 *
 * Each domain mutation emits an `CacheInvalidationEvent`; the central
 * `applyInvalidation` function maps it to the affected key patterns and
 * removes them from Redis.  Cache failures are non-fatal and always fall
 * back to database reads.
 */

import redis, { invalidateKey, invalidatePattern } from '../redis.js';
import { logger } from '../logger.js';
import {
  cacheInvalidationsTotal,
  cacheInvalidationFailuresTotal,
} from '../metrics.js';

// ── Key registry ──────────────────────────────────────────────────────────────
// Keep this in one place so every producer and consumer agrees on key shape.

export type ResourceKind = 'listing' | 'auction' | 'offer' | 'collection' | 'activity' | 'stats';

export type InvalidationScope = {
  kind: ResourceKind;
  id?: string;
  wallet?: string;
  collection?: string;
};

export function buildCacheKey(scope: InvalidationScope): string {
  const parts: string[] = ['cache'];
  if (scope.kind) parts.push(scope.kind);
  if (scope.id) parts.push(scope.id);
  if (scope.wallet) parts.push(`wallet:${scope.wallet}`);
  if (scope.collection) parts.push(`collection:${scope.collection}`);
  return parts.join(':');
}

export function buildCachePattern(scope: InvalidationScope): string {
  const parts: string[] = ['cache', scope.kind];
  if (scope.id) parts.push(`${scope.id}*`);
  else parts.push('*');
  return parts.join(':');
}

// ── Event model ───────────────────────────────────────────────────────────────

export type CacheInvalidationEvent = {
  kind: ResourceKind;
  id?: string;
  wallet?: string;
  collection?: string;
  /** Extra glob patterns beyond the standard registry rules. */
  extraPatterns?: string[];
};

// ── Apply invalidation ────────────────────────────────────────────────────────

export async function applyInvalidation(evt: CacheInvalidationEvent): Promise<void> {
  const patterns: string[] = [];

  if (evt.id) {
    patterns.push(buildCacheKey({ ...evt, id: evt.id }));
  }
  patterns.push(buildCachePattern({ kind: evt.kind, id: evt.id }));
  if (evt.wallet) {
    patterns.push(buildCachePattern({ kind: 'activity', wallet: evt.wallet }));
  }
  if (evt.collection) {
    patterns.push(buildCachePattern({ kind: 'collection', collection: evt.collection }));
  }
  if (evt.extraPatterns) {
    patterns.push(...evt.extraPatterns);
  }

  cacheInvalidationsTotal.inc({ resource: evt.kind });

  for (const pattern of patterns) {
    try {
      await invalidatePattern(pattern);
    } catch (err) {
      cacheInvalidationFailuresTotal.inc({ resource: evt.kind });
      logger.warn('cache: invalidation failed', { pattern, err });
    }
  }
}

// ── Domain-specific helpers ───────────────────────────────────────────────────

export async function invalidateListing(listingId: string, wallet?: string): Promise<void> {
  await applyInvalidation({ kind: 'listing', id: listingId, wallet });
}

export async function invalidateAuction(auctionId: string, wallet?: string): Promise<void> {
  await applyInvalidation({ kind: 'auction', id: auctionId, wallet });
}

export async function invalidateOffer(offerId: string, wallet?: string): Promise<void> {
  await applyInvalidation({ kind: 'offer', id: offerId, wallet });
}

export async function invalidateCollection(contractAddress: string): Promise<void> {
  await applyInvalidation({ kind: 'collection', id: contractAddress, collection: contractAddress });
}

export async function invalidateWalletActivity(wallet: string): Promise<void> {
  await applyInvalidation({ kind: 'activity', wallet });
}

export async function invalidateStats(): Promise<void> {
  await applyInvalidation({ kind: 'stats' });
}
