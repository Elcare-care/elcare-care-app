/**
 * search.test.ts
 *
 * Unit tests for:
 *  - GET /listings?search=   (FTS path ≥3 chars, ILIKE fallback <3 chars)
 *  - GET /search             (cross-entity: listings + auctions + collections)
 *  - backfillListingMetadata (poller helper that populates title/description/artistName)
 *
 * Strategy: mock prisma (db + prisma-write) and redis so tests run without a
 * live database, mirroring the patterns in poller.test.ts and sse.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findMany:   vi.fn().mockResolvedValue([]),
    count:      vi.fn().mockResolvedValue(0),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert:     vi.fn().mockResolvedValue({}),
  },
  auction: {
    findMany: vi.fn().mockResolvedValue([]),
    count:    vi.fn().mockResolvedValue(0),
  },
  collection: {
    findMany: vi.fn().mockResolvedValue([]),
    count:    vi.fn().mockResolvedValue(0),
  },
  ipfsMetadata: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert:     vi.fn().mockResolvedValue({}),
  },
  ipfsQueue: {
    findFirst: vi.fn().mockResolvedValue(null),
    create:    vi.fn().mockResolvedValue({}),
  },
  $queryRawUnsafe: vi.fn(),
  $transaction:    vi.fn((fn: any) => fn(mockPrisma)),
}));

const mockRedis = vi.hoisted(() => ({
  isOpen:  false,
  isReady: false,
  get:     vi.fn().mockResolvedValue(null),
  setEx:   vi.fn().mockResolvedValue(undefined),
  on:      vi.fn(),
  connect: vi.fn().mockRejectedValue(new Error('No Redis')),
}));

vi.mock('../db',           () => ({ default: mockPrisma }));
vi.mock('../prisma-write', () => ({ default: mockPrisma }));
vi.mock('../redis.js',     () => ({ default: mockRedis }));
vi.mock('../metrics.js', () => ({
  stalledGauge:               { set: vi.fn() },
  pollerStallTotal:           { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  pollerRestartTotal:         { inc: vi.fn() },
  latestLedgerProcessedGauge: { set: vi.fn() },
  networkLatestLedgerGauge:   { set: vi.fn() },
  syncLatencyGauge:           { set: vi.fn() },
  sseConnectionsTotal:        { inc: vi.fn() },
  sseActiveConnectionsGauge:  { set: vi.fn() },
  apiRequestDurationHistogram:{ labels: vi.fn().mockReturnValue({ observe: vi.fn() }) },
  listingsCreatedTotal:       { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  activeListingsGauge:        { set: vi.fn() },
}));

// ── Build Express app ─────────────────────────────────────────────────────────

import router from '../api/routes.js';
import { errorHandler } from '../api/errors.js';

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A Listing row shape the mock returns. */
function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    listingId:       1n,
    artist:          'GART1234567890',
    owner:           null,
    price:           '10000000.0000000',
    currency:        'XLM',
    collection:      'CCOLLECTION',
    nftTokenId:      1n,
    token:           'Qm1234',
    status:          'Active',
    recipients:      [],
    createdAtLedger: 100,
    updatedAtLedger: 100,
    createdAt:       new Date('2025-01-01'),
    updatedAt:       new Date('2025-01-01'),
    title:           'Benin Bronze',
    description:     'A traditional Benin bronze artwork',
    artistName:      'Osagie Omo',
    ...overrides,
  };
}

function makeAuction(overrides: Record<string, unknown> = {}) {
  return {
    auctionId:       2n,
    creator:         'GAUCTIONEER',
    collection:      'CCOLLECTION',
    nftTokenId:      2n,
    token:           'XLM',
    reservePrice:    '50000000.0000000',
    highestBid:      '0.0000000',
    highestBidder:   null,
    endTime:         1800000000n,
    status:          'Active',
    recipients:      [],
    createdAtLedger: 200,
    updatedAtLedger: 200,
    createdAt:       new Date('2025-01-01'),
    updatedAt:       new Date('2025-01-01'),
    ...overrides,
  };
}

function makeCollection(overrides: Record<string, unknown> = {}) {
  return {
    id:               1,
    contractAddress:  'CCONTRACT1',
    kind:             'normal_721',
    creator:          'GCREATOR',
    name:             'Benin Art Gallery',
    symbol:           'BAG',
    deployedAtLedger: 50,
    createdAt:        new Date('2025-01-01'),
    ...overrides,
  };
}

// ── GET /listings?search= — FTS path ─────────────────────────────────────────

describe('GET /listings?search= — full-text search (≥3 chars)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses $queryRawUnsafe when search term is ≥ 3 characters', async () => {
    const listing = makeListing({ _rank: 0.9 });
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([listing])           // SELECT * …
      .mockResolvedValueOnce([{ count: 1n }]);    // SELECT COUNT …

    const res = await request(app)
      .get('/listings?search=benin')
      .expect(200);

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);

    // First call should be the ranked SELECT
    const [firstSql] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(firstSql).toContain('ts_rank_cd');
    expect(firstSql).toContain('plainto_tsquery');
    expect(firstSql).toContain('"searchVector"');

    // Response must include listings array
    expect(res.body).toHaveProperty('listings');
    expect(Array.isArray(res.body.listings)).toBe(true);
  });

  it('passes the sanitised search term as a parameter (not inline SQL)', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeListing()])
      .mockResolvedValueOnce([{ count: 1n }]);

    await request(app).get('/listings?search=benin+bronze');

    const params = mockPrisma.$queryRawUnsafe.mock.calls[0].slice(1); // args after sql
    expect(params[0]).toBe('benin bronze'); // sanitised — + → space via URL decoding
  });

  it('strips tsquery special characters from the search parameter', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }]);

    await request(app).get('/listings?search=benin%26bronze%7Cnft');

    // sanitiseTsQuery strips & and | so the param should contain only text
    const params = mockPrisma.$queryRawUnsafe.mock.calls[0].slice(1);
    expect(params[0]).not.toMatch(/[&|!:<>()]/);
  });

  it('returns X-Total-Count header', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeListing()])
      .mockResolvedValueOnce([{ count: 1n }]);

    const res = await request(app).get('/listings?search=benin').expect(200);
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('results carry a _rank field from ts_rank_cd', async () => {
    const ranked = makeListing({ _rank: 0.75 });
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([ranked])
      .mockResolvedValueOnce([{ count: 1n }]);

    const res = await request(app).get('/listings?search=benin').expect(200);
    // Serialise converts bigint but keeps numeric _rank
    expect(res.body.listings[0]).toHaveProperty('_rank', 0.75);
  });

  it('returns an empty array when no FTS match found', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }]);

    const res = await request(app).get('/listings?search=zzznomatch').expect(200);
    expect(res.body.listings).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('FTS query includes ORDER BY _rank DESC', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }]);

    await request(app).get('/listings?search=benin');

    const [sql] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/ORDER BY.*_rank.*DESC/i);
  });
});

// ── GET /listings?search= — ILIKE fallback ────────────────────────────────────

describe('GET /listings?search= — ILIKE fallback (< 3 chars)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses Prisma findMany (not $queryRawUnsafe) for short terms', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);

    await request(app).get('/listings?search=ab').expect(200);

    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.listing.findMany).toHaveBeenCalled();
  });

  it('ILIKE where clause includes title and artistName fields', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);

    await request(app).get('/listings?search=ab');

    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    const orConditions = call.where.OR as Array<Record<string, unknown>>;
    const fieldNames = orConditions.map((c) => Object.keys(c)[0]);
    expect(fieldNames).toContain('title');
    expect(fieldNames).toContain('artistName');
  });

  it('returns results normally via ILIKE path', async () => {
    const listing = makeListing();
    mockPrisma.listing.findMany.mockResolvedValue([listing]);
    mockPrisma.listing.count.mockResolvedValue(1);

    const res = await request(app).get('/listings?search=ab').expect(200);
    expect(res.body.listings).toHaveLength(1);
  });
});

// ── GET /search — cross-entity ────────────────────────────────────────────────

describe('GET /search — cross-entity endpoint', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when q is missing', async () => {
    const res = await request(app).get('/search').expect(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when q is empty string', async () => {
    const res = await request(app).get('/search?q=').expect(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns all three entity buckets by default', async () => {
    // FTS path for listings + collections; ILIKE for auctions
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeListing()])          // listings SELECT
      .mockResolvedValueOnce([{ count: 1n }])          // listings COUNT
      .mockResolvedValueOnce([makeCollection()])        // collections SELECT
      .mockResolvedValueOnce([{ count: 1n }]);          // collections COUNT
    mockPrisma.auction.findMany.mockResolvedValue([makeAuction()]);
    mockPrisma.auction.count.mockResolvedValue(1);

    const res = await request(app).get('/search?q=benin').expect(200);

    expect(res.body).toHaveProperty('listings');
    expect(res.body).toHaveProperty('auctions');
    expect(res.body).toHaveProperty('collections');
    expect(res.body.query).toBe('benin');
  });

  it('returns only requested entity types when ?types= is specified', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeListing()])
      .mockResolvedValueOnce([{ count: 1n }]);

    const res = await request(app).get('/search?q=benin&types=listings').expect(200);

    expect(res.body).toHaveProperty('listings');
    expect(res.body).not.toHaveProperty('auctions');
    expect(res.body).not.toHaveProperty('collections');
  });

  it('accepts comma-separated types parameter', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeCollection()])
      .mockResolvedValueOnce([{ count: 1n }]);
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);

    const res = await request(app).get('/search?q=gallery&types=auctions,collections').expect(200);

    expect(res.body).toHaveProperty('auctions');
    expect(res.body).toHaveProperty('collections');
    expect(res.body).not.toHaveProperty('listings');
  });

  it('uses FTS for listings and collections with q ≥ 3 chars', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValue([]);

    await request(app).get('/search?q=benin&types=listings,collections');

    // All 4 $queryRawUnsafe calls should contain plainto_tsquery
    for (const call of mockPrisma.$queryRawUnsafe.mock.calls) {
      expect(call[0]).toContain('plainto_tsquery');
    }
  });

  it('uses ILIKE for all entities with q < 3 chars', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);
    mockPrisma.collection.findMany.mockResolvedValue([]);
    mockPrisma.collection.count.mockResolvedValue(0);

    await request(app).get('/search?q=ba').expect(200);

    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.listing.findMany).toHaveBeenCalled();
    expect(mockPrisma.auction.findMany).toHaveBeenCalled();
    expect(mockPrisma.collection.findMany).toHaveBeenCalled();
  });

  it('auctions always use ILIKE (no searchVector) even with long q', async () => {
    // Only listings + collections need FTS mocks; auctions use Prisma
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])              // listings SELECT
      .mockResolvedValueOnce([{ count: 0n }]) // listings COUNT
      .mockResolvedValueOnce([])              // collections SELECT
      .mockResolvedValueOnce([{ count: 0n }]);// collections COUNT
    mockPrisma.auction.findMany.mockResolvedValue([makeAuction()]);
    mockPrisma.auction.count.mockResolvedValue(1);

    const res = await request(app).get('/search?q=benin').expect(200);

    expect(res.body.auctions.items).toHaveLength(1);
    // The auction query must have gone through prisma.auction.findMany (ILIKE)
    expect(mockPrisma.auction.findMany).toHaveBeenCalled();
  });

  it('respects the limit parameter per entity type', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeListing()])
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([makeCollection()])
      .mockResolvedValueOnce([{ count: 1n }]);
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);

    await request(app).get('/search?q=benin&limit=3');

    // The raw SQL calls should embed LIMIT 3
    for (const call of mockPrisma.$queryRawUnsafe.mock.calls.filter(
      (c: any[]) => c[0].includes('LIMIT')
    )) {
      expect(call[0]).toContain('LIMIT $2');
      expect(call[1]).toBe('benin');
      expect(call[2]).toBe(3);
    }
  });

  it('returns 400 for invalid entity type', async () => {
    const res = await request(app).get('/search?q=benin&types=invalid').expect(400);
    expect(res.body).toHaveProperty('error');
  });

  it('response includes total counts per entity type', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([makeListing(), makeListing({ listingId: 2n })])
      .mockResolvedValueOnce([{ count: 2n }]);
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }]);

    const res = await request(app).get('/search?q=benin&types=listings').expect(200);
    expect(res.body.listings.total).toBe(2);
    expect(res.body.listings.items).toHaveLength(2);
  });

  it('sanitises tsquery special chars in the q parameter', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValue([]);

    await request(app).get('/search?q=benin%26bronze&types=listings');

    const param = mockPrisma.$queryRawUnsafe.mock.calls[0][1];
    expect(param).not.toContain('&');
  });

  it('returns empty results gracefully when all entity queries return nothing', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }]);
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);

    const res = await request(app).get('/search?q=zzznomatch').expect(200);

    expect(res.body.listings.items).toEqual([]);
    expect(res.body.listings.total).toBe(0);
    expect(res.body.auctions.items).toEqual([]);
    expect(res.body.collections.items).toEqual([]);
  });
});

// ── backfillListingMetadata ───────────────────────────────────────────────────

describe('backfillListingMetadata', () => {
  beforeEach(() => vi.clearAllMocks());

  // Dynamic import so we get the real function after mocks are set up
  async function getBackfill() {
    const { backfillListingMetadata } = await import('../poller.js');
    return backfillListingMetadata;
  }

  it('does nothing when the CID is not yet in IpfsMetadata cache', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);

    const backfill = await getBackfill();
    await backfill(1n, 'Qmnotcached');

    expect(mockPrisma.listing.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when CID is empty string', async () => {
    const backfill = await getBackfill();
    await backfill(1n, '');

    expect(mockPrisma.ipfsMetadata.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.listing.updateMany).not.toHaveBeenCalled();
  });

  it('updates title and description from cached IpfsMetadata', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmtest1',
      title:       'Benin Bronze',
      description: 'A traditional Benin bronze artwork',
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         {},
    });

    const backfill = await getBackfill();
    await backfill(42n, 'Qmtest1');

    expect(mockPrisma.listing.updateMany).toHaveBeenCalledOnce();
    const call = mockPrisma.listing.updateMany.mock.calls[0][0];
    expect(call.where.listingId).toBe(42n);
    expect(call.data.title).toBe('Benin Bronze');
    expect(call.data.description).toBe('A traditional Benin bronze artwork');
  });

  it('extracts artistName from raw.artist field', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmtest2',
      title:       'Art',
      description: null,
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         { artist: 'Osagie Omo' },
    });

    const backfill = await getBackfill();
    await backfill(7n, 'Qmtest2');

    const call = mockPrisma.listing.updateMany.mock.calls[0][0];
    expect(call.data.artistName).toBe('Osagie Omo');
  });

  it('falls back to raw.creator when raw.artist is absent', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmtest3',
      title:       'Art',
      description: null,
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         { creator: 'Taiwo Adeyemi' },
    });

    const backfill = await getBackfill();
    await backfill(8n, 'Qmtest3');

    const call = mockPrisma.listing.updateMany.mock.calls[0][0];
    expect(call.data.artistName).toBe('Taiwo Adeyemi');
  });

  it('falls back to raw.by when raw.artist and raw.creator are absent', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmtest4',
      title:       'Art',
      description: null,
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         { by: 'Emeka Obi' },
    });

    const backfill = await getBackfill();
    await backfill(9n, 'Qmtest4');

    const call = mockPrisma.listing.updateMany.mock.calls[0][0];
    expect(call.data.artistName).toBe('Emeka Obi');
  });

  it('uses a conditional WHERE so it never clobbers existing metadata', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmtest5',
      title:       'Already Set',
      description: 'Already Set',
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         { artist: 'Someone' },
    });

    const backfill = await getBackfill();
    await backfill(10n, 'Qmtest5');

    const call = mockPrisma.listing.updateMany.mock.calls[0][0];
    // The OR clause ensures we only update rows that still have null fields
    expect(call.where).toHaveProperty('OR');
    const orClauses = call.where.OR as Array<Record<string, unknown>>;
    const nullFields = orClauses.map((c) => Object.keys(c)[0]);
    expect(nullFields).toContain('title');
    expect(nullFields).toContain('description');
    expect(nullFields).toContain('artistName');
  });

  it('does nothing when IpfsMetadata has no usable text fields', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmempty',
      title:       null,
      description: null,
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         {},       // no artist / creator / by
    });

    const backfill = await getBackfill();
    await backfill(11n, 'Qmempty');

    expect(mockPrisma.listing.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent — calling it twice writes nothing new on second call', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({
      cid:         'Qmidempotent',
      title:       'Title',
      description: 'Desc',
      imageUrl:    null,
      attributes:  null,
      fetchedAt:   new Date(),
      raw:         { artist: 'Artist' },
    });
    mockPrisma.listing.updateMany.mockResolvedValue({ count: 0 }); // already set

    const backfill = await getBackfill();
    await backfill(12n, 'Qmidempotent');
    await backfill(12n, 'Qmidempotent');

    // Both calls should be safe — two updateMany calls, each conditional
    expect(mockPrisma.listing.updateMany).toHaveBeenCalledTimes(2);
    // Both calls carry the conditional OR so they are always idempotent
    for (const [arg] of mockPrisma.listing.updateMany.mock.calls) {
      expect(arg.where).toHaveProperty('OR');
    }
  });
});
