/**
 * fixtures.ts
 *
 * Shared factory helpers for indexer unit and integration tests.
 * Import from `./helpers/fixtures` to get typed, minimal-viable test data
 * without duplicating setup across test files.
 *
 * All factories accept a `Partial<T>` override so callers can vary only the
 * fields relevant to their test scenario, keeping noise low.
 */

// ── Marketplace event row ─────────────────────────────────────────────────────

export interface MarketplaceEventRow {
  id: number;
  eventType: string;
  listingId: bigint | string | null;
  actor: string;
  data: Record<string, unknown>;
  ledgerSequence: number;
  ledgerTimestamp: Date | null;
  txHash: string | null;
  confirmed: boolean;
}

let _eventSeq = 1;

export function makeMarketplaceEvent(
  overrides: Partial<MarketplaceEventRow> = {}
): MarketplaceEventRow {
  const id = _eventSeq++;
  return {
    id,
    eventType: 'LISTING_CREATED',
    listingId: BigInt(id),
    actor: `GARTIST${id.toString().padStart(50, '0')}`,
    data: {
      listing_id: BigInt(id),
      price: 10_000_000n,
      artist: `GARTIST${id.toString().padStart(50, '0')}`,
      currency: 'XLM',
    },
    ledgerSequence: 1000 + id,
    ledgerTimestamp: new Date('2025-01-01T12:00:00Z'),
    txHash: `TX${id.toString().padStart(62, '0')}`,
    confirmed: true,
    ...overrides,
  };
}

// ── Artwork-sold event ────────────────────────────────────────────────────────

export function makeArtworkSoldEvent(
  overrides: Partial<MarketplaceEventRow> = {}
): MarketplaceEventRow {
  const base = makeMarketplaceEvent({
    eventType: 'ARTWORK_SOLD',
    ...overrides,
  });
  return {
    ...base,
    data: {
      listing_id: base.listingId,
      price: 10_000_000n,
      buyer: 'GBUYER' + String(base.id).padStart(50, '0'),
      artist: base.actor,
      currency: 'XLM',
    },
    ...overrides,
  };
}

// ── Bid-placed event ──────────────────────────────────────────────────────────

export function makeBidPlacedEvent(
  auctionId: number,
  overrides: Partial<MarketplaceEventRow> = {}
): MarketplaceEventRow {
  return makeMarketplaceEvent({
    eventType: 'BID_PLACED',
    listingId: null,
    data: {
      auction_id: BigInt(auctionId),
      bid_amount: 5_000_000n,
      bidder: 'GBIDDER' + String(auctionId).padStart(49, '0'),
    },
    ...overrides,
  });
}

// ── Offer event ───────────────────────────────────────────────────────────────

export function makeOfferMadeEvent(
  listingId: number,
  overrides: Partial<MarketplaceEventRow> = {}
): MarketplaceEventRow {
  return makeMarketplaceEvent({
    eventType: 'OFFER_MADE',
    listingId: BigInt(listingId),
    data: {
      offer_id: 1n,
      listing_id: BigInt(listingId),
      offerer: 'GOFFERER' + String(listingId).padStart(48, '0'),
      amount: 8_000_000n,
      token: 'CTOKEN' + String(listingId).padStart(50, '0'),
    },
    ...overrides,
  });
}

// ── IPFS queue row ────────────────────────────────────────────────────────────

export interface IpfsQueueRow {
  id: number;
  cid: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  nextRetryAt: Date | null;
  createdAt: Date;
}

let _queueSeq = 1;

export function makeIpfsQueueRow(
  overrides: Partial<IpfsQueueRow> = {}
): IpfsQueueRow {
  const id = _queueSeq++;
  return {
    id,
    cid: `Qm${'A'.repeat(44)}${id.toString().padStart(2, '0')}`,
    status: 'pending',
    attempts: 0,
    nextRetryAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── IPFS metadata row ─────────────────────────────────────────────────────────

export interface IpfsMetadataRow {
  cid: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  attributes: unknown;
  raw: Record<string, unknown>;
  contentHash: string | null;
  fetchedAt: Date;
}

export function makeIpfsMetadataRow(
  overrides: Partial<IpfsMetadataRow> = {}
): IpfsMetadataRow {
  return {
    cid: 'QmDefaultCid' + Math.random().toString(36).slice(2, 8),
    title: 'Test Artwork',
    description: 'A test piece',
    imageUrl: 'ipfs://QmImageCid',
    attributes: [],
    raw: { title: 'Test Artwork', description: 'A test piece', image: 'ipfs://QmImageCid' },
    contentHash: 'a'.repeat(64),
    fetchedAt: new Date('2025-01-01T12:00:00Z'),
    ...overrides,
  };
}

// ── Listing DB row ────────────────────────────────────────────────────────────

export interface ListingRow {
  listingId: bigint;
  artist: string;
  price: bigint;
  currency: string;
  token: string;
  collection: string;
  tokenId: bigint;
  status: 'Active' | 'Sold' | 'Cancelled';
  owner: string | null;
  createdAt: number;
  updatedAtLedger: number;
  royaltyBps: number;
  protocolFeeBps: number;
  originalCreator: string | null;
  metadataCid: string | null;
}

let _listingSeq = 1;

export function makeListingRow(
  overrides: Partial<ListingRow> = {}
): ListingRow {
  const id = BigInt(_listingSeq++);
  const artist = 'GARTIST' + id.toString().padStart(49, '0');
  return {
    listingId: id,
    artist,
    price: 10_000_000n,
    currency: 'XLM',
    token: 'CTOKEN' + id.toString().padStart(50, '0'),
    collection: 'CCOLLECTION' + id.toString().padStart(45, '0'),
    tokenId: 1n,
    status: 'Active',
    owner: null,
    createdAt: 1000,
    updatedAtLedger: 1000 + Number(id),
    royaltyBps: 500,
    protocolFeeBps: 250,
    originalCreator: artist,
    metadataCid: `QmMeta${id.toString().padStart(39, '0')}`,
    ...overrides,
  };
}

// ── Reset sequence counters (call in beforeEach for deterministic ids) ─────────

export function resetFixtureSequences(): void {
  _eventSeq = 1;
  _queueSeq = 1;
  _listingSeq = 1;
}
