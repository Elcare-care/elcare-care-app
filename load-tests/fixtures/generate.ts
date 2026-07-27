/**
 * load-tests/fixtures/generate.ts
 *
 * Generates synthetic but realistic data fixtures for the load-test environment.
 *
 * Design decisions:
 *  - Addresses are 56-character Stellar G-addresses (Strkey encoded).
 *  - Prices are realistic XLM amounts (7 decimal places = stroops).
 *  - Events carry canonical eventHash values so the poller's duplicate-detection
 *    logic exercises its unique-constraint path.
 *  - The seed covers every entity type: Listing, Auction, Offer, Bid,
 *    MarketplaceEvent, RoyaltyPayment, Collection, PriceHistory, SyncState,
 *    TrackedContract so that every API route and DB index is stressed.
 *
 * Volumes (configurable via env vars for short-load vs soak):
 *   SEED_LISTINGS       default 2000
 *   SEED_AUCTIONS       default 500
 *   SEED_OFFERS         default 4000
 *   SEED_EVENTS         default 10000
 *   SEED_COLLECTIONS    default 100
 */

import { createHash, randomBytes } from 'crypto';

// ── Stellar address helpers ───────────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a deterministic fake Stellar G-address from a seed integer. */
export function fakeAddress(seed: number): string {
  // A valid Strkey G-address is 56 chars; we fake one using a padded base32 body.
  const body = seed.toString(16).padStart(52, '0').toUpperCase();
  return 'G' + body.slice(0, 55);
}

/** Pick one of N pre-generated addresses (round-robin). */
export function addressPool(size: number): string[] {
  return Array.from({ length: size }, (_, i) => fakeAddress(i + 1));
}

// ── Price helpers ─────────────────────────────────────────────────────────────

/** Random price between minXlm and maxXlm with 7-decimal precision. */
export function randomPrice(minXlm = 1, maxXlm = 10_000): string {
  const stroops = Math.floor(
    (Math.random() * (maxXlm - minXlm) + minXlm) * 10_000_000,
  );
  return (stroops / 10_000_000).toFixed(7);
}

// ── Event hash helpers ────────────────────────────────────────────────────────

/** Canonical event identity: SHA256(contractId:ledger:txHash:eventIndex). */
export function eventHash(
  contractId: string,
  ledger: number,
  txHash: string,
  eventIndex: number,
): string {
  return createHash('sha256')
    .update(`${contractId}:${ledger}:${txHash}:${eventIndex}`)
    .digest('hex');
}

/** Random hex string of `bytes` bytes. */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// ── Collection kinds ──────────────────────────────────────────────────────────

const COLLECTION_KINDS = ['normal_721', 'normal_1155', 'lazy_721', 'lazy_1155'] as const;

// ── Event type roster ─────────────────────────────────────────────────────────

const EVENT_TYPES = [
  'LISTING_CREATED',
  'LISTING_UPDATED',
  'LISTING_CANCELLED',
  'ARTWORK_SOLD',
  'AUCTION_CREATED',
  'BID_PLACED',
  'AUCTION_RESOLVED',
  'OFFER_MADE',
  'OFFER_ACCEPTED',
  'OFFER_REJECTED',
  'ROYALTY_PAID',
] as const;

// ── Fixture generators ────────────────────────────────────────────────────────

export interface FixtureSet {
  trackedContracts: TrackedContractRow[];
  collections: CollectionRow[];
  listings: ListingRow[];
  auctions: AuctionRow[];
  offers: OfferRow[];
  bids: BidRow[];
  events: EventRow[];
  royaltyPayments: RoyaltyPaymentRow[];
  priceHistory: PriceHistoryRow[];
}

export interface TrackedContractRow {
  contractId: string;
  type: string;
  label: string;
  startLedger: number;
  lastLedger: number;
  lastLedgerHash: string | null;
  active: boolean;
}

export interface CollectionRow {
  contractAddress: string;
  kind: string;
  creator: string;
  name: string;
  symbol: string;
  deployedAtLedger: number;
  feeBpsOverride: number | null;
}

export interface ListingRow {
  listingId: bigint;
  artist: string;
  owner: string | null;
  price: string;
  currency: string;
  collection: string;
  nftTokenId: bigint;
  token: string;
  status: 'Active' | 'Sold' | 'Cancelled';
  recipients: object;
  createdAtLedger: number;
  updatedAtLedger: number;
  title: string | null;
  description: string | null;
  artistName: string | null;
}

export interface AuctionRow {
  auctionId: bigint;
  creator: string;
  collection: string;
  nftTokenId: bigint;
  token: string;
  reservePrice: string;
  highestBid: string;
  highestBidder: string | null;
  endTime: bigint;
  status: 'Active' | 'Finalized' | 'Cancelled';
  recipients: object;
  createdAtLedger: number;
  updatedAtLedger: number;
}

export interface OfferRow {
  offerId: bigint;
  listingId: bigint;
  offerer: string;
  amount: string;
  token: string;
  status: 'Pending' | 'Accepted' | 'Rejected' | 'Withdrawn' | 'Reclaimed';
  expiresAt: bigint | null;
  createdAtLedger: number;
  updatedAtLedger: number;
}

export interface BidRow {
  auctionId: bigint;
  bidder: string;
  amount: string;
  ledgerSequence: number;
}

export interface EventRow {
  listingId: bigint | null;
  eventType: string;
  actor: string;
  data: object;
  ledgerSequence: number;
  ledgerTimestamp: Date;
  eventHash: string;
  contractId: string;
  confirmed: boolean;
}

export interface RoyaltyPaymentRow {
  listingId: bigint | null;
  auctionId: bigint | null;
  recipient: string;
  amount: string;
  salePrice: string;
  ledgerSequence: number;
}

export interface PriceHistoryRow {
  listingId: bigint;
  oldPrice: string;
  newPrice: string;
  changedBy: string;
  changedAtLedger: number;
}

// ── Main generator ────────────────────────────────────────────────────────────

export function generateFixtures(opts: {
  seedListings?: number;
  seedAuctions?: number;
  seedOffers?: number;
  seedEvents?: number;
  seedCollections?: number;
  baseLedger?: number;
  contractId?: string;
}): FixtureSet {
  const N_LISTINGS    = opts.seedListings    ?? 2_000;
  const N_AUCTIONS    = opts.seedAuctions    ?? 500;
  const N_OFFERS      = opts.seedOffers      ?? 4_000;
  const N_EVENTS      = opts.seedEvents      ?? 10_000;
  const N_COLLECTIONS = opts.seedCollections ?? 100;
  const BASE_LEDGER   = opts.baseLedger      ?? 1_000_000;
  const CONTRACT_ID   = opts.contractId      ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2OC';
  const TOKEN_ADDR    = fakeAddress(99999);

  // Address pools
  const artists  = addressPool(200);
  const buyers   = addressPool(500);
  const bidders  = addressPool(300);
  const offerers = addressPool(400);
  const colAddrs = Array.from({ length: N_COLLECTIONS }, (_, i) =>
    fakeAddress(100_000 + i),
  );

  // ── TrackedContract ───────────────────────────────────────────────────────

  const trackedContracts: TrackedContractRow[] = [
    {
      contractId: CONTRACT_ID,
      type: 'marketplace',
      label: 'lt-marketplace',
      startLedger: 0,
      lastLedger: BASE_LEDGER + N_EVENTS,
      lastLedgerHash: randomHex(32),
      active: true,
    },
  ];

  // ── Collections ───────────────────────────────────────────────────────────

  const collections: CollectionRow[] = colAddrs.map((addr, i) => ({
    contractAddress: addr,
    kind: COLLECTION_KINDS[i % COLLECTION_KINDS.length],
    creator: artists[i % artists.length],
    name: `Collection ${i + 1}`,
    symbol: `COL${i + 1}`,
    deployedAtLedger: BASE_LEDGER + i * 10,
    feeBpsOverride: i % 5 === 0 ? 250 : null,
  }));

  // ── Listings ──────────────────────────────────────────────────────────────

  const listings: ListingRow[] = Array.from({ length: N_LISTINGS }, (_, i) => {
    const id = BigInt(i + 1);
    const artist = artists[i % artists.length];
    const col = colAddrs[i % colAddrs.length];
    const ledger = BASE_LEDGER + i;
    const statusIndex = i % 10;
    const status: ListingRow['status'] =
      statusIndex < 6 ? 'Active' : statusIndex < 8 ? 'Sold' : 'Cancelled';
    return {
      listingId: id,
      artist,
      owner: status === 'Sold' ? buyers[i % buyers.length] : null,
      price: randomPrice(1, 5_000),
      currency: 'XLM',
      collection: col,
      nftTokenId: BigInt(i + 1),
      token: TOKEN_ADDR,
      status,
      recipients: [{ address: artist, percentage: 9500 }],
      createdAtLedger: ledger,
      updatedAtLedger: ledger + (status !== 'Active' ? 5 : 0),
      title: `Artwork #${i + 1}`,
      description: `A unique digital artwork number ${i + 1}.`,
      artistName: `Artist ${(i % artists.length) + 1}`,
    };
  });

  // ── Auctions ──────────────────────────────────────────────────────────────

  const auctions: AuctionRow[] = Array.from({ length: N_AUCTIONS }, (_, i) => {
    const id = BigInt(i + 1);
    const creator = artists[i % artists.length];
    const col = colAddrs[i % colAddrs.length];
    const ledger = BASE_LEDGER + i * 2;
    const statusIndex = i % 5;
    const status: AuctionRow['status'] =
      statusIndex < 3 ? 'Active' : statusIndex < 4 ? 'Finalized' : 'Cancelled';
    const highestBidder = status === 'Finalized' ? bidders[i % bidders.length] : null;
    const highestBid = highestBidder ? randomPrice(10, 20_000) : '0.0000000';
    return {
      auctionId: id,
      creator,
      collection: col,
      nftTokenId: BigInt(N_LISTINGS + i + 1),
      token: TOKEN_ADDR,
      reservePrice: randomPrice(5, 1_000),
      highestBid,
      highestBidder,
      endTime: BigInt(Date.now() / 1000 + 86_400 * (i % 7)),
      status,
      recipients: [{ address: creator, percentage: 9500 }],
      createdAtLedger: ledger,
      updatedAtLedger: ledger + (status !== 'Active' ? 10 : 0),
    };
  });

  // ── Offers ────────────────────────────────────────────────────────────────

  const offers: OfferRow[] = Array.from({ length: N_OFFERS }, (_, i) => {
    const id = BigInt(i + 1);
    const listingId = BigInt((i % N_LISTINGS) + 1);
    const offerer = offerers[i % offerers.length];
    const ledger = BASE_LEDGER + i;
    const statusIndex = i % 6;
    const status: OfferRow['status'] =
      statusIndex < 2 ? 'Pending' :
      statusIndex < 3 ? 'Accepted' :
      statusIndex < 4 ? 'Rejected' :
      statusIndex < 5 ? 'Withdrawn' : 'Reclaimed';
    return {
      offerId: id,
      listingId,
      offerer,
      amount: randomPrice(0.5, 4_000),
      token: TOKEN_ADDR,
      status,
      expiresAt: i % 3 === 0 ? BigInt(Math.floor(Date.now() / 1000) + 3600 * 24) : null,
      createdAtLedger: ledger,
      updatedAtLedger: ledger + (status !== 'Pending' ? 3 : 0),
    };
  });

  // ── Bids ──────────────────────────────────────────────────────────────────

  const bids: BidRow[] = [];
  for (let i = 0; i < N_AUCTIONS; i++) {
    const nBids = 1 + (i % 10);
    for (let b = 0; b < nBids; b++) {
      bids.push({
        auctionId: BigInt(i + 1),
        bidder: bidders[(i + b) % bidders.length],
        amount: randomPrice(10 * (b + 1), 20_000),
        ledgerSequence: BASE_LEDGER + i * 2 + b + 1,
      });
    }
  }

  // ── MarketplaceEvents ─────────────────────────────────────────────────────

  const events: EventRow[] = Array.from({ length: N_EVENTS }, (_, i) => {
    const eventType = EVENT_TYPES[i % EVENT_TYPES.length];
    const listingId = BigInt((i % N_LISTINGS) + 1);
    const actor = artists[i % artists.length];
    const ledger = BASE_LEDGER + i;
    const txHash = randomHex(32);
    const hash = eventHash(CONTRACT_ID, ledger, txHash, i % 10);
    const ts = new Date(Date.now() - (N_EVENTS - i) * 5_000);
    return {
      listingId: eventType.startsWith('AUCTION') ? null : listingId,
      eventType,
      actor,
      data: { listing_id: (i % N_LISTINGS) + 1, artist: actor, price: randomPrice() },
      ledgerSequence: ledger,
      ledgerTimestamp: ts,
      eventHash: hash,
      contractId: CONTRACT_ID,
      confirmed: ledger < BASE_LEDGER + N_EVENTS - 10,
    };
  });

  // ── RoyaltyPayments ───────────────────────────────────────────────────────

  const royaltyPayments: RoyaltyPaymentRow[] = Array.from(
    { length: Math.floor(N_LISTINGS / 5) },
    (_, i) => ({
      listingId: BigInt(i * 5 + 1),
      auctionId: null,
      recipient: artists[i % artists.length],
      amount: randomPrice(0.01, 100),
      salePrice: randomPrice(10, 5_000),
      ledgerSequence: BASE_LEDGER + i * 5 + 5,
    }),
  );

  // ── PriceHistory ──────────────────────────────────────────────────────────

  const priceHistory: PriceHistoryRow[] = Array.from(
    { length: Math.floor(N_LISTINGS / 4) },
    (_, i) => ({
      listingId: BigInt(i * 4 + 1),
      oldPrice: randomPrice(1, 2_000),
      newPrice: randomPrice(1, 2_000),
      changedBy: artists[i % artists.length],
      changedAtLedger: BASE_LEDGER + i * 4 + 2,
    }),
  );

  return {
    trackedContracts,
    collections,
    listings,
    auctions,
    offers,
    bids,
    events,
    royaltyPayments,
    priceHistory,
  };
}
