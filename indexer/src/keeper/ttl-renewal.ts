/**
 * keeper/ttl-renewal.ts
 *
 * TTL renewal keeper module (Issue #280).
 *
 * Discovers storage entries (listings, auctions, offers) that are within
 * 50,000 ledgers of their TTL expiry and calls renew_storage to extend them.
 * This prevents active entries from expiring silently due to lack of access.
 *
 * TTL constants (from contract):
 *   LISTING_TTL_LEDGERS: 2,073,600 (120 days)
 *   AUCTION_TTL_LEDGERS: 1,036,800 (60 days)
 *   OFFER_TTL_LEDGERS: 1,036,800 (60 days)
 *
 * Danger window: 50,000 ledgers before expiry
 */

import { rpc, Contract, TransactionBuilder, BASE_FEE, Account, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import prisma from '../db.js';
import { logger } from '../logger.js';
import { elcarehubEntriesNearExpiry } from '../metrics.js';
import type { KeeperCandidate } from './types.js';

// TTL constants from the contract (in ledgers)
const LISTING_TTL_LEDGERS = 2_073_600;  // 120 days
const AUCTION_TTL_LEDGERS = 1_036_800;   // 60 days
const OFFER_TTL_LEDGERS = 1_036_800;     // 60 days

// Danger window: renew entries within this many ledgers of expiry
const DANGER_WINDOW_LEDGERS = 50_000;

// Maximum entries to renew per cycle (bounded to prevent abuse)
const MAX_RENEWALS_PER_CYCLE = 100;

/**
 * Discover entries that need TTL renewal.
 *
 * Reads active listings and auctions from the database, calculates their
 * expiry based on createdAtLedger + TTL constants, and returns those within
 * the danger window.
 */
export async function discoverTtlRenewalCandidates(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
): Promise<KeeperCandidate[]> {
  const currentLedger = await server.getLatestLedger();
  const currentSequence = currentLedger.sequence;
  
  const candidates: KeeperCandidate[] = [];
  let nearExpiryCount = 0;

  // Check active listings
  const activeListings = await prisma.listing.findMany({
    where: { status: 'Active' },
    select: { id: true, createdAtLedger: true },
    take: MAX_RENEWALS_PER_CYCLE,
  });

  for (const listing of activeListings) {
    const age = currentSequence - BigInt(listing.createdAtLedger);
    const remaining = LISTING_TTL_LEDGERS - Number(age);
    
    if (remaining <= DANGER_WINDOW_LEDGERS && remaining > 0) {
      candidates.push({
        targetType: 'RenewStorage',
        targetId: BigInt(listing.id),
      });
      nearExpiryCount++;
    }
  }

  // Check active auctions
  const activeAuctions = await prisma.auction.findMany({
    where: { status: 'Active' },
    select: { id: true, createdAtLedger: true },
    take: MAX_RENEWALS_PER_CYCLE,
  });

  for (const auction of activeAuctions) {
    const age = currentSequence - BigInt(auction.createdAtLedger);
    const remaining = AUCTION_TTL_LEDGERS - Number(age);
    
    if (remaining <= DANGER_WINDOW_LEDGERS && remaining > 0) {
      candidates.push({
        targetType: 'RenewStorage',
        targetId: BigInt(auction.id),
      });
      nearExpiryCount++;
    }
  }

  // Check pending offers
  const pendingOffers = await prisma.offer.findMany({
    where: { status: 'Pending' },
    select: { id: true, createdAtLedger: true },
    take: MAX_RENEWALS_PER_CYCLE,
  });

  for (const offer of pendingOffers) {
    const age = currentSequence - BigInt(offer.createdAtLedger);
    const remaining = OFFER_TTL_LEDGERS - Number(age);
    
    if (remaining <= DANGER_WINDOW_LEDGERS && remaining > 0) {
      candidates.push({
        targetType: 'RenewStorage',
        targetId: BigInt(offer.id),
      });
      nearExpiryCount++;
    }
  }

  // Update Prometheus gauge
  elcarehubEntriesNearExpiry.set(nearExpiryCount);

  logger.info('ttl-renewal: discovered candidates', {
    total: candidates.length,
    nearExpiry: nearExpiryCount,
    currentLedger: currentSequence,
  });

  return candidates.slice(0, MAX_RENEWALS_PER_CYCLE);
}

/**
 * Build a renew_storage transaction for the given candidates.
 *
 * Groups candidates by type (listings, auctions, offers) and calls
 * renew_storage with the appropriate ID vectors.
 */
export async function buildRenewStorageTransaction(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  sourceAccount: Account,
  candidates: KeeperCandidate[],
): Promise<rpc.Transaction> {
  const contract = new Contract(contractId);
  
  // Separate candidates by type
  const listingIds: bigint[] = [];
  const auctionIds: bigint[] = [];
  const offerIds: bigint[] = [];

  for (const candidate of candidates) {
    // For now, we need to determine the type from the database
    // In a real implementation, we'd store the type in the candidate
    const listing = await prisma.listing.findUnique({
      where: { id: Number(candidate.targetId) },
      select: { status: true },
    });
    
    if (listing && listing.status === 'Active') {
      listingIds.push(candidate.targetId);
      continue;
    }

    const auction = await prisma.auction.findUnique({
      where: { id: Number(candidate.targetId) },
      select: { status: true },
    });
    
    if (auction && auction.status === 'Active') {
      auctionIds.push(candidate.targetId);
      continue;
    }

    const offer = await prisma.offer.findUnique({
      where: { id: Number(candidate.targetId) },
      select: { status: true },
    });
    
    if (offer && offer.status === 'Pending') {
      offerIds.push(candidate.targetId);
    }
  }

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'renew_storage',
        nativeToScVal(listingIds, { type: 'Vec' }),
        nativeToScVal(auctionIds, { type: 'Vec' }),
        nativeToScVal(offerIds, { type: 'Vec' }),
      ),
    )
    .setTimeout(30)
    .build();

  return tx;
}
