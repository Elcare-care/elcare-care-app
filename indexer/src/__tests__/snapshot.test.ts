/**
 * snapshot.test.ts
 *
 * Tests for the IndexerSnapshot system (snapshot.ts):
 *   1. writeSnapshot() creates an IndexerSnapshot row with correct fields
 *   2. maybeWriteSnapshot() only fires every SNAPSHOT_INTERVAL batches
 *   3. verifySnapshot() — hash matches → status=Verified
 *   4. verifySnapshot() — hash mismatches → status=Mismatch, hashMismatch=true, gauge=1
 *   5. verifySnapshot() — future checkpoint (ledger not yet on RPC) → RPC error handled gracefully
 *   6. verifySnapshot() — missing snapshot → throws 404
 *   7. findLastVerifiedSnapshot() returns null when no Verified snapshot exists
 *   8. findLastVerifiedSnapshot() returns the latest Verified snapshot at or before ledger
 *   9. validateSnapshotRange() counts by status and detects gaps
 *  10. writeSnapshot() increments snapshotsWrittenTotal metric
 *  11. verifySnapshot() increments snapshotVerificationsTotal metric per result
 *  12. verifySnapshot() writes OperationalAudit record
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

vi.mock('../config', () => ({
  VERSION: { app: '1.0.0', dbMigration: '20260829000000' },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockAuditLog = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../audit/audit-service', () => ({
  getAuditService: () => ({ log: mockAuditLog }),
}));

// Metrics mocks
const mockSnapshotsWrittenInc      = vi.hoisted(() => vi.fn());
const mockVerificationsInc         = vi.hoisted(() => vi.fn());
const mockHashMismatchGaugeSet     = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({
  snapshotsWrittenTotal:         { inc: mockSnapshotsWrittenInc },
  snapshotVerificationsTotal:    { inc: mockVerificationsInc },
  snapshotHashMismatchGauge:     { set: mockHashMismatchGaugeSet },
  deadLetterReplayAttemptsTotal: { inc: vi.fn() },
  deadLetterPendingGauge:        { set: vi.fn() },
}));

// Stellar SDK mock — controls the ledger hash returned by getLedger
const mockGetLedger = vi.hoisted(() => vi.fn());
vi.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: class {
      getLedger = mockGetLedger;
    },
  },
}));

// ── DB mocks ──────────────────────────────────────────────────────────────────

function makeSnapshotRecord(overrides: Record<string, unknown> = {}) {
  return {
    id:              1,
    ledgerSequence:  50000,
    ledgerHash:      'AABBCCDD',
    contractCursors: { 'CA_MARKET': 50000 },
    eventCount:      BigInt(100),
    schemaVersion:   '1.0.0/20260829000000',
    rpcVerified:     false,
    hashMismatch:    false,
    rpcHash:         null,
    status:          'Pending',
    notes:           null,
    createdAt:       new Date('2026-08-29T00:00:00Z'),
    ...overrides,
  };
}

const mockReadDb = {
  indexerSnapshot: {
    findUnique: vi.fn(),
    findFirst:  vi.fn(),
    findMany:   vi.fn().mockResolvedValue([]),
    count:      vi.fn().mockResolvedValue(0),
  },
  trackedContract: { findMany: vi.fn().mockResolvedValue([]) },
  marketplaceEvent: { count: vi.fn().mockResolvedValue(0) },
};

const mockWriteDb = {
  indexerSnapshot: {
    create: vi.fn(),
    update: vi.fn(),
  },
  trackedContract: { findMany: vi.fn().mockResolvedValue([]) },
  marketplaceEvent: { count: vi.fn().mockResolvedValue(0) },
  $disconnect: vi.fn(),
};

vi.mock('../db',           () => ({ default: mockReadDb }));
vi.mock('../prisma-write', () => ({ default: mockWriteDb }));

// ── Import module under test ──────────────────────────────────────────────────

import {
  writeSnapshot,
  verifySnapshot,
  listSnapshots,
  getSnapshot,
  findLastVerifiedSnapshot,
  validateSnapshotRange,
  maybeWriteSnapshot,
  resetSnapshotCounter,
  SNAPSHOT_INTERVAL,
} from '../snapshot';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetAllMocks() {
  vi.clearAllMocks();
  mockGetLedger.mockResolvedValue({ ledgerHash: 'AABBCCDD' });
  mockAuditLog.mockResolvedValue(undefined);
  mockWriteDb.indexerSnapshot.create.mockResolvedValue(makeSnapshotRecord());
  mockWriteDb.indexerSnapshot.update.mockResolvedValue(makeSnapshotRecord());
  mockReadDb.indexerSnapshot.findUnique.mockResolvedValue(makeSnapshotRecord());
  mockReadDb.indexerSnapshot.findFirst.mockResolvedValue(makeSnapshotRecord({ status: 'Verified' }));
  mockReadDb.indexerSnapshot.findMany.mockResolvedValue([makeSnapshotRecord()]);
  mockReadDb.indexerSnapshot.count.mockResolvedValue(1);
  resetSnapshotCounter();
}

const WRITE_OPTS = {
  ledgerSequence:  50000,
  ledgerHash:      'AABBCCDD',
  contractCursors: { 'CA_MARKET': 50000 },
  eventCount:      BigInt(100),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeSnapshot', () => {
  beforeEach(resetAllMocks);

  it('creates an IndexerSnapshot with correct fields', async () => {
    await writeSnapshot(WRITE_OPTS);

    expect(mockWriteDb.indexerSnapshot.create).toHaveBeenCalledOnce();
    const data = mockWriteDb.indexerSnapshot.create.mock.calls[0][0].data;
    expect(data.ledgerSequence).toBe(50000);
    expect(data.ledgerHash).toBe('AABBCCDD');
    expect(data.contractCursors).toEqual({ 'CA_MARKET': 50000 });
    expect(data.eventCount).toBe(BigInt(100));
    expect(data.schemaVersion).toContain('1.0.0');
    expect(data.status).toBe('Pending');
    expect(data.rpcVerified).toBe(false);
    expect(data.hashMismatch).toBe(false);
  });

  it('increments snapshotsWrittenTotal metric', async () => {
    await writeSnapshot(WRITE_OPTS);
    expect(mockSnapshotsWrittenInc).toHaveBeenCalledOnce();
  });
});

describe('maybeWriteSnapshot', () => {
  beforeEach(resetAllMocks);

  it(`does NOT write before ${SNAPSHOT_INTERVAL} batches`, async () => {
    for (let i = 0; i < SNAPSHOT_INTERVAL - 1; i++) {
      await maybeWriteSnapshot(WRITE_OPTS);
    }
    expect(mockWriteDb.indexerSnapshot.create).not.toHaveBeenCalled();
  });

  it(`writes exactly on the ${SNAPSHOT_INTERVAL}th batch`, async () => {
    for (let i = 0; i < SNAPSHOT_INTERVAL; i++) {
      await maybeWriteSnapshot(WRITE_OPTS);
    }
    expect(mockWriteDb.indexerSnapshot.create).toHaveBeenCalledOnce();
  });

  it('resets counter after writing and fires again after another interval', async () => {
    for (let i = 0; i < SNAPSHOT_INTERVAL * 2; i++) {
      await maybeWriteSnapshot(WRITE_OPTS);
    }
    expect(mockWriteDb.indexerSnapshot.create).toHaveBeenCalledTimes(2);
  });
});

describe('verifySnapshot — hash matches', () => {
  beforeEach(resetAllMocks);

  it('returns match=true and status=Verified when RPC hash equals stored hash', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'AABBCCDD' });
    mockReadDb.indexerSnapshot.findUnique.mockResolvedValue(makeSnapshotRecord({ ledgerHash: 'AABBCCDD' }));

    const result = await verifySnapshot(1, { actor: 'op:test' });

    expect(result.match).toBe(true);
    expect(result.status).toBe('Verified');
    expect(result.rpcHash).toBe('AABBCCDD');
  });

  it('updates snapshot to status=Verified with rpcVerified=true', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'AABBCCDD' });

    await verifySnapshot(1, { actor: 'op:test' });

    expect(mockWriteDb.indexerSnapshot.update).toHaveBeenCalledOnce();
    const data = mockWriteDb.indexerSnapshot.update.mock.calls[0][0].data;
    expect(data.status).toBe('Verified');
    expect(data.rpcVerified).toBe(true);
    expect(data.hashMismatch).toBe(false);
  });

  it('increments snapshotVerificationsTotal with result=match', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'AABBCCDD' });

    await verifySnapshot(1, { actor: 'op:test' });

    expect(mockVerificationsInc).toHaveBeenCalledWith({ result: 'match' });
  });

  it('writes OperationalAudit record on success', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'AABBCCDD' });

    await verifySnapshot(1, { actor: 'op:test' });

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.actionType).toBe('SnapshotVerify');
    expect(call.outcome).toBe('Success');
    expect(call.context.match).toBe(true);
  });
});

describe('verifySnapshot — hash mismatch', () => {
  beforeEach(resetAllMocks);

  it('returns match=false and status=Mismatch when RPC hash differs', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'DIFFERENT_HASH' });
    mockReadDb.indexerSnapshot.findUnique.mockResolvedValue(makeSnapshotRecord({ ledgerHash: 'AABBCCDD' }));

    const result = await verifySnapshot(1, { actor: 'op:test' });

    expect(result.match).toBe(false);
    expect(result.status).toBe('Mismatch');
    expect(result.rpcHash).toBe('DIFFERENT_HASH');
  });

  it('sets hashMismatch=true on the snapshot row', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'DIFFERENT_HASH' });

    await verifySnapshot(1, { actor: 'op:test' });

    const data = mockWriteDb.indexerSnapshot.update.mock.calls[0][0].data;
    expect(data.hashMismatch).toBe(true);
    expect(data.status).toBe('Mismatch');
  });

  it('sets snapshotHashMismatchGauge to 1', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'DIFFERENT_HASH' });

    await verifySnapshot(1, { actor: 'op:test' });

    expect(mockHashMismatchGaugeSet).toHaveBeenCalledWith(1);
  });

  it('increments snapshotVerificationsTotal with result=mismatch', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'DIFFERENT_HASH' });

    await verifySnapshot(1, { actor: 'op:test' });

    expect(mockVerificationsInc).toHaveBeenCalledWith({ result: 'mismatch' });
  });

  it('writes OperationalAudit with outcome=Partial on mismatch', async () => {
    mockGetLedger.mockResolvedValue({ ledgerHash: 'DIFFERENT_HASH' });

    await verifySnapshot(1, { actor: 'op:test' });

    const call = mockAuditLog.mock.calls[0][0];
    expect(call.outcome).toBe('Partial');
    expect(call.context.match).toBe(false);
  });
});

describe('verifySnapshot — RPC error (future/unavailable ledger)', () => {
  beforeEach(resetAllMocks);

  it('does NOT update snapshot status when RPC throws', async () => {
    mockGetLedger.mockRejectedValue(new Error('ledger not found on network'));

    const result = await verifySnapshot(1, { actor: 'op:test' });

    // rpcHash stays null, no update
    expect(result.rpcHash).toBeNull();
    expect(mockWriteDb.indexerSnapshot.update).not.toHaveBeenCalled();
  });

  it('increments snapshotVerificationsTotal with result=error', async () => {
    mockGetLedger.mockRejectedValue(new Error('timeout'));

    await verifySnapshot(1, { actor: 'op:test' });

    expect(mockVerificationsInc).toHaveBeenCalledWith({ result: 'error' });
  });

  it('writes OperationalAudit with outcome=Failure on RPC error', async () => {
    mockGetLedger.mockRejectedValue(new Error('network error'));

    await verifySnapshot(1, { actor: 'op:test' });

    const call = mockAuditLog.mock.calls[0][0];
    expect(call.outcome).toBe('Failure');
    expect(call.context.rpcError).toContain('network error');
  });
});

describe('verifySnapshot — missing snapshot', () => {
  beforeEach(resetAllMocks);

  it('throws 404 when snapshot does not exist', async () => {
    mockReadDb.indexerSnapshot.findUnique.mockResolvedValue(null);

    await expect(verifySnapshot(999, { actor: 'op:test' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('findLastVerifiedSnapshot', () => {
  beforeEach(resetAllMocks);

  it('returns null when no Verified snapshot exists at or before ledger', async () => {
    mockReadDb.indexerSnapshot.findFirst.mockResolvedValue(null);

    const result = await findLastVerifiedSnapshot(50000);
    expect(result).toBeNull();
  });

  it('returns the latest Verified snapshot at or before the given ledger', async () => {
    const verified = makeSnapshotRecord({ status: 'Verified', ledgerSequence: 49000 });
    mockReadDb.indexerSnapshot.findFirst.mockResolvedValue(verified);

    const result = await findLastVerifiedSnapshot(50000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('Verified');
    expect(result!.ledgerSequence).toBe(49000);
  });
});

describe('validateSnapshotRange', () => {
  beforeEach(resetAllMocks);

  it('returns correct counts by status', async () => {
    const snapshots = [
      makeSnapshotRecord({ id: 1, ledgerSequence: 1000, status: 'Verified' }),
      makeSnapshotRecord({ id: 2, ledgerSequence: 2000, status: 'Mismatch' }),
      makeSnapshotRecord({ id: 3, ledgerSequence: 3000, status: 'Pending' }),
    ];
    mockReadDb.indexerSnapshot.findMany.mockResolvedValue(snapshots);

    const result = await validateSnapshotRange(1000, 3000);

    expect(result.total).toBe(3);
    expect(result.verified).toBe(1);
    expect(result.mismatch).toBe(1);
    expect(result.pending).toBe(1);
  });

  it('detects no gaps between tightly-spaced snapshots', async () => {
    const snapshots = [
      makeSnapshotRecord({ id: 1, ledgerSequence: 1000 }),
      makeSnapshotRecord({ id: 2, ledgerSequence: 1010 }),
    ];
    mockReadDb.indexerSnapshot.findMany.mockResolvedValue(snapshots);

    const result = await validateSnapshotRange(1000, 1010);
    expect(result.gaps).toHaveLength(0);
  });
});
