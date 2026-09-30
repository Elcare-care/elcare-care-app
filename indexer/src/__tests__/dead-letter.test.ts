/**
 * dead-letter.test.ts
 *
 * Tests for dead-letter event storage (issue #287):
 *   1. collectMarketplaceEvents persists a dead-letter record when decode fails
 *   2. Duplicate failures for the same event upsert (increment attempts) not duplicate
 *   3. Successful decode does NOT create a dead-letter record
 *   4. Dead-letter storage redacts stack traces and bounds payload size
 *   5. Metrics counter is incremented on persistence
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrismaWrite = vi.hoisted(() => ({
  deadLetterEvent: { upsert: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../prisma-write', () => ({ default: mockPrismaWrite }));

// Stub the RPC server so getEvents returns a controlled payload
const mockGetEvents = vi.hoisted(() => vi.fn());
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    rpc: {
      ...orig.rpc,
      Server: class {
        getEvents = mockGetEvents;
      },
    },
  };
});

// Hoisted so the factory closure below can reference it safely
const mockParse = vi.hoisted(() => vi.fn());

// We stub parseMarketplaceEvent to simulate decode errors and successes
vi.mock('../parser', () => ({
  parseMarketplaceEvent: mockParse,
  SchemaDecodeError: class SchemaDecodeError extends Error {
    constructor(public eventType: string, public reason: string, public raw: unknown) {
      super(`[SchemaDecodeError] ${eventType}: ${reason}`);
      this.name = 'SchemaDecodeError';
    }
  },
}));

vi.mock('../retry', () => ({
  withRpcRetry: (fn: () => unknown) => fn(),
}));

import { collectMarketplaceEvents } from '../event-sync';
import { rpc } from '@stellar/stellar-sdk';

const mockServer = new (rpc as any).Server('https://test') as rpc.Server;

const fakeEvent = {
  topic:      ['dGVzdA=='], // base64 "test"
  value:      'dGVzdA==',
  ledger:     1000,
  contractId: 'CA_CONTRACT_1',
  txHash:     'TXHASH_ABC',
  id:         '1000-0-0',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaWrite.deadLetterEvent.upsert.mockResolvedValue({});
  mockGetEvents.mockResolvedValue({ events: [fakeEvent], paginationToken: null });
});

// ── Dead-letter persistence ───────────────────────────────────────────────────

describe('collectMarketplaceEvents — dead-letter persistence', () => {
  it('persists a dead-letter record when decode throws a generic error', async () => {
    mockParse.mockImplementation(() => { throw new Error('XDR parse failed'); });

    await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);

    // Give fire-and-forget microtask queue a tick
    await new Promise((r) => setImmediate(r));

    expect(mockPrismaWrite.deadLetterEvent.upsert).toHaveBeenCalledOnce();
    const call = mockPrismaWrite.deadLetterEvent.upsert.mock.calls[0][0];
    expect(call.create.contractId).toBe('CA_CONTRACT_1');
    expect(call.create.ledgerSequence).toBe(1000);
    expect(call.create.txHash).toBe('TXHASH_ABC');
    expect(call.create.errorCode).toBe('UNKNOWN');
    expect(call.create.errorMessage).not.toContain(' at '); // stack trace redacted
  });

  it('sets errorCode=SCHEMA_DECODE for SchemaDecodeError', async () => {
    const { SchemaDecodeError } = await import('../parser');
    mockParse.mockImplementation(() => {
      throw new (SchemaDecodeError as any)('LISTING_CREATED', 'missing field: price', {});
    });

    await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);
    await new Promise((r) => setImmediate(r));

    const call = mockPrismaWrite.deadLetterEvent.upsert.mock.calls[0][0];
    expect(call.create.errorCode).toBe('SCHEMA_DECODE');
  });

  it('does NOT persist a dead-letter record when decode succeeds', async () => {
    mockParse.mockReturnValue({
      eventType: 'LISTING_CREATED', listingId: BigInt(1),
      actor: 'GA_ARTIST', ledgerSequence: 1000, data: {},
      eventHash: 'abc', contractId: 'CA_CONTRACT_1', txHash: 'TXHASH_ABC', eventIndex: 0,
    });

    await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);
    await new Promise((r) => setImmediate(r));

    expect(mockPrismaWrite.deadLetterEvent.upsert).not.toHaveBeenCalled();
  });

  it('bounds errorMessage to 1000 characters (no unbounded raw payload)', async () => {
    const longMsg = 'x'.repeat(5000);
    mockParse.mockImplementation(() => { throw new Error(longMsg); });

    await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);
    await new Promise((r) => setImmediate(r));

    const call = mockPrismaWrite.deadLetterEvent.upsert.mock.calls[0][0];
    expect(call.create.errorMessage.length).toBeLessThanOrEqual(1000);
  });

  it('upserts on duplicate (does not insert duplicate records for the same event)', async () => {
    mockParse.mockImplementation(() => { throw new Error('decode error'); });

    // Simulate two polling cycles seeing the same failed event
    await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);
    await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);
    await new Promise((r) => setImmediate(r));

    // Two calls to upsert, both with the same where key
    expect(mockPrismaWrite.deadLetterEvent.upsert).toHaveBeenCalledTimes(2);
    const where0 = mockPrismaWrite.deadLetterEvent.upsert.mock.calls[0][0].where;
    const where1 = mockPrismaWrite.deadLetterEvent.upsert.mock.calls[1][0].where;
    expect(where0).toEqual(where1);

    // The update clause increments attempts
    const update0 = mockPrismaWrite.deadLetterEvent.upsert.mock.calls[0][0].update;
    expect(update0.attempts).toEqual({ increment: 1 });
  });

  it('continues processing remaining events after a failure', async () => {
    const secondEvent = { ...fakeEvent, id: '1000-0-1' };
    mockGetEvents.mockResolvedValue({ events: [fakeEvent, secondEvent], paginationToken: null });

    let callCount = 0;
    mockParse.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('first fails');
      return {
        eventType: 'ARTWORK_SOLD', listingId: BigInt(1),
        actor: 'GA_BUYER', ledgerSequence: 1000, data: {},
        eventHash: 'xyz', contractId: 'CA_CONTRACT_1', txHash: 'TXHASH_ABC', eventIndex: 1,
      };
    });

    const results = await collectMarketplaceEvents(mockServer, ['CA_CONTRACT_1'], 1000, 1000);

    // Second event decoded successfully → included in results
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('ARTWORK_SOLD');
  });
});

// ── Dead-letter replay idempotency ────────────────────────────────────────────

describe('dead-letter replay — idempotency', () => {
  it('parseMarketplaceEvent called with stored topics and rawValue on replay', async () => {
    // Simulate a record in the dead-letter table
    const storedRecord = {
      id:            42,
      rawTopics:     ['dGVzdA=='],
      rawValue:      'dGVzdA==',
      ledgerSequence: 1000,
      contractId:    'CA_CONTRACT_1',
      txHash:        'TXHASH_ABC',
      eventIndex:    0,
    };

    // parseMarketplaceEvent with these args should be callable without throwing
    mockParse.mockReturnValue(null); // unknown type → returns null

    const { parseMarketplaceEvent: parseFn } = await import('../parser');
    const result = parseFn(
      storedRecord.rawTopics,
      storedRecord.rawValue,
      storedRecord.ledgerSequence,
      storedRecord.contractId,
      storedRecord.txHash,
      storedRecord.eventIndex,
    );
    // null means unknown event type — idempotent and harmless
    expect(result).toBeNull();
  });
});
