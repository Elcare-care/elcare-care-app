import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing:    { findMany: vi.fn() },
  auction:    { findMany: vi.fn() },
  offer:      { findMany: vi.fn() },
  collection: { findMany: vi.fn() },
  reconciliationRun: { findFirst: vi.fn() },
  discrepancy:       { count: vi.fn() },
}));

const mockPrismaWrite = vi.hoisted(() => ({
  $transaction:         vi.fn().mockImplementation(async (fn: any) => fn(mockPrismaWrite)),
  listing:              { update: vi.fn().mockResolvedValue({}) },
  auction:              { update: vi.fn().mockResolvedValue({}) },
  offer:                { update: vi.fn().mockResolvedValue({}) },
  collection:           { update: vi.fn().mockResolvedValue({}) },
  reconciliationRepair: { create: vi.fn().mockResolvedValue({}) },
  reconciliationRun:    { create: vi.fn().mockResolvedValue({ id: 42 }), update: vi.fn().mockResolvedValue({}) },
  discrepancy:          { create: vi.fn().mockResolvedValue({ id: 1 }), update: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../db',           () => ({ default: mockPrisma }));
vi.mock('../prisma-write', () => ({ default: mockPrismaWrite }));

import {
  runReconciliation,
  runAccountingReconciliation,
  fetchListingOnChain,
  fetchAuctionOnChain,
  fetchOfferOnChain,
  fetchCollectionFeeBpsFromMarketplace,
} from '../reconciler';
import type { rpc } from '@stellar/stellar-sdk';

const mockServer = {} as rpc.Server;

// ── Sample helpers ────────────────────────────────────────────────────────────

const sampleListing = (overrides = {}) => ({
  listingId:       BigInt(1),
  status:          'Active',
  price:           { toString: () => '100.0000000' },
  owner:           null,
  updatedAtLedger: 500,
  ...overrides,
});

const sampleAuction = (overrides = {}) => ({
  auctionId:       BigInt(1),
  status:          'Active',
  highestBid:      { toString: () => '0.0000000' },
  highestBidder:   null,
  endTime:         { toString: () => '1700000000' },
  updatedAtLedger: 500,
  ...overrides,
});

const sampleOffer = (overrides = {}) => ({
  offerId:         BigInt(10),
  status:          'Pending',
  amount:          { toString: () => '50.0000000' },
  updatedAtLedger: 400,
  ...overrides,
});

const sampleCollection = (overrides = {}) => ({
  id:               1,
  contractAddress:  'CABC',
  feeBpsOverride:   null,
  deployedAtLedger: 300,
  ...overrides,
});

// ── Reset mocks before each test ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.listing.findMany.mockResolvedValue([]);
  mockPrisma.auction.findMany.mockResolvedValue([]);
  mockPrisma.offer.findMany.mockResolvedValue([]);
  mockPrisma.collection.findMany.mockResolvedValue([]);
  mockPrismaWrite.$transaction.mockImplementation(async (fn: any) => fn(mockPrismaWrite));
  mockPrismaWrite.listing.update.mockResolvedValue({});
  mockPrismaWrite.auction.update.mockResolvedValue({});
  mockPrismaWrite.offer.update.mockResolvedValue({});
  mockPrismaWrite.collection.update.mockResolvedValue({});
  mockPrismaWrite.reconciliationRepair.create.mockResolvedValue({});
  mockPrismaWrite.reconciliationRun.create.mockResolvedValue({ id: 42 });
  mockPrismaWrite.reconciliationRun.update.mockResolvedValue({});
  mockPrismaWrite.discrepancy.create.mockResolvedValue({ id: 1 });
  mockPrismaWrite.discrepancy.update.mockResolvedValue({});
});

// ── Exports ───────────────────────────────────────────────────────────────────

describe('re-exported chain-state functions', () => {
  it('fetchListingOnChain is a callable function', () => {
    expect(typeof fetchListingOnChain).toBe('function');
  });
  it('fetchAuctionOnChain is a callable function', () => {
    expect(typeof fetchAuctionOnChain).toBe('function');
  });
  it('fetchOfferOnChain is a callable function', () => {
    expect(typeof fetchOfferOnChain).toBe('function');
  });
  it('fetchCollectionFeeBpsFromMarketplace is a callable function', () => {
    expect(typeof fetchCollectionFeeBpsFromMarketplace).toBe('function');
  });
});

// ── runReconciliation — listings ──────────────────────────────────────────────

describe('runReconciliation — null chain response', () => {
  it('returns zero discrepancies when chain responses are null (stub/unavailable)', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const result = await runReconciliation(mockServer, 'CONTRACT');

    expect(result.sampledListings).toBe(1);
    expect(result.sampledAuctions).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
    expect(result.dryRun).toBe(true);
  });
});

describe('runReconciliation — listing mismatches', () => {
  it('detects a listing status mismatch', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Sold', price: '100.0000000' });
    const result   = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'listing', field: 'status', dbValue: 'Active', chainValue: 'Sold',
    });
  });

  it('detects a listing price mismatch', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Active', price: '999.0000000' });
    const result   = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'listing', field: 'price', dbValue: '100.0000000', chainValue: '999.0000000',
    });
  });

  it('detects a listing owner mismatch', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing({ owner: 'GABC' })]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Active', price: '100.0000000', owner: 'GXYZ' });
    const result   = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined);

    expect(result.discrepancies.some(d => d.field === 'owner')).toBe(true);
  });

  it('reports no discrepancies when DB and chain match', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const fetchListingSpy = vi.fn().mockResolvedValue({ status: 'Active', price: '100.0000000' });
    const fetchAuctionSpy = vi.fn().mockResolvedValue({ status: 'Active', highestBid: '0.0000000' });
    const result = await runReconciliation(mockServer, 'CONTRACT', 50, fetchListingSpy, fetchAuctionSpy);

    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
  });
});

describe('runReconciliation — auction mismatches', () => {
  it('detects an auction status mismatch', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const fetchAuctionSpy = vi.fn().mockResolvedValue({ status: 'Finalized', highestBid: '0.0000000' });
    const result          = await runReconciliation(mockServer, 'CONTRACT', 50, undefined, fetchAuctionSpy);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'auction', field: 'status', dbValue: 'Active', chainValue: 'Finalized',
    });
  });

  it('detects an auction highestBid mismatch', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const fetchAuctionSpy = vi.fn().mockResolvedValue({ status: 'Active', highestBid: '500.0000000' });
    const result          = await runReconciliation(mockServer, 'CONTRACT', 50, undefined, fetchAuctionSpy);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'auction', field: 'highestBid', dbValue: '0.0000000', chainValue: '500.0000000',
    });
  });
});

describe('runReconciliation — sampleSize', () => {
  it('respects the sampleSize parameter', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    await runReconciliation(mockServer, 'CONTRACT', 25);

    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 })
    );
    expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 })
    );
  });
});

// ── runReconciliation — dry-run ───────────────────────────────────────────────

describe('runReconciliation — dry-run mode', () => {
  it('records a DryRun repair without updating DB when dryRun=true', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Sold', price: '100.0000000' });
    const result   = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined, true);

    expect(result.dryRun).toBe(true);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.repairs).toBe(1);
    expect(mockPrismaWrite.listing.update).not.toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRepair.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DryRun', field: 'status' }),
      })
    );
  });

  it('applies DB update and writes Applied repair record when dryRun=false', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Cancelled', price: '100.0000000' });
    await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined, false);

    expect(mockPrismaWrite.$transaction).toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRepair.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Applied' }),
      })
    );
  });
});

// ── runReconciliation — RPC failure paths ─────────────────────────────────────

describe('runReconciliation — RPC failure', () => {
  it('leaves DB unchanged and skips record when RPC throws', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const throwingSpy = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const result      = await runReconciliation(mockServer, 'CONTRACT', 50, throwingSpy, undefined);

    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockPrismaWrite.listing.update).not.toHaveBeenCalled();
  });

  it('continues processing remaining records after a single RPC failure', async () => {
    const listings = [sampleListing({ listingId: BigInt(1) }), sampleListing({ listingId: BigInt(2) })];
    mockPrisma.listing.findMany.mockResolvedValue(listings);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ status: 'Sold', price: '100.0000000' });

    const result = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'listing', field: 'status' });
  });

  it('skips record when fetch returns null (entry not found)', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue(null);
    const result   = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined);

    expect(result.discrepancies).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});

// ── runReconciliation — budget exhaustion ─────────────────────────────────────

describe('runReconciliation — budget exhaustion', () => {
  it('skips all records when budget=0', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing(), sampleListing({ listingId: BigInt(2) })]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Active', price: '100.0000000' });
    const result   = await runReconciliation(
      mockServer, 'CONTRACT', 50, fetchSpy, undefined, true, 0
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.skipped).toBe(3);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('stops after budget exhaustion mid-run', async () => {
    const listings = [
      sampleListing({ listingId: BigInt(1) }),
      sampleListing({ listingId: BigInt(2) }),
      sampleListing({ listingId: BigInt(3) }),
    ];
    mockPrisma.listing.findMany.mockResolvedValue(listings);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Active', price: '100.0000000' });
    const result   = await runReconciliation(
      mockServer, 'CONTRACT', 50, fetchSpy, undefined, true, 2
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(1);
  });
});

// ── runReconciliation — ReconciliationRun row ─────────────────────────────────

describe('runReconciliation — run tracking', () => {
  it('creates a ReconciliationRun row and updates it on completion', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const result = await runReconciliation(mockServer, 'CONTRACT');

    expect(mockPrismaWrite.reconciliationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dryRun: true }) })
    );
    expect(mockPrismaWrite.reconciliationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
    expect(result.runId).toBe(42);
  });

  it('continues without run tracking when ReconciliationRun.create fails', async () => {
    mockPrismaWrite.reconciliationRun.create.mockRejectedValueOnce(new Error('DB error'));
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const result = await runReconciliation(mockServer, 'CONTRACT');

    expect(result.runId).toBeNull();
    expect(result.discrepancies).toHaveLength(0);
  });
});

// ── runAccountingReconciliation — offers ──────────────────────────────────────

describe('runAccountingReconciliation — empty state', () => {
  it('returns zeros when there are no offers or collections', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const result = await runAccountingReconciliation(mockServer, 'CONTRACT');

    expect(result.sampledOffers).toBe(0);
    expect(result.sampledCollections).toBe(0);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
  });
});

describe('runAccountingReconciliation — offer mismatches', () => {
  it('detects an offer status mismatch (Pending → Accepted on chain)', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy  = vi.fn().mockResolvedValue({ status: 'Accepted', amount: '50.0000000' });
    const fetchFeeSpy    = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.sampledOffers).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'offer', field: 'status', dbValue: 'Pending', chainValue: 'Accepted',
    });
  });

  it('detects an offer amount mismatch', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Pending', amount: '999.0000000' });
    const fetchFeeSpy   = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'offer', field: 'amount', dbValue: '50.0000000', chainValue: '999.0000000',
    });
  });

  it('reports no discrepancies when offer DB and chain match', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Pending', amount: '50.0000000' });
    const fetchFeeSpy   = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
  });
});

describe('runAccountingReconciliation — collection mismatches', () => {
  it('detects a collection feeBpsOverride mismatch (null vs 500)', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([
      sampleCollection({ feeBpsOverride: null }),
    ]);

    const fetchOfferSpy = vi.fn();
    const fetchFeeSpy   = vi.fn().mockResolvedValue(500);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.sampledCollections).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'collection', field: 'feeBpsOverride', dbValue: '', chainValue: '500',
    });
  });

  it('detects a collection feeBpsOverride mismatch (250 vs null)', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([
      sampleCollection({ feeBpsOverride: 250 }),
    ]);

    const fetchOfferSpy = vi.fn();
    const fetchFeeSpy   = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'collection', field: 'feeBpsOverride', dbValue: '250', chainValue: '',
    });
  });

  it('reports no discrepancies when collection fee matches (both null)', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection()]);

    const fetchOfferSpy = vi.fn();
    const fetchFeeSpy   = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(0);
  });

  it('reports no discrepancies when collection fee matches (both 300)', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection({ feeBpsOverride: 300 })]);

    const fetchFeeSpy = vi.fn().mockResolvedValue(300);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, vi.fn(), fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(0);
  });
});

// ── runAccountingReconciliation — RPC failure paths ───────────────────────────

describe('runAccountingReconciliation — RPC failure', () => {
  it('skips offer and does not crash when fetchOffer throws', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const fetchFeeSpy   = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(mockPrismaWrite.offer.update).not.toHaveBeenCalled();
  });

  it('skips collection and does not crash when fetchCollectionFeeBps throws', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection()]);

    const fetchFeeSpy = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, vi.fn(), fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(mockPrismaWrite.collection.update).not.toHaveBeenCalled();
  });

  it('continues processing second offer after first fails', async () => {
    const offers = [
      sampleOffer({ offerId: BigInt(10) }),
      sampleOffer({ offerId: BigInt(11) }),
    ];
    mockPrisma.offer.findMany.mockResolvedValue(offers);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 'Accepted', amount: '50.0000000' });

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, vi.fn()
    );

    expect(result.skipped).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'offer', field: 'status' });
  });

  it('skips offer when chain state is null (entry not found)', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, vi.fn()
    );

    expect(result.discrepancies).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});

// ── runAccountingReconciliation — malformed / ABI decode errors ───────────────

describe('runAccountingReconciliation — malformed contract response', () => {
  it('handles fetchOffer returning an invalid status gracefully', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    // Simulate a decoder throwing on invalid status (as chain-state.ts would)
    const fetchOfferSpy = vi.fn().mockRejectedValue(
      new Error('[chain-state] Unexpected offer status: "Unknown"')
    );

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, vi.fn()
    );

    // ABI decode error treated same as RPC failure — skip the record
    expect(result.discrepancies).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('handles fetchCollectionFeeBps returning NaN without crashing', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection()]);

    // fetchCollectionFeeBpsFromMarketplace returns null on parse failure
    const fetchFeeSpy = vi.fn().mockResolvedValue(null);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, vi.fn(), fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(0);
  });
});

// ── runAccountingReconciliation — budget exhaustion ───────────────────────────

describe('runAccountingReconciliation — budget exhaustion', () => {
  it('skips all records when budget=0', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer(), sampleOffer({ offerId: BigInt(11) })]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection()]);

    const fetchOfferSpy = vi.fn();
    const fetchFeeSpy   = vi.fn();

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy, true, 0
    );

    expect(fetchOfferSpy).not.toHaveBeenCalled();
    expect(fetchFeeSpy).not.toHaveBeenCalled();
    expect(result.skipped).toBe(3);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('uses offer budget before collection budget', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([
      sampleOffer({ offerId: BigInt(10) }),
      sampleOffer({ offerId: BigInt(11) }),
    ]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection()]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Pending', amount: '50.0000000' });
    const fetchFeeSpy   = vi.fn().mockResolvedValue(null);

    // Budget of 2: both offers consume it, collection is skipped
    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy, true, 2
    );

    expect(fetchOfferSpy).toHaveBeenCalledTimes(2);
    expect(fetchFeeSpy).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

// ── runAccountingReconciliation — dry-run mode ────────────────────────────────

describe('runAccountingReconciliation — dry-run mode', () => {
  it('writes DryRun repair record for offer without updating DB', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Withdrawn', amount: '50.0000000' });

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, vi.fn(), true
    );

    expect(result.dryRun).toBe(true);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.repairs).toBe(1);
    expect(mockPrismaWrite.offer.update).not.toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRepair.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DryRun', field: 'status' }),
      })
    );
  });

  it('applies offer DB update when dryRun=false', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Rejected', amount: '50.0000000' });

    await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, vi.fn(), false
    );

    expect(mockPrismaWrite.$transaction).toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRepair.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Applied' }),
      })
    );
  });

  it('writes DryRun repair record for collection without updating DB', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection({ feeBpsOverride: null })]);

    const fetchFeeSpy = vi.fn().mockResolvedValue(400);

    await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, vi.fn(), fetchFeeSpy, true
    );

    expect(mockPrismaWrite.collection.update).not.toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRepair.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DryRun', modelType: 'collection' }),
      })
    );
  });
});

// ── runAccountingReconciliation — run tracking ────────────────────────────────

describe('runAccountingReconciliation — run tracking', () => {
  it('creates a ReconciliationRun row and updates it on completion', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const result = await runAccountingReconciliation(mockServer, 'CONTRACT');

    expect(mockPrismaWrite.reconciliationRun.create).toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
    expect(result.runId).toBe(42);
  });

  it('continues without run tracking when create fails', async () => {
    mockPrismaWrite.reconciliationRun.create.mockRejectedValueOnce(new Error('DB down'));
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const result = await runAccountingReconciliation(mockServer, 'CONTRACT');

    expect(result.runId).toBeNull();
  });
});

// ── runAccountingReconciliation — batching behavior ──────────────────────────

describe('runAccountingReconciliation — batching behavior', () => {
  it('samples multiple offers in order of updatedAtLedger desc', async () => {
    const offers = [
      sampleOffer({ offerId: BigInt(20), updatedAtLedger: 1000 }),
      sampleOffer({ offerId: BigInt(21), updatedAtLedger: 900 }),
      sampleOffer({ offerId: BigInt(22), updatedAtLedger: 800 }),
    ];
    mockPrisma.offer.findMany.mockResolvedValue(offers);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Pending', amount: '50.0000000' });

    await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, vi.fn()
    );

    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { updatedAtLedger: 'desc' } })
    );
    expect(fetchOfferSpy).toHaveBeenCalledTimes(3);
  });

  it('queries only Pending offers', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    mockPrisma.collection.findMany.mockResolvedValue([]);

    await runAccountingReconciliation(mockServer, 'CONTRACT');

    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'Pending' } })
    );
  });
});

// ── Cross-entity scenarios ────────────────────────────────────────────────────

describe('runAccountingReconciliation — mixed entity discrepancies', () => {
  it('detects discrepancies in both offers and collections', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer()]);
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection()]);

    const fetchOfferSpy = vi.fn().mockResolvedValue({ status: 'Accepted', amount: '50.0000000' });
    const fetchFeeSpy   = vi.fn().mockResolvedValue(750);

    const result = await runAccountingReconciliation(
      mockServer, 'CONTRACT', '', 50, fetchOfferSpy, fetchFeeSpy
    );

    expect(result.discrepancies).toHaveLength(2);
    expect(result.discrepancies.some(d => d.kind === 'offer')).toBe(true);
    expect(result.discrepancies.some(d => d.kind === 'collection')).toBe(true);
  });
});
