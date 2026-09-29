/**
 * event-parsing.test.ts
 *
 * Acceptance criteria for Issue #846 — schema-versioned event parsing.
 *
 *   ✓ Every event struct that carries `schema_version` on the contract side is
 *     reachable through the topic the contract actually publishes, and has a
 *     registry entry whose `schema_version` field is optional (the CI gate in
 *     scripts/check-event-schemas.mjs enforces the static half of this).
 *   ✓ For all eleven versioned event types: the pre-upgrade shape (no
 *     `schema_version` field at all) decodes and reports implicit version 0.
 *   ✓ The post-upgrade shape decodes and reports version 1.
 *   ✓ Every other field decodes identically in both shapes, so a mixed
 *     historical scan across an upgrade boundary is decoded consistently.
 *
 * The payloads below are real XDR: a Soroban `#[contracttype]` struct is a map
 * of symbol keys to values, which is what these fixtures build with the SDK's
 * ScVal constructors. That matters — the earlier suite mocked scValToNative and
 * therefore could not see that a u32 field declared as `bigint` (or an unknown
 * topic) made real events undecodable.
 */

import { describe, it, expect } from 'vitest';
import { Address, xdr } from '@stellar/stellar-sdk';

import { parseMarketplaceEvent, resolveEventType } from '../src/parser.js';
import { SCHEMA_REGISTRY } from '../src/event-schemas.js';

// ── XDR helpers ──────────────────────────────────────────────────────────────

const ACCOUNT = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
const ACCOUNT_2 = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const u64 = (n: number) => xdr.ScVal.scvU64(new xdr.Uint64(n));
const i128 = (n: number) =>
  xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: new xdr.Int64(0), lo: new xdr.Uint64(n) }));
const addr = (a: string = ACCOUNT) => Address.fromString(a).toScVal();
const none = () => xdr.ScVal.scvVoid();
const vec = (vals: xdr.ScVal[]) => xdr.ScVal.scvVec(vals);

/** A `#[contracttype]` unit-variant enum encodes as a one-element vec of its variant name. */
const unitEnum = (variant: string) => vec([sym(variant)]);

/** A `#[contracttype]` struct encodes as a map of symbol keys → values. */
const structXdr = (fields: Array<[string, xdr.ScVal]>) =>
  new xdr.ScVal.scvMap(fields.map(([key, val]) => new xdr.ScMapEntry({ key: sym(key), val })));

const encode = (fields: Array<[string, xdr.ScVal]>) => structXdr(fields).toXDR('base64');

// ── Fixtures: one per versioned event type ───────────────────────────────────

interface VersionedCase {
  /** Registry/topic constants name, e.g. LISTING_CREATED */
  constName: string;
  /** The Rust struct it decodes from */
  struct: string;
  /** Topic the current contract build publishes */
  topic: string;
  /** Legacy short topic kept for historical backfills, when one exists */
  legacyTopic?: string;
  /** Struct fields as emitted *before* schema_version existed (i.e. version 0) */
  fields: Array<[string, xdr.ScVal]>;
}

const CASES: VersionedCase[] = [
  {
    constName: 'LISTING_CREATED',
    struct: 'ListingCreatedEvent',
    topic: 'listing_created',
    legacyTopic: 'lst_crtd',
    fields: [
      ['listing_id', u64(1)],
      ['artist', addr()],
      ['price', i128(10_000_000)],
      ['currency', sym('USDC')],
      ['collection', addr(CONTRACT)],
      ['token_id', u64(7)],
      ['ledger_sequence', u32(1234)],
    ],
  },
  {
    constName: 'ARTWORK_SOLD',
    struct: 'ArtworkSoldEvent',
    topic: 'artwork_sold',
    legacyTopic: 'art_sold',
    fields: [
      ['listing_id', u64(2)],
      ['artist', addr()],
      ['buyer', addr(ACCOUNT_2)],
      ['price', i128(5_000_000)],
      ['currency', sym('USDC')],
      ['ledger_sequence', u32(1235)],
    ],
  },
  {
    constName: 'AUCTION_CREATED',
    struct: 'AuctionCreatedEvent',
    topic: 'auction_created',
    legacyTopic: 'auc_crtd',
    fields: [
      ['auction_id', u64(3)],
      ['creator', addr()],
      ['reserve_price', i128(2_000_000)],
      ['token', addr(CONTRACT)],
      ['collection', addr(CONTRACT)],
      ['token_id', u64(9)],
      ['end_time', u64(1_800_000_000)],
    ],
  },
  {
    constName: 'AUCTION_RESOLVED',
    struct: 'AuctionFinalizedEvent',
    topic: 'auction_resolved',
    legacyTopic: 'auc_rslv',
    fields: [
      ['auction_id', u64(4)],
      ['winner', addr(ACCOUNT_2)],
      ['amount', i128(3_000_000)],
    ],
  },
  {
    constName: 'AUCTION_CANCELLED',
    struct: 'AuctionCancelledEvent',
    topic: 'auction_cancelled',
    legacyTopic: 'auc_cncl',
    fields: [
      ['auction_id', u64(5)],
      ['cancelled_by', addr()],
      ['reason', unitEnum('Owner')],
      ['escrow_amount', i128(0)],
      ['token', addr(CONTRACT)],
      ['ledger_sequence', u32(1240)],
    ],
  },
  {
    constName: 'AUCTION_BID_REFUNDED',
    struct: 'AuctionBidRefundedEvent',
    topic: 'auction_bid_refunded',
    fields: [
      ['auction_id', u64(6)],
      ['bidder', addr(ACCOUNT_2)],
      ['amount', i128(1_500_000)],
      ['token', addr(CONTRACT)],
      ['reason', sym('outbid')],
      ['ledger_sequence', u32(1241)],
    ],
  },
  {
    constName: 'AUCTION_ADMIN_CANCELLED',
    struct: 'AuctionAdminCancelledEvent',
    topic: 'auction_admin_cancelled',
    fields: [
      ['auction_id', u64(7)],
      ['cancelled_by', addr()],
      ['refunded_amount', i128(700_000)],
      ['token', addr(CONTRACT)],
      ['ledger_sequence', u32(1242)],
    ],
  },
  {
    constName: 'ROYALTY_SETTLEMENT',
    struct: 'RoyaltySettlementEvent',
    topic: 'royalty_settlement',
    fields: [
      ['id', u64(8)],
      [
        'recipients',
        vec([structXdr([['address', addr()], ['percentage', u32(500)]])]),
      ],
      ['total_amount', i128(900_000)],
      ['token', addr(CONTRACT)],
      ['ledger_sequence', u32(1243)],
    ],
  },
  {
    constName: 'OFFER_MADE',
    struct: 'OfferMadeEvent',
    topic: 'offer_made',
    legacyTopic: 'ofr_made',
    fields: [
      ['offer_id', u64(9)],
      ['listing_id', u64(1)],
      ['offerer', addr(ACCOUNT_2)],
      ['amount', i128(4_000_000)],
      ['token', addr(CONTRACT)],
      ['expires_at', none()],
    ],
  },
  {
    constName: 'OFFER_ACCEPTED',
    struct: 'OfferAcceptedEvent',
    topic: 'offer_accepted',
    legacyTopic: 'ofr_accp',
    fields: [
      ['offer_id', u64(9)],
      ['listing_id', u64(1)],
      ['offerer', addr(ACCOUNT_2)],
      ['amount', i128(4_000_000)],
    ],
  },
  {
    constName: 'PROTOCOL_FEE_COLLECTED',
    struct: 'ProtocolFeeCollectedEvent',
    topic: 'protocol_fee_collected',
    legacyTopic: 'fee_cltd',
    fields: [
      ['listing_id', u64(1)],
      ['amount', i128(250_000)],
      ['token', addr(CONTRACT)],
      ['treasury', addr()],
    ],
  },
];

const LEDGER = 4_242;

/** Decode the version-0 (pre-upgrade) shape. */
const decodeV0 = (c: VersionedCase) =>
  parseMarketplaceEvent([c.topic], encode(c.fields), LEDGER, CONTRACT);

/** Decode the version-1 (post-upgrade) shape. */
const decodeV1 = (c: VersionedCase) =>
  parseMarketplaceEvent(
    [c.topic],
    encode([...c.fields, ['schema_version', u32(1)]]),
    LEDGER,
    CONTRACT,
  );

// ── Static parity: topic and registry reachability ───────────────────────────

describe('versioned event registry parity (#846)', () => {
  it('covers the eleven structs that carry schema_version', () => {
    expect(CASES).toHaveLength(11);
  });

  for (const c of CASES) {
    it(`${c.constName} (${c.struct}) is reachable and has an optional schema_version`, () => {
      // The topic the contract publishes today must resolve.
      expect(resolveEventType([c.topic])).toBe(c.constName);
      if (c.legacyTopic) {
        // …and the legacy short topic historical backfills carry.
        expect(resolveEventType([c.legacyTopic])).toBe(c.constName);
      }

      const schema = SCHEMA_REGISTRY.get(c.constName);
      expect(schema).toBeDefined();
      const versionField = schema!.data.find((f) => f.name === 'schema_version');
      expect(versionField, 'schema_version must be declared').toBeDefined();
      expect(versionField!.optional, 'schema_version must be optional (version 0)').toBe(true);
      expect(versionField!.type).toBe('number');
    });
  }
});

// ── Both shapes decode, and agree on everything but the version ──────────────

describe('decoding across an upgrade boundary (#846)', () => {
  for (const c of CASES) {
    describe(`${c.constName}`, () => {
      it('decodes the pre-upgrade shape (no schema_version) as implicit version 0', () => {
        const decoded = decodeV0(c);
        expect(decoded).not.toBeNull();
        expect(decoded!.eventType).toBe(c.constName);
        expect(decoded!.data.schema_version).toBeUndefined();
      });

      it('decodes the post-upgrade shape with schema_version = 1', () => {
        const decoded = decodeV1(c);
        expect(decoded).not.toBeNull();
        expect(decoded!.eventType).toBe(c.constName);
        expect(decoded!.data.schema_version).toBe(1);
      });

      it('decodes every other field identically in both shapes', () => {
        const v0 = decodeV0(c)!;
        const v1 = decodeV1(c)!;

        const stripVersion = (data: Record<string, unknown>) => {
          const { schema_version: _ignored, ...rest } = data;
          return rest;
        };

        expect(stripVersion(v1.data)).toEqual(stripVersion(v0.data));
      });
    });
  }

  it('decodes a mixed pre/post-upgrade scan (backfill over an upgrade boundary)', () => {
    // Two payloads per event type: the historical one first, then the current
    // one — the order a backfill walks its ledger ranges in.
    const mixed = CASES.flatMap((c) => [
      encode(c.fields),
      encode([...c.fields, ['schema_version', u32(1)]]),
    ]);
    const topics = CASES.flatMap((c) => [c.topic, c.topic]);

    const decoded = mixed.map((payload, i) =>
      parseMarketplaceEvent([topics[i]], payload, LEDGER + i, CONTRACT),
    );

    expect(decoded).toHaveLength(CASES.length * 2);
    expect(decoded.every((d) => d !== null)).toBe(true);

    const versions = decoded.map((d) => d!.data.schema_version ?? 0);
    for (let i = 0; i < versions.length; i += 2) {
      expect(versions[i]).toBe(0); // pre-upgrade
      expect(versions[i + 1]).toBe(1); // post-upgrade
    }
  });

  it('still decodes a payload that carries only what the contract emits today', () => {
    // Guards the opposite mistake: a schema declaring a *required* field the
    // contract never emits would reject every real event of that type.
    for (const c of CASES) {
      const payload = encode([...c.fields, ['schema_version', u32(1)]]);
      expect(() => parseMarketplaceEvent([c.topic], payload, LEDGER, CONTRACT)).not.toThrow();
    }
  });
});
