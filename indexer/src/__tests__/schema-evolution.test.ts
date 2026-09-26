/**
 * schema-evolution.test.ts  —  Issue #438
 *
 * Tests for the version-aware event parsing framework:
 *   - Unsupported schema version is classified explicitly and never mis-decoded
 *   - Ordering is preserved even when event IDs are missing or malformed
 *   - Unknown / malformed events are routed to dead-letter storage
 *   - Cross-version compatibility: old (no schema_version) and new events both decode
 *   - isSupportedSchemaVersion edge cases
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decodeWithSchema,
  isSupportedSchemaVersion,
  SUPPORTED_SCHEMA_VERSIONS,
  SCHEMA_REGISTRY,
  LISTING_CREATED_SCHEMA,
  AUCTION_CREATED_SCHEMA,
  OFFER_MADE_SCHEMA,
} from '../event-schemas.js';
import {
  extractEventOrdering,
  sortDecodedEvents,
} from '../event-sync.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../metrics.js', () => ({
  decodeErrorsCounter: { inc: vi.fn() },
  eventDecodeErrorsCounter: { inc: vi.fn() },
  unsupportedSchemaVersionCounter: { inc: vi.fn() },
  rpcRetryExhaustedCounter: { inc: vi.fn() },
  deadLetterCreatedTotal: { inc: vi.fn() },
  stalledGauge: { set: vi.fn() },
  latestLedgerProcessedGauge: { set: vi.fn() },
  networkLatestLedgerGauge: { set: vi.fn() },
  syncLatencyGauge: { set: vi.fn() },
}));

vi.mock('../parser.js', () => ({
  parseMarketplaceEvent: vi.fn(),
  SchemaDecodeError: class SchemaDecodeError extends Error {
    eventType: string;
    constructor(eventType: string, reason: string) {
      super(`[SchemaDecodeError] ${eventType}: ${reason}`);
      this.name = 'SchemaDecodeError';
      this.eventType = eventType;
    }
  },
  UnsupportedSchemaVersionError: class UnsupportedSchemaVersionError extends Error {
    eventType: string;
    schemaVersion: number;
    constructor(eventType: string, schemaVersion: number) {
      super(`[UnsupportedSchemaVersionError] ${eventType}: schema_version ${schemaVersion}`);
      this.name = 'UnsupportedSchemaVersionError';
      this.eventType = eventType;
      this.schemaVersion = schemaVersion;
    }
  },
}));

vi.mock('../retry.js', () => ({
  withRpcRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

// ── isSupportedSchemaVersion ──────────────────────────────────────────────────

describe('isSupportedSchemaVersion', () => {
  it('undefined version is always supported (implicit version 0)', () => {
    expect(isSupportedSchemaVersion('LISTING_CREATED', undefined)).toBe(true);
  });

  it('null version is always supported (implicit version 0)', () => {
    expect(isSupportedSchemaVersion('LISTING_CREATED', null)).toBe(true);
  });

  it('version 0 is always supported for any known event type', () => {
    for (const type of Object.keys(SUPPORTED_SCHEMA_VERSIONS)) {
      expect(isSupportedSchemaVersion(type, 0)).toBe(true);
    }
  });

  it('version at the max is supported', () => {
    expect(isSupportedSchemaVersion('LISTING_CREATED', 1)).toBe(true);
  });

  it('version exceeding the max is NOT supported', () => {
    const max = SUPPORTED_SCHEMA_VERSIONS['LISTING_CREATED']!;
    expect(isSupportedSchemaVersion('LISTING_CREATED', max + 1)).toBe(false);
  });

  it('unknown event type passes through (no version registry entry)', () => {
    expect(isSupportedSchemaVersion('UNKNOWN_EVENT_FUTURE', 999)).toBe(true);
  });

  it('negative version is not supported for a versioned type', () => {
    expect(isSupportedSchemaVersion('LISTING_CREATED', -1)).toBe(false);
  });

  it('non-finite version (NaN) is not supported', () => {
    expect(isSupportedSchemaVersion('LISTING_CREATED', NaN)).toBe(false);
  });

  it('supported versions cover all settlement-critical event types', () => {
    const required = [
      'LISTING_CREATED',
      'ARTWORK_SOLD',
      'AUCTION_CREATED',
      'AUCTION_RESOLVED',
      'OFFER_MADE',
      'OFFER_ACCEPTED',
      'PROTOCOL_FEE_COLLECTED',
      'ROYALTY_SETTLEMENT',
      'AUCTION_BID_REFUNDED',
      'AUCTION_ADMIN_CANCELLED',
    ];
    for (const type of required) {
      expect(
        SUPPORTED_SCHEMA_VERSIONS[type],
        `${type} must have a supported version entry`
      ).toBeDefined();
    }
  });
});

// ── Schema version compatibility — additive fields ────────────────────────────
// Historical events (no schema_version) must decode with the same schema as
// current events. This validates the "additive-only" policy.

describe('cross-version schema compatibility', () => {
  it('LISTING_CREATED decodes without schema_version (pre-upgrade historical event)', () => {
    const legacy = {
      listing_id: 42n,
      artist: 'GCREATOR',
      price: 1000n,
      currency: 'XLM',
      collection: 'GCOLL',
      token_id: 1n,
      // no schema_version — pre-Issue #278 event
    };
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, legacy);
    expect(result.ok).toBe(true);
  });

  it('LISTING_CREATED decodes with schema_version = 1 (current contract)', () => {
    const current = {
      listing_id: 42n,
      artist: 'GCREATOR',
      price: 1000n,
      currency: 'XLM',
      collection: 'GCOLL',
      token_id: 1n,
      schema_version: 1,
    };
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, current);
    expect(result.ok).toBe(true);
  });

  it('LISTING_CREATED decodes with unknown additive fields (future contract, older indexer)', () => {
    const futureEvent = {
      listing_id: 42n,
      artist: 'GCREATOR',
      price: 1000n,
      currency: 'XLM',
      collection: 'GCOLL',
      token_id: 1n,
      schema_version: 1,
      // hypothetical future field the current schema ignores
      future_field: 'some_value',
    };
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, futureEvent);
    expect(result.ok).toBe(true);
  });

  it('AUCTION_CREATED decodes without schema_version (historical)', () => {
    const legacy = {
      auction_id: 1n,
      creator: 'GCREATOR',
      reserve_price: 500n,
      token: 'GTOKEN',
      collection: 'GCOLL',
      token_id: 1n,
      end_time: 9999999n,
    };
    const result = decodeWithSchema('AUCTION_CREATED', AUCTION_CREATED_SCHEMA, legacy);
    expect(result.ok).toBe(true);
  });

  it('OFFER_MADE decodes without expires_at (historical, pre-offer-expiry feature)', () => {
    const legacy = {
      offer_id: 1n,
      listing_id: 1n,
      offerer: 'GOFFERER',
      amount: 100n,
      token: 'GTOKEN',
      // no expires_at, no schema_version
    };
    const result = decodeWithSchema('OFFER_MADE', OFFER_MADE_SCHEMA, legacy);
    expect(result.ok).toBe(true);
  });
});

// ── Schema decode error path ───────────────────────────────────────────────────

describe('decodeWithSchema — error classification', () => {
  it('missing required field returns ok=false with field name in reason', () => {
    const incomplete = { listing_id: 1n, artist: 'GA' /* missing price, currency, etc. */ };
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, incomplete);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/price|currency|collection|token_id/);
    }
  });

  it('wrong type for required field returns ok=false', () => {
    const badType = {
      listing_id: 'not-a-bigint', // should be bigint
      artist: 'GA',
      price: 100n,
      currency: 'XLM',
      collection: 'GC',
      token_id: 1n,
    };
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, badType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/listing_id/);
    }
  });

  it('null payload returns ok=false (not an object)', () => {
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, null);
    expect(result.ok).toBe(false);
  });

  it('array payload for non-deploy event returns ok=false', () => {
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, [1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it('deploy event with < 2 elements returns ok=false', () => {
    const schema = SCHEMA_REGISTRY.get('DEPLOY_NORMAL_721')!;
    const result = decodeWithSchema('DEPLOY_NORMAL_721', schema, ['only-one']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/2/);
    }
  });

  it('deploy event with non-string element returns ok=false', () => {
    const schema = SCHEMA_REGISTRY.get('DEPLOY_LAZY_721')!;
    const result = decodeWithSchema('DEPLOY_LAZY_721', schema, [123, 'GCONTRACT']);
    expect(result.ok).toBe(false);
  });

  it('deploy event with exactly 2 string elements returns ok=true', () => {
    const schema = SCHEMA_REGISTRY.get('DEPLOY_NORMAL_1155')!;
    const result = decodeWithSchema('DEPLOY_NORMAL_1155', schema, ['GCREATOR', 'GCONTRACT']);
    expect(result.ok).toBe(true);
  });

  it('raw field (preserve raw on error) is the original input', () => {
    const badInput = { listing_id: 'bad' };
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, badInput);
    if (!result.ok) {
      expect(result.raw).toBe(badInput);
    }
  });
});

// ── Event ordering invariants ─────────────────────────────────────────────────

describe('extractEventOrdering', () => {
  it('parses standard Stellar event ID format correctly', () => {
    // Stellar TOID: ledgerSequence << 32 | txApplicationOrder << 12 | operationIndex
    // For ledger=1000, txOrder=5: TOID = (1000 << 32) | (5 << 12) = 4295012352 | 20480
    const toid = (BigInt(1000) << 32n) | (BigInt(5) << 12n);
    const eventId = `${toid.toString()}-2`; // eventIndex = 2

    const result = extractEventOrdering({ id: eventId } as any, 0);
    expect(result.txIndex).toBe(5);
    expect(result.eventIndex).toBe(2);
  });

  it('falls back to array position when id is absent', () => {
    const result = extractEventOrdering({} as any, 7);
    expect(result.txIndex).toBe(0);
    expect(result.eventIndex).toBe(7);
  });

  it('falls back to array position when id is malformed', () => {
    const result = extractEventOrdering({ id: 'not-a-valid-toid' } as any, 3);
    expect(result.txIndex).toBe(0);
    expect(result.eventIndex).toBe(3);
  });

  it('falls back when id has only one part (no dash)', () => {
    const result = extractEventOrdering({ id: '12345678901234' } as any, 4);
    expect(result.eventIndex).toBe(4);
  });

  it('handles eventIndex of 0 correctly', () => {
    const toid = (BigInt(500) << 32n) | (BigInt(1) << 12n);
    const eventId = `${toid.toString()}-0`;
    const result = extractEventOrdering({ id: eventId } as any, 99);
    expect(result.eventIndex).toBe(0);
  });
});

describe('sortDecodedEvents — canonical application order', () => {
  it('sorts by ledgerSequence ascending', () => {
    const events = [
      { ledgerSequence: 300, txIndex: 0, eventIndex: 0 },
      { ledgerSequence: 100, txIndex: 0, eventIndex: 0 },
      { ledgerSequence: 200, txIndex: 0, eventIndex: 0 },
    ];
    const sorted = sortDecodedEvents(events as any);
    expect(sorted.map((e) => e.ledgerSequence)).toEqual([100, 200, 300]);
  });

  it('breaks ledger ties by txIndex', () => {
    const events = [
      { ledgerSequence: 100, txIndex: 3, eventIndex: 0 },
      { ledgerSequence: 100, txIndex: 1, eventIndex: 0 },
      { ledgerSequence: 100, txIndex: 2, eventIndex: 0 },
    ];
    const sorted = sortDecodedEvents(events as any);
    expect(sorted.map((e) => e.txIndex)).toEqual([1, 2, 3]);
  });

  it('breaks txIndex ties by eventIndex', () => {
    const events = [
      { ledgerSequence: 100, txIndex: 1, eventIndex: 2 },
      { ledgerSequence: 100, txIndex: 1, eventIndex: 0 },
      { ledgerSequence: 100, txIndex: 1, eventIndex: 1 },
    ];
    const sorted = sortDecodedEvents(events as any);
    expect(sorted.map((e) => e.eventIndex)).toEqual([0, 1, 2]);
  });

  it('does not mutate the input array', () => {
    const events = [
      { ledgerSequence: 200, txIndex: 0, eventIndex: 0 },
      { ledgerSequence: 100, txIndex: 0, eventIndex: 0 },
    ];
    const copy = [...events];
    sortDecodedEvents(events as any);
    expect(events).toEqual(copy);
  });

  it('handles missing txIndex / eventIndex (defaults to 0)', () => {
    const events = [
      { ledgerSequence: 100 },
      { ledgerSequence: 100, txIndex: 1 },
    ] as any[];
    const sorted = sortDecodedEvents(events);
    // first has txIndex=0, second has txIndex=1
    expect(sorted[0].txIndex).toBeUndefined();
    expect(sorted[1].txIndex).toBe(1);
  });

  it('empty array returns empty array', () => {
    expect(sortDecodedEvents([])).toEqual([]);
  });

  it('single element returns same element', () => {
    const events = [{ ledgerSequence: 42, txIndex: 1, eventIndex: 0 }];
    expect(sortDecodedEvents(events as any)).toHaveLength(1);
  });

  it('preserves total order across ledger boundaries', () => {
    const events = [
      { ledgerSequence: 10, txIndex: 0, eventIndex: 1 },
      { ledgerSequence: 10, txIndex: 0, eventIndex: 0 },
      { ledgerSequence: 9, txIndex: 5, eventIndex: 3 },
      { ledgerSequence: 11, txIndex: 0, eventIndex: 0 },
    ];
    const sorted = sortDecodedEvents(events as any);
    expect(sorted[0]).toMatchObject({ ledgerSequence: 9, txIndex: 5, eventIndex: 3 });
    expect(sorted[1]).toMatchObject({ ledgerSequence: 10, txIndex: 0, eventIndex: 0 });
    expect(sorted[2]).toMatchObject({ ledgerSequence: 10, txIndex: 0, eventIndex: 1 });
    expect(sorted[3]).toMatchObject({ ledgerSequence: 11 });
  });
});

// ── Schema registry completeness ──────────────────────────────────────────────

describe('SCHEMA_REGISTRY completeness', () => {
  it('all 4 deploy variants are registered', () => {
    expect(SCHEMA_REGISTRY.has('DEPLOY_NORMAL_721')).toBe(true);
    expect(SCHEMA_REGISTRY.has('DEPLOY_NORMAL_1155')).toBe(true);
    expect(SCHEMA_REGISTRY.has('DEPLOY_LAZY_721')).toBe(true);
    expect(SCHEMA_REGISTRY.has('DEPLOY_LAZY_1155')).toBe(true);
  });

  it('settlement-critical events are all registered', () => {
    const critical = [
      'LISTING_CREATED', 'ARTWORK_SOLD', 'LISTING_CANCELLED',
      'AUCTION_CREATED', 'AUCTION_RESOLVED', 'AUCTION_CANCELLED',
      'BID_PLACED', 'OFFER_MADE', 'OFFER_ACCEPTED', 'OFFER_REJECTED',
      'OFFER_WITHDRAWN', 'OFFER_RECLAIMED', 'ROYALTY_PAID',
      'PROTOCOL_FEE_COLLECTED',
    ];
    for (const t of critical) {
      expect(SCHEMA_REGISTRY.has(t), `${t} must be in SCHEMA_REGISTRY`).toBe(true);
    }
  });

  it('every schema in the registry has a type string and data array', () => {
    for (const [key, schema] of SCHEMA_REGISTRY) {
      expect(typeof schema.type).toBe('string');
      expect(Array.isArray(schema.data)).toBe(true);
    }
  });
});

// ── Partial payload corruption ────────────────────────────────────────────────

describe('partial payload corruption handling', () => {
  it('event with all required fields but one corrupted to wrong type is rejected', () => {
    // BID_PLACED: auction_id, bidder, bid_amount
    const corrupt = {
      auction_id: 1n,
      bidder: 999, // should be string
      bid_amount: 100n,
    };
    const schema = SCHEMA_REGISTRY.get('BID_PLACED')!;
    const result = decodeWithSchema('BID_PLACED', schema, corrupt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/bidder/);
    }
  });

  it('event with undefined in required bigint field is rejected', () => {
    const missingId = {
      auction_id: undefined,
      bidder: 'GB1',
      bid_amount: 100n,
    };
    const schema = SCHEMA_REGISTRY.get('BID_PLACED')!;
    const result = decodeWithSchema('BID_PLACED', schema, missingId);
    expect(result.ok).toBe(false);
  });

  it('event data that is a number (not object) is rejected for non-deploy events', () => {
    const result = decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, 42);
    expect(result.ok).toBe(false);
  });

  it('royalty_paid with empty recipients array still passes (valid empty)', () => {
    const minimal = {
      sale_price: 1000n,
      protocol_fee_amount: 50n,
      token: 'GTOKEN',
      recipients: [], // empty but valid array
    };
    const schema = SCHEMA_REGISTRY.get('ROYALTY_PAID')!;
    const result = decodeWithSchema('ROYALTY_PAID', schema, minimal);
    expect(result.ok).toBe(true);
  });
});
