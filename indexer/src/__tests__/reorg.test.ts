/**
 * reorg.test.ts — Vitest tests for deep re-org halt behavior.
 *
 * Acceptance criteria:
 *   1. Re-orgs deeper than MAX_ROLLBACK_DEPTH halt the poller and emit a
 *      CRITICAL_REORG SSE event rather than executing a deep rollback.
 *   2. Shallow re-orgs execute normally and emit a REORG SSE event.
 *   3. The admin recovery endpoint allows manual rollback initiation and
 *      clears the halt state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Prevent dotenv from loading .env so module-level constants stay empty
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// Prisma mock
const mockTx = vi.hoisted(() => ({
  marketplaceEvent: { deleteMany: vi.fn().mockResolvedValue({}) },
  listing: {
    deleteMany: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({}),
  },
  collection: { deleteMany: vi.fn().mockResolvedValue({}) },
  syncState: { update: vi.fn().mockResolvedValue({}) },
  auction: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
}));

const mockPrisma = vi.hoisted(() => ({
  syncState: {
    findUnique: vi.fn(),
    findFirst: vi.fn().mockResolvedValue({ id: 1, lastLedger: 0 }),
    create: vi.fn().mockResolvedValue({ id: 1, lastLedger: 0 }),
    update: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({ id: 1, lastLedger: 0, lastLedgerHash: null }),
  },
  trackedContract: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
  marketplaceEvent: {
    create: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  },
  listing: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  auction: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  offer: {
    upsert: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
  collection: { upsert: vi.fn().mockResolvedValue({}) },
  ledgerGap: {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
  },
  $transaction: vi.fn((fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
}));

vi.mock('../db', () => ({ default: mockPrisma }));
// poller.ts imports from prisma-write; mock it with the same object
vi.mock('../prisma-write', () => ({ default: mockPrisma }));

vi.mock('../metrics.js', () => ({
  latestLedgerProcessedGauge: { set: vi.fn() },
  networkLatestLedgerGauge: { set: vi.fn() },
  syncLatencyGauge: { set: vi.fn() },
  decodeErrorsCounter: { inc: vi.fn() },
  duplicateEventsCounter: { inc: vi.fn() },
  gapsCreatedTotal: { inc: vi.fn() },
  openGapsGauge: { set: vi.fn() },
  openGapLedgersTotalGauge: { set: vi.fn() },
}));

vi.mock('../stall.js', () => ({ recordProgress: vi.fn() }));
vi.mock('../event-sync.js', () => ({
  collectMarketplaceEvents: vi.fn().mockResolvedValue([]),
  MAX_LEDGER_WINDOW: 17_000,
}));
vi.mock('../retry.js', () => ({
  withRpcRetry: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../redis.js', () => ({
  default: {
    isOpen: false, isReady: false,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    connect: vi.fn().mockRejectedValue(new Error('No Redis')),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../ipfs-cache.js', () => ({ enqueueIpfsFetch: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    pollIntervalMs: 5000,
    maxLedgersPerCycle: 1000,
    maxRollbackDepth: 100,
    reorgHaltOnDeep: true,
  })),
  parseTrackedContracts: vi.fn(() => []),
}));

// SSE route mock — captures emitted events
const emittedEvents: unknown[] = [];
vi.mock('../api/routes.js', () => ({
  emitSSEEvent: vi.fn((event: unknown) => {
    emittedEvents.push(event);
  }),
  closeSSEClients: vi.fn(),
}));

// Import after mocks are set up
import {
  validateHashContinuity,
  revertLedgers,
  isPollerHalted,
  getHaltReason,
  resumePoller,
} from '../poller';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockServer(overrides: {
  hashAtLedger?: (ledger: number) => string | null;
} = {}) {
  return {
    getLedgers: vi.fn(({ startLedger }: { startLedger: number }) => {
      const hash = overrides.hashAtLedger?.(startLedger) ?? null;
      if (hash === null) {
        return Promise.resolve({ ledgers: [] });
      }
      return Promise.resolve({ ledgers: [{ hash, sequence: startLedger }] });
    }),
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validateHashContinuity — shallow re-org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEvents.length = 0;
    // Ensure poller is not halted before each test
    resumePoller();
  });

  afterEach(() => {
    resumePoller();
  });

  it('returns true when hashes match (no re-org)', async () => {
    const server = makeMockServer({ hashAtLedger: () => 'matching_hash' });

    const result = await validateHashContinuity(
      { lastLedger: 100, lastLedgerHash: 'matching_hash' },
      server,
      100,
      true
    );

    expect(result).toBe(true);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(0);
  });

  it('returns true and skips RPC when lastLedgerHash is null', async () => {
    const server = makeMockServer();

    const result = await validateHashContinuity(
      { lastLedger: 100, lastLedgerHash: null },
      server,
      100,
      true
    );

    expect(result).toBe(true);
    expect(server.getLedgers).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(0);
  });

  it('emits a REORG event for a shallow re-org (depth <= maxRollbackDepth)', async () => {
    // Hash mismatch at ledger 100; safe point is ledger 95 (depth 5, well under limit 100)
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 100) return 'network_hash'; // differs from DB hash
        if (ledger === 95) return 'good_hash'; // first accessible ancestor
        return null;
      },
    });

    const result = await validateHashContinuity(
      { lastLedger: 100, lastLedgerHash: 'db_hash' },
      server,
      100,
      true
    );

    expect(result).toBe(false);
    // revertLedgers should have been called (via $transaction)
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    // A REORG event (not CRITICAL_REORG) should be emitted
    const reorgEvent = emittedEvents.find((e: any) => e.type === 'REORG');
    expect(reorgEvent).toBeDefined();
    expect((reorgEvent as any).from_ledger).toBe(100);
    // Poller should NOT be halted
    expect(isPollerHalted()).toBe(false);
  });

  it('does not emit CRITICAL_REORG for shallow re-orgs', async () => {
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 100) return 'different_hash';
        if (ledger === 99) return 'ancestor_hash'; // depth 1
        return null;
      },
    });

    await validateHashContinuity(
      { lastLedger: 100, lastLedgerHash: 'db_hash' },
      server,
      100,
      true
    );

    const criticalEvent = emittedEvents.find((e: any) => e.type === 'CRITICAL_REORG');
    expect(criticalEvent).toBeUndefined();
  });
});

describe('validateHashContinuity — deep re-org halting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEvents.length = 0;
    resumePoller();
  });

  afterEach(() => {
    resumePoller();
  });

  it('halts the poller and emits CRITICAL_REORG when depth exceeds maxRollbackDepth', async () => {
    // Hash mismatch at ledger 200; no accessible ancestor within 5 ledgers (depth > maxRollbackDepth=5)
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 200) return 'network_hash_mismatch'; // different from DB
        // All ancestors return null (not accessible) — findReorgSafePoint falls back to divergedAt - maxDepth
        return null;
      },
    });

    expect(isPollerHalted()).toBe(false);

    const result = await validateHashContinuity(
      { lastLedger: 200, lastLedgerHash: 'stored_db_hash' },
      server,
      5,   // maxRollbackDepth = 5 (low for testing)
      true // reorgHaltOnDeep = true
    );

    expect(result).toBe(false);
    // The poller should be halted
    expect(isPollerHalted()).toBe(true);
    expect(getHaltReason()).toContain('MAX_ROLLBACK_DEPTH');
    // revertLedgers should NOT have been called (we halt instead)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // A CRITICAL_REORG event should be emitted
    const criticalEvent = emittedEvents.find((e: any) => e.type === 'CRITICAL_REORG');
    expect(criticalEvent).toBeDefined();
    expect((criticalEvent as any).from_ledger).toBe(200);
    expect((criticalEvent as any).depth).toBeGreaterThan(5);
    expect((criticalEvent as any).message).toContain('MAX_ROLLBACK_DEPTH');
    // A plain REORG event should NOT be emitted
    const reorgEvent = emittedEvents.find((e: any) => e.type === 'REORG');
    expect(reorgEvent).toBeUndefined();
  });

  it('does NOT halt when reorgHaltOnDeep is false (even for deep re-orgs)', async () => {
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 200) return 'different_hash';
        return null; // all ancestors inaccessible
      },
    });

    const result = await validateHashContinuity(
      { lastLedger: 200, lastLedgerHash: 'db_hash' },
      server,
      5,    // low maxRollbackDepth
      false // reorgHaltOnDeep = false → allow deep rollback
    );

    expect(result).toBe(false);
    expect(isPollerHalted()).toBe(false);
    // Should proceed to revertLedgers
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    // Should emit a plain REORG event (not CRITICAL)
    const reorgEvent = emittedEvents.find((e: any) => e.type === 'REORG');
    expect(reorgEvent).toBeDefined();
    const criticalEvent = emittedEvents.find((e: any) => e.type === 'CRITICAL_REORG');
    expect(criticalEvent).toBeUndefined();
  });
});

describe('resumePoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEvents.length = 0;
    resumePoller();
  });

  afterEach(() => {
    resumePoller();
  });

  it('clears the halt state so the poller can continue', async () => {
    // First trigger a halt
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 100) return 'different_hash';
        return null;
      },
    });

    await validateHashContinuity(
      { lastLedger: 100, lastLedgerHash: 'db_hash' },
      server,
      1, // tiny depth to ensure halt
      true
    );

    expect(isPollerHalted()).toBe(true);

    // Now resume
    resumePoller();

    expect(isPollerHalted()).toBe(false);
    expect(getHaltReason()).toBeNull();
  });
});

describe('revertLedgers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEvents.length = 0;
    resumePoller();
  });

  it('deletes marketplace events beyond the safe ledger', async () => {
    await revertLedgers(500);
    expect(mockTx.marketplaceEvent.deleteMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: 500 } },
    });
  });

  it('removes listings first created after the safe ledger', async () => {
    await revertLedgers(500);
    expect(mockTx.listing.deleteMany).toHaveBeenCalledWith({
      where: { createdAtLedger: { gt: 500 } },
    });
  });

  it('resets listing status to Active for listings updated after safe ledger', async () => {
    await revertLedgers(500);
    expect(mockTx.listing.updateMany).toHaveBeenCalledWith({
      where: { updatedAtLedger: { gt: 500 } },
      data: { status: 'Active', updatedAtLedger: 500 },
    });
  });

  it('removes collections deployed after the safe ledger', async () => {
    await revertLedgers(500);
    expect(mockTx.collection.deleteMany).toHaveBeenCalledWith({
      where: { deployedAtLedger: { gt: 500 } },
    });
  });

  it('resets SyncState cursor to the safe ledger and clears the hash', async () => {
    await revertLedgers(500);
    expect(mockTx.syncState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { lastLedger: 500, lastLedgerHash: null },
    });
  });

  it('runs all operations inside a single transaction', async () => {
    await revertLedgers(300);
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
  });
});

describe('ReorgEvent SSE shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEvents.length = 0;
    resumePoller();
  });

  afterEach(() => {
    resumePoller();
  });

  it('REORG event has required fields: type, from_ledger, to_ledger, timestamp, depth', async () => {
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 100) return 'mismatched_network_hash';
        if (ledger === 98) return 'good_ancestor';
        return null;
      },
    });

    await validateHashContinuity(
      { lastLedger: 100, lastLedgerHash: 'db_stored_hash' },
      server,
      100,
      true
    );

    const reorgEvent = emittedEvents.find((e: any) => e.type === 'REORG') as any;
    expect(reorgEvent).toBeDefined();
    expect(typeof reorgEvent.from_ledger).toBe('number');
    expect(typeof reorgEvent.to_ledger).toBe('number');
    expect(typeof reorgEvent.timestamp).toBe('string');
    expect(typeof reorgEvent.depth).toBe('number');
    expect(reorgEvent.from_ledger).toBe(100);
    expect(reorgEvent.depth).toBeGreaterThan(0);
  });

  it('CRITICAL_REORG event has all required fields including message', async () => {
    const server = makeMockServer({
      hashAtLedger: (ledger: number) => {
        if (ledger === 200) return 'different';
        return null;
      },
    });

    await validateHashContinuity(
      { lastLedger: 200, lastLedgerHash: 'stored' },
      server,
      3,
      true
    );

    const critEvent = emittedEvents.find((e: any) => e.type === 'CRITICAL_REORG') as any;
    expect(critEvent).toBeDefined();
    expect(typeof critEvent.from_ledger).toBe('number');
    expect(typeof critEvent.to_ledger).toBe('number');
    expect(typeof critEvent.timestamp).toBe('string');
    expect(typeof critEvent.depth).toBe('number');
    expect(typeof critEvent.message).toBe('string');
    expect(critEvent.message.length).toBeGreaterThan(0);
  });
});
