/**
 * event-verifier.test.ts
 *
 * Tests for the read-only event integrity verifier covering:
 *   - Clean range: deterministic clean result
 *   - Injected duplicate: detected and reported
 *   - Injected gap / omission: RPC event not in DB
 *   - Orphan projection: DB event not on RPC
 *   - Ledger discontinuity: recorded LedgerGap within range
 *   - Memory safety: streaming windows don't accumulate all events at once
 *   - Resumable cursor: second run starts from cursor
 *   - Read-only guarantee: no mutations to DB tables
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Prisma ───────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  trackedContract: {
    findMany: vi.fn(),
  },
  marketplaceEvent: {
    findMany: vi.fn(),
  },
  ledgerGap: {
    findMany: vi.fn(),
  },
  // These MUST NOT be called by the verifier (read-only guarantee)
  marketplaceEvent_create: vi.fn(),
  listing:    { update: vi.fn(), create: vi.fn() },
  auction:    { update: vi.fn(), create: vi.fn() },
  syncState:  { update: vi.fn() },
}));

vi.mock('../db.js', () => ({
  default: mockPrisma,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Mock event-sync (collectMarketplaceEvents) ────────────────────────────────

const { mockCollect } = vi.hoisted(() => ({ mockCollect: vi.fn() }));

vi.mock('../event-sync.js', () => ({
  collectMarketplaceEvents: mockCollect,
  MAX_LEDGER_WINDOW: 17000,
}));

// ── Mock parser ───────────────────────────────────────────────────────────────

vi.mock('../parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parser.js')>();
  return { ...actual };
});

import {
  runEventVerifier,
  serializeVerifierResult,
  type VerifierResult,
} from '../event-verifier.js';
import { computeEventHash } from '../parser.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDecodedEvent(ledger: number, idx: number, contractId = 'CONTRACT_A') {
  const txHash = `tx${ledger}_${idx}`;
  const eventHash = computeEventHash(contractId, ledger, txHash, idx);
  return {
    eventType: 'LISTING_CREATED',
    listingId: BigInt(idx + 1),
    actor: 'GARTIST',
    ledgerSequence: ledger,
    data: {},
    eventHash,
    contractId,
    txHash,
    eventIndex: idx,
    eventId: `${ledger}-1-${idx}`,
    txIndex: 1,
  };
}

function makeDbRow(event: ReturnType<typeof makeDecodedEvent>) {
  return {
    eventHash: event.eventHash,
    ledgerSequence: event.ledgerSequence,
    contractId: event.contractId,
    eventIndex: event.eventIndex,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runEventVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no tracked contracts from env; return one from DB
    mockPrisma.trackedContract.findMany.mockResolvedValue([
      { contractId: 'CONTRACT_A', startLedger: 1000, lastLedger: 1010 },
    ]);

    // Default: no gaps
    mockPrisma.ledgerGap.findMany.mockResolvedValue([]);
  });

  // ── Clean range ────────────────────────────────────────────────────────────

  it('returns deterministic clean result for a range with no discrepancies', async () => {
    const events = [makeDecodedEvent(1001, 0), makeDecodedEvent(1002, 0)];
    mockCollect.mockResolvedValue(events);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue(
      events.map(makeDbRow)
    );

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1002,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.duplicates).toHaveLength(0);
    expect(result.omissions).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
    expect(result.discontinuities).toHaveLength(0);
    expect(result.complete).toBe(true);
    expect(result.rpcEventCount).toBe(2);
    expect(result.dbEventCount).toBe(2);
  });

  // ── Duplicate detection ────────────────────────────────────────────────────

  it('detects an injected duplicate in the DB', async () => {
    const event = makeDecodedEvent(1001, 0);
    mockCollect.mockResolvedValue([event]);

    // DB returns the same eventHash twice
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      makeDbRow(event),
      makeDbRow(event), // duplicate
    ]);

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1001,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].kind).toBe('duplicate');
    expect(result.duplicates[0].eventHash).toBe(event.eventHash);
    expect(result.omissions).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  // ── Omission detection ─────────────────────────────────────────────────────

  it('detects an event present on RPC but missing from DB (omission)', async () => {
    const rpcEvent = makeDecodedEvent(1001, 0);
    mockCollect.mockResolvedValue([rpcEvent]);

    // DB has no events for this ledger
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1001,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0].kind).toBe('omission');
    expect(result.omissions[0].eventHash).toBe(rpcEvent.eventHash);
    expect(result.duplicates).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  // ── Orphan detection ───────────────────────────────────────────────────────

  it('detects a DB event with no matching on-chain identity (orphan)', async () => {
    // RPC returns nothing (empty ledger)
    mockCollect.mockResolvedValue([]);

    // DB has an event that doesn't exist on-chain
    const orphanHash = computeEventHash('CONTRACT_A', 1001, 'phantom_tx', 0);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      { eventHash: orphanHash, ledgerSequence: 1001, contractId: 'CONTRACT_A', eventIndex: 0 },
    ]);

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1001,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].kind).toBe('orphan');
    expect(result.orphans[0].eventHash).toBe(orphanHash);
    expect(result.omissions).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });

  // ── Ledger discontinuity ───────────────────────────────────────────────────

  it('reports a recorded LedgerGap within the verified range', async () => {
    mockCollect.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    // Inject a gap overlapping our range
    mockPrisma.ledgerGap.findMany.mockResolvedValue([
      { fromLedger: 1001, toLedger: 1002, source: 'reorg', status: 'Open' },
    ]);

    const result = await runEventVerifier({
      fromLedger: 1000,
      toLedger: 1005,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.discontinuities.length).toBeGreaterThanOrEqual(1);
    const gap = result.discontinuities.find(
      (d) => d.kind === 'discontinuity' && d.fromLedger === 1001
    );
    expect(gap).toBeDefined();
  });

  // ── Resumable cursor ───────────────────────────────────────────────────────

  it('starts from cursor when provided, skipping already-verified ledgers', async () => {
    const event = makeDecodedEvent(1003, 0);
    mockCollect.mockResolvedValue([event]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([makeDbRow(event)]);

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1005,
      contractIds: ['CONTRACT_A'],
      cursorLedger: 1002, // already verified up to 1002
      windowSize: 100,
    });

    // Should only scan 1003–1005 (cursor+1 onward)
    expect(result.cursor).toBeGreaterThanOrEqual(1002);
    // collectMarketplaceEvents should have been called with startLedger >= 1003
    const calls = mockCollect.mock.calls;
    expect(calls.every(([, , start]) => start >= 1003)).toBe(true);
  });

  // ── Read-only guarantee ────────────────────────────────────────────────────

  it('does not call any write methods on Prisma tables', async () => {
    mockCollect.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1002,
      contractIds: ['CONTRACT_A'],
    });

    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
    expect(mockPrisma.auction.update).not.toHaveBeenCalled();
    expect(mockPrisma.syncState.update).not.toHaveBeenCalled();
  });

  // ── Streaming windows ──────────────────────────────────────────────────────

  it('processes range in multiple windows when windowSize is small', async () => {
    // 1001–1005 with windowSize=2 should produce 3 windows
    mockCollect.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1005,
      contractIds: ['CONTRACT_A'],
      windowSize: 2,
    });

    // Should have called collectMarketplaceEvents 3 times (1001-1002, 1003-1004, 1005-1005)
    expect(mockCollect).toHaveBeenCalledTimes(3);
  });

  // ── serializeVerifierResult ────────────────────────────────────────────────

  it('serializes result to JSON-safe object without BigInts', () => {
    const result: VerifierResult = {
      fromLedger: 1000,
      toLedger: 1005,
      scannedLedgers: 6,
      rpcEventCount: 2,
      dbEventCount: 2,
      duplicates: [],
      omissions: [],
      orphans: [],
      discontinuities: [],
      cursor: 1005,
      complete: true,
    };

    const json = serializeVerifierResult(result);
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(json.complete).toBe(true);
  });

  // ── RPC failure in window ──────────────────────────────────────────────────

  it('records a discontinuity when RPC fetch fails for a window', async () => {
    mockCollect.mockRejectedValue(new Error('RPC unavailable'));
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1002,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.discontinuities.length).toBeGreaterThanOrEqual(1);
    const rpcFail = result.discontinuities.find((d) =>
      d.detail.includes('RPC fetch failed')
    );
    expect(rpcFail).toBeDefined();
  });

  // ── Multiple discrepancy classes in one run ────────────────────────────────

  it('detects all discrepancy classes simultaneously', async () => {
    const rpcEvent  = makeDecodedEvent(1001, 0); // will be found → clean
    const omitted   = makeDecodedEvent(1001, 1); // only on RPC
    const orphanHash = computeEventHash('CONTRACT_A', 1001, 'phantom', 99);
    const dupEvent  = makeDecodedEvent(1001, 2); // duplicate in DB

    mockCollect.mockResolvedValue([rpcEvent, omitted, dupEvent]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      makeDbRow(rpcEvent),
      // omitted: not in DB
      makeDbRow(dupEvent),
      makeDbRow(dupEvent), // duplicate
      { eventHash: orphanHash, ledgerSequence: 1001, contractId: 'CONTRACT_A', eventIndex: 99 },
    ]);

    const result = await runEventVerifier({
      fromLedger: 1001,
      toLedger: 1001,
      contractIds: ['CONTRACT_A'],
    });

    expect(result.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(result.omissions.length).toBeGreaterThanOrEqual(1);
    expect(result.orphans.length).toBeGreaterThanOrEqual(1);
  });
});
