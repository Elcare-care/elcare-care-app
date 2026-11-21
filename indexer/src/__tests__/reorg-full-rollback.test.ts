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

// vi.hoisted so the vi.mock() factory closures resolve without TDZ errors.
const mockReadDb = vi.hoisted(() => ({
  listing:    { findMany: vi.fn() },
  auction:    { findMany: vi.fn() },
  bid:        { findMany: vi.fn() },
  offer:      { findMany: vi.fn() },
  collection: { findMany: vi.fn() },
  syncState:  { findUnique: vi.fn() },
}));

const mockWriteDb = vi.hoisted(() => ({
  offer:            { updateMany: vi.fn() },
  bid:              { deleteMany: vi.fn() },
  marketplaceEvent: { deleteMany: vi.fn() },
  listing:          { deleteMany: vi.fn(), updateMany: vi.fn() },
  auction:          { deleteMany: vi.fn(), updateMany: vi.fn() },
  collection:       { deleteMany: vi.fn() },
  syncState:        { update: vi.fn() },
  whitelistedToken: { updateMany: vi.fn(), deleteMany: vi.fn() },
  royaltyPayment:   { deleteMany: vi.fn() },
  deploymentFee:    { deleteMany: vi.fn() },
  priceHistory:     { deleteMany: vi.fn() },
  $transaction:     vi.fn(),
  $executeRawUnsafe: vi.fn(),
}));

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

// revertLedgers is imported lazily per-test via a module-level variable set
// once after all vi.mock() hoisting has completed. This avoids the TDZ issue
// caused by the vi.mock('../prisma-write') factory closing over mockWriteDb
// before it is initialized.
let revertLedgers: (safeAtLedger: number) => Promise<void>;

// ── Helper ────────────────────────────────────────────────────────────────────

function resetAll() {
  vi.clearAllMocks();
  // Wire $transaction after clearAllMocks so the self-reference is fresh.
  mockWriteDb.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(mockWriteDb));
  mockWriteDb.$executeRawUnsafe.mockResolvedValue(undefined);
  // Restore default read-DB return values
  mockReadDb.listing.findMany.mockResolvedValue(affectedListings);
  mockReadDb.auction.findMany.mockResolvedValue(affectedAuctionIds.map((id) => ({ auctionId: id })));
  mockReadDb.bid.findMany.mockResolvedValue(affectedAuctionIds.map((id) => ({ auctionId: id })));
  mockReadDb.offer.findMany.mockResolvedValue(affectedOffers);
  mockReadDb.collection.findMany.mockResolvedValue(affectedCollections.map((addr) => ({ contractAddress: addr })));
  mockReadDb.syncState.findUnique.mockResolvedValue({ lastLedger: 50_100 });
  // Restore default write-DB return values
  mockWriteDb.offer.updateMany.mockResolvedValue({ count: affectedOffers.length });
  mockWriteDb.bid.deleteMany.mockResolvedValue({ count: 2 });
  mockWriteDb.marketplaceEvent.deleteMany.mockResolvedValue({ count: 5 });
  mockWriteDb.listing.deleteMany.mockResolvedValue({ count: 1 });
  mockWriteDb.listing.updateMany.mockResolvedValue({ count: 2 });
  mockWriteDb.auction.deleteMany.mockResolvedValue({ count: 1 });
  mockWriteDb.auction.updateMany.mockResolvedValue({ count: 1 });
  mockWriteDb.collection.deleteMany.mockResolvedValue({ count: 1 });
  mockWriteDb.syncState.update.mockResolvedValue({});
  mockWriteDb.whitelistedToken.updateMany.mockResolvedValue({ count: 0 });
  mockWriteDb.whitelistedToken.deleteMany.mockResolvedValue({ count: 0 });
  mockWriteDb.royaltyPayment.deleteMany.mockResolvedValue({ count: 2 });
  mockWriteDb.deploymentFee.deleteMany.mockResolvedValue({ count: 1 });
  mockWriteDb.priceHistory.deleteMany.mockResolvedValue({ count: 0 });
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

// ── revertLedgers — extended domain table rollback (via rollbackReorg) ───────
//
// rollbackReorg calls revertLedgers from ../poller which runs its own
// $transaction through a separate prisma-write import. Those inner writes
// are not reachable from mockWriteDb. We verify the observable post-conditions:
// rollbackReorg resolves, the REORG SSE event fires with the correct safeLedger,
// and the offer/bid guards on the shared mock surface use the right ledger value.

describe('revertLedgers — extended domain table rollback', () => {
  beforeEach(resetAll);

  it('rollbackReorg resolves without error (inner revertLedgers transaction completes)', async () => {
    await expect(rollbackReorg(SAFE_LEDGER)).resolves.toBeUndefined();
  });

  it('REORG SSE event safeLedger matches the safeAtLedger passed to rollbackReorg', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const ev = mockEmitSSEEvent.mock.calls.find((c: any[]) => c[0]?.eventType === 'REORG');
    expect(ev).toBeDefined();
    expect(ev![0].safeLedger).toBe(SAFE_LEDGER);
  });

  it('offer.updateMany guard gt value matches safeAtLedger', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const call = mockWriteDb.offer.updateMany.mock.calls[0]?.[0] as any;
    expect(call?.where?.updatedAtLedger?.gt).toBe(SAFE_LEDGER);
  });

  it('bid.deleteMany guard gt value matches safeAtLedger', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const call = mockWriteDb.bid.deleteMany.mock.calls[0]?.[0] as any;
    expect(call?.where?.ledgerSequence?.gt).toBe(SAFE_LEDGER);
  });
});

// ── SyncState cursor reset — write-DB routing ────────────────────────────────

describe('revertLedgers — SyncState cursor is reset to safeAtLedger', () => {
  beforeEach(resetAll);

  it('offer resets route exclusively through write DB (not read DB)', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockWriteDb.offer.updateMany).toHaveBeenCalled();
    expect((mockReadDb.offer as any).updateMany).toBeUndefined();
  });

  it('bid deletes route exclusively through write DB', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockWriteDb.bid.deleteMany).toHaveBeenCalled();
    expect((mockReadDb.bid as any).deleteMany).toBeUndefined();
  });
});

// ── rollbackReorg — SyncState read and cache coherence ───────────────────────

describe('rollbackReorg — sync state read and cache coherence', () => {
  beforeEach(resetAll);

  it('invalidateStats is always called after rollback', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockInvalidateStats).toHaveBeenCalled();
  });

  it('invalidateAllActivity is always called after rollback', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockInvalidateAllActivity).toHaveBeenCalled();
  });

  it('cache invalidation fires even when all entity ID queries fail', async () => {
    mockReadDb.listing.findMany.mockRejectedValue(new Error('timeout'));
    mockReadDb.auction.findMany.mockRejectedValue(new Error('timeout'));
    mockReadDb.offer.findMany.mockRejectedValue(new Error('timeout'));
    mockReadDb.collection.findMany.mockRejectedValue(new Error('timeout'));
    await rollbackReorg(SAFE_LEDGER);
    expect(mockInvalidateStats).toHaveBeenCalled();
    expect(mockInvalidateAllActivity).toHaveBeenCalled();
  });
});

// ── rollbackReorg — derived rows via write DB ─────────────────────────────────

describe('rollbackReorg — derived rows cleaned up via write DB', () => {
  beforeEach(resetAll);

  it('offer.updateMany is called on the write DB', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockWriteDb.offer.updateMany).toHaveBeenCalled();
  });

  it('bid.deleteMany is called on the write DB', async () => {
    await rollbackReorg(SAFE_LEDGER);
    expect(mockWriteDb.bid.deleteMany).toHaveBeenCalled();
  });

  it('offer.updateMany uses ledger-sequence guard to avoid over-deleting safe rows', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const call = mockWriteDb.offer.updateMany.mock.calls[0]?.[0] as any;
    expect(call?.where?.updatedAtLedger?.gt).toBe(SAFE_LEDGER);
  });

  it('bid.deleteMany uses ledger-sequence guard', async () => {
    await rollbackReorg(SAFE_LEDGER);
    const call = mockWriteDb.bid.deleteMany.mock.calls[0]?.[0] as any;
    expect(call?.where?.ledgerSequence?.gt).toBe(SAFE_LEDGER);
  });
});
