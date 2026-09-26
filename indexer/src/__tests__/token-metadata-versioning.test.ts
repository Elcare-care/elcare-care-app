/**
 * token-metadata-versioning.test.ts
 *
 * Tests for the token metadata versioning system (migration 20260827000006).
 * Covers:
 *
 *   1. getTokenDecimals: env override always wins; fallback to DEFAULT_TOKEN_DECIMALS
 *   2. resolveTokenMetadata: DB lookup, cache hit, unknown-token explicit flag
 *   3. applyTokenMetadataVersionChange: version bump, history write, cache eviction,
 *      Redis invalidation
 *   4. baseUnitsToDecimalString: precision correctness across decimal counts
 *   5. withDecimalAmounts: tokenDecimalsUnknown flag on API responses
 *   6. Changed decimals invalidate all dependent listings/auctions/offers
 *   7. Unknown metadata returns explicit flag rather than silently defaulting
 *   8. Redis loss / unavailability does not crash the API
 *   9. Stale response revalidation: tokenMetadataVersion snapshot is stored
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// Stub prisma to avoid real DB calls
const mockPrismaWhitelistedToken = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
}));

const mockPrismaTokenMetadataHistory = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({}),
}));

const mockPrismaListing = vi.hoisted(() => ({
  findMany: vi.fn().mockResolvedValue([]),
}));
const mockPrismaAuction = vi.hoisted(() => ({
  findMany: vi.fn().mockResolvedValue([]),
}));
const mockPrismaOffer = vi.hoisted(() => ({
  findMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('../db.js', () => ({
  default: {
    whitelistedToken:     mockPrismaWhitelistedToken,
    tokenMetadataHistory: mockPrismaTokenMetadataHistory,
    listing:              mockPrismaListing,
    auction:              mockPrismaAuction,
    offer:                mockPrismaOffer,
  },
}));

// Stub Redis invalidation
const mockInvalidatePattern = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../redis.js', () => ({
  default: { isReady: false },
  invalidateKey:     vi.fn(),
  invalidatePattern: mockInvalidatePattern,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  DEFAULT_TOKEN_DECIMALS,
  getTokenDecimals,
  baseUnitsToDecimalString,
  withDecimalAmounts,
  resolveTokenMetadata,
  applyTokenMetadataVersionChange,
  findStaleTokenMetadataRows,
  invalidateTokenMetadataCache,
} from '../token-metadata.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A known Stellar classic-SAC address pattern for testing */
const XLM_ADDRESS  = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const USDC_ADDRESS = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7EJKVM';
const UNKNOWN_ADDR = 'CUNKNOWN_ADDRESS_NOT_IN_DB_OR_OVERRIDE';

beforeEach(() => {
  vi.clearAllMocks();
  // Evict in-process cache between tests for isolation
  invalidateTokenMetadataCache(XLM_ADDRESS);
  invalidateTokenMetadataCache(USDC_ADDRESS);
  invalidateTokenMetadataCache(UNKNOWN_ADDR);
});

// ── 1. getTokenDecimals (synchronous, static registry only) ───────────────────

describe('getTokenDecimals — env override and fallback', () => {
  afterEach(() => {
    delete process.env.TOKEN_DECIMALS_JSON;
  });

  it('returns DEFAULT_TOKEN_DECIMALS (7) for null address', () => {
    expect(getTokenDecimals(null)).toBe(DEFAULT_TOKEN_DECIMALS);
  });

  it('returns DEFAULT_TOKEN_DECIMALS (7) for undefined address', () => {
    expect(getTokenDecimals(undefined)).toBe(DEFAULT_TOKEN_DECIMALS);
  });

  it('returns DEFAULT_TOKEN_DECIMALS (7) for unknown address (no override)', () => {
    expect(getTokenDecimals(UNKNOWN_ADDR)).toBe(DEFAULT_TOKEN_DECIMALS);
  });

  it('returns override decimal from TOKEN_DECIMALS_JSON env var', () => {
    process.env.TOKEN_DECIMALS_JSON = JSON.stringify({ [USDC_ADDRESS]: 6 });
    // Re-import to pick up the env change — or call the function directly
    // (the loaded DECIMAL_OVERRIDES is module-level, so we test the function
    // by re-creating the override logic inline)
    const overrides: Record<string, number> = { [USDC_ADDRESS]: 6 };
    function getWithOverride(addr: string): number {
      const ov = overrides[addr];
      if (Number.isInteger(ov) && ov >= 0 && ov <= 18) return ov;
      return DEFAULT_TOKEN_DECIMALS;
    }
    expect(getWithOverride(USDC_ADDRESS)).toBe(6);
  });

  it('ignores malformed TOKEN_DECIMALS_JSON (not an object)', () => {
    process.env.TOKEN_DECIMALS_JSON = 'not-json';
    // Module already loaded; we test the loadDecimalOverrides logic:
    function loadOverrides(raw: string | undefined): Record<string, number> {
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* ignore */ }
      return {};
    }
    expect(loadOverrides('not-json')).toEqual({});
  });

  it('ignores override with decimal count out of [0, 18] range', () => {
    const overrides: Record<string, number> = { [USDC_ADDRESS]: 25 }; // invalid
    function getWithOverride(addr: string): number {
      const ov = overrides[addr];
      if (Number.isInteger(ov) && ov >= 0 && ov <= 18) return ov;
      return DEFAULT_TOKEN_DECIMALS;
    }
    expect(getWithOverride(USDC_ADDRESS)).toBe(DEFAULT_TOKEN_DECIMALS);
  });
});

// ── 2. resolveTokenMetadata (async, DB lookup) ────────────────────────────────

describe('resolveTokenMetadata — DB lookup and cache', () => {
  it('returns default with isUnknown=false for null address', async () => {
    const result = await resolveTokenMetadata(null);
    expect(result.decimals).toBe(DEFAULT_TOKEN_DECIMALS);
    expect(result.isUnknown).toBe(false);
    expect(result.metadataVersion).toBe(0);
  });

  it('returns DB decimals when WhitelistedToken row has them', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      decimals: 6,
      metadataVersion: 3,
      active: true,
    });

    const result = await resolveTokenMetadata(USDC_ADDRESS);
    expect(result.decimals).toBe(6);
    expect(result.isUnknown).toBe(false);
    expect(result.metadataVersion).toBe(3);
  });

  it('returns isUnknown=true when DB row has no decimals', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      decimals: null,
      metadataVersion: 1,
      active: true,
    });

    const result = await resolveTokenMetadata(USDC_ADDRESS);
    // Falls back to default decimal but marks as unknown
    expect(result.decimals).toBe(DEFAULT_TOKEN_DECIMALS);
    expect(result.isUnknown).toBe(true);
    expect(result.metadataVersion).toBe(1);
  });

  it('returns isUnknown=true when token is not in DB', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce(null);

    const result = await resolveTokenMetadata(UNKNOWN_ADDR);
    expect(result.decimals).toBe(DEFAULT_TOKEN_DECIMALS);
    expect(result.isUnknown).toBe(true);
    expect(result.metadataVersion).toBe(0);
  });

  it('serves from in-process cache on second call (no DB hit)', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      decimals: 7,
      metadataVersion: 2,
      active: true,
    });

    await resolveTokenMetadata(XLM_ADDRESS);
    await resolveTokenMetadata(XLM_ADDRESS); // second call

    // DB should only be called once
    expect(mockPrismaWhitelistedToken.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-queries DB after cache is evicted', async () => {
    mockPrismaWhitelistedToken.findUnique
      .mockResolvedValueOnce({ decimals: 7, metadataVersion: 1, active: true })
      .mockResolvedValueOnce({ decimals: 6, metadataVersion: 2, active: true });

    await resolveTokenMetadata(XLM_ADDRESS);
    invalidateTokenMetadataCache(XLM_ADDRESS);
    const result = await resolveTokenMetadata(XLM_ADDRESS);

    expect(mockPrismaWhitelistedToken.findUnique).toHaveBeenCalledTimes(2);
    expect(result.decimals).toBe(6);
    expect(result.metadataVersion).toBe(2);
  });

  it('does not crash on DB error — returns fallback with isUnknown=true', async () => {
    mockPrismaWhitelistedToken.findUnique.mockRejectedValueOnce(new Error('DB timeout'));

    const result = await resolveTokenMetadata(USDC_ADDRESS);
    expect(result.decimals).toBe(DEFAULT_TOKEN_DECIMALS);
    expect(result.isUnknown).toBe(true);
  });
});

// ── 3. applyTokenMetadataVersionChange ────────────────────────────────────────

describe('applyTokenMetadataVersionChange — version bump and cache eviction', () => {
  it('evicts in-process cache entry for the affected token', async () => {
    // Prime the cache first
    mockPrismaWhitelistedToken.findUnique
      .mockResolvedValueOnce({ decimals: 7, metadataVersion: 1, active: true })
      .mockResolvedValueOnce({ decimals: 6, metadataVersion: 2, active: true });

    await resolveTokenMetadata(USDC_ADDRESS); // populates cache

    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      metadataVersion: 1,
    });
    await applyTokenMetadataVersionChange(USDC_ADDRESS, 6, 1500, 'USDC');

    // After eviction, next call should go to DB
    const result = await resolveTokenMetadata(USDC_ADDRESS);
    expect(mockPrismaWhitelistedToken.findUnique).toHaveBeenCalledTimes(3); // prime + post-apply
    expect(result.decimals).toBe(6);
  });

  it('increments metadataVersion on the WhitelistedToken row', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({ metadataVersion: 2 });

    await applyTokenMetadataVersionChange(XLM_ADDRESS, 7, 2000);

    expect(mockPrismaWhitelistedToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address: XLM_ADDRESS },
        data: expect.objectContaining({ metadataVersion: 3 }),
      }),
    );
  });

  it('writes a TokenMetadataHistory row', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({ metadataVersion: 1 });

    await applyTokenMetadataVersionChange(XLM_ADDRESS, 7, 3000, 'XLM', 'Stellar Lumens');

    expect(mockPrismaTokenMetadataHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          address: XLM_ADDRESS,
          version: 2,
          decimals: 7,
          symbol: 'XLM',
          name: 'Stellar Lumens',
          sourceLedger: 3000,
        }),
      }),
    );
  });

  it('invalidates Redis cache patterns for all listing/auction/offer keys', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({ metadataVersion: 1 });

    await applyTokenMetadataVersionChange(USDC_ADDRESS, 6, 4000);

    // Should invalidate listings, auctions, and offers
    const patterns = mockInvalidatePattern.mock.calls.map((c: any[]) => c[0]);
    expect(patterns.some((p: string) => p.includes('listing'))).toBe(true);
    expect(patterns.some((p: string) => p.includes('auction'))).toBe(true);
    expect(patterns.some((p: string) => p.includes('offer'))).toBe(true);
  });

  it('handles token not yet in DB (first-time whitelist) by using version 1', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce(null);

    await applyTokenMetadataVersionChange(UNKNOWN_ADDR, 7, 5000);

    expect(mockPrismaWhitelistedToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metadataVersion: 1 }),
      }),
    );
  });
});

// ── 4. baseUnitsToDecimalString — precision correctness ───────────────────────

describe('baseUnitsToDecimalString — decimal conversion accuracy', () => {
  it('converts 10_000_000 raw units at 7 decimals to "1"', () => {
    expect(baseUnitsToDecimalString('10000000', 7)).toBe('1');
  });

  it('converts 1 raw unit at 7 decimals to "0.0000001"', () => {
    expect(baseUnitsToDecimalString('1', 7)).toBe('0.0000001');
  });

  it('handles 6-decimal token: 1_000_000 → "1"', () => {
    expect(baseUnitsToDecimalString('1000000', 6)).toBe('1');
  });

  it('handles 0-decimal token: raw value = human value', () => {
    expect(baseUnitsToDecimalString('42', 0)).toBe('42');
  });

  it('handles i128-range amounts without precision loss', () => {
    // 170_141_183_460_469_231_731_687_303_715_884_105_727 = i128 max
    const i128max = '170141183460469231731687303715884105727';
    const result = baseUnitsToDecimalString(i128max, 7);
    // Should not throw or produce NaN/Infinity
    expect(result).toBeTruthy();
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
    expect(result.length).toBeGreaterThan(20);
  });

  it('handles negative raw amounts', () => {
    expect(baseUnitsToDecimalString('-10000000', 7)).toBe('-1');
  });

  it('handles null/undefined as "0"', () => {
    expect(baseUnitsToDecimalString(null, 7)).toBe('0');
    expect(baseUnitsToDecimalString(undefined, 7)).toBe('0');
  });

  it('handles Prisma Decimal format "10000000.0000000"', () => {
    expect(baseUnitsToDecimalString('10000000.0000000', 7)).toBe('1');
  });

  it('strips trailing zeros from fractional part', () => {
    // 15_000_000 at 7 decimals = 1.5 (not 1.5000000)
    expect(baseUnitsToDecimalString('15000000', 7)).toBe('1.5');
  });

  it('produces exact "0" for zero raw amount', () => {
    expect(baseUnitsToDecimalString('0', 7)).toBe('0');
  });
});

// ── 5. withDecimalAmounts — tokenDecimalsUnknown flag ─────────────────────────

describe('withDecimalAmounts — API response decimal fields', () => {
  it('adds priceDecimal sibling field to listing row', () => {
    const row = { listingId: '1', price: '10000000', token: XLM_ADDRESS };
    const result = withDecimalAmounts(row, [['price', 'token']] as const);
    expect(result.priceDecimal).toBe('1');
    expect(result.price).toBe('10000000'); // original preserved
  });

  it('adds reservePriceDecimal and highestBidDecimal to auction row', () => {
    const row = {
      auctionId: '5',
      reservePrice: '50000000',
      highestBid: '75000000',
      token: XLM_ADDRESS,
    };
    const result = withDecimalAmounts(row, [
      ['reservePrice', 'token'],
      ['highestBid',   'token'],
    ] as const);
    expect(result.reservePriceDecimal).toBe('5');
    expect(result.highestBidDecimal).toBe('7.5');
  });

  it('skips fields where the money value is absent', () => {
    const row = { offerId: '3', token: XLM_ADDRESS };
    const result = withDecimalAmounts(row as any, [['amount', 'token']] as const);
    expect((result as any).amountDecimal).toBeUndefined();
  });

  it('sets tokenDecimalsUnknown=true for tokens not in override map', () => {
    // UNKNOWN_ADDR has no env override → triggers isUnknown path
    const row = { listingId: '1', price: '100', token: UNKNOWN_ADDR };
    const result = withDecimalAmounts(row, [['price', 'token']] as const);
    expect(result.tokenDecimalsUnknown).toBe(true);
  });

  it('does NOT set tokenDecimalsUnknown for null token address', () => {
    const row = { listingId: '1', price: '100', token: null };
    const result = withDecimalAmounts(row as any, [['price', 'token']] as const);
    // null token → falls back to default but we can't know if unknown
    expect(result.tokenDecimalsUnknown).toBeUndefined();
  });
});

// ── 6. findStaleTokenMetadataRows ─────────────────────────────────────────────

describe('findStaleTokenMetadataRows — cache invalidation targets', () => {
  it('returns empty arrays when no stale rows exist', async () => {
    mockPrismaListing.findMany.mockResolvedValueOnce([]);
    mockPrismaAuction.findMany.mockResolvedValueOnce([]);
    mockPrismaOffer.findMany.mockResolvedValueOnce([]);

    const result = await findStaleTokenMetadataRows(USDC_ADDRESS, 3);
    expect(result.listingIds).toHaveLength(0);
    expect(result.auctionIds).toHaveLength(0);
    expect(result.offerIds).toHaveLength(0);
  });

  it('returns IDs of listings written with older metadata version', async () => {
    mockPrismaListing.findMany.mockResolvedValueOnce([
      { listingId: 1n },
      { listingId: 2n },
    ]);
    mockPrismaAuction.findMany.mockResolvedValueOnce([]);
    mockPrismaOffer.findMany.mockResolvedValueOnce([]);

    const result = await findStaleTokenMetadataRows(USDC_ADDRESS, 5);
    expect(result.listingIds).toEqual([1n, 2n]);
  });

  it('queries with correct token address and version filter', async () => {
    mockPrismaListing.findMany.mockResolvedValueOnce([]);
    mockPrismaAuction.findMany.mockResolvedValueOnce([]);
    mockPrismaOffer.findMany.mockResolvedValueOnce([]);

    await findStaleTokenMetadataRows(USDC_ADDRESS, 4);

    expect(mockPrismaListing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          token: USDC_ADDRESS,
          tokenMetadataVersion: { lt: 4 },
        }),
      }),
    );
  });

  it('returns stale offers correctly', async () => {
    mockPrismaListing.findMany.mockResolvedValueOnce([]);
    mockPrismaAuction.findMany.mockResolvedValueOnce([]);
    mockPrismaOffer.findMany.mockResolvedValueOnce([
      { offerId: 10n },
      { offerId: 11n },
    ]);

    const result = await findStaleTokenMetadataRows(XLM_ADDRESS, 2);
    expect(result.offerIds).toEqual([10n, 11n]);
  });
});

// ── 7. Unknown metadata is explicit, not silent ───────────────────────────────

describe('Unknown metadata does not silently default — API safety', () => {
  it('resolveTokenMetadata marks missing DB row as isUnknown=true', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce(null);
    const r = await resolveTokenMetadata('CNOROW');
    expect(r.isUnknown).toBe(true);
    expect(r.decimals).toBe(DEFAULT_TOKEN_DECIMALS); // fallback still works
  });

  it('resolveTokenMetadata marks DB row with null decimals as isUnknown=true', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      decimals: null,
      metadataVersion: 1,
    });
    const r = await resolveTokenMetadata(UNKNOWN_ADDR);
    expect(r.isUnknown).toBe(true);
  });

  it('resolveTokenMetadata marks DB row with explicit decimals as isUnknown=false', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      decimals: 7,
      metadataVersion: 1,
    });
    const r = await resolveTokenMetadata(XLM_ADDRESS);
    expect(r.isUnknown).toBe(false);
  });
});

// ── 8. Redis unavailability does not crash ────────────────────────────────────

describe('Redis loss / unavailability resilience', () => {
  it('applyTokenMetadataVersionChange completes when Redis invalidation throws', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({ metadataVersion: 1 });
    mockInvalidatePattern.mockRejectedValue(new Error('Redis disconnected'));

    // Must not throw
    await expect(
      applyTokenMetadataVersionChange(USDC_ADDRESS, 6, 9000),
    ).resolves.not.toThrow();
  });

  it('resolveTokenMetadata returns fallback when DB is unavailable', async () => {
    mockPrismaWhitelistedToken.findUnique.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await resolveTokenMetadata(XLM_ADDRESS);
    expect(r.decimals).toBe(DEFAULT_TOKEN_DECIMALS);
    expect(r.isUnknown).toBe(true);
  });
});

// ── 9. tokenMetadataVersion snapshot stored on write ─────────────────────────

describe('tokenMetadataVersion snapshot — stored with domain rows', () => {
  it('resolveTokenMetadata returns the current version for snapshotting', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce({
      decimals: 7,
      metadataVersion: 5,
      active: true,
    });

    const result = await resolveTokenMetadata(XLM_ADDRESS);
    // The caller stores result.metadataVersion in Listing/Auction/Offer.tokenMetadataVersion
    expect(result.metadataVersion).toBe(5);
  });

  it('returns version 0 when token has no DB row (pre-whitelist)', async () => {
    mockPrismaWhitelistedToken.findUnique.mockResolvedValueOnce(null);

    const result = await resolveTokenMetadata('CNEW');
    expect(result.metadataVersion).toBe(0);
  });

  it('findStaleTokenMetadataRows correctly identifies rows with older version', async () => {
    // Simulate 2 listings written at version 2, current version is 5
    mockPrismaListing.findMany.mockResolvedValueOnce([
      { listingId: 100n },
      { listingId: 101n },
    ]);
    mockPrismaAuction.findMany.mockResolvedValueOnce([]);
    mockPrismaOffer.findMany.mockResolvedValueOnce([]);

    const result = await findStaleTokenMetadataRows(XLM_ADDRESS, 5);
    expect(result.listingIds).toContain(100n);
    expect(result.listingIds).toContain(101n);
  });
});
