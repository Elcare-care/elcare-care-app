/**
 * event-parsing.test.ts
 *
 * Integration test: schema-versioned event decoding for all eleven
 * explicitly-versioned event types (Issue #278) plus the new
 * FeeAttributionEvent (Issue #488).
 *
 * For each versioned event type this suite verifies:
 *   1. A pre-upgrade (v0 / implicit) payload — no `schema_version` field —
 *      decodes successfully and is treated as version 0 by the version gate.
 *   2. A post-upgrade (v1) payload — `schema_version: 1` present — decodes
 *      successfully with `schema_version === 1`.
 *   3. All non-version fields decode identically in both shapes.
 *   4. A future-version payload (`schema_version: 99`) is rejected by
 *      `isSupportedSchemaVersion` but does NOT throw a `SchemaDecodeError`
 *      (the structural shape is still valid).
 *
 * The tests exercise `decodeWithSchema` and `isSupportedSchemaVersion`
 * directly — no live RPC or XDR encoding is required.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeWithSchema,
  isSupportedSchemaVersion,
  SCHEMA_REGISTRY,
  SUPPORTED_SCHEMA_VERSIONS,
  type FeeAttributionData,
} from '../src/event-schemas.js';

// ── Shared assertion helper ───────────────────────────────────────────────────

/**
 * Asserts the three-version contract for a single versioned event type:
 *   - v0 payload decodes successfully
 *   - v1 payload decodes successfully with schema_version === 1
 *   - A future payload is structurally valid but `isSupportedSchemaVersion`
 *     rejects it
 *   - Both v0 and v1 return identical values for all non-version fields
 *
 * @param eventType   Upper-case registry key, e.g. "LISTING_CREATED"
 * @param baseFields  All required/optional fields except `schema_version`
 */
function assertVersionedEvent(
  eventType: string,
  baseFields: Record<string, unknown>
): void {
  const schema = SCHEMA_REGISTRY.get(eventType);
  if (!schema) throw new Error(`No schema registered for ${eventType}`);

  const v0Payload = { ...baseFields };                     // no schema_version
  const v1Payload = { ...baseFields, schema_version: 1 };  // post-upgrade
  const vFuturePayload = { ...baseFields, schema_version: 99 };

  // ── v0: must decode and isSupportedSchemaVersion(undefined/0) = true ──────
  const v0Result = decodeWithSchema(eventType, schema, v0Payload);
  expect(v0Result.ok, `${eventType} v0 should decode successfully`).toBe(true);
  expect(
    isSupportedSchemaVersion(eventType, undefined),
    `${eventType}: absent schema_version must be supported`
  ).toBe(true);
  expect(
    isSupportedSchemaVersion(eventType, 0),
    `${eventType}: explicit version 0 must be supported`
  ).toBe(true);

  // ── v1: must decode and isSupportedSchemaVersion(1) = true ───────────────
  const v1Result = decodeWithSchema(eventType, schema, v1Payload);
  expect(v1Result.ok, `${eventType} v1 should decode successfully`).toBe(true);
  if (v1Result.ok) {
    expect(
      (v1Result.data as Record<string, unknown>)['schema_version'],
      `${eventType} v1 data.schema_version should be 1`
    ).toBe(1);
  }
  expect(
    isSupportedSchemaVersion(eventType, 1),
    `${eventType}: version 1 must be supported`
  ).toBe(true);

  // ── Field parity: non-version fields must be identical in v0 and v1 ──────
  if (v0Result.ok && v1Result.ok) {
    for (const [key, value] of Object.entries(baseFields)) {
      const v0Val = (v0Result.data as Record<string, unknown>)[key];
      const v1Val = (v1Result.data as Record<string, unknown>)[key];
      expect(v0Val, `${eventType} v0.${key}`).toEqual(value);
      expect(v1Val, `${eventType} v1.${key}`).toEqual(value);
    }
  }

  // ── Future version: structurally valid but version gate rejects ───────────
  const vFutureResult = decodeWithSchema(eventType, schema, vFuturePayload);
  expect(
    vFutureResult.ok,
    `${eventType} future-version payload is structurally valid`
  ).toBe(true);
  expect(
    isSupportedSchemaVersion(eventType, 99),
    `${eventType}: version 99 must NOT be supported`
  ).toBe(false);

  // ── SUPPORTED_SCHEMA_VERSIONS entry must exist ────────────────────────────
  expect(
    Object.prototype.hasOwnProperty.call(SUPPORTED_SCHEMA_VERSIONS, eventType),
    `${eventType} must have an entry in SUPPORTED_SCHEMA_VERSIONS`
  ).toBe(true);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// All id/amount fields are BigInt (Soroban u64/i128 → JS BigInt after
// scValToNative). Addresses and symbols are plain strings.

const LISTING_BASE = {
  listing_id: BigInt(1),
  artist:     'GABC',
  price:      BigInt(100_000_000),
  currency:   'XLM',
  collection: 'CCOL',
  token_id:   BigInt(42),
};

const ARTWORK_SOLD_BASE = {
  listing_id: BigInt(1),
  buyer:      'GBUY',
  price:      BigInt(100_000_000),
};

const AUCTION_CREATED_BASE = {
  auction_id:    BigInt(7),
  creator:       'GCRT',
  reserve_price: BigInt(50_000_000),
  token:         'GTKN',
  collection:    'CCOL',
  token_id:      BigInt(3),
  end_time:      BigInt(9_999_999),
};

const AUCTION_RESOLVED_BASE = {
  auction_id: BigInt(7),
  amount:     BigInt(75_000_000),
};

const OFFER_MADE_BASE = {
  offer_id:   BigInt(5),
  listing_id: BigInt(1),
  offerer:    'GOFF',
  amount:     BigInt(90_000_000),
  token:      'GTKN',
};

const OFFER_ACCEPTED_BASE = {
  offer_id:   BigInt(5),
  listing_id: BigInt(1),
  offerer:    'GOFF',
};

const PROTOCOL_FEE_BASE = {
  listing_id: BigInt(1),
  amount:     BigInt(200_000),
  token:      'GTKN',
  treasury:   'GTRE',
};

const ROYALTY_SETTLEMENT_BASE = {
  id:           BigInt(1),
  recipients:   [{ address: 'GRCP', percentage: BigInt(10_000) }],
  total_amount: BigInt(100_000_000),
  token:        'GTKN',
};

const AUCTION_BID_REFUNDED_BASE = {
  auction_id: BigInt(7),
  bidder:     'GBDR',
  amount:     BigInt(50_000_000),
  token:      'GTKN',
};

const AUCTION_ADMIN_CANCELLED_BASE = {
  auction_id:      BigInt(7),
  refunded_amount: BigInt(50_000_000),
  token:           'GTKN',
};

const AUCTION_CANCELLED_BASE = {
  auction_id: BigInt(7),
};

const FEE_ATTRIBUTION_BASE: Omit<FeeAttributionData, 'schema_version'> = {
  listing_id:            BigInt(1),
  collection:            'CCOL',
  applied_fee_bps:       250,
  is_collection_override: true,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('event-parsing: schema-versioned event decoding', () => {

  // ── §1  LISTING_CREATED ────────────────────────────────────────────────────

  describe('LISTING_CREATED', () => {
    it('decodes v0 (no schema_version) and v1 identically for base fields', () => {
      assertVersionedEvent('LISTING_CREATED', LISTING_BASE);
    });

    it('v0 payload is missing schema_version → version gate treats as v0', () => {
      expect(isSupportedSchemaVersion('LISTING_CREATED', undefined)).toBe(true);
    });

    it('v1 payload schema_version === 1 is present and correct', () => {
      const schema = SCHEMA_REGISTRY.get('LISTING_CREATED')!;
      const result = decodeWithSchema(
        'LISTING_CREATED', schema, { ...LISTING_BASE, schema_version: 1 }
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as Record<string, unknown>)['schema_version']).toBe(1);
      }
    });
  });

  // ── §2  ARTWORK_SOLD ───────────────────────────────────────────────────────

  describe('ARTWORK_SOLD', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('ARTWORK_SOLD', ARTWORK_SOLD_BASE);
    });
  });

  // ── §3  AUCTION_CREATED ────────────────────────────────────────────────────

  describe('AUCTION_CREATED', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('AUCTION_CREATED', AUCTION_CREATED_BASE);
    });
  });

  // ── §4  AUCTION_RESOLVED (AuctionFinalizedEvent) ───────────────────────────

  describe('AUCTION_RESOLVED', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('AUCTION_RESOLVED', AUCTION_RESOLVED_BASE);
    });

    it('winner field is optional (no-bid finalization)', () => {
      const schema = SCHEMA_REGISTRY.get('AUCTION_RESOLVED')!;
      // winner absent — no-bid case
      const result = decodeWithSchema('AUCTION_RESOLVED', schema, AUCTION_RESOLVED_BASE);
      expect(result.ok).toBe(true);
    });
  });

  // ── §5  OFFER_MADE ─────────────────────────────────────────────────────────

  describe('OFFER_MADE', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('OFFER_MADE', OFFER_MADE_BASE);
    });

    it('expires_at field is optional', () => {
      const schema = SCHEMA_REGISTRY.get('OFFER_MADE')!;
      const withExpiry = { ...OFFER_MADE_BASE, expires_at: BigInt(9_999_999) };
      const result = decodeWithSchema('OFFER_MADE', schema, withExpiry);
      expect(result.ok).toBe(true);
    });
  });

  // ── §6  OFFER_ACCEPTED ─────────────────────────────────────────────────────

  describe('OFFER_ACCEPTED', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('OFFER_ACCEPTED', OFFER_ACCEPTED_BASE);
    });

    it('amount field is optional (absent on pre-upgrade events)', () => {
      const schema = SCHEMA_REGISTRY.get('OFFER_ACCEPTED')!;
      // amount absent
      const result = decodeWithSchema('OFFER_ACCEPTED', schema, {
        offer_id: BigInt(5), listing_id: BigInt(1), offerer: 'GOFF',
      });
      expect(result.ok).toBe(true);
    });
  });

  // ── §7  PROTOCOL_FEE_COLLECTED ─────────────────────────────────────────────

  describe('PROTOCOL_FEE_COLLECTED', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('PROTOCOL_FEE_COLLECTED', PROTOCOL_FEE_BASE);
    });
  });

  // ── §8  ROYALTY_SETTLEMENT ─────────────────────────────────────────────────

  describe('ROYALTY_SETTLEMENT', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('ROYALTY_SETTLEMENT', ROYALTY_SETTLEMENT_BASE);
    });

    it('ledger_sequence is optional', () => {
      const schema = SCHEMA_REGISTRY.get('ROYALTY_SETTLEMENT')!;
      const withSeq = { ...ROYALTY_SETTLEMENT_BASE, ledger_sequence: BigInt(100) };
      const result = decodeWithSchema('ROYALTY_SETTLEMENT', schema, withSeq);
      expect(result.ok).toBe(true);
    });
  });

  // ── §9  AUCTION_BID_REFUNDED ───────────────────────────────────────────────

  describe('AUCTION_BID_REFUNDED', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('AUCTION_BID_REFUNDED', AUCTION_BID_REFUNDED_BASE);
    });

    it('reason field is optional', () => {
      const schema = SCHEMA_REGISTRY.get('AUCTION_BID_REFUNDED')!;
      const withReason = { ...AUCTION_BID_REFUNDED_BASE, reason: 'outbid' };
      const result = decodeWithSchema('AUCTION_BID_REFUNDED', schema, withReason);
      expect(result.ok).toBe(true);
    });
  });

  // ── §10 AUCTION_ADMIN_CANCELLED ────────────────────────────────────────────

  describe('AUCTION_ADMIN_CANCELLED', () => {
    it('decodes v0 and v1 identically for base fields', () => {
      assertVersionedEvent('AUCTION_ADMIN_CANCELLED', AUCTION_ADMIN_CANCELLED_BASE);
    });

    it('cancelled_by is optional', () => {
      const schema = SCHEMA_REGISTRY.get('AUCTION_ADMIN_CANCELLED')!;
      const withBy = { ...AUCTION_ADMIN_CANCELLED_BASE, cancelled_by: 'GADM' };
      const result = decodeWithSchema('AUCTION_ADMIN_CANCELLED', schema, withBy);
      expect(result.ok).toBe(true);
    });
  });

  // ── §11 AUCTION_CANCELLED (AuctionCancelledEvent carries schema_version) ───

  describe('AUCTION_CANCELLED', () => {
    it('decodes with only auction_id present (base fields)', () => {
      const schema = SCHEMA_REGISTRY.get('AUCTION_CANCELLED')!;
      const result = decodeWithSchema('AUCTION_CANCELLED', schema, AUCTION_CANCELLED_BASE);
      expect(result.ok).toBe(true);
    });

    it('cancelled_by is optional', () => {
      const schema = SCHEMA_REGISTRY.get('AUCTION_CANCELLED')!;
      const withBy = { ...AUCTION_CANCELLED_BASE, cancelled_by: 'GOWN' };
      const result = decodeWithSchema('AUCTION_CANCELLED', schema, withBy);
      expect(result.ok).toBe(true);
    });

    // AUCTION_CANCELLED is not in SUPPORTED_SCHEMA_VERSIONS because its
    // schema has never required a version-tracked shape change — the
    // schema_version field on the Rust struct is emitted but the indexer
    // schema marks it as simply optional rather than version-gated.
    it('version gate passes any version for AUCTION_CANCELLED (untracked)', () => {
      expect(isSupportedSchemaVersion('AUCTION_CANCELLED', 999)).toBe(true);
    });
  });

  // ── §12 FEE_ATTRIBUTION (Issue #488) ──────────────────────────────────────

  describe('FEE_ATTRIBUTION', () => {
    it('decodes v0 (no schema_version) and v1 identically for base fields', () => {
      assertVersionedEvent(
        'FEE_ATTRIBUTION',
        FEE_ATTRIBUTION_BASE as unknown as Record<string, unknown>
      );
    });

    it('v1 with is_collection_override=false decodes correctly', () => {
      const schema = SCHEMA_REGISTRY.get('FEE_ATTRIBUTION')!;
      const globalRatePayload = {
        listing_id:             BigInt(2),
        collection:             'CCOL2',
        applied_fee_bps:        150,
        is_collection_override: false,
        schema_version:         1,
      };
      const result = decodeWithSchema('FEE_ATTRIBUTION', schema, globalRatePayload);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const d = result.data as Record<string, unknown>;
        expect(d['is_collection_override']).toBe(false);
        expect(d['applied_fee_bps']).toBe(150);
        expect(d['schema_version']).toBe(1);
      }
    });

    it('FEE_ATTRIBUTION in SUPPORTED_SCHEMA_VERSIONS with max = 1', () => {
      expect(SUPPORTED_SCHEMA_VERSIONS['FEE_ATTRIBUTION']).toBe(1);
    });

    it('version 0 is supported (implicit pre-upgrade)', () => {
      expect(isSupportedSchemaVersion('FEE_ATTRIBUTION', 0)).toBe(true);
    });

    it('version 2 is not yet supported', () => {
      expect(isSupportedSchemaVersion('FEE_ATTRIBUTION', 2)).toBe(false);
    });

    it('missing required field listing_id returns a decode error', () => {
      const schema = SCHEMA_REGISTRY.get('FEE_ATTRIBUTION')!;
      const broken = {
        // listing_id intentionally absent
        collection:             'CCOL',
        applied_fee_bps:        250,
        is_collection_override: true,
        schema_version:         1,
      };
      const result = decodeWithSchema('FEE_ATTRIBUTION', schema, broken);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/listing_id/);
      }
    });
  });

  // ── §13 Cross-event: all 11 versioned types are in SUPPORTED_SCHEMA_VERSIONS

  describe('SUPPORTED_SCHEMA_VERSIONS completeness', () => {
    const VERSIONED_TYPES = [
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
      'FEE_ATTRIBUTION',
    ] as const;

    for (const type of VERSIONED_TYPES) {
      it(`${type} has a SUPPORTED_SCHEMA_VERSIONS entry`, () => {
        expect(
          Object.prototype.hasOwnProperty.call(SUPPORTED_SCHEMA_VERSIONS, type)
        ).toBe(true);
      });

      it(`${type} entry is a non-negative integer`, () => {
        const ver = SUPPORTED_SCHEMA_VERSIONS[type];
        expect(typeof ver).toBe('number');
        expect(Number.isInteger(ver) && ver >= 0).toBe(true);
      });
    }
  });

  // ── §14 Cross-event: every versioned type has a SCHEMA_REGISTRY entry ──────

  describe('SCHEMA_REGISTRY completeness', () => {
    const VERSIONED_TYPES = [
      'LISTING_CREATED', 'ARTWORK_SOLD', 'AUCTION_CREATED', 'AUCTION_RESOLVED',
      'OFFER_MADE', 'OFFER_ACCEPTED', 'PROTOCOL_FEE_COLLECTED',
      'ROYALTY_SETTLEMENT', 'AUCTION_BID_REFUNDED', 'AUCTION_ADMIN_CANCELLED',
      'FEE_ATTRIBUTION',
    ] as const;

    for (const type of VERSIONED_TYPES) {
      it(`${type} is registered in SCHEMA_REGISTRY`, () => {
        expect(SCHEMA_REGISTRY.has(type)).toBe(true);
      });

      it(`${type} schema has schema_version field marked optional`, () => {
        const schema = SCHEMA_REGISTRY.get(type)!;
        const svField = schema.data.find(f => f.name === 'schema_version');
        expect(
          svField,
          `${type} schema must include a schema_version field`
        ).toBeDefined();
        expect(
          svField?.optional,
          `${type} schema.schema_version must be optional:true`
        ).toBe(true);
      });
    }
  });

  // ── §15 Backfill boundary: both event shapes decode through the same path ──

  describe('backfill boundary — upgrade-spanning ledger range', () => {
    it('pre-upgrade LISTING_CREATED (v0, no schema_version) decodes without error', () => {
      const schema = SCHEMA_REGISTRY.get('LISTING_CREATED')!;
      // Simulate an event emitted before Issue #278 — no schema_version field
      const preUpgrade = { ...LISTING_BASE }; // no schema_version
      const result = decodeWithSchema('LISTING_CREATED', schema, preUpgrade);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const d = result.data as Record<string, unknown>;
        // schema_version must be absent (undefined) — not defaulted to 0
        expect(d['schema_version']).toBeUndefined();
      }
    });

    it('post-upgrade LISTING_CREATED (v1, schema_version: 1) decodes without error', () => {
      const schema = SCHEMA_REGISTRY.get('LISTING_CREATED')!;
      const postUpgrade = { ...LISTING_BASE, schema_version: 1 };
      const result = decodeWithSchema('LISTING_CREATED', schema, postUpgrade);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          (result.data as Record<string, unknown>)['schema_version']
        ).toBe(1);
      }
    });

    it('both shapes return the same values for all non-version fields', () => {
      const schema = SCHEMA_REGISTRY.get('LISTING_CREATED')!;
      const v0 = decodeWithSchema('LISTING_CREATED', schema, LISTING_BASE);
      const v1 = decodeWithSchema('LISTING_CREATED', schema, {
        ...LISTING_BASE, schema_version: 1,
      });
      expect(v0.ok).toBe(true);
      expect(v1.ok).toBe(true);
      if (v0.ok && v1.ok) {
        const d0 = v0.data as Record<string, unknown>;
        const d1 = v1.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(LISTING_BASE)) {
          expect(d0[key]).toEqual(value);
          expect(d1[key]).toEqual(value);
        }
      }
    });

    it('a ledger-scan spanning the upgrade boundary decodes both shapes without error', () => {
      // Simulate a backfill worker processing two events from the same ledger
      // range — one before the upgrade (v0) and one after (v1). Both must
      // decode successfully through the same code path.
      const schema = SCHEMA_REGISTRY.get('ARTWORK_SOLD')!;

      const historicalEvent = {                          // emitted pre-upgrade
        listing_id: BigInt(100),
        buyer: 'GBUY',
        price: BigInt(500_000_000),
      };
      const currentEvent = {                             // emitted post-upgrade
        listing_id: BigInt(101),
        buyer: 'GBUY2',
        price: BigInt(600_000_000),
        schema_version: 1,
      };

      const r0 = decodeWithSchema('ARTWORK_SOLD', schema, historicalEvent);
      const r1 = decodeWithSchema('ARTWORK_SOLD', schema, currentEvent);

      expect(r0.ok).toBe(true);
      expect(r1.ok).toBe(true);

      // Version gate confirms both are within the supported range
      expect(isSupportedSchemaVersion('ARTWORK_SOLD', undefined)).toBe(true);
      expect(isSupportedSchemaVersion('ARTWORK_SOLD', 1)).toBe(true);
    });
  });

});
