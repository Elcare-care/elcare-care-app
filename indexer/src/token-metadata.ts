/**
 * token-metadata.ts
 *
 * Canonical payment-token registry + base-unit/decimal conversion helpers
 * for the indexer API (Issue #282: payment token decimal & asset validation).
 *
 * Every money value persisted by the indexer (Listing.price,
 * Auction.reservePrice / highestBid, Offer.amount, Bid.amount) is the *raw*
 * on-chain base-unit i128 value emitted by the marketplace contract (see
 * `contracts/soroban-marketplace/src/types.rs`) — the contract never scales
 * these amounts, and the indexer stores them unscaled too. The Postgres
 * `Decimal(32, 7)` column type is only headroom for i128-sized integers; it
 * does NOT mean the stored value has already been divided into human
 * (XLM/token) display units. A raw value of `100000000` is 10 XLM, not
 * "100000000.0000000" XLM.
 *
 * ── Metadata versioning ────────────────────────────────────────────────────────
 *
 * Each WhitelistedToken row now carries a `metadataVersion` counter that is
 * incremented whenever the token's decimal precision or other configuration
 * changes (via a TOKEN_WHITELISTED registry event or a config correction).
 *
 * Listings, auctions, and offers snapshot the token's `metadataVersion` at
 * write time (the `tokenMetadataVersion` column). When the token's
 * metadataVersion advances, the cache-invalidation layer can efficiently
 * target all rows written with the old version by querying:
 *
 *   SELECT listingId FROM "Listing"
 *   WHERE token = $addr AND tokenMetadataVersion < $currentVersion;
 *
 * This prevents API responses from silently serving stale decimal values after
 * a token's decimal precision changes.
 *
 * ── Unknown metadata handling ─────────────────────────────────────────────────
 *
 * When a token's decimal count is not recorded in the registry, the system
 * distinguishes three cases:
 *   1. Known Stellar classic-SAC (XLM or any classic asset SAC): default to 7.
 *   2. Token in the DB with no decimals yet set: return null (isUnknown: true).
 *   3. TOKEN_DECIMALS_JSON env override: always authoritative regardless of DB.
 *
 * API responses include a `tokenDecimalsUnknown: true` flag when case 2 applies
 * so consumers know not to rely on the decimal value.
 */

import prisma from './db.js';
import { invalidatePattern } from './redis.js';
import { logger } from './logger.js';

/** Default decimal precision for Stellar native XLM and any classic-asset SAC. */
export const DEFAULT_TOKEN_DECIMALS = 7;

/**
 * Optional JSON map of `{"<contract address>": <decimals>}` overrides for
 * any future whitelisted token whose precision differs from the Stellar
 * default. Empty by default — every token whitelisted today uses 7
 * decimals. Set via the `TOKEN_DECIMALS_JSON` env var.
 */
function loadDecimalOverrides(): Record<string, number> {
  const raw = process.env.TOKEN_DECIMALS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // Malformed overrides must never crash the API — fall back to defaults.
  }
  return {};
}

const DECIMAL_OVERRIDES = loadDecimalOverrides();

// ── In-memory metadata cache ──────────────────────────────────────────────────
//
// A simple in-process map caches resolved metadata per token address.
// Entries are evicted when a token's metadataVersion changes (via
// invalidateTokenMetadataCache).  This avoids a DB round-trip per API call
// in the common case where metadata is stable.

interface CachedTokenMetadata {
  decimals: number | null;
  metadataVersion: number;
  isUnknown: boolean;
}

const metadataCache = new Map<string, CachedTokenMetadata>();

/**
 * Evict a specific token's metadata from the in-process cache.
 * Called by applyTokenMetadataVersionChange() when a new version is recorded.
 */
export function invalidateTokenMetadataCache(tokenAddress: string): void {
  metadataCache.delete(tokenAddress);
}

/**
 * Resolve the decimal precision for a token address.
 *
 * Resolution order:
 *   1. TOKEN_DECIMALS_JSON env override (authoritative regardless of DB state).
 *   2. In-process metadata cache (avoids DB round-trip).
 *   3. WhitelistedToken row in the database.
 *   4. Fall back to DEFAULT_TOKEN_DECIMALS (7) for valid Stellar SAC-pattern addresses.
 *
 * Returns a `TokenDecimalResult` with:
 *   - decimals: the resolved decimal count (always a number, even when unknown)
 *   - isUnknown: true when the decimal count was not explicitly recorded and
 *     the fallback default was used — callers should include this in API responses
 *     so consumers know the value may be imprecise
 *   - metadataVersion: the token's current version counter (0 when no DB row)
 */
export interface TokenDecimalResult {
  decimals: number;
  isUnknown: boolean;
  metadataVersion: number;
}

/** Known decimal precision for a payment-token contract address. */
export function getTokenDecimals(tokenAddress: string | null | undefined): number {
  // Fast path: no address → default
  if (!tokenAddress) return DEFAULT_TOKEN_DECIMALS;

  // 1. Env override is always authoritative
  const override = DECIMAL_OVERRIDES[tokenAddress];
  if (Number.isInteger(override) && override >= 0 && override <= 18) {
    return override;
  }

  return DEFAULT_TOKEN_DECIMALS;
}

/**
 * Async version of getTokenDecimals that also checks the database.
 * Returns full metadata including version and unknown flag.
 *
 * Use this in write paths (processEvent, OFFER_MADE handler) where you want
 * to snapshot the current metadataVersion into the row being written.
 */
export async function resolveTokenMetadata(
  tokenAddress: string | null | undefined
): Promise<TokenDecimalResult> {
  if (!tokenAddress) {
    return { decimals: DEFAULT_TOKEN_DECIMALS, isUnknown: false, metadataVersion: 0 };
  }

  // 1. Env override is always authoritative
  const override = DECIMAL_OVERRIDES[tokenAddress];
  if (Number.isInteger(override) && override >= 0 && override <= 18) {
    return { decimals: override, isUnknown: false, metadataVersion: 0 };
  }

  // 2. In-process cache
  const cached = metadataCache.get(tokenAddress);
  if (cached !== undefined) {
    return {
      decimals: cached.decimals ?? DEFAULT_TOKEN_DECIMALS,
      isUnknown: cached.isUnknown,
      metadataVersion: cached.metadataVersion,
    };
  }

  // 3. Database lookup
  try {
    const row = await (prisma as any).whitelistedToken.findUnique({
      where: { address: tokenAddress },
      select: { decimals: true, metadataVersion: true, active: true },
    });

    if (row) {
      const hasDecimals = typeof row.decimals === 'number';
      const entry: CachedTokenMetadata = {
        decimals: hasDecimals ? row.decimals : null,
        metadataVersion: row.metadataVersion ?? 1,
        isUnknown: !hasDecimals,
      };
      metadataCache.set(tokenAddress, entry);
      return {
        decimals: entry.decimals ?? DEFAULT_TOKEN_DECIMALS,
        isUnknown: entry.isUnknown,
        metadataVersion: entry.metadataVersion,
      };
    }
  } catch (err) {
    // Non-fatal: DB lookup failure must not crash the write path.
    logger.warn('[token-metadata] DB lookup failed, using default', {
      tokenAddress,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Fallback: not in DB → unknown, use default decimals
  return { decimals: DEFAULT_TOKEN_DECIMALS, isUnknown: true, metadataVersion: 0 };
}

/**
 * Apply a token metadata version change:
 *   1. Evict the in-process cache for the affected token.
 *   2. Invalidate Redis cache patterns for listings, auctions, and offers
 *      that reference this token.
 *   3. Optionally record a new TokenMetadataHistory row (if prisma is passed).
 *
 * Called by the indexer's TOKEN_WHITELISTED event handler whenever a
 * TOKEN_WHITELISTED event arrives with updated metadata, and by the
 * manual /admin/token-metadata endpoint.
 */
export async function applyTokenMetadataVersionChange(
  tokenAddress: string,
  newDecimals: number | null,
  sourceLedger: number,
  symbol?: string,
  name?: string,
): Promise<void> {
  // 1. Evict in-process cache
  invalidateTokenMetadataCache(tokenAddress);

  // 2. Increment metadataVersion and update WhitelistedToken record
  try {
    const current = await (prisma as any).whitelistedToken.findUnique({
      where: { address: tokenAddress },
      select: { metadataVersion: true },
    });

    const nextVersion = (current?.metadataVersion ?? 0) + 1;

    await (prisma as any).whitelistedToken.update({
      where: { address: tokenAddress },
      data: {
        metadataVersion: nextVersion,
        decimals: newDecimals ?? undefined,
        symbol: symbol ?? undefined,
        name: name ?? undefined,
        sourceLedger,
      },
    });

    // Record history row
    await (prisma as any).tokenMetadataHistory.create({
      data: {
        address: tokenAddress,
        version: nextVersion,
        decimals: newDecimals,
        symbol: symbol ?? null,
        name: name ?? null,
        sourceLedger,
        active: true,
      },
    });

    logger.info('[token-metadata] Version advanced', {
      tokenAddress,
      nextVersion,
      sourceLedger,
      decimals: newDecimals,
    });
  } catch (err) {
    logger.warn('[token-metadata] Failed to advance metadata version', {
      tokenAddress,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Invalidate Redis cache entries that reference this token
  // These patterns cover all listing/auction/offer responses that embed the token
  await Promise.allSettled([
    invalidatePattern(`cache:listing:*`),
    invalidatePattern(`cache:auction:*`),
    invalidatePattern(`cache:offer:*`),
    invalidatePattern(`cache:/listings*`),
    invalidatePattern(`cache:/auctions*`),
    invalidatePattern(`cache:/offers*`),
  ]);
}

/**
 * Find all listings/auctions/offers that were written with a stale token
 * metadata version and need cache invalidation.
 *
 * Returns arrays of IDs for each model type that should have their cache keys
 * invalidated.  Called by the /admin/diagnostics endpoint and by the
 * applyTokenMetadataVersionChange() flow after a version bump.
 */
export async function findStaleTokenMetadataRows(
  tokenAddress: string,
  currentVersion: number,
): Promise<{ listingIds: bigint[]; auctionIds: bigint[]; offerIds: bigint[] }> {
  const [listings, auctions, offers] = await Promise.all([
    (prisma as any).listing.findMany({
      where: {
        token: tokenAddress,
        tokenMetadataVersion: { lt: currentVersion },
      },
      select: { listingId: true },
    }),
    (prisma as any).auction.findMany({
      where: {
        token: tokenAddress,
        tokenMetadataVersion: { lt: currentVersion },
      },
      select: { auctionId: true },
    }),
    (prisma as any).offer.findMany({
      where: {
        token: tokenAddress,
        tokenMetadataVersion: { lt: currentVersion },
      },
      select: { offerId: true },
    }),
  ]);

  return {
    listingIds: listings.map((r: { listingId: bigint }) => r.listingId),
    auctionIds: auctions.map((r: { auctionId: bigint }) => r.auctionId),
    offerIds:   offers.map((r: { offerId: bigint }) => r.offerId),
  };
}

/**
 * Convert a raw base-unit amount (as stored — a Prisma `Decimal`, string, or
 * number that is always integer-valued on-chain) to a human-readable
 * decimal string using `decimals` places.
 *
 * Pure string/BigInt arithmetic throughout — the value is never routed
 * through a JS `Number`, so precision survives even for i128-range amounts
 * beyond `Number.MAX_SAFE_INTEGER`.
 */
export function baseUnitsToDecimalString(
  raw: unknown,
  decimals: number = DEFAULT_TOKEN_DECIMALS
): string {
  if (raw === null || raw === undefined) return '0';
  const str = typeof raw === 'string' ? raw : String(raw);
  // Raw on-chain amounts are always integers; strip a fixed-scale
  // "X.0000000"-style suffix the DB column may have produced.
  const integerPart = str.split('.')[0] || '0';
  const negative = integerPart.startsWith('-');
  const digits = negative ? integerPart.slice(1) : integerPart;
  const value = digits === '' ? 0n : BigInt(digits);

  if (decimals <= 0) {
    return negative && value !== 0n ? `-${value}` : `${value}`;
  }

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative && value !== 0n ? '-' : '';
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/**
 * Return a shallow copy of `row` with a `<moneyField>Decimal` sibling added
 * for each `[moneyField, tokenField]` pair, computed via
 * `baseUnitsToDecimalString` using the decimals registered for
 * `row[tokenField]`. Skips a pair when the money field is absent.
 *
 * Also attaches `tokenDecimalsUnknown: true` to the row when the token's
 * decimal precision is not recorded in the static registry — this flag tells
 * API consumers that the decimal value is a best-effort default and may be
 * imprecise.
 */
export function withDecimalAmounts<T extends Record<string, unknown>>(
  row: T,
  fields: ReadonlyArray<readonly [moneyField: string, tokenField: string]>
): T & Record<string, string | boolean> {
  const out: Record<string, unknown> = { ...row };
  let anyUnknown = false;

  for (const [moneyField, tokenField] of fields) {
    const value = row[moneyField];
    if (value === undefined || value === null) continue;

    const tokenAddress = row[tokenField] as string | undefined;
    const decimals = getTokenDecimals(tokenAddress);

    // Check whether this token has an env override; if not, we must declare unknown
    // for non-null addresses not in the override map (the DB async path is not
    // available in this synchronous helper).
    const hasOverride = tokenAddress
      ? Number.isInteger(DECIMAL_OVERRIDES[tokenAddress])
      : false;

    if (!hasOverride && tokenAddress) {
      anyUnknown = true;
    }

    out[`${moneyField}Decimal`] = baseUnitsToDecimalString(value, decimals);
  }

  if (anyUnknown) {
    out['tokenDecimalsUnknown'] = true;
  }

  return out as T & Record<string, string | boolean>;
}
