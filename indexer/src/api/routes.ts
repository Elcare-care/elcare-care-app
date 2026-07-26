import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../db.js';
import redis from '../redis.js';
import { Prisma } from '@prisma/client';
import { cacheMiddleware } from './cache-middleware.js';
import { etagMiddleware } from './etag-middleware.js';
import { strictRateLimiter } from './rate-limit-middleware.js';
import { badRequest, notFound, internalError } from './errors.js';
import { applyDecodedEvents } from '../poller.js';
import { collectMarketplaceEvents } from '../event-sync.js';
import {
  validateQuery,
  listingsQuerySchema,
  auctionsQuerySchema,
  offersQuerySchema,
  walletActivityQuerySchema,
  collectionsQuerySchema,
  creatorCollectionsQuerySchema,
  statsQuerySchema,
  syncGapsQuerySchema,
  artistMetricsQuerySchema,
  royaltyBreakdownQuerySchema,
} from './query-schemas.js';
import { isValidStellarAddress, STELLAR_ADDRESS_ERROR } from '../stellar-address.js';
import {
  getOverviewStats,
  getDailyStats,
  getTopCollections,
  getTopArtists,
} from '../stats.js';
import {
  sseConnectionsTotal,
  sseActiveConnectionsGauge,
  apiRequestDurationHistogram,
} from '../metrics.js';
import { TTL } from '../cache-warmer.js';

// ── SSE registry ───────────────────────────────────────────────────────────────

const SSE_BUFFER_SIZE = 200;
const MAX_SSE_CONNECTIONS = parseInt(process.env.MAX_SSE_CONNECTIONS || '500');

interface SSEEvent {
  id: number;
  data: string;
}

let sseEventCounter = 0;
const sseBuffer: SSEEvent[] = [];
const sseClients: Map<Response, number> = new Map();

function nextSseId(): number {
  return ++sseEventCounter;
}

// Exposed for testing only
export function _getSseBuffer() { return sseBuffer; }
export function _getSseEventCounter() { return sseEventCounter; }
export function _resetSseState() {
  sseEventCounter = 0;
  sseBuffer.length = 0;
  sseClients.clear();
}

/** Track SSE client metrics and run cleanup on disconnect. */
function setupSSEHeartbeat(res: Response): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { cleanupSSEClient(res); }
  }, 30_000);
}

function cleanupSSEClient(res: Response): void {
  sseClients.delete(res);
  sseActiveConnectionsGauge.set(sseClients.size);
}

// SSE clients registry — keyed by Response, value is last-seen event ID

export function emitSSEEvent(event: any) {
  const id = nextSseId();
  const dataStr = JSON.stringify(event, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  const payload: SSEEvent = { id, data: dataStr };

  sseBuffer.push(payload);
  if (sseBuffer.length > SSE_BUFFER_SIZE) sseBuffer.shift();

  const frame = `id: ${id}\ndata: ${dataStr}\n\n`;
  for (const [client] of sseClients) {
    try {
      client.write(frame);
      sseClients.set(client, id);
    } catch {
      cleanupSSEClient(client);
    }
  }
}

export function closeSSEClients(): void {
    for (const [client] of sseClients) {
        try { client.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    sseActiveConnectionsGauge.set(0);
}

// ── API request duration middleware ───────────────────────────────────────────
// Records per-route latency histogram with method / route / status_code labels.

export function apiDurationMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime();
  res.on('finish', () => {
    const [s, ns] = process.hrtime(start);
    const route = req.route ? (req.baseUrl || '') + req.route.path : req.path;
    apiRequestDurationHistogram
      .labels(req.method, route, String(res.statusCode))
      .observe(s + ns / 1e9);
  });
  next();
}

const router = Router();

router.use(etagMiddleware);
router.use(apiDurationMiddleware);

const CACHE_TTL_SECONDS = parseInt(process.env.REDIS_CACHE_TTL_SECONDS || '30');

async function getCached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch {
    // Redis unavailable — fall through to DB
  }
  const result = await fetcher();
  try {
    await (redis as any).setEx(key, ttl, JSON.stringify(result));
  } catch {
    // ignore cache write failures
  }
  return result;
}

const serialize = (obj: any) =>
  JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));

// ── GET /events (SSE) ─────────────────────────────────────────────────────────

router.get('/events', (req: Request, res: Response) => {
  // Check connection limit
  if (sseClients.size >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({ error: 'Too many SSE connections' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const lastEventId = req.headers['last-event-id'];
  const resumeFrom = lastEventId ? parseInt(String(lastEventId), 10) : null;

  sseClients.set(res, resumeFrom ?? sseEventCounter);
  sseConnectionsTotal.inc();
  sseActiveConnectionsGauge.set(sseClients.size);

  // Replay missed events
  if (resumeFrom !== null && !isNaN(resumeFrom)) {
    const missed = sseBuffer.filter(e => e.id > resumeFrom);
    for (const ev of missed) {
      try { res.write(`id: ${ev.id}\ndata: ${ev.data}\n\n`); } catch { break; }
    }
  }

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);

  const heartbeat = setupSSEHeartbeat(res);

  const cleanup = () => {
    clearInterval(heartbeat);
    cleanupSSEClient(res);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
});

// ── GET /listings ─────────────────────────────────────────────────────────────
//
// Full-text search strategy:
//   - search term < 3 chars  → ILIKE fallback on artist + collection fields
//   - search term >= 3 chars → ts_rank on searchVector (GIN index), results
//                              ordered by relevance descending then by
//                              updatedAtLedger for tie-breaking

/** Minimum search term length to trigger tsvector path. */
const FTS_MIN_LENGTH = 3;

/**
 * Escape a user string so it is safe to embed in a plainto_tsquery /
 * to_tsquery call.  Strips characters that have special meaning in tsquery
 * syntax (&, |, !, :, <, >, (, )) and trims whitespace.
 */
function sanitiseTsQuery(raw: string): string {
  return raw.replace(/[&|!:<>()]/g, ' ').trim();
}

router.get('/listings', cacheMiddleware(TTL.LISTINGS_LIST), validateQuery(listingsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { artist, owner, status, limit, offset, minPrice, maxPrice, search, cursor_ledger, cursor_direction } =
    (req as any).validatedQuery;
  try {
    const where: any = {};
    if (artist) where.artist = artist;
    if (owner) where.owner = owner;
    if (status) where.status = status;

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = String(minPrice);
      if (maxPrice !== undefined) where.price.lte = String(maxPrice);
    }

    // ── Cursor pagination ─────────────────────────────────────────────────
    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.updatedAtLedger = direction === 'desc'
        ? { lt: cursor_ledger }
        : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    // ── Full-text search ──────────────────────────────────────────────────
    if (search && search.length >= FTS_MIN_LENGTH) {
      // Build a safe plainto_tsquery expression.  plainto_tsquery handles
      // phrase tokenisation automatically and never throws on malformed input.
      const sanitised = sanitiseTsQuery(search);

      // Construct the additional Prisma filters as raw-SQL fragments so we can
      // combine them with the ts_rank ORDER BY.
      // We build the WHERE conditions from the `where` object manually for the
      // raw query so we can inject the tsquery predicate.

      const filterClauses: string[] = [
        `"searchVector" @@ plainto_tsquery('english', $1)`,
      ];
      const params: unknown[] = [sanitised];
      let pIdx = 2;

      if (artist)   { filterClauses.push(`"artist" = $${pIdx++}`);  params.push(artist); }
      if (owner)    { filterClauses.push(`"owner" = $${pIdx++}`);   params.push(owner); }
      if (status)   { filterClauses.push(`"status" = $${pIdx++}::"ListingStatus"`); params.push(status); }
      if (minPrice !== undefined) { filterClauses.push(`"price" >= $${pIdx++}`); params.push(String(minPrice)); }
      if (maxPrice !== undefined) { filterClauses.push(`"price" <= $${pIdx++}`); params.push(String(maxPrice)); }
      if (cursor_ledger !== undefined) {
        filterClauses.push(
          direction === 'desc'
            ? `"updatedAtLedger" < $${pIdx++}`
            : `"updatedAtLedger" > $${pIdx++}`
        );
        params.push(cursor_ledger);
      }

      const whereSQL = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';

      // ts_rank_cd is the coverage-density variant; it rewards documents where
      // the query terms are near each other.  Normalisation option 1 divides
      // rank by the document length to avoid bias toward longer descriptions.
      const results: any[] = await prisma.$queryRawUnsafe(
        `SELECT *,
                ts_rank_cd("searchVector", plainto_tsquery('english', $1), 1) AS "_rank"
         FROM "Listing"
         ${whereSQL}
         ORDER BY "_rank" DESC, "updatedAtLedger" ${direction === 'desc' ? 'DESC' : 'ASC'}
         LIMIT ${take} OFFSET ${skip}`,
        ...params
      );

      const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Listing" ${whereSQL}`,
        ...params
      );

      const nextCursor = results.length === take
        ? String(results[results.length - 1].updatedAtLedger)
        : '';

      res.setHeader('X-Next-Cursor', nextCursor);
      res.setHeader('X-Total-Count', String(count));
      return res.json({ listings: serialize(results), total: Number(count) });
    }

    // ── Short-term ILIKE fallback (<3 chars) or no search ────────────────
    if (search) {
      where.OR = [
        { artist:     { contains: search, mode: 'insensitive' } },
        { collection: { contains: search, mode: 'insensitive' } },
        { title:      { contains: search, mode: 'insensitive' } },
        { artistName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [results, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy: { updatedAtLedger: direction },
        take,
        skip,
      }),
      prisma.listing.count({ where: { ...where, updatedAtLedger: undefined } }),
    ]);

    const nextCursor = results.length === take
      ? String(results[results.length - 1].updatedAtLedger)
      : '';

    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));

    if (limit !== undefined || offset !== undefined || cursor_ledger !== undefined) {
      return res.json({ listings: serialize(results), total });
    }
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch listings'));
  }
});

// ── GET /listings/:id ─────────────────────────────────────────────────────────

router.get('/listings/:id', cacheMiddleware(TTL.LISTING_DETAIL), async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  try {
    const listing = await prisma.listing.findUnique({
      where: { listingId: BigInt(id as string) },
    });
    if (!listing) return next(notFound('Listing not found'));

    // Attach cached IPFS metadata when available, or null if still pending.
    const ipfsMetadata = listing.token
      ? await prisma.ipfsMetadata.findUnique({ where: { cid: listing.token } }).catch(() => null)
      : null;

    return res.json(serialize({ ...listing, ipfsMetadata: ipfsMetadata ?? null }));
  } catch (err) {
    next(internalError('Failed to fetch listing details'));
  }
});

// ── GET /listings/:id/history ─────────────────────────────────────────────────

router.get('/listings/:id/history', async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  if (!/^\d+$/.test(id)) {
    return next(badRequest('Invalid ID format'));
  }

  const limitRaw  = req.query.limit  as string | undefined;
  const offsetRaw = req.query.offset as string | undefined;

  const limitParsed  = limitRaw  !== undefined ? parseInt(limitRaw,  10) : 100;
  const offsetParsed = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;

  if (limitRaw !== undefined  && (!Number.isInteger(limitParsed)  || limitParsed  < 1 || limitParsed  > 500)) {
    return next(badRequest('limit must be an integer between 1 and 500'));
  }
  if (offsetRaw !== undefined && (!Number.isInteger(offsetParsed) || offsetParsed < 0 || offsetParsed > 10_000)) {
    return next(badRequest('offset must be a non-negative integer up to 10000'));
  }

  const limit  = limitParsed;
  const offset = offsetParsed;

  try {
    const where: any = { listingId: BigInt(id) };
    // Issue #286: optional filter for confirmed-only events
    const confirmedOnly = (req.query as any).confirmed === 'true';
    if (confirmedOnly) {
      where.confirmed = true;
    }
    const [results, total] = await Promise.all([
      prisma.marketplaceEvent.findMany({
        where,
        orderBy: { ledgerSequence: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceEvent.count({ where }),
    ]);
    res.json({ events: serialize(results), total });
  } catch (err) {
    next(internalError('Failed to fetch listing history'));
  }
});

// ── GET /ipfs/:cid ────────────────────────────────────────────────────────────
//
// Serves cached IPFS metadata for a given CID.  If the metadata is not yet
// cached, fetches it on-demand (populating the cache), enqueues a background
// refresh job, and returns the result.  Returns 404 when the content cannot be
// fetched from any gateway.

router.get('/ipfs/:cid', cacheMiddleware(300), async (req: Request, res: Response, next: NextFunction) => {
  const cid = req.params.cid as string;
  if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) {
    return next(badRequest('Invalid CID format'));
  }

  try {
    // 1. Serve from cache if available
    const cached = await prisma.ipfsMetadata.findUnique({ where: { cid } });
    if (cached) {
      return res.json(serialize(cached));
    }

    // 2. On-demand fetch and cache (for direct /ipfs/:cid requests)
    let raw: ReturnType<typeof Object.create>;
    try {
      raw = await fetchIpfsMetadata(cid);
    } catch {
      return next(notFound('IPFS content not available'));
    }

    const stored = await prisma.ipfsMetadata.upsert({
      where: { cid },
      create: {
        cid,
        title: typeof raw.title === 'string' ? raw.title : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        imageUrl: typeof raw.image === 'string'
          ? raw.image
          : typeof raw.imageUrl === 'string' ? raw.imageUrl : undefined,
        attributes: raw.attributes != null ? (raw.attributes as Prisma.InputJsonValue) : Prisma.JsonNull,
        raw: raw as Prisma.InputJsonValue,
      },
      update: {
        title: typeof raw.title === 'string' ? raw.title : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        imageUrl: typeof raw.image === 'string'
          ? raw.image
          : typeof raw.imageUrl === 'string' ? raw.imageUrl : undefined,
        attributes: raw.attributes != null ? (raw.attributes as Prisma.InputJsonValue) : Prisma.JsonNull,
        fetchedAt: new Date(),
        raw: raw as Prisma.InputJsonValue,
      },
    });

    // 3. Ensure a queue entry exists for future refreshes (fire-and-forget)
    enqueueIpfsFetch(cid).catch(() => { /* ignore */ });

    return res.json(serialize(stored));
  } catch (err) {
    next(internalError('Failed to fetch IPFS metadata'));
  }
});

// ── GET /auctions ─────────────────────────────────────────────────────────────

router.get('/auctions', cacheMiddleware(TTL.AUCTIONS_LIST), validateQuery(auctionsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { creator, status, limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (creator) where.creator = creator;
    if (status) where.status = status;

    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.updatedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const [results, total] = await Promise.all([
      prisma.auction.findMany({ where, orderBy: { updatedAtLedger: direction }, take, skip }),
      prisma.auction.count({ where: { ...(creator ? { creator } : {}), ...(status ? { status } : {}) } }),
    ]);

    const nextCursor = results.length === take ? String(results[results.length - 1].updatedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch auctions'));
  }
});

// ── GET /auctions/:id ─────────────────────────────────────────────────────────

router.get('/auctions/:id', cacheMiddleware(TTL.AUCTION_DETAIL), async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  if (!/^\d+$/.test(id)) {
    return next(badRequest('Invalid ID format'));
  }
  try {
    const result = await prisma.auction.findUnique({
      where: { auctionId: BigInt(id) },
    });
    if (!result) return next(notFound('Auction not found'));
    res.json(serialize(result));
  } catch (err) {
    next(internalError('Failed to fetch auction'));
  }
});

// ── GET /offers ───────────────────────────────────────────────────────────────

router.get('/offers', validateQuery(offersQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { listing_id, limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (listing_id) where.listingId = BigInt(listing_id);

    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.updatedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const [results, total] = await Promise.all([
      prisma.offer.findMany({ where, orderBy: { updatedAtLedger: direction }, take, skip }),
      prisma.offer.count({ where: listing_id ? { listingId: BigInt(listing_id) } : {} }),
    ]);

    const nextCursor = results.length === take ? String(results[results.length - 1].updatedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch offers'));
  }
});

// ── GET /activity/recent ──────────────────────────────────────────────────────

router.get('/activity/recent', cacheMiddleware(TTL.ACTIVITY_RECENT), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const results = await getCached('activity:recent', TTL.ACTIVITY_RECENT, () =>
      prisma.marketplaceEvent.findMany({
        take: 20,
        orderBy: { ledgerSequence: 'desc' },
      })
    );
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch recent activity'));
  }
});

// ── GET /collections ──────────────────────────────────────────────────────────

router.get('/collections', cacheMiddleware(TTL.COLLECTIONS), validateQuery(collectionsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { kind, creator, limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (kind)    where.kind    = kind;
    if (creator) where.creator = creator;

    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.deployedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const [results, total] = await Promise.all([
      prisma.collection.findMany({ where, orderBy: { deployedAtLedger: direction }, take, skip }),
      prisma.collection.count({ where: { ...(kind ? { kind } : {}), ...(creator ? { creator } : {}) } }),
    ]);

    const nextCursor = results.length === take ? String(results[results.length - 1].deployedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch collections'));
  }
});

// ── GET /creators/:address/collections ───────────────────────────────────────

router.get('/creators/:address/collections', validateQuery(creatorCollectionsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  if (!isValidStellarAddress(address)) {
    return next(badRequest('Invalid creator address: must be a valid 56-character Stellar G-address'));
  }
  const { limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    const where: any = { creator: address };
    if (cursor_ledger !== undefined) {
      where.deployedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }
    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const [results, total] = await Promise.all([
      prisma.collection.findMany({ where, orderBy: { deployedAtLedger: direction }, take, skip }),
      prisma.collection.count({ where: { creator: address } }),
    ]);

    const nextCursor = results.length === take ? String(results[results.length - 1].deployedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch creator collections'));
  }
});

// ── GET /wallets/:address/activity ────────────────────────────────────────────

router.get('/wallets/:address/activity', strictRateLimiter, validateQuery(walletActivityQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  const { limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  const take = Math.min(limit ?? 50, 200);

  try {
    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    const cursorWhere: any = cursor_ledger !== undefined
      ? { ledgerSequence: direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger } }
      : {};

    const jsonKeys = ['buyer', 'artist', 'offerer', 'bidder', 'winner', 'creator'];
    const fromJson = jsonKeys.map((path) => ({
      data: { path: [path], equals: address },
    }));

    const baseWhere = { OR: [{ actor: address }, ...fromJson] };
    const where = { ...baseWhere, ...cursorWhere };

    const [events, total] = await Promise.all([
      prisma.marketplaceEvent.findMany({
        where,
        orderBy: { ledgerSequence: direction },
        take,
        skip: cursor_ledger !== undefined ? 0 : (offset ?? 0),
      }),
      prisma.marketplaceEvent.count({ where: baseWhere }),
    ]);

    const nextCursor = events.length === take ? String(events[events.length - 1].ledgerSequence) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(events));
  } catch (err) {
    next(internalError('Failed to fetch wallet activity'));
  }
});

// ── GET /wallets/:address/royalty-stats ───────────────────────────────────────

router.get('/wallets/:address/royalty-stats', strictRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const { address } = req.params;
  try {
    const sold = await prisma.listing.findMany({
      where: {
        originalCreator: address as string,
        status: 'Sold',
        NOT: { artist: address as string },
      },
      select: {
        listingId: true,
        price: true,
        royaltyBps: true,
        updatedAtLedger: true,
      },
    });

    let totalEarned = 0;
    for (const row of sold) {
      const p = Number(row.price);
      totalEarned += (p * row.royaltyBps) / 10000;
    }

    const lastSale = sold.reduce<(typeof sold)[0] | null>((latest, row) => {
      if (!latest || row.updatedAtLedger > latest.updatedAtLedger) return row;
      return latest;
    }, null);

    res.json({
      totalEarned: totalEarned.toFixed(7),
      payoutCount: sold.length,
      lastPayout: lastSale ? lastSale.updatedAtLedger * 1000 : 0,
    });
  } catch (err) {
    next(internalError('Failed to fetch royalty stats'));
  }
});

// ── GET /wallets/:address/royalty-breakdown ───────────────────────────────────
// Per-sale royalty audit trail (Issue #201): paginated RoyaltyPayment rows for
// the given recipient address, newest-first, optionally bounded to the
// inclusive ledger-sequence window [from, to]. Cached for 60 seconds.

router.get('/wallets/:address/royalty-breakdown', cacheMiddleware(60), validateQuery(royaltyBreakdownQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  if (!isValidStellarAddress(address)) {
    return next(badRequest(STELLAR_ADDRESS_ERROR));
  }
  const { from, to, limit, offset } = (req as any).validatedQuery;
  try {
    const where: any = { recipient: address };
    if (from !== undefined || to !== undefined) {
      where.ledgerSequence = {};
      if (from !== undefined) where.ledgerSequence.gte = from;
      if (to !== undefined)   where.ledgerSequence.lte = to;
    }

    const take = limit ?? 50;
    const skip = offset ?? 0;
    const [payments, total] = await Promise.all([
      prisma.royaltyPayment.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        take,
        skip,
      }),
      prisma.royaltyPayment.count({ where }),
    ]);

    res.setHeader('X-Total-Count', String(total));
    res.json({
      payments: serialize(payments),
      total,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    next(internalError('Failed to fetch royalty breakdown'));
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────

router.get('/stats', validateQuery(statsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { from, to, range } = (req as any).validatedQuery;
  try {
    let dateFrom: Date | undefined;
    let dateTo: Date | undefined;

    if (range) {
      const now = new Date();
      dateTo = now;
      if (range === 'day') {
        dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      } else if (range === 'week') {
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else {
        dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
    } else {
      if (from) {
        dateFrom = new Date(from as string);
        if (isNaN(dateFrom.getTime())) {
          return next(badRequest('Invalid from date format. Use ISO 8601.'));
        }
      }
      if (to) {
        dateTo = new Date(to as string);
        if (isNaN(dateTo.getTime())) {
          return next(badRequest('Invalid to date format. Use ISO 8601.'));
        }
      }
    }

    const eventTimeFilter: any = {};
    if (dateFrom) eventTimeFilter.gte = dateFrom;
    if (dateTo)   eventTimeFilter.lte = dateTo;
    const hasTimeFilter = Object.keys(eventTimeFilter).length > 0;

    const totalListings = await prisma.listing.count();
    const activeListings = await prisma.listing.count({ where: { status: 'Active' } });

    const volumeResult = await prisma.listing.aggregate({
      _sum: { price: true },
      where: { status: 'Sold' },
    });
    const totalVolume = volumeResult._sum.price?.toString() ?? '0';

    const userFilter: any = hasTimeFilter ? { ledgerTimestamp: eventTimeFilter } : {};
    const distinctActors = await prisma.marketplaceEvent.findMany({
      where: userFilter,
      select: { actor: true },
      distinct: ['actor'],
    });
    const activeUsers = distinctActors.length;

    const totalEvents = await prisma.marketplaceEvent.count({ where: userFilter });

    const salesFilter: any = { eventType: 'ARTWORK_SOLD' };
    if (hasTimeFilter) salesFilter.ledgerTimestamp = eventTimeFilter;
    const totalSales = await prisma.marketplaceEvent.count({ where: salesFilter });

    res.json({
      totalListings,
      activeListings,
      totalVolume,
      activeUsers,
      totalEvents,
      totalSales,
      ...(hasTimeFilter && {
        timeRange: {
          from: dateFrom?.toISOString() ?? null,
          to: dateTo?.toISOString() ?? null,
        },
      }),
    });
  } catch (err) {
    next(internalError('Failed to fetch stats'));
  }
});

// GET /events — Server-Sent Events stream with keep-alive heartbeats
router.get('/events', (req: Request, res: Response) => {
    // Check connection limit
    if (sseClients.size >= MAX_SSE_CONNECTIONS) {
        return res.status(503).json({ error: 'Too many SSE connections' });
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx from buffering SSE chunks
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Setup heartbeat
    setupSSEHeartbeat(res);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);

    // Cleanup on disconnect
    res.on('close', () => {
        cleanupSSEClient(res);
    });

    res.on('error', () => {
        cleanupSSEClient(res);
    });
});

// ── GET /artists/:address/metrics ─────────────────────────────────────────────
// Returns mints-over-time, volume-over-time, and conversion rate aggregates
// for a given artist, scoped by an optional ?range=day|week|month query param.

router.get('/artists/:address/metrics', cacheMiddleware(60), validateQuery(artistMetricsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  const { range } = (req as any).validatedQuery;

  const now = new Date();
  let dateFrom: Date | undefined;
  if (range === 'day')   dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  else if (range === 'week')  dateFrom = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  else if (range === 'month') dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const timeWhere = dateFrom ? { createdAt: { gte: dateFrom } } : {};

    // Total listings created by artist in range (proxy for mints)
    const totalListings = await prisma.listing.count({
      where: { artist: address, ...timeWhere },
    });

    // Sales (sold listings)
    const totalSales = await prisma.listing.count({
      where: { artist: address, status: 'Sold', ...timeWhere },
    });

    // Volume (sum of sold listing prices in range)
    const volumeResult = await prisma.listing.aggregate({
      _sum: { price: true },
      where: { artist: address, status: 'Sold', ...timeWhere },
    });
    const totalVolume = volumeResult._sum.price?.toString() ?? '0';

    // Unique buyers
    const soldListings = await prisma.listing.findMany({
      where: { artist: address, status: 'Sold', owner: { not: null }, ...timeWhere },
      select: { owner: true },
    });
    const uniqueBuyers = new Set(soldListings.map((l) => l.owner)).size;

    // Conversion rate: sales / listings (0 if no listings)
    const conversionRate = totalListings > 0
      ? Number((totalSales / totalListings).toFixed(4))
      : 0;

    // Mints over time: group sold ARTWORK_SOLD events by day
    const soldEvents = await prisma.marketplaceEvent.findMany({
      where: {
        actor: address,
        eventType: 'ARTWORK_SOLD',
        ...(dateFrom ? { ledgerTimestamp: { gte: dateFrom } } : {}),
      },
      select: { ledgerTimestamp: true },
      orderBy: { ledgerTimestamp: 'asc' },
    });

    // Bucket events by ISO date (YYYY-MM-DD)
    const salesByDay: Record<string, number> = {};
    for (const ev of soldEvents) {
      const day = ev.ledgerTimestamp.toISOString().slice(0, 10);
      salesByDay[day] = (salesByDay[day] ?? 0) + 1;
    }
    const salesTimeline = Object.entries(salesByDay).map(([date, count]) => ({ date, count }));

    res.json({
      address,
      range: range ?? 'all',
      totalListings,
      totalSales,
      totalVolume,
      uniqueBuyers,
      conversionRate,
      salesTimeline,
    });
  } catch (err) {
    next(internalError('Failed to fetch artist metrics'));
  }
});

// ── GET /backfill/status ──────────────────────────────────────────────────────
//
// Returns the current state of any running backfill job: progress percentage,
// throughput (events/s), ETA, and ledger range.  Returns running: false when
// no backfill is currently active.

router.get('/backfill/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getBackfillStatus } = await import('../backfill.js');
    res.json(getBackfillStatus());
  } catch (err) {
    next(internalError('Failed to fetch backfill status'));
  }
});

// ── GET /keeper/status ────────────────────────────────────────────────────────
//
// Returns the keeper's current operational state:
//   - whether it is running and in dry-run mode
//   - aggregate counts by KeeperActionStatus
//   - the most recent 20 actions (for quick operator triage)
//   - stats from the last completed cycle

router.get('/keeper/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Lazy-import to avoid a hard dependency when the keeper is disabled.
    const { getLastCycleStats, isKeeperRunning } = await import('../keeper/index.js');
    const { getActionSummary, getRecentActions } = await import('../keeper/idempotency.js');

    const [summary, recent, lastCycle] = await Promise.all([
      getActionSummary(),
      getRecentActions(20),
      Promise.resolve(getLastCycleStats()),
    ]);

    const payload = {
      running:       isKeeperRunning(),
      dryRun:        process.env.KEEPER_DRY_RUN !== 'false',
      enabled:       process.env.KEEPER_ENABLED === 'true',
      actionCounts:  summary,
      lastCycle: lastCycle
        ? {
            startedAt:            lastCycle.startedAt,
            completedAt:          lastCycle.completedAt,
            candidatesDiscovered: lastCycle.candidatesDiscovered,
            actionsAttempted:     lastCycle.actionsAttempted,
            actionsSucceeded:     lastCycle.actionsSucceeded,
            actionsFailed:        lastCycle.actionsFailed,
            actionsSkipped:       lastCycle.actionsSkipped,
            feesSpentStroops:     lastCycle.feesSpentStroops.toString(),
            budgetExhausted:      lastCycle.budgetExhausted,
            dryRun:               lastCycle.dryRun,
          }
        : null,
      recentActions: serialize(recent),
    };

    res.json(payload);
  } catch (err) {
    next(internalError('Failed to fetch keeper status'));
  }
});

// ── GET /sync/gaps ────────────────────────────────────────────────────────────
//
// Returns ledger gaps with optional filtering by status/source.
// Also includes a summary of open gaps and total missing ledgers.

router.get('/sync/gaps', validateQuery(syncGapsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { status, source, limit, offset } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (status) where.status = status;
    if (source) where.source = source;

    const take = limit ?? 50;
    const skip = offset ?? 0;

    const [gaps, total, openSummary] = await Promise.all([
      prisma.ledgerGap.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take,
        skip,
        include: { repairJob: { select: { id: true, status: true, checkpointLedger: true, totalInserted: true } } },
      }),
      prisma.ledgerGap.count({ where }),
      prisma.ledgerGap.findMany({
        where: { status: 'Open' },
        select: { fromLedger: true, toLedger: true },
      }),
    ]);

    const openLedgers = openSummary.reduce(
      (acc, g) => acc + (g.toLedger - g.fromLedger + 1), 0,
    );

    res.json({
      summary: {
        openGaps:    openSummary.length,
        openLedgers,
      },
      total,
      gaps: serialize(gaps),
    });
  } catch (err) {
    next(internalError('Failed to fetch sync gaps'));
  }
});

// ── GET /sync/gaps/:id ────────────────────────────────────────────────────────

router.get('/sync/gaps/:id', async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return next(badRequest('Gap ID must be an integer'));
  try {
    const gap = await prisma.ledgerGap.findUnique({
      where: { id },
      include: { repairJob: true },
    });
    if (!gap) return next(notFound('Gap not found'));
    res.json(serialize(gap));
  } catch (err) {
    next(internalError('Failed to fetch gap'));
  }
});

// ── GET /sync/jobs ────────────────────────────────────────────────────────────
//
// BackfillJob listing for operator visibility.

router.get('/sync/jobs', async (req: Request, res: Response, next: NextFunction) => {
  const status = req.query.status as string | undefined;
  try {
    const where: any = {};
    if (status) where.status = status;
    const jobs = await prisma.backfillJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(serialize(jobs));
  } catch (err) {
    next(internalError('Failed to fetch backfill jobs'));
  }
});

// ── GET /sync/jobs/:id ────────────────────────────────────────────────────────

router.get('/sync/jobs/:id', async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return next(badRequest('Job ID must be an integer'));
  try {
    const job = await prisma.backfillJob.findUnique({ where: { id } });
    if (!job) return next(notFound('BackfillJob not found'));
    res.json(serialize(job));
  } catch (err) {
    next(internalError('Failed to fetch backfill job'));
  }
});

// ── GET /admin/contracts ──────────────────────────────────────────────────────
//
// List all tracked contracts with their current sync status.

router.get('/admin/contracts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contracts = await prisma.trackedContract.findMany({
      orderBy: { createdAt: 'asc' },
    });
    res.json(serialize(contracts));
  } catch (err) {
    next(internalError('Failed to fetch tracked contracts'));
  }
});

// ── POST /admin/contracts ─────────────────────────────────────────────────────
//
// Add a new contract to track. Body: { contractId, type, label?, startLedger? }

router.post('/admin/contracts', async (req: Request, res: Response, next: NextFunction) => {
  const { contractId, type, label = '', startLedger = 0 } = req.body ?? {};

  if (!contractId || typeof contractId !== 'string' || contractId.trim() === '') {
    return next(badRequest('contractId is required'));
  }
  if (type !== 'marketplace' && type !== 'launchpad') {
    return next(badRequest('type must be "marketplace" or "launchpad"'));
  }
  if (!Number.isInteger(startLedger) || startLedger < 0) {
    return next(badRequest('startLedger must be a non-negative integer'));
  }

  try {
    const contract = await prisma.trackedContract.upsert({
      where: { contractId: contractId.trim() },
      create: {
        contractId: contractId.trim(),
        type,
        label: String(label),
        startLedger,
        lastLedger: startLedger,
        active: true,
      },
      update: {
        type,
        label: String(label),
        active: true,
      },
    });
    res.status(201).json(serialize(contract));
  } catch (err) {
    next(internalError('Failed to add tracked contract'));
  }
});

// ── DELETE /admin/contracts/:id ───────────────────────────────────────────────
//
// Deactivate a tracked contract. The polling loop will stop on the next tick.

router.delete('/admin/contracts/:id', async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return next(badRequest('Contract ID must be an integer'));

  try {
    const existing = await prisma.trackedContract.findUnique({ where: { id } });
    if (!existing) return next(notFound('Tracked contract not found'));

    const updated = await prisma.trackedContract.update({
      where: { id },
      data: { active: false },
    });
    res.json(serialize(updated));
  } catch (err) {
    next(internalError('Failed to deactivate tracked contract'));
  }
});

// ── GET /search ───────────────────────────────────────────────────────────────
//
// Cross-entity full-text search across listings, auctions, and collections.
//
// ?q=benin&types=listings,collections&limit=5
//
// Each included entity type runs its own ts_rank-ordered query.  Results for
// types without a searchVector (auctions) fall back to ILIKE on key text
// fields so that /search works before IPFS metadata is populated.
//
// Response shape:
// {
//   query: string,
//   listings:    { items: Listing[],    total: number },
//   auctions:    { items: Auction[],    total: number },
//   collections: { items: Collection[], total: number },
// }
// Entity buckets not requested in ?types= are omitted from the response.

router.get('/search', validateQuery(searchQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { q, types, limit } = (req as any).validatedQuery as {
    q: string;
    types: Array<'listings' | 'auctions' | 'collections'>;
    limit: number;
  };

  try {
    const sanitised = sanitiseTsQuery(q);
    const useFts = q.length >= FTS_MIN_LENGTH;
    const result: Record<string, any> = { query: q };

    // ── Listings ────────────────────────────────────────────────────────────
    if (types.includes('listings')) {
      if (useFts) {
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT *,
                  ts_rank_cd("searchVector", plainto_tsquery('english', $1), 1) AS "_rank"
           FROM "Listing"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)
           ORDER BY "_rank" DESC, "updatedAtLedger" DESC
           LIMIT $2`,
          sanitised,
          limit,
        );
        const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
          `SELECT COUNT(*) as count FROM "Listing"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)`,
          sanitised,
        );
        result.listings = { items: serialize(rows), total: Number(count) };
      } else {
        // Short term — ILIKE fallback
        const [rows, total] = await Promise.all([
          prisma.listing.findMany({
            where: {
              OR: [
                { artist:     { contains: q, mode: 'insensitive' } },
                { collection: { contains: q, mode: 'insensitive' } },
                { title:      { contains: q, mode: 'insensitive' } },
                { artistName: { contains: q, mode: 'insensitive' } },
              ],
            },
            orderBy: { updatedAtLedger: 'desc' },
            take: limit,
          }),
          prisma.listing.count({
            where: {
              OR: [
                { artist:     { contains: q, mode: 'insensitive' } },
                { collection: { contains: q, mode: 'insensitive' } },
                { title:      { contains: q, mode: 'insensitive' } },
                { artistName: { contains: q, mode: 'insensitive' } },
              ],
            },
          }),
        ]);
        result.listings = { items: serialize(rows), total };
      }
    }

    // ── Auctions ────────────────────────────────────────────────────────────
    // Auctions do not have a searchVector; always use ILIKE on creator +
    // collection address fields.
    if (types.includes('auctions')) {
      const auctionWhere: any = {
        OR: [
          { creator:    { contains: q, mode: 'insensitive' } },
          { collection: { contains: q, mode: 'insensitive' } },
        ],
      };
      const [rows, total] = await Promise.all([
        prisma.auction.findMany({
          where: auctionWhere,
          orderBy: { updatedAtLedger: 'desc' },
          take: limit,
        }),
        prisma.auction.count({ where: auctionWhere }),
      ]);
      result.auctions = { items: serialize(rows), total };
    }

    // ── Collections ─────────────────────────────────────────────────────────
    if (types.includes('collections')) {
      if (useFts) {
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT *,
                  ts_rank_cd("searchVector", plainto_tsquery('english', $1), 1) AS "_rank"
           FROM "Collection"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)
           ORDER BY "_rank" DESC, "deployedAtLedger" DESC
           LIMIT $2`,
          sanitised,
          limit,
        );
        const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
          `SELECT COUNT(*) as count FROM "Collection"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)`,
          sanitised,
        );
        result.collections = { items: serialize(rows), total: Number(count) };
      } else {
        const collectionWhere: any = {
          OR: [
            { name:            { contains: q, mode: 'insensitive' } },
            { symbol:          { contains: q, mode: 'insensitive' } },
            { contractAddress: { contains: q, mode: 'insensitive' } },
            { creator:         { contains: q, mode: 'insensitive' } },
          ],
        };
        const [rows, total] = await Promise.all([
          prisma.collection.findMany({
            where: collectionWhere,
            orderBy: { deployedAtLedger: 'desc' },
            take: limit,
          }),
          prisma.collection.count({ where: collectionWhere }),
        ]);
        result.collections = { items: serialize(rows), total };
      }
    }

    res.json(result);
  } catch (err) {
    next(internalError('Failed to execute search'));
  }
});

export default router;
