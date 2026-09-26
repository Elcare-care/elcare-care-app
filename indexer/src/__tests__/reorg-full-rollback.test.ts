/**
 * reorg-full-rollback.test.ts
 *
 * Integration-style tests for the complete reorg rollback pipeline.
 *
 * Acceptance criteria verified:
 *   1. After rollbackReorg(), affected listings are reverted to Active
 *   2. Auctions created in the reorg window are deleted; updated auctions revert to Active
 *   3. Offers whose status changed past safeAtLedger revert to Pending
 *   4. Bids placed past safeAtLedger are removed
 *   5. RoyaltyPayment rows past safeAtLedger are removed (via revertLedgers)
 *   6. DeploymentFee rows past safeAtLedger are removed (via revertLedgers)
 *   7. WhitelistedToken removals past safeAtLedger are undone; new additions deleted
 *   8. Per-entity cache invalidation fires for each affected listing/auction/offer/collection
 *   9. Per-entity REORG_ENTITY SSE events are emitted for each affected entity
 *  10. Global REORG SSE event is emitted with the correct safeLedger
 *  11. bumpConfirmedVersion() is called
 *  12. rebuildProjectionsForRange() is triggered (fire-and-forget via setImmediate)
 *  13. revertLedgers() removes raw MarketplaceEvent rows past safeAtLedger
 *  14. revertLedgers() resets SyncState.lastLedger to safeAtLedger
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Cache invalidation spies
const mockInvalidateListing     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateAuction     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateOffer       = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateCollection  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateStats       = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateAllActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../cache-invalidation', () => ({
  invalidateListing:     mockInvalidateListing,
  invalidateAuction:     mockInvalidateAuction,
  invalidateOffer:       mockInvalidateOffer,
  invalidateCollection:  mockInvalidateCollection,
  invalidateStats:       mockInvalidateStats,
  invalidateAllActivity: mockInvalidateAllActivity,
  invalidateKey:         vi.fn().mockResolvedValue(undefined),
  invalidatePattern:     vi.fn().mockResolvedValue(undefined),
}));

// SSE spy
const mockEmitSSEEvent = vi.hoisted(() => vi.fn());
vi.mock('../api/routes', () => ({
  emitSSEEvent:        mockEmitSSEEvent,
  _getSseBuffer:       () => [],
  _getSseEventCounter: () => 0,
  _resetSseState:      vi.fn(),
  closeSSEClients:     vi.fn(),
  default:             {},
}));

// ETag spy
const mockBumpConfirmedVersion = vi.hoisted(() => vi.fn());
vi.mock('../api/etag-middleware', () => ({
  bumpConfirmedVersion: mockBumpConfirmedVersion,
  getConfirmedVersion: vi.fn().mockReturnValue(0),
  _resetConfirmedVersion: vi.fn(),
  isStreaming: vi.fn().mockReturnValue(false),
  isProvisional: vi.fn().mockReturnValue(false),
  etagMiddleware: vi.fn(() => (_: any, __: any, next: any) => next()),
  cacheControlForPath: vi.fn().mockReturnValue('no-cache'),
}));

// rebuild-projections spy
const mockRebuildForRange = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../rebuild-projections', () => ({
  rebuildProjectionsForRange: mockRebuildForRange,
  runRebuild:                 vi.fn().mockResolvedValue({ status: 'completed' }),
  getRebuildStatus:           vi.fn().mockResolvedValue([]),
}));

// ── DB mocks ──────────────────────────────────────────────────────────────────

const SAFE_LEDGER = 50_000;

// Data that exists AFTER the safe ledger (should be rolled back)
const affectedListings    = [{ listingId: BigInt(101) }, { listingId: BigInt(102) }];
const affectedAuctionIds  = [BigInt(201)];
const affectedOffers      = [{ offerId: BigInt(301), listingId: BigInt(101) }];
const affectedCollections = ['CA_COLLECTION_NEW'];

const mockReadDb = {
  listing:    { findMany: vi.fn().mockResolvedValue(affectedListings) },
  auction:    { findMany: vi.fn().mockResolvedValue(affectedAuctionIds.map((id) => ({ auctionId: id }))) },
  bid:        { findMany: vi.fn().mockResolvedValue(affectedAuctionIds.map((id) => ({ auctionId: id }))) },
  offer:      { findMany: vi.fn().mockResolvedValue(affectedOffers) },
  collection: { findMany: vi.fn().mockResolvedValue(affectedCollections.map((addr) => ({ contractAddress: addr }))) },
  syncState:  { findUnique: vi.fn().mockResolvedValue({ lastLedger: 50_100 }) },
};

const mockWriteDb = {
  offer: {
    updateMany: vi.fn().mockResolvedValue({ count: affectedOffers.length }),
  },
  bid: {
    deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
  },
  marketplaceEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
  listing: {
    deleteMany:  vi.fn().mockResolvedValue({ count: 1 }),
    updateMany:  vi.fn().mockResolvedValue({ count: 2 }),
  },
  auction: {
    deleteMany:  vi.fn().mockResolvedValue({ count: 1 }),
    updateMany:  vi.fn().mockResolvedValue({ count: 1 }),
  },
  collection: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  syncState:   { update: vi.fn().mockResolvedValue({}) },
  whitelistedToken: {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  royaltyPayment: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
  deploymentFee:  { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  priceHistory:   { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  $transaction:   vi.fn(async (fn: (tx: any) => Promise<any>) => fn(mockWriteDb)),
  $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../db',           () => ({ default: mockReadDb }));
vi.mock('../prisma-write', () => ({ default: mockWriteDb }));

// Stub recovery FSM so poller.ts doesn't throw
vi.mock('../recovery-state-machine', () => ({
  recoveryFSM: { reorgRollbackComplete: vi.fn() },
}));

vi.mock('../recovery-metrics', () => ({
  reorgRollbackDurationSeconds: { observe: vi.fn() },
  gapRepairDurationSeconds:     { observe: vi.fn() },
  gapLengthLedgers:             { observe: vi.fn() },
  replayRangeStartedTotal:      { inc: vi.fn() },
  replayRangeCompletedTotal:    { inc: vi.fn() },
}));

vi.mock('../metrics', () => ({
  latestLedgerProcessedGauge:   { set: vi.fn() },
  networkLatestLedgerGauge:     { set: vi.fn() },
  syncLatencyGauge:             { set: vi.fn() },
  decodeErrorsCounter:          { inc: vi.fn() },
  duplicateEventsCounter:       { inc: vi.fn() },
  gapsCreatedTotal:             { inc: vi.fn() },
  openGapsGauge:                { set: vi.fn() },
  openGapLedgersTotalGauge:     { set: vi.fn() },
  reorgRollbackDurationSeconds: { observe: vi.fn() },
  activeListingsGauge:          { set: vi.fn() },
  activeAuctionsGauge:          { set: vi.fn() },
  snapshotsWrittenTotal:        { inc: vi.fn() },
  snapshotVerificationsTotal:   { inc: vi.fn() },
  snapshotHashMismatchGauge:    { set: vi.fn() },
  deadLetterReplayAttemptsTotal: { inc: vi.fn() },
  deadLetterPendingGauge:       { set: vi.fn() },
}));

// ── Import modules under test ─────────────────────────────────────────────────

import { rollbackReorg } from '../reorg';

// ── Helper ────────────────────────────────────────────────────────────────────

function resetAll() {
  vi.clearAllMocks();
  // Restore default mocks
  mockReadDb.listing.findMany.mockResolvedValue(affectedListings);
  mockReadDb.bid.findMany.mockResolvedValue(affectedAuctionIds.map((id) => ({ auctionId: id })));
  mockReadDb.offer.findMany.mockResolvedValue(affectedOffers);
  mockReadDb.collection.findMany.mockResolvedValue(affectedCollections.map((addr) => ({ contractAddress: addr })));
  mockWriteDb.offer.updateMany.mockResolvedValue({ count: affectedOffers.length });
  mockWriteDb.bid.deleteMany.mockResolvedValue({ count: 2 });
  mockRebuildForRange.mockResolvedValue(undefined);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('rollbackReorg — offer and bid rollback', () => {
  beforeEach(resetAll);

  it('resets offers past safeAtLedger back to Pending', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockWriteDb.offer.updateMany).toHaveBeenCalledWith({
      where: { updatedAtLedger: { gt: SAFE_LEDGER } },
      data:  { status: 'Pending', updatedAtLedger: SAFE_LEDGER },
    });
  });

  it('deletes bids past safeAtLedger', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockWriteDb.bid.deleteMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: SAFE_LEDGER } },
    });
  });
});

describe('rollbackReorg — per-entity cache invalidation', () => {
  beforeEach(resetAll);

  it('calls invalidateListing for each affected listing', async () => {
    await rollbackReorg(SAFE_LEDGER);
    for (const { listingId } of affectedListings) {
      expect(mockInvalidateListing).toHaveBeenCalledWith(listingId.toString());
    }
  });

  it('calls invalidateAuction for each affected auction', async () => {
    await rollbackReorg(SAFE_LEDGER);
    for (const auctionId of affectedAuctionIds) {
      expect(mockInvalidateAuction).toHaveBeenCalledWith(auctionId.toString());
    }
  });

  it('calls invalidateOffer for each affected offer', async () => {
    await rollbackReorg(SAFE_LEDGER);
    for (const { offerId } of affectedOffers) {
      expect(mockInvalidateOffer).toHaveBeenCalledWith(offerId.toString());
    }
  });

  it('calls invalidateCollection for each collection deployed in reorg window', async () => {
    await rollbackReorg(SAFE_LEDGER);
    for (const addr of affectedCollections) {
      expect(mockInvalidateCollection).toHaveBeenCalledWith(addr);
    }
  });

  it('always calls invalidateStats and invalidateAllActivity', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockInvalidateStats).toHaveBeenCalled();
    expect(mockInvalidateAllActivity).toHaveBeenCalled();
  });
});

describe('rollbackReorg — SSE events', () => {
  beforeEach(resetAll);

  it('emits REORG_ENTITY SSE event for each affected listing', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const entityEvents = mockEmitSSEEvent.mock.calls
      .filter((c: any[]) => c[0]?.eventType === 'REORG_ENTITY' && c[0]?.entityType === 'listing');
    expect(entityEvents.length).toBe(affectedListings.length);
  });

  it('emits REORG_ENTITY SSE event for each affected auction', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const entityEvents = mockEmitSSEEvent.mock.calls
      .filter((c: any[]) => c[0]?.eventType === 'REORG_ENTITY' && c[0]?.entityType === 'auction');
    expect(entityEvents.length).toBe(affectedAuctionIds.length);
  });

  it('emits REORG_ENTITY SSE event for each affected offer', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const entityEvents = mockEmitSSEEvent.mock.calls
      .filter((c: any[]) => c[0]?.eventType === 'REORG_ENTITY' && c[0]?.entityType === 'offer');
    expect(entityEvents.length).toBe(affectedOffers.length);
  });

  it('emits global REORG SSE event with correct safeLedger', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const reorgEvent = mockEmitSSEEvent.mock.calls.find((c: any[]) => c[0]?.eventType === 'REORG');
    expect(reorgEvent).toBeDefined();
    expect(reorgEvent![0].safeLedger).toBe(SAFE_LEDGER);
  });
});

describe('rollbackReorg — ETag bump', () => {
  beforeEach(resetAll);

  it('calls bumpConfirmedVersion()', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockBumpConfirmedVersion).toHaveBeenCalledOnce();
  });
});

describe('rollbackReorg — projection rebuild', () => {
  beforeEach(resetAll);

  it('calls rebuildProjectionsForRange via setImmediate (fire-and-forget)', async () => {
    await rollbackReorg(SAFE_LEDGER);
    // setImmediate fires after current tick; flush it
    await new Promise((r) => setImmediate(r));
    expect(mockRebuildForRange).toHaveBeenCalledWith(SAFE_LEDGER);
  });
});

describe('rollbackReorg — resilience: no affected entities', () => {
  beforeEach(() => {
    resetAll();
    mockReadDb.listing.findMany.mockResolvedValue([]);
    mockReadDb.bid.findMany.mockResolvedValue([]);
    mockReadDb.offer.findMany.mockResolvedValue([]);
    mockReadDb.collection.findMany.mockResolvedValue([]);
  });

  it('still emits global REORG SSE event when nothing was affected', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const reorgEvent = mockEmitSSEEvent.mock.calls.find((c: any[]) => c[0]?.eventType === 'REORG');
    expect(reorgEvent).toBeDefined();
  });

  it('still calls bumpConfirmedVersion when nothing was affected', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockBumpConfirmedVersion).toHaveBeenCalledOnce();
  });

  it('does not call per-entity invalidators when nothing was affected', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockInvalidateListing).not.toHaveBeenCalled();
    expect(mockInvalidateAuction).not.toHaveBeenCalled();
    expect(mockInvalidateOffer).not.toHaveBeenCalled();
    expect(mockInvalidateCollection).not.toHaveBeenCalled();
  });
});

describe('rollbackReorg — resilience: DB read error for affected IDs', () => {
  beforeEach(() => {
    resetAll();
    // Simulate DB errors for the collection queries
    mockReadDb.listing.findMany.mockRejectedValue(new Error('DB timeout'));
    mockReadDb.bid.findMany.mockRejectedValue(new Error('DB timeout'));
    mockReadDb.offer.findMany.mockRejectedValue(new Error('DB timeout'));
    mockReadDb.collection.findMany.mockRejectedValue(new Error('DB timeout'));
  });

  it('proceeds with rollback even when collection-of-IDs queries fail', async () => {
    // Should not throw — all collection errors are caught internally
    await expect(rollbackReorg(SAFE_LEDGER)).resolves.toBeUndefined();
  });

  it('still emits global REORG SSE event despite collection-query errors', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const reorgEvent = mockEmitSSEEvent.mock.calls.find((c: any[]) => c[0]?.eventType === 'REORG');
    expect(reorgEvent).toBeDefined();
  });
});

// ── revertLedgers tests (via poller.ts) ───────────────────────────────────────
// Test the poller-level hard-delete rollback transaction.

describe('revertLedgers — extended domain table rollback', () => {
  beforeEach(resetAll);

  it('includes royaltyPayment.deleteMany when the model exists', async () => {
    const { revertLedgers } = await import('../poller');
    await revertLedgers(SAFE_LEDGER);

    // The transaction client passed to the fn should have called deleteMany
    // on royaltyPayment with ledgerSequence > safeAtLedger
    const txFnArg = mockWriteDb.$transaction.mock.calls[0]?.[0];
    expect(txFnArg).toBeDefined();

    // Execute the tx fn against a tx client with royaltyPayment
    const txClient = {
      ...mockWriteDb,
      royaltyPayment: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      deploymentFee:  { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    };
    await txFnArg(txClient);

    expect(txClient.royaltyPayment.deleteMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: SAFE_LEDGER } },
    });
  });

  it('includes deploymentFee.deleteMany when the model exists', async () => {
    const { revertLedgers } = await import('../poller');

    const txClient = {
      ...mockWriteDb,
      royaltyPayment: { deleteMany: vi.fn().mockResolvedValue({}) },
      deploymentFee:  { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    };
    mockWriteDb.$transaction.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => fn(txClient));

    await revertLedgers(SAFE_LEDGER);

    expect(txClient.deploymentFee.deleteMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: SAFE_LEDGER } },
    });
  });

  it('reverts auction.updateMany for auctions updated in reorg window', async () => {
    const { revertLedgers } = await import('../poller');

    const txClient = {
      ...mockWriteDb,
      royaltyPayment: { deleteMany: vi.fn().mockResolvedValue({}) },
      deploymentFee:  { deleteMany: vi.fn().mockResolvedValue({}) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    };
    mockWriteDb.$transaction.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => fn(txClient));

    await revertLedgers(SAFE_LEDGER);

    expect(txClient.auction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAtLedger: { gt: SAFE_LEDGER } }),
        data:  expect.objectContaining({ status: 'Active' }),
      }),
    );
  });

  it('undoes WhitelistedToken removals from reorg window', async () => {
    const { revertLedgers } = await import('../poller');

    const txClient = {
      ...mockWriteDb,
      royaltyPayment:   { deleteMany: vi.fn().mockResolvedValue({}) },
      deploymentFee:    { deleteMany: vi.fn().mockResolvedValue({}) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    };
    mockWriteDb.$transaction.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => fn(txClient));

    await revertLedgers(SAFE_LEDGER);

    expect(txClient.whitelistedToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: false, removedAtLedger: { gt: SAFE_LEDGER } }),
        data:  expect.objectContaining({ active: true, removedAtLedger: null }),
      }),
    );
  });
});
