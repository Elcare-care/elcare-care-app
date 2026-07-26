import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn() },
  auction: { findMany: vi.fn() },
}));

const mockPrismaWrite = vi.hoisted(() => ({
  $transaction: vi.fn().mockImplementation(async (fn: any) => fn(mockPrismaWrite)),
  listing:      { update: vi.fn().mockResolvedValue({}) },
  auction:      { update: vi.fn().mockResolvedValue({}) },
  reconciliationRepair: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../db',           () => ({ default: mockPrisma }));
vi.mock('../prisma-write', () => ({ default: mockPrismaWrite }));

import { runReconciliation, fetchListingOnChain, fetchAuctionOnChain } from '../reconciler';
import type { rpc } from '@stellar/stellar-sdk';

const mockServer = {} as rpc.Server;

const sampleListing = (overrides = {}) => ({
  listingId:       BigInt(1),
  status:          'Active',
  price:           { toString: () => '100.0000000' },
  updatedAtLedger: 500,
  ...overrides,
});

const sampleAuction = (overrides = {}) => ({
  auctionId:       BigInt(1),
  status:          'Active',
  highestBid:      { toString: () => '0.0000000' },
  updatedAtLedger: 500,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.listing.findMany.mockResolvedValue([]);
  mockPrisma.auction.findMany.mockResolvedValue([]);
  mockPrismaWrite.$transaction.mockImplementation(async (fn: any) => fn(mockPrismaWrite));
  mockPrismaWrite.listing.update.mockResolvedValue({});
  mockPrismaWrite.auction.update.mockResolvedValue({});
  mockPrismaWrite.reconciliationRepair.create.mockResolvedValue({});
});

// ── Stub functions ────────────────────────────────────────────────────────────

describe('fetchListingOnChain / fetchAuctionOnChain stubs', () => {
  it('returns null (stub — real implementation requires contract ABI)', async () => {
    expect(await fetchListingOnChain(mockServer, 'CONTRACT', BigInt(1))).toBeNull();
    expect(await fetchAuctionOnChain(mockServer, 'CONTRACT', BigInt(1))).toBeNull();
  });
});

// ── runReconciliation ─────────────────────────────────────────────────────────

describe('runReconciliation', () => {
  it('returns zero discrepancies when chain responses are null (stub/unavailable)', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const result = await runReconciliation(mockServer, 'CONTRACT');

    expect(result.sampledListings).toBe(1);
    expect(result.sampledAuctions).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
    expect(result.dryRun).toBe(false);
  });

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

  it('reports no discrepancies when DB and chain match', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction()]);

    const fetchListingSpy = vi.fn().mockResolvedValue({ status: 'Active', price: '100.0000000' });
    const fetchAuctionSpy = vi.fn().mockResolvedValue({ status: 'Active', highestBid: '0.0000000' });
    const result = await runReconciliation(mockServer, 'CONTRACT', 50, fetchListingSpy, fetchAuctionSpy);

    expect(result.discrepancies).toHaveLength(0);
    expect(result.sampledListings).toBe(1);
    expect(result.sampledAuctions).toBe(1);
    expect(result.repairs).toBe(0);
  });

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

// ── Dry-run mode ──────────────────────────────────────────────────────────────

describe('runReconciliation — dry-run', () => {
  it('records a DryRun repair without updating the DB when dryRun=true', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn().mockResolvedValue({ status: 'Sold', price: '100.0000000' });
    const result   = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined, true);

    expect(result.dryRun).toBe(true);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.repairs).toBe(1);

    // DB record should NOT be updated in dry-run
    expect(mockPrismaWrite.listing.update).not.toHaveBeenCalled();

    // Audit repair record should be written with DryRun status
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

// ── RPC failure ───────────────────────────────────────────────────────────────

describe('runReconciliation — RPC failure', () => {
  it('leaves DB unchanged and skips the record when RPC throws', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const throwingSpy = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const result      = await runReconciliation(mockServer, 'CONTRACT', 50, throwingSpy, undefined);

    expect(result.discrepancies).toHaveLength(0);
    expect(result.repairs).toBe(0);
    expect(mockPrismaWrite.listing.update).not.toHaveBeenCalled();
    expect(mockPrismaWrite.reconciliationRepair.create).not.toHaveBeenCalled();
  });

  it('continues processing remaining records after a single RPC failure', async () => {
    const listings = [sampleListing({ listingId: BigInt(1) }), sampleListing({ listingId: BigInt(2) })];
    mockPrisma.listing.findMany.mockResolvedValue(listings);
    mockPrisma.auction.findMany.mockResolvedValue([]);

    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ status: 'Sold', price: '100.0000000' });

    const result = await runReconciliation(mockServer, 'CONTRACT', 50, fetchSpy, undefined);

    // First record skipped; second record detected as discrepancy
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'listing', field: 'status' });
  });
});
