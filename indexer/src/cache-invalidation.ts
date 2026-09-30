/**
 * Cache key registry and event-driven invalidation.
 *
 * Each domain mutation emits a `CacheInvalidationEvent`; the central
 * `applyInvalidation` function maps it to the affected key patterns and
 * removes them from Redis.  Cache failures are non-fatal and always fall
 * back to database reads.
 *
 * # Coverage policy (Issue #443)
 *
 * Every state-mutating event the poller ingests MUST call one of the
 * domain helpers below so downstream reads never serve stale data. The
 * helpers are intentionally over-inclusive — invalidating a superset of
 * affected keys is safe; under-invalidation is not.
 *
 * Event → invalidation mapping:
 *   LISTING_CREATED / LISTING_UPDATED / LISTING_PRICE_UPDATED
 *     → invalidateListingRelated(listingId, artist, collection)
 *   ARTWORK_SOLD / LISTING_CANCELLED / LISTING_EXPIRED
 *     → invalidateListingRelated + invalidateStats() + invalidateWalletActivity(buyer/artist)
 *   AUCTION_CREATED / BID_PLACED / AUCTION_EXTENDED
 *     → invalidateAuctionRelated(auctionId, creator, collection)
 *   AUCTION_RESOLVED / AUCTION_CANCELLED
 *     → invalidateAuctionRelated + invalidateStats() + invalidateWalletActivity(winner/creator)
 *   OFFER_MADE / OFFER_WITHDRAWN / OFFER_REJECTED / OFFER_RECLAIMED
 *     → invalidateOffer(offerId) + invalidateListing(listingId)
 *   OFFER_ACCEPTED
 *     → invalidateOffer + invalidateListingRelated + invalidateStats()
 *   TOKEN_WHITELISTED / TOKEN_REMOVED
 *     → invalidateConfig()
 *   COLLECTION_FEE_SET / COLLECTION_FEE_CLEARED
 *     → invalidateCollection(address) + invalidateConfig()
 *   ROYALTY_SETTLEMENT / ROYALTY_PAID
 *     → invalidateWalletActivity(recipient) (called per recipient)
 */

import redis, { invalidateKey, invalidatePattern } from './redis.js';
import { logger } from './logger.js';
import {
  cacheInvalidationsTotal,
  cacheInvalidationFailuresTotal,
} from './metrics.js';

// ── Key registry ──────────────────────────────────────────────────────────────
// Keep this in one place so every producer and consumer agrees on key shape.

export type ResourceKind =
  | 'listing'
  | 'auction'
  | 'offer'
  | 'collection'
  | 'activity'
  | 'stats'
  | 'config'
  | 'token';

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
    // Always also invalidate the collection list page so newly-deployed
    // collections appear and fee changes are reflected.
    patterns.push('cache:/collections*');
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
      logger.warn('cache.invalidation_failed', { pattern, err });
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
  await applyInvalidation({
    kind: 'collection',
    id: contractAddress,
    collection: contractAddress,
  });
}

export async function invalidateWalletActivity(wallet: string): Promise<void> {
  await applyInvalidation({ kind: 'activity', wallet });
}

export async function invalidateStats(): Promise<void> {
  await applyInvalidation({
    kind: 'stats',
    extraPatterns: ['cache:/stats*', 'cache:stats*'],
  });
}

export async function invalidateConfig(): Promise<void> {
  await applyInvalidation({
    kind: 'config',
    extraPatterns: ['cache:config:*', 'cache:/config/*'],
  });
}

/**
 * Invalidate ALL activity cache keys.
 * Used after a reorg or mass confirmation promotion where the affected wallet
 * set is unknown.  Over-invalidation is safe; under-invalidation is not.
 */
export async function invalidateAllActivity(): Promise<void> {
  await applyInvalidation({
    kind: 'activity',
    extraPatterns: ['cache:/activity*', 'cache:/wallets/*/activity*'],
  });
}

// ── Composite helpers (Issue #443) ────────────────────────────────────────────
//
// These helpers invalidate all keys that are logically affected by a single
// domain event — listing mutation, auction mutation, etc. — so call sites in
// the poller/parser can use a single function call instead of threading
// individual IDs through multiple helpers.

/**
 * Invalidate all cache entries related to a listing mutation.
 *
 * @param listingId  - numeric listing ID (as string)
 * @param artist     - artist wallet address (optional; invalidates wallet activity)
 * @param collection - collection contract address (optional; invalidates collection pages)
 * @param buyer      - buyer wallet address for sold events (optional)
 */
export async function invalidateListingRelated(
  listingId: string,
  artist?: string,
  collection?: string,
  buyer?: string,
): Promise<void> {
  const tasks: Promise<void>[] = [
    applyInvalidation({
      kind: 'listing',
      id: listingId,
      wallet: artist,
      collection,
      // Also clear the listings list pages so updates appear immediately.
      extraPatterns: ['cache:/listings*'],
    }),
  ];
  if (buyer) tasks.push(invalidateWalletActivity(buyer));
  await Promise.all(tasks);
}

/**
 * Invalidate all cache entries related to an auction mutation.
 *
 * @param auctionId  - numeric auction ID (as string)
 * @param creator    - creator wallet address (optional)
 * @param collection - collection contract address (optional)
 * @param winner     - winner wallet address for finalized events (optional)
 */
export async function invalidateAuctionRelated(
  auctionId: string,
  creator?: string,
  collection?: string,
  winner?: string,
): Promise<void> {
  const tasks: Promise<void>[] = [
    applyInvalidation({
      kind: 'auction',
      id: auctionId,
      wallet: creator,
      collection,
      extraPatterns: ['cache:/auctions*'],
    }),
  ];
  if (winner) tasks.push(invalidateWalletActivity(winner));
  await Promise.all(tasks);
}

/**
 * Invalidate offer + the parent listing.
 * Called on any offer state transition (made, accepted, rejected, withdrawn, reclaimed).
 */
export async function invalidateOfferRelated(
  offerId: string,
  listingId: string,
  offerer?: string,
): Promise<void> {
  await Promise.all([
    applyInvalidation({
      kind: 'offer',
      id: offerId,
      wallet: offerer,
      extraPatterns: ['cache:/offers*'],
    }),
    // The listing's pending-offer count changed — clear its cached page too.
    applyInvalidation({ kind: 'listing', id: listingId }),
  ]);
}

