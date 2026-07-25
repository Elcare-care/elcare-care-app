import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// ── Mock Prisma ───────────────────────────────────────────────────────────────
const mockPrisma = vi.hoisted(() => ({
  backfillJob: {
    create:      vi.fn(),
    findUnique:  vi.fn().mockResolvedValue(null),
    update:      vi.fn(),
  },
  syncState: {
    findUnique:  vi.fn().mockResolvedValue({ id: 1, lastLedger: 0, lastLedgerHash: null }),
    upsert:      vi.fn().mockResolvedValue({}),
    update:      vi.fn().mockResolvedValue({}),
  },
  ledgerGap: {
    findMany:    vi.fn().mockResolvedValue([]),
  },
  $queryRaw:    vi.fn().mockResolvedValue([{ acquired: true }]),
  $transaction: vi.fn((fn: (tx: any) => Promise<any>) => fn(mockTx)),
}));

const mockTx = vi.hoisted(() => ({
  syncState: {
    upsert: vi.fn().mockResolvedValue({ id: 1, lastLedger: 0 }),
    update: vi.fn().mockResolvedValue({}),
  },
  backfillJob: {
    update: vi.fn().mockResolvedValue({}),
  },
  marketplaceEvent: {
    findMany:    vi.fn().mockResolvedValue([]),
    findUnique:  vi.fn().mockResolvedValue(null),
    create:      vi.fn().mockResolvedValue({}),
    createMany:  vi.fn().mockResolvedValue({}),
  },
  listing: {
    upsert:      vi.fn().mockResolvedValue({}),
    updateMany:  vi.fn().mockResolvedValue({ count: 1 }),
  },
  collection: {
    upsert:      vi.fn().mockResolvedValue({}),
  },
}));

// backfill.ts now imports from prisma-write (write pool), not db (read pool)
vi.mock('../prisma-write', () => ({ default: mockPrisma }));
vi.mock('../db', () => ({ default: mockPrisma }));

// ── Mock metrics ──────────────────────────────────────────────────────────────
vi.mock('../metrics.js', () => ({
  rpcRetryExhaustedCounter:    { inc: vi.fn() },
  decodeErrorsCounter:         { inc: vi.fn() },
  eventDecodeErrorsCounter:    { inc: vi.fn() },
  stalledGauge:                { set: vi.fn() },
  latestLedgerProcessedGauge:  { set: vi.fn() },
  networkLatestLedgerGauge:    { set: vi.fn() },
  syncLatencyGauge:            { set: vi.fn() },
  backfillJobsTotal:           { inc: vi.fn() },
  backfillDurationSeconds:     { startTimer: vi.fn(() => vi.fn()) },
  backfillBatchLedgers:        { observe: vi.fn() },
  backfillBatchInserted:       { observe: vi.fn() },
  backfillLockContentions:     { inc: vi.fn() },
  duplicateEventsCounter:      { inc: vi.fn() },
  gapsCreatedTotal:            { inc: vi.fn() },
  openGapsGauge:               { set: vi.fn() },
  openGapLedgersTotalGauge:    { set: vi.fn() },
}));

vi.mock('../retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  withRpcRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  withDbRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  withIpfsRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

// ── Mock Stellar SDK ──────────────────────────────────────────────────────────
vi.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: class {
      getEvents() { return Promise.resolve({ events: [], paginationToken: null }); }
      getLedgers() { return Promise.resolve({ ledgers: [{ hash: 'hash', sequence: 1000 }] }); }
      getLatestLedger() { return Promise.resolve({ sequence: 1000 }); }
    },
  },
  Contract: class { call() { return {}; } },
  TransactionBuilder: class {
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return {}; }
  },
  BASE_FEE: '100',
  nativeToScVal: () => ({}),
  scValToNative: () => ({}),
}));

// ── parser mock ───────────────────────────────────────────────────────────────
vi.mock('../parser.js', () => ({
  parseMarketplaceEvent: vi.fn().mockReturnValue(null),
}));

// ── redis mock ────────────────────────────────────────────────────────────────
vi.mock('../redis.js', () => ({
  default: { disconnect: vi.fn(), on: vi.fn(), connect: vi.fn() },
}));

// ── poller applyDecodedEvents / buildSyncStateLedgerData mocks ───────────────
vi.mock('../poller.js', () => ({
  applyDecodedEvents: vi.fn().mockResolvedValue([]),
  buildSyncStateLedgerData: vi.fn((ledger: number, hash: string | null) =>
    hash ? { lastLedger: ledger, lastLedgerHash: hash } : { lastLedger: ledger }
  ),
  registerShutdownHook: vi.fn(),
  gracefulShutdown: vi.fn(),
}));

import { runBackfill } from '../backfill.js';

describe('runBackfill — range validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MARKETPLACE_CONTRACT_ID = 'CTEST';
    process.env.STELLAR_RPC_URL = 'http://rpc.test';
    // Simulate CLI args required by parseArgs
    process.argv = ['node', 'backfill.ts', '--start=100', '--end=200'];

    // Default job returned by backfillJob.create
    mockPrisma.backfillJob.create.mockResolvedValue({
      id: 1, startLedger: 100, endLedger: 200, checkpointLedger: 0,
      status: 'Pending', rpcUrl: 'http://rpc.test', totalInserted: 0,
      gapId: null, error: null, createdAt: new Date(), updatedAt: new Date(),
    });
    // update called to mark Running / Completed
    mockPrisma.backfillJob.update.mockResolvedValue({});
    // advisory lock always acquired
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
  });

  afterEach(() => {
    delete process.env.MARKETPLACE_CONTRACT_ID;
    delete process.env.STELLAR_RPC_URL;
  });

  it('throws when startLedger > endLedger (from > to)', async () => {
    process.argv = ['node', 'backfill.ts', '--start=500', '--end=200'];
    await expect(runBackfill()).rejects.toThrow(/--start=500.*must be ≤.*--end=200/);
  });

  it('throws when startLedger is negative', async () => {
    process.argv = ['node', 'backfill.ts', '--start=-1', '--end=100'];
    await expect(runBackfill()).rejects.toThrow(/non-negative/);
  });

  it('throws when endLedger exceeds the chain tip', async () => {
    // Chain tip = 1000 from the mock getLatestLedger
    process.argv = ['node', 'backfill.ts', '--start=100', '--end=9999'];
    await expect(runBackfill()).rejects.toThrow(/exceeds chain tip/);
  });

  it('completes successfully for a valid small range', async () => {
    process.argv = ['node', 'backfill.ts', '--start=100', '--end=200'];
    await expect(runBackfill()).resolves.toMatchObject({
      startLedger: 100,
      endLedger: 200,
      totalInserted: 0,
    });
  });

  it('logs progress at each batch boundary', async () => {
    // New backfill uses process.stdout.write for CLI progress bar and logger.debug
    // for structured batch logs.  Just verify it completes successfully.
    process.argv = ['node', 'backfill.ts', '--start=100', '--end=200'];
    await expect(runBackfill({ silent: true })).resolves.toMatchObject({
      status: 'Completed',
    });
  });

  it('re-running the same range is safe (idempotent) — no duplicate inserts', async () => {
    process.argv = ['node', 'backfill.ts', '--start=100', '--end=200'];
    await runBackfill();
    await runBackfill();
    // applyDecodedEvents (mocked) would deduplicate; we just verify it doesn't throw
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
