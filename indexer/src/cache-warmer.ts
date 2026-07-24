/**
 * cache-warmer.ts — Pre-populates the most common cache keys on indexer startup.
 *
 * Warms:
 *   - First page of listings  (active, newest first)
 *   - First page of auctions  (active, newest first)
 *
 * This ensures cold-start traffic hits cache rather than the database.
 */

import redis from './redis.js';
import prisma from './db.js';
import { logger } from './logger.js';

const WARM_PAGE_SIZE = 20;

// TTL constants (seconds) — must match the per-endpoint values in routes.ts
export const TTL = {
  LISTING_DETAIL:  60,   // GET /listings/:id
  LISTINGS_LIST:   10,   // GET /listings
  AUCTION_DETAIL:  5,    // GET /auctions/:id
  AUCTIONS_LIST:   10,   // GET /auctions
  METRICS:         15,   // GET /metrics (app-level)
  ACTIVITY_RECENT: 30,   // GET /activity/recent
  COLLECTIONS:     60,   // GET /collections
};

function isRedisReady(client: any): boolean {
  if (typeof client.isReady === 'boolean') return client.isReady;
  if (typeof client.status === 'string') return client.status === 'ready';
  return Boolean(client.isOpen);
}

const serialize = (obj: any) =>
  JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function setCache(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    const client = redis as any;
    await client.setEx(key, ttl, JSON.stringify(value));
  } catch (err) {
    // Non-fatal — cache warming is best-effort
    logger.warn('[cache-warmer] Failed to set cache key', {
      key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Warm the first page of active listings.
 * Cache key mirrors what cacheMiddleware produces for GET /listings?status=Active&limit=20&offset=0
 */
async function warmListings(): Promise<void> {
  try {
    const listings = await prisma.listing.findMany({
      where: { status: 'Active' },
      orderBy: { updatedAtLedger: 'desc' },
      take: WARM_PAGE_SIZE,
    });
    const total = await prisma.listing.count({ where: { status: 'Active' } });
    const payload = { listings: serialize(listings), total };

    // Warm the paginated form (what the frontend hits most)
    await setCache(
      'cache:/listings?status=Active&limit=20&offset=0',
      payload,
      TTL.LISTINGS_LIST,
    );
    // Also warm the unfiltered first page
    const all = await prisma.listing.findMany({
      orderBy: { updatedAtLedger: 'desc' },
      take: WARM_PAGE_SIZE,
    });
    const allTotal = await prisma.listing.count();
    await setCache(
      'cache:/listings?limit=20&offset=0',
      { listings: serialize(all), total: allTotal },
      TTL.LISTINGS_LIST,
    );

    logger.info('[cache-warmer] listings warmed', { count: listings.length });
  } catch (err) {
    logger.warn('[cache-warmer] Failed to warm listings', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Warm the first page of active auctions.
 */
async function warmAuctions(): Promise<void> {
  try {
    const auctions = await prisma.auction.findMany({
      where: { status: 'Active' },
      orderBy: { updatedAtLedger: 'desc' },
      take: WARM_PAGE_SIZE,
    });

    await setCache(
      'cache:/auctions?status=Active&limit=20&offset=0',
      serialize(auctions),
      TTL.AUCTIONS_LIST,
    );
    const all = await prisma.auction.findMany({
      orderBy: { updatedAtLedger: 'desc' },
      take: WARM_PAGE_SIZE,
    });
    await setCache('cache:/auctions?limit=20&offset=0', serialize(all), TTL.AUCTIONS_LIST);

    logger.info('[cache-warmer] auctions warmed', { count: auctions.length });
  } catch (err) {
    logger.warn('[cache-warmer] Failed to warm auctions', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Warm recent activity feed.
 */
async function warmRecentActivity(): Promise<void> {
  try {
    const events = await prisma.marketplaceEvent.findMany({
      take: 20,
      orderBy: { ledgerSequence: 'desc' },
    });
    await setCache('cache:/activity/recent', serialize(events), TTL.ACTIVITY_RECENT);
    logger.info('[cache-warmer] recent activity warmed', { count: events.length });
  } catch (err) {
    logger.warn('[cache-warmer] Failed to warm recent activity', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Entry point — call from index.ts after the server starts.
 * Skips warming when Redis is not yet connected.
 */
export async function warmCache(): Promise<void> {
  const client = redis as any;
  if (!isRedisReady(client)) {
    logger.info('[cache-warmer] Redis not ready — skipping cache warm');
    return;
  }

  logger.info('[cache-warmer] Starting cache warm...');
  await Promise.all([warmListings(), warmAuctions(), warmRecentActivity()]);
  logger.info('[cache-warmer] Cache warm complete');
}
