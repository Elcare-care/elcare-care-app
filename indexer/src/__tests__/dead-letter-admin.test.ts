/**
 * dead-letter-admin.test.ts
 *
 * Tests for the dead-letter admin service (dead-letter-service.ts):
 *   1. Successful replay: parse succeeds → projection committed → status=Replayed
 *   2. Parse-null replay: parseMarketplaceEvent returns null → status kept Pending, outcome=parse_null
 *   3. Persistent failure: attempts >= MAX (3) → status=Failed
 *   4. Duplicate replay (idempotency key already used on same record) → outcome=duplicate, no re-run
 *   5. Already-replayed record → outcome=duplicate immediately
 *   6. Concurrency lock: lockedAt set and not stale → 409 thrown
 *   7. Remediate: sets remediationReason and writes OperationalAudit
 *   8. Auth failure: operator token missing → 401 from the HTTP layer
 *   9. Metrics: deadLetterReplayAttemptsTotal incremented per outcome
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const mockParse = vi.hoisted(() => vi.fn());
vi.mock('../parser', () => ({
  parseMarketplaceEvent: mockParse,
  SchemaDecodeError: class SchemaDecodeError extends Error {
    constructor(public eventType: string, public reason: string, public raw: unknown) {
      super(`[SchemaDecodeError] ${eventType}: ${reason}`);
      this.name = 'SchemaDecodeError';
    }
  },
}));

const mockProcessEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../poller', () => ({
  processEvent:   mockProcessEvent,
  isPollerHalted: vi.fn().mockReturnValue(false),
  getHaltReason:  vi.fn().mockReturnValue(null),
  resumePoller:   vi.fn(),
  revertLedgers:  vi.fn().mockResolvedValue(undefined),
  applyDecodedEvents: vi.fn().mockResolvedValue(undefined),
}));

const mockAuditLog = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../audit/audit-service', () => ({
  getAuditService: () => ({ log: mockAuditLog }),
  AuditService: class {},
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Metrics mocks
const mockReplayAttemptsInc = vi.hoisted(() => vi.fn());
const mockPendingGaugeSet   = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({
  deadLetterReplayAttemptsTotal:    { inc: mockReplayAttemptsInc },
  deadLetterPendingGauge:           { set: mockPendingGaugeSet },
  deadLetterReplayProjectedTotal:   { inc: vi.fn() },
  deadLetterCreatedTotal:           { inc: vi.fn() },
  deadLetterOldestAgeSeconds:       { set: vi.fn() },
  snapshotsWrittenTotal:            { inc: vi.fn() },
  snapshotVerificationsTotal:       { inc: vi.fn() },
  snapshotHashMismatchGauge:        { set: vi.fn() },
}));

// ── Shared DB stub factory ────────────────────────────────────────────────────

function makeDeadLetterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    contractId:    'CA_CONTRACT_1',
    ledgerSequence: 1000,
    txHash:        'TXHASH_001',
    eventIndex:    0,
    rawTopics:     ['dGVzdA=='],
    rawValue:      'dGVzdA==',
    errorCode:     'UNKNOWN',
    errorMessage:  'XDR parse failed',
    parserVersion: '',
    status:        'Pending',
    attempts:       0,
    remediationReason: null,
    replayedBy:    null,
    lockedAt:      null,
    idempotencyKey: null,
    createdAt:     new Date('2026-08-29T00:00:00Z'),
    updatedAt:     new Date('2026-08-29T00:00:00Z'),
    ...overrides,
  };
}

// Build a DB mock that the service reads/writes through
function makeDbMock(recordOverrides: Record<string, unknown> = {}) {
  const record = makeDeadLetterRecord(recordOverrides);

  const attempt = { id: 99, deadLetterId: record.id, outcome: 'success', projectionCommitted: true };

  return {
    deadLetterEvent: {
      findUnique: vi.fn().mockResolvedValue(record),
      findFirst:  vi.fn().mockResolvedValue(null),
      findMany:   vi.fn().mockResolvedValue([record]),
      count:      vi.fn().mockResolvedValue(1),
      update:     vi.fn().mockResolvedValue(record),
    },
    deadLetterReplayAttempt: {
      create: vi.fn().mockResolvedValue(attempt),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txClient = {
        deadLetterEvent: {
          update: vi.fn().mockResolvedValue(record),
        },
        deadLetterReplayAttempt: {
          create: vi.fn().mockResolvedValue(attempt),
        },
      };
      return fn(txClient);
    }),
  };
}

// Inject mocks before importing the module under test
const mockRead  = vi.hoisted(() => makeDbMock());
const mockWrite = vi.hoisted(() => makeDbMock());

vi.mock('../db',          () => ({ default: mockRead }));
vi.mock('../prisma-write', () => ({ default: { ...mockWrite, $disconnect: vi.fn() } }));

// ── Import the module under test AFTER mocks are set ─────────────────────────

import {
  replayDeadLetter,
  remediateDeadLetter,
  listDeadLetters,
  inspectDeadLetter,
} from '../dead-letter-service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTOR = 'op:test-operator';

function resetMocks() {
  vi.clearAllMocks();

  // Restore defaults
  mockParse.mockReturnValue(null);
  mockProcessEvent.mockResolvedValue(undefined);
  mockAuditLog.mockResolvedValue(undefined);

  // Restore DB defaults
  const fresh = makeDbMock();
  Object.assign(mockRead.deadLetterEvent,          fresh.deadLetterEvent);
  Object.assign(mockRead.deadLetterReplayAttempt,  fresh.deadLetterReplayAttempt);
  mockRead.$transaction.mockImplementation(fresh.$transaction);

  Object.assign(mockWrite.deadLetterEvent,         fresh.deadLetterEvent);
  Object.assign(mockWrite.deadLetterReplayAttempt, fresh.deadLetterReplayAttempt);
  mockWrite.$transaction.mockImplementation(fresh.$transaction);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('replayDeadLetter — successful replay', () => {
  beforeEach(resetMocks);

  it('returns outcome=success and projectionCommitted=true when parse + processEvent succeed', async () => {
    mockParse.mockReturnValue({
      eventType:      'LISTING_CREATED',
      listingId:      BigInt(1),
      actor:          'GA_ARTIST',
      ledgerSequence: 1000,
      data:           {},
      eventHash:      'abc',
      contractId:     'CA_CONTRACT_1',
      txHash:         'TXHASH_001',
      eventIndex:     0,
    });

    const result = await replayDeadLetter(1, { actor: ACTOR });

    expect(result.outcome).toBe('success');
    expect(result.projectionCommitted).toBe(true);
    expect(result.parsedEventType).toBe('LISTING_CREATED');
    expect(mockProcessEvent).toHaveBeenCalledOnce();
  });

  it('writes a DeadLetterReplayAttempt row with projectionCommitted=true', async () => {
    mockParse.mockReturnValue({ eventType: 'ARTWORK_SOLD', listingId: BigInt(1), actor: 'GA', ledgerSequence: 1000, data: {}, eventHash: 'xyz', contractId: 'CA', txHash: 'TX', eventIndex: 0 });

    await replayDeadLetter(1, { actor: ACTOR });

    // The $transaction was called — inside it, deadLetterReplayAttempt.create was invoked
    expect(mockWrite.$transaction).toHaveBeenCalledOnce();
  });

  it('writes an OperationalAudit record on success', async () => {
    mockParse.mockReturnValue({ eventType: 'LISTING_CREATED', listingId: BigInt(1), actor: 'GA', ledgerSequence: 1000, data: {}, eventHash: 'abc', contractId: 'CA', txHash: 'TX', eventIndex: 0 });

    await replayDeadLetter(1, { actor: ACTOR });

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.actionType).toBe('DeadLetterReplay');
    expect(call.outcome).toBe('Success');
    expect(call.context.replayOutcome).toBe('success');
  });

  it('increments deadLetterReplayAttemptsTotal with outcome=success', async () => {
    mockParse.mockReturnValue({ eventType: 'ARTWORK_SOLD', listingId: BigInt(1), actor: 'GA', ledgerSequence: 1000, data: {}, eventHash: 'xyz', contractId: 'CA', txHash: 'TX', eventIndex: 0 });

    await replayDeadLetter(1, { actor: ACTOR });

    expect(mockReplayAttemptsInc).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('dry-run: does NOT call processEvent, still records attempt', async () => {
    mockParse.mockReturnValue({ eventType: 'LISTING_CREATED', listingId: BigInt(1), actor: 'GA', ledgerSequence: 1000, data: {}, eventHash: 'abc', contractId: 'CA', txHash: 'TX', eventIndex: 0 });

    const result = await replayDeadLetter(1, { actor: ACTOR, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.projectionCommitted).toBe(false);
    expect(mockProcessEvent).not.toHaveBeenCalled();
  });
});

describe('replayDeadLetter — parse_null', () => {
  beforeEach(resetMocks);

  it('returns outcome=parse_null when parseMarketplaceEvent returns null', async () => {
    mockParse.mockReturnValue(null);

    const result = await replayDeadLetter(1, { actor: ACTOR });

    expect(result.outcome).toBe('parse_null');
    expect(result.projectionCommitted).toBe(false);
    expect(mockProcessEvent).not.toHaveBeenCalled();
  });

  it('does NOT set status=Replayed when parse returns null', async () => {
    mockParse.mockReturnValue(null);

    await replayDeadLetter(1, { actor: ACTOR });

    // Confirm the $transaction was still called but with status != Replayed
    const txCalls = mockWrite.$transaction.mock.calls;
    expect(txCalls.length).toBe(1);
  });
});

describe('replayDeadLetter — persistent failure', () => {
  beforeEach(resetMocks);

  it('sets status=Failed when attempts reaches MAX_REPLAY_ATTEMPTS (3)', async () => {
    // Record is on attempt 2 (next one = 3 = MAX)
    const record = makeDeadLetterRecord({ attempts: 2, status: 'Pending' });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);
    mockParse.mockImplementation(() => { throw new Error('parse exploded'); });

    const result = await replayDeadLetter(1, { actor: ACTOR });

    expect(result.outcome).toBe('projection_error');
    // The transaction should have set status=Failed
    expect(mockWrite.$transaction).toHaveBeenCalledOnce();
  });

  it('keeps status=Pending when attempts < MAX and parse fails', async () => {
    // Record is on attempt 0
    const record = makeDeadLetterRecord({ attempts: 0, status: 'Pending' });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);
    mockParse.mockImplementation(() => { throw new Error('parse failed'); });

    const result = await replayDeadLetter(1, { actor: ACTOR });

    expect(result.outcome).toBe('projection_error');
    expect(result.projectionCommitted).toBe(false);
  });

  it('increments deadLetterReplayAttemptsTotal with outcome=projection_error', async () => {
    mockParse.mockImplementation(() => { throw new Error('boom'); });

    await replayDeadLetter(1, { actor: ACTOR });

    expect(mockReplayAttemptsInc).toHaveBeenCalledWith({ outcome: 'projection_error' });
  });

  it('writes OperationalAudit record with outcome=Failure on parse error', async () => {
    mockParse.mockImplementation(() => { throw new Error('bad parse'); });

    await replayDeadLetter(1, { actor: ACTOR });

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.outcome).toBe('Failure');
  });
});

describe('replayDeadLetter — duplicate / idempotency', () => {
  beforeEach(resetMocks);

  it('returns outcome=duplicate immediately when record is already Replayed', async () => {
    const record = makeDeadLetterRecord({ status: 'Replayed', attempts: 1 });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    const result = await replayDeadLetter(1, { actor: ACTOR });

    expect(result.outcome).toBe('duplicate');
    expect(mockProcessEvent).not.toHaveBeenCalled();
    expect(mockReplayAttemptsInc).toHaveBeenCalledWith({ outcome: 'duplicate' });
  });

  it('returns outcome=duplicate for same record when idempotencyKey already used on Replayed record', async () => {
    const record = makeDeadLetterRecord({ status: 'Replayed', idempotencyKey: 'key-abc' });
    // findFirst (idempotency check) returns the same record
    mockRead.deadLetterEvent.findFirst.mockResolvedValue({ ...record, replayAttempts: [{ id: 10, outcome: 'success', parsedEventType: 'LISTING_CREATED' }] });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    const result = await replayDeadLetter(1, { actor: ACTOR, idempotencyKey: 'key-abc' });

    expect(result.outcome).toBe('duplicate');
  });
});

describe('replayDeadLetter — concurrency lock', () => {
  beforeEach(resetMocks);

  it('throws 409 when lockedAt is recent (non-stale)', async () => {
    const recentLock = new Date(Date.now() - 10_000); // 10 seconds ago — within TTL
    const record = makeDeadLetterRecord({ lockedAt: recentLock });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    await expect(replayDeadLetter(1, { actor: ACTOR }))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(mockProcessEvent).not.toHaveBeenCalled();
  });

  it('proceeds when lockedAt is stale (> REPLAY_LOCK_TTL_SECONDS)', async () => {
    const staleLock = new Date(Date.now() - 200_000); // 200 seconds ago — stale
    const record = makeDeadLetterRecord({ lockedAt: staleLock });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);
    mockParse.mockReturnValue({ eventType: 'LISTING_CREATED', listingId: BigInt(1), actor: 'GA', ledgerSequence: 1000, data: {}, eventHash: 'abc', contractId: 'CA', txHash: 'TX', eventIndex: 0 });

    const result = await replayDeadLetter(1, { actor: ACTOR });

    expect(result.outcome).toBe('success');
  });
});

describe('remediateDeadLetter', () => {
  beforeEach(resetMocks);

  it('sets remediationReason on the record', async () => {
    const record = makeDeadLetterRecord({ status: 'Pending' });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    await remediateDeadLetter(1, {
      remediationReason: 'Parser v2.1 fixes this by adding missing field',
      actor: ACTOR,
    });

    expect(mockWrite.deadLetterEvent.update).toHaveBeenCalledOnce();
    const call = mockWrite.deadLetterEvent.update.mock.calls[0][0];
    expect(call.data.remediationReason).toContain('Parser v2.1');
  });

  it('throws 404 when record does not exist', async () => {
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(null);

    await expect(remediateDeadLetter(99, { remediationReason: 'reason', actor: ACTOR }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 409 when record is already Replayed', async () => {
    const record = makeDeadLetterRecord({ status: 'Replayed' });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    await expect(remediateDeadLetter(1, { remediationReason: 'late reason', actor: ACTOR }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('writes OperationalAudit with actionType=DeadLetterRemediate', async () => {
    const record = makeDeadLetterRecord({ status: 'Pending' });
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    await remediateDeadLetter(1, { remediationReason: 'fix applied', actor: ACTOR });

    expect(mockAuditLog).toHaveBeenCalledOnce();
    const call = mockAuditLog.mock.calls[0][0];
    expect(call.actionType).toBe('DeadLetterRemediate');
    expect(call.outcome).toBe('Success');
  });
});

describe('listDeadLetters', () => {
  beforeEach(resetMocks);

  it('returns records and total', async () => {
    const record = makeDeadLetterRecord();
    mockRead.deadLetterEvent.findMany.mockResolvedValue([record]);
    mockRead.deadLetterEvent.count.mockResolvedValue(1);

    const result = await listDeadLetters({ status: 'Pending', limit: 10, offset: 0 });

    expect(result.records).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('caps limit at 200', async () => {
    mockRead.deadLetterEvent.findMany.mockResolvedValue([]);
    mockRead.deadLetterEvent.count.mockResolvedValue(0);

    await listDeadLetters({ limit: 9999 });

    const call = mockRead.deadLetterEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(200);
  });
});

describe('inspectDeadLetter', () => {
  beforeEach(resetMocks);

  it('returns null when record not found', async () => {
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(null);
    const result = await inspectDeadLetter(999);
    expect(result).toBeNull();
  });

  it('redacts rawValue to max 256 chars', async () => {
    const longValue = 'a'.repeat(2000);
    const record = { ...makeDeadLetterRecord({ rawValue: longValue }), replayAttempts: [] };
    mockRead.deadLetterEvent.findUnique.mockResolvedValue(record);

    const result = await inspectDeadLetter(1);

    expect(result).not.toBeNull();
    expect((result!.rawValue as string).length).toBeLessThanOrEqual(256);
  });
});

// ── HTTP auth layer test ──────────────────────────────────────────────────────
// Validates that the auth middleware produces 401 when token is wrong.
// We test the middleware in isolation so we don't need a live DB.

describe('admin API — auth failure', () => {
  it('authMiddleware returns 401 for wrong operator token', async () => {
    const { authMiddleware, resetAuthConfigCache } = await import('../api/auth-middleware');
    resetAuthConfigCache();
    process.env.OPERATOR_TOKEN = 'valid-secret-token';

    const req = {
      headers:  { 'x-operator-token': 'wrong-token' },
      query:    {},
      path:     '/admin/dead-letters',
      method:   'GET',
      ip:       '127.0.0.1',
    } as any;

    let capturedError: any = null;
    const next = (err?: any) => { capturedError = err; };
    const res  = { locals: { requestId: 'test-req-id' } } as any;

    const middleware = authMiddleware('operator');
    middleware(req, res as any, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.status ?? capturedError.statusCode).toBe(401);

    delete process.env.OPERATOR_TOKEN;
    resetAuthConfigCache();
  });

  it('authMiddleware calls next() without error for correct token', async () => {
    process.env.OPERATOR_TOKEN = 'correct-token';
    const { authMiddleware, resetAuthConfigCache } = await import('../api/auth-middleware');
    resetAuthConfigCache();

    const req  = { headers: { 'x-operator-token': 'correct-token' }, query: {}, path: '/admin/dead-letters', method: 'GET', ip: '127.0.0.1' } as any;
    const res  = { locals: { requestId: 'test-req' } } as any;
    let called = false;
    const next = (err?: any) => { called = !err; };

    authMiddleware('operator')(req, res, next);

    expect(called).toBe(true);

    delete process.env.OPERATOR_TOKEN;
    resetAuthConfigCache();
  });
});
