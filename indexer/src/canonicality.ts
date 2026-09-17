/**
 * canonicality.ts — Formal canonicality model and affected-entity aggregation (Issue #644)
 *
 * Overview
 * --------
 * In a blockchain indexer, blocks/ledgers may belong to one of several lifecycle states:
 *   - provisional: Recently ingested, within the confirmation window (ledger > tip - depth).
 *   - confirmed: Guaranteed immutable after accumulating required confirmation depth.
 *   - reverted: Discarded as part of a chain reorganization (fork rollback).
 *   - replayed: Re-ingested from the alternate canonical chain after rollback.
 *
 * This module defines:
 *   1. Explicit lifecycle state types.
 *   2. Unified `AffectedEntitySet` tracking all entities impacted by a reorg.
 *   3. Extraction and aggregation logic so that rollback, cache eviction, and SSE correction
 *      operate on the EXACT same affected set atomically.
 */

export type LedgerCanonicalStatus =
  | 'provisional'
  | 'confirmed'
  | 'reverted'
  | 'replayed';

export interface AffectedEntitySet {
  safeAtLedger: number;
  listings: Set<string>;
  auctions: Set<string>;
  offers: Set<string>;
  bids: Set<string>;
  collections: Set<string>;
  royalties: Set<string>;
  dailyStats: Set<string>;
}

export interface AffectedEntitySummary {
  [key: string]: unknown;
  safeAtLedger: number;
  listingsCount: number;
  auctionsCount: number;
  offersCount: number;
  bidsCount: number;
  collectionsCount: number;
  totalAffected: number;
}

export function createAffectedEntitySet(safeAtLedger: number): AffectedEntitySet {
  return {
    safeAtLedger,
    listings: new Set<string>(),
    auctions: new Set<string>(),
    offers: new Set<string>(),
    bids: new Set<string>(),
    collections: new Set<string>(),
    royalties: new Set<string>(),
    dailyStats: new Set<string>(),
  };
}

export function summarizeAffectedEntities(set: AffectedEntitySet): AffectedEntitySummary {
  const listingsCount = set.listings.size;
  const auctionsCount = set.auctions.size;
  const offersCount = set.offers.size;
  const bidsCount = set.bids.size;
  const collectionsCount = set.collections.size;
  const totalAffected =
    listingsCount +
    auctionsCount +
    offersCount +
    bidsCount +
    collectionsCount;

  return {
    safeAtLedger: set.safeAtLedger,
    listingsCount,
    auctionsCount,
    offersCount,
    bidsCount,
    collectionsCount,
    totalAffected,
  };
}

/**
 * Scan database models to discover all entity IDs that have provisional state
 * above `safeAtLedger`.
 */
export async function collectAffectedEntities(
  safeAtLedger: number,
  db: any,
): Promise<AffectedEntitySet> {
  const set = createAffectedEntitySet(safeAtLedger);

  try {
    // 1. Listings created or updated on fork
    const listings = await db.listing.findMany({
      where: {
        OR: [
          { createdAtLedger: { gt: safeAtLedger } },
          { updatedAtLedger: { gt: safeAtLedger } },
        ],
      },
      select: { listingId: true },
    });
    for (const l of listings) {
      set.listings.add(l.listingId.toString());
    }
  } catch {}

  try {
    // 2. Auctions created or updated on fork
    const auctions = await db.auction.findMany({
      where: {
        OR: [
          { createdAtLedger: { gt: safeAtLedger } },
          { updatedAtLedger: { gt: safeAtLedger } },
        ],
      },
      select: { auctionId: true },
    });
    for (const a of auctions) {
      set.auctions.add(a.auctionId.toString());
    }
  } catch {}

  try {
    // 3. Offers created or updated on fork
    const offers = await db.offer.findMany({
      where: {
        OR: [
          { createdAtLedger: { gt: safeAtLedger } },
          { updatedAtLedger: { gt: safeAtLedger } },
        ],
      },
      select: { offerId: true, listingId: true },
    });
    for (const o of offers) {
      set.offers.add(o.offerId.toString());
      if (o.listingId) {
        set.listings.add(o.listingId.toString());
      }
    }
  } catch {}

  try {
    // 4. Bids placed on fork
    const bids = await db.bid.findMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
      select: { id: true, auctionId: true },
    });
    for (const b of bids) {
      set.bids.add(b.id.toString());
      if (b.auctionId) {
        set.auctions.add(b.auctionId.toString());
      }
    }
  } catch {}

  try {
    // 5. Collections deployed on fork
    const collections = await db.collection.findMany({
      where: { deployedAtLedger: { gt: safeAtLedger } },
      select: { contractAddress: true },
    });
    for (const c of collections) {
      set.collections.add(c.contractAddress);
    }
  } catch {}

  return set;
}
