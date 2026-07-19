/**
 * event-decode.test.ts
 *
 * Vitest tests for schema-driven XDR event decoding (Feature A).
 * Each event type has tests for: valid decode, missing required field,
 * extra fields (should pass — extra fields are ignored), wrong type.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decodeWithSchema,
  LISTING_CREATED_SCHEMA,
  ARTWORK_SOLD_SCHEMA,
  LISTING_CANCELLED_SCHEMA,
  LISTING_UPDATED_SCHEMA,
  LISTING_PRICE_UPDATED_SCHEMA,
  LISTING_EXPIRED_SCHEMA,
  AUCTION_CREATED_SCHEMA,
  BID_PLACED_SCHEMA,
  AUCTION_RESOLVED_SCHEMA,
  AUCTION_CANCELLED_SCHEMA,
  AUCTION_EXTENDED_SCHEMA,
  OFFER_MADE_SCHEMA,
  OFFER_ACCEPTED_SCHEMA,
  OFFER_REJECTED_SCHEMA,
  OFFER_WITHDRAWN_SCHEMA,
  OFFER_RECLAIMED_SCHEMA,
  ROYALTY_PAID_SCHEMA,
  PROTOCOL_FEE_COLLECTED_SCHEMA,
  ARTIST_REVOKED_SCHEMA,
  ARTIST_REINSTATED_SCHEMA,
  ADMIN_TRANSFER_PROPOSED_SCHEMA,
  ADMIN_TRANSFERRED_SCHEMA,
  CONTRACT_PAUSED_SCHEMA,
  CONTRACT_UNPAUSED_SCHEMA,
  SCHEMA_REGISTRY,
} from '../event-schemas';

// ── helpers ───────────────────────────────────────────────────────────────────

function assertOk<T>(result: ReturnType<typeof decodeWithSchema<T>>) {
  if (!result.ok) throw new Error(`Expected ok, got error: ${result.reason}`);
  return result;
}

function assertErr(result: ReturnType<typeof decodeWithSchema>) {
  if (result.ok) throw new Error(`Expected error, but got ok`);
  return result;
}

// ── SCHEMA_REGISTRY completeness ──────────────────────────────────────────────

describe('SCHEMA_REGISTRY', () => {
  const expectedTypes = [
    'LISTING_CREATED', 'ARTWORK_SOLD', 'LISTING_CANCELLED', 'LISTING_UPDATED',
    'LISTING_PRICE_UPDATED', 'LISTING_EXPIRED', 'AUCTION_CREATED', 'BID_PLACED',
    'AUCTION_RESOLVED', 'AUCTION_CANCELLED', 'AUCTION_EXTENDED', 'OFFER_MADE',
    'OFFER_ACCEPTED', 'OFFER_REJECTED', 'OFFER_WITHDRAWN', 'OFFER_RECLAIMED',
    'ROYALTY_PAID', 'PROTOCOL_FEE_COLLECTED', 'ARTIST_REVOKED', 'ARTIST_REINSTATED',
    'ADMIN_TRANSFER_PROPOSED', 'ADMIN_TRANSFERRED', 'CONTRACT_PAUSED', 'CONTRACT_UNPAUSED',
    'DEPLOY_NORMAL_721', 'DEPLOY_NORMAL_1155', 'DEPLOY_LAZY_721', 'DEPLOY_LAZY_1155',
  ];

  for (const type of expectedTypes) {
    it(`has a schema for ${type}`, () => {
      expect(SCHEMA_REGISTRY.has(type)).toBe(true);
    });
  }
});

// ── LISTING_CREATED ───────────────────────────────────────────────────────────

describe('decodeWithSchema — LISTING_CREATED', () => {
  const validData = {
    listing_id: 1n, artist: 'GA1', price: 1000n,
    currency: 'USDC', collection: 'CC1', token_id: 42n,
  };

  it('valid: returns ok=true with full data', () => {
    const r = assertOk(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, validData));
    expect(r.eventType).toBe('LISTING_CREATED');
  });

  it('valid: extra fields are ignored (no error)', () => {
    assertOk(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, {
      ...validData, unexpected_extra: 'hello',
    }));
  });

  it('valid: optional recipients absent is fine', () => {
    const { recipients: _r, ...noRecipients } = { ...validData, recipients: [] };
    assertOk(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, noRecipients));
  });

  it('error: missing required field listing_id', () => {
    const { listing_id: _id, ...noId } = validData;
    const r = assertErr(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, noId));
    expect(r.reason).toContain('listing_id');
  });

  it('error: missing required field artist', () => {
    const { artist: _a, ...noArtist } = validData;
    const r = assertErr(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, noArtist));
    expect(r.reason).toContain('artist');
  });

  it('error: wrong type for price (string instead of bigint)', () => {
    const r = assertErr(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, {
      ...validData, price: '1000',
    }));
    expect(r.reason).toContain('price');
  });

  it('error: data is not an object (array)', () => {
    const r = assertErr(decodeWithSchema('LISTING_CREATED', LISTING_CREATED_SCHEMA, [1, 2, 3]));
    expect(r.reason).toContain('plain object');
  });
});

// ── ARTWORK_SOLD ──────────────────────────────────────────────────────────────

describe('decodeWithSchema — ARTWORK_SOLD', () => {
  const valid = { listing_id: 8n, buyer: 'GBUYER', price: 25000n };

  it('valid decode', () => assertOk(decodeWithSchema('ARTWORK_SOLD', ARTWORK_SOLD_SCHEMA, valid)));
  it('extra fields ignored', () => assertOk(decodeWithSchema('ARTWORK_SOLD', ARTWORK_SOLD_SCHEMA, { ...valid, extra: 1 })));

  it('error: missing buyer', () => {
    const { buyer: _b, ...d } = valid;
    const r = assertErr(decodeWithSchema('ARTWORK_SOLD', ARTWORK_SOLD_SCHEMA, d));
    expect(r.reason).toContain('buyer');
  });

  it('error: wrong type for listing_id', () => {
    const r = assertErr(decodeWithSchema('ARTWORK_SOLD', ARTWORK_SOLD_SCHEMA, { ...valid, listing_id: '8' }));
    expect(r.reason).toContain('listing_id');
  });
});

// ── LISTING_CANCELLED ─────────────────────────────────────────────────────────

describe('decodeWithSchema — LISTING_CANCELLED', () => {
  const valid = { listing_id: 3n };

  it('valid: only required field', () => assertOk(decodeWithSchema('LISTING_CANCELLED', LISTING_CANCELLED_SCHEMA, valid)));
  it('valid: with optional cancelled_by', () => assertOk(decodeWithSchema('LISTING_CANCELLED', LISTING_CANCELLED_SCHEMA, { ...valid, cancelled_by: 'GADMIN' })));

  it('error: missing listing_id', () => {
    const r = assertErr(decodeWithSchema('LISTING_CANCELLED', LISTING_CANCELLED_SCHEMA, {}));
    expect(r.reason).toContain('listing_id');
  });

  it('error: wrong type for listing_id', () => {
    const r = assertErr(decodeWithSchema('LISTING_CANCELLED', LISTING_CANCELLED_SCHEMA, { listing_id: 3 }));
    expect(r.reason).toContain('listing_id');
  });
});

// ── LISTING_UPDATED ───────────────────────────────────────────────────────────

describe('decodeWithSchema — LISTING_UPDATED', () => {
  const valid = { listing_id: 5n, new_price: 2000n };

  it('valid decode', () => assertOk(decodeWithSchema('LISTING_UPDATED', LISTING_UPDATED_SCHEMA, valid)));
  it('extra fields ignored', () => assertOk(decodeWithSchema('LISTING_UPDATED', LISTING_UPDATED_SCHEMA, { ...valid, junk: 'x' })));

  it('error: missing new_price', () => {
    const r = assertErr(decodeWithSchema('LISTING_UPDATED', LISTING_UPDATED_SCHEMA, { listing_id: 5n }));
    expect(r.reason).toContain('new_price');
  });

  it('error: wrong type for new_price', () => {
    const r = assertErr(decodeWithSchema('LISTING_UPDATED', LISTING_UPDATED_SCHEMA, { listing_id: 5n, new_price: 2000 }));
    expect(r.reason).toContain('new_price');
  });
});

// ── LISTING_PRICE_UPDATED ─────────────────────────────────────────────────────

describe('decodeWithSchema — LISTING_PRICE_UPDATED', () => {
  const valid = { listing_id: 1n, old_price: 500n, new_price: 800n, updated_by: 'GARTIST' };

  it('valid decode', () => assertOk(decodeWithSchema('LISTING_PRICE_UPDATED', LISTING_PRICE_UPDATED_SCHEMA, valid)));

  it('error: missing old_price', () => {
    const { old_price: _op, ...d } = valid;
    const r = assertErr(decodeWithSchema('LISTING_PRICE_UPDATED', LISTING_PRICE_UPDATED_SCHEMA, d));
    expect(r.reason).toContain('old_price');
  });

  it('error: missing updated_by', () => {
    const { updated_by: _u, ...d } = valid;
    const r = assertErr(decodeWithSchema('LISTING_PRICE_UPDATED', LISTING_PRICE_UPDATED_SCHEMA, d));
    expect(r.reason).toContain('updated_by');
  });

  it('error: wrong type for updated_by', () => {
    const r = assertErr(decodeWithSchema('LISTING_PRICE_UPDATED', LISTING_PRICE_UPDATED_SCHEMA, { ...valid, updated_by: 123 }));
    expect(r.reason).toContain('updated_by');
  });
});

// ── LISTING_EXPIRED ───────────────────────────────────────────────────────────

describe('decodeWithSchema — LISTING_EXPIRED', () => {
  const valid = { listing_id: 9n, expired_at: 1800000000n };

  it('valid decode', () => assertOk(decodeWithSchema('LISTING_EXPIRED', LISTING_EXPIRED_SCHEMA, valid)));

  it('error: missing expired_at', () => {
    const r = assertErr(decodeWithSchema('LISTING_EXPIRED', LISTING_EXPIRED_SCHEMA, { listing_id: 9n }));
    expect(r.reason).toContain('expired_at');
  });

  it('error: wrong type for expired_at', () => {
    const r = assertErr(decodeWithSchema('LISTING_EXPIRED', LISTING_EXPIRED_SCHEMA, { listing_id: 9n, expired_at: '1800000000' }));
    expect(r.reason).toContain('expired_at');
  });
});

// ── AUCTION_CREATED ───────────────────────────────────────────────────────────

describe('decodeWithSchema — AUCTION_CREATED', () => {
  const valid = {
    auction_id: 11n, creator: 'GCREATOR', reserve_price: 5000n,
    token: 'CTOKEN', collection: 'CAUC', token_id: 99n, end_time: 1800000000n,
  };

  it('valid decode', () => assertOk(decodeWithSchema('AUCTION_CREATED', AUCTION_CREATED_SCHEMA, valid)));
  it('extra fields ignored', () => assertOk(decodeWithSchema('AUCTION_CREATED', AUCTION_CREATED_SCHEMA, { ...valid, extra: 'x' })));

  it('error: missing creator', () => {
    const { creator: _c, ...d } = valid;
    const r = assertErr(decodeWithSchema('AUCTION_CREATED', AUCTION_CREATED_SCHEMA, d));
    expect(r.reason).toContain('creator');
  });

  it('error: missing end_time', () => {
    const { end_time: _e, ...d } = valid;
    const r = assertErr(decodeWithSchema('AUCTION_CREATED', AUCTION_CREATED_SCHEMA, d));
    expect(r.reason).toContain('end_time');
  });

  it('error: wrong type for reserve_price', () => {
    const r = assertErr(decodeWithSchema('AUCTION_CREATED', AUCTION_CREATED_SCHEMA, { ...valid, reserve_price: 5000 }));
    expect(r.reason).toContain('reserve_price');
  });
});

// ── BID_PLACED ────────────────────────────────────────────────────────────────

describe('decodeWithSchema — BID_PLACED', () => {
  const valid = { auction_id: 11n, bidder: 'GBIDDER', bid_amount: 6000n };

  it('valid decode', () => assertOk(decodeWithSchema('BID_PLACED', BID_PLACED_SCHEMA, valid)));

  it('error: missing bidder', () => {
    const { bidder: _b, ...d } = valid;
    const r = assertErr(decodeWithSchema('BID_PLACED', BID_PLACED_SCHEMA, d));
    expect(r.reason).toContain('bidder');
  });

  it('error: wrong type for bid_amount (number instead of bigint)', () => {
    const r = assertErr(decodeWithSchema('BID_PLACED', BID_PLACED_SCHEMA, { ...valid, bid_amount: 6000 }));
    expect(r.reason).toContain('bid_amount');
  });
});

// ── AUCTION_RESOLVED ──────────────────────────────────────────────────────────

describe('decodeWithSchema — AUCTION_RESOLVED', () => {
  const valid = { auction_id: 11n, winner: 'GWINNER', amount: 6000n };

  it('valid decode with winner', () => assertOk(decodeWithSchema('AUCTION_RESOLVED', AUCTION_RESOLVED_SCHEMA, valid)));
  it('valid: winner absent (no-bid resolution)', () => assertOk(decodeWithSchema('AUCTION_RESOLVED', AUCTION_RESOLVED_SCHEMA, { auction_id: 11n, amount: 0n })));
  it('valid: winner null', () => assertOk(decodeWithSchema('AUCTION_RESOLVED', AUCTION_RESOLVED_SCHEMA, { auction_id: 11n, amount: 0n, winner: null })));

  it('error: missing amount', () => {
    const { amount: _a, ...d } = valid;
    const r = assertErr(decodeWithSchema('AUCTION_RESOLVED', AUCTION_RESOLVED_SCHEMA, d));
    expect(r.reason).toContain('amount');
  });

  it('error: wrong type for amount', () => {
    const r = assertErr(decodeWithSchema('AUCTION_RESOLVED', AUCTION_RESOLVED_SCHEMA, { ...valid, amount: '6000' }));
    expect(r.reason).toContain('amount');
  });
});

// ── AUCTION_CANCELLED ─────────────────────────────────────────────────────────

describe('decodeWithSchema — AUCTION_CANCELLED', () => {
  it('valid: with required auction_id only', () => assertOk(decodeWithSchema('AUCTION_CANCELLED', AUCTION_CANCELLED_SCHEMA, { auction_id: 13n })));
  it('valid: with optional cancelled_by', () => assertOk(decodeWithSchema('AUCTION_CANCELLED', AUCTION_CANCELLED_SCHEMA, { auction_id: 13n, cancelled_by: 'GCREATOR' })));

  it('error: missing auction_id', () => {
    const r = assertErr(decodeWithSchema('AUCTION_CANCELLED', AUCTION_CANCELLED_SCHEMA, {}));
    expect(r.reason).toContain('auction_id');
  });
});

// ── AUCTION_EXTENDED ──────────────────────────────────────────────────────────

describe('decodeWithSchema — AUCTION_EXTENDED', () => {
  const valid = { auction_id: 11n, new_end_time: 1900000000n };

  it('valid decode', () => assertOk(decodeWithSchema('AUCTION_EXTENDED', AUCTION_EXTENDED_SCHEMA, valid)));

  it('error: missing new_end_time', () => {
    const r = assertErr(decodeWithSchema('AUCTION_EXTENDED', AUCTION_EXTENDED_SCHEMA, { auction_id: 11n }));
    expect(r.reason).toContain('new_end_time');
  });

  it('error: wrong type for new_end_time', () => {
    const r = assertErr(decodeWithSchema('AUCTION_EXTENDED', AUCTION_EXTENDED_SCHEMA, { auction_id: 11n, new_end_time: 1900000000 }));
    expect(r.reason).toContain('new_end_time');
  });
});

// ── OFFER_MADE ────────────────────────────────────────────────────────────────

describe('decodeWithSchema — OFFER_MADE', () => {
  const valid = { offer_id: 1n, listing_id: 42n, offerer: 'GOFFERER', amount: 3000n, token: 'CTOKEN' };

  it('valid decode', () => assertOk(decodeWithSchema('OFFER_MADE', OFFER_MADE_SCHEMA, valid)));
  it('extra fields ignored', () => assertOk(decodeWithSchema('OFFER_MADE', OFFER_MADE_SCHEMA, { ...valid, bonus: 'x' })));

  it('error: missing offer_id', () => {
    const { offer_id: _o, ...d } = valid;
    const r = assertErr(decodeWithSchema('OFFER_MADE', OFFER_MADE_SCHEMA, d));
    expect(r.reason).toContain('offer_id');
  });

  it('error: missing token', () => {
    const { token: _t, ...d } = valid;
    const r = assertErr(decodeWithSchema('OFFER_MADE', OFFER_MADE_SCHEMA, d));
    expect(r.reason).toContain('token');
  });

  it('error: wrong type for amount', () => {
    const r = assertErr(decodeWithSchema('OFFER_MADE', OFFER_MADE_SCHEMA, { ...valid, amount: 3000 }));
    expect(r.reason).toContain('amount');
  });
});

// ── OFFER_ACCEPTED ────────────────────────────────────────────────────────────

describe('decodeWithSchema — OFFER_ACCEPTED', () => {
  const valid = { offer_id: 1n, listing_id: 42n, offerer: 'GOFFERER' };

  it('valid: required fields only', () => assertOk(decodeWithSchema('OFFER_ACCEPTED', OFFER_ACCEPTED_SCHEMA, valid)));
  it('valid: with optional amount', () => assertOk(decodeWithSchema('OFFER_ACCEPTED', OFFER_ACCEPTED_SCHEMA, { ...valid, amount: 100n })));

  it('error: missing offerer', () => {
    const { offerer: _o, ...d } = valid;
    const r = assertErr(decodeWithSchema('OFFER_ACCEPTED', OFFER_ACCEPTED_SCHEMA, d));
    expect(r.reason).toContain('offerer');
  });
});

// ── OFFER_REJECTED ────────────────────────────────────────────────────────────

describe('decodeWithSchema — OFFER_REJECTED', () => {
  const valid = { offer_id: 2n, listing_id: 5n, offerer: 'GOFFERER' };

  it('valid decode', () => assertOk(decodeWithSchema('OFFER_REJECTED', OFFER_REJECTED_SCHEMA, valid)));

  it('error: missing listing_id', () => {
    const { listing_id: _l, ...d } = valid;
    const r = assertErr(decodeWithSchema('OFFER_REJECTED', OFFER_REJECTED_SCHEMA, d));
    expect(r.reason).toContain('listing_id');
  });

  it('error: wrong type for offer_id', () => {
    const r = assertErr(decodeWithSchema('OFFER_REJECTED', OFFER_REJECTED_SCHEMA, { ...valid, offer_id: '2' }));
    expect(r.reason).toContain('offer_id');
  });
});

// ── OFFER_WITHDRAWN ───────────────────────────────────────────────────────────

describe('decodeWithSchema — OFFER_WITHDRAWN', () => {
  const valid = { offer_id: 3n, listing_id: 7n, offerer: 'GOFFERER' };

  it('valid decode', () => assertOk(decodeWithSchema('OFFER_WITHDRAWN', OFFER_WITHDRAWN_SCHEMA, valid)));

  it('error: missing offerer', () => {
    const { offerer: _o, ...d } = valid;
    const r = assertErr(decodeWithSchema('OFFER_WITHDRAWN', OFFER_WITHDRAWN_SCHEMA, d));
    expect(r.reason).toContain('offerer');
  });
});

// ── OFFER_RECLAIMED ───────────────────────────────────────────────────────────

describe('decodeWithSchema — OFFER_RECLAIMED', () => {
  const valid = { offer_id: 4n, listing_id: 7n, offerer: 'GOFFERER', amount: 100n };

  it('valid decode', () => assertOk(decodeWithSchema('OFFER_RECLAIMED', OFFER_RECLAIMED_SCHEMA, valid)));

  it('error: missing amount', () => {
    const { amount: _a, ...d } = valid;
    const r = assertErr(decodeWithSchema('OFFER_RECLAIMED', OFFER_RECLAIMED_SCHEMA, d));
    expect(r.reason).toContain('amount');
  });
});

// ── ROYALTY_PAID ──────────────────────────────────────────────────────────────

describe('decodeWithSchema — ROYALTY_PAID', () => {
  const valid = { recipient: 'GRECIP', amount: 50n };

  it('valid decode', () => assertOk(decodeWithSchema('ROYALTY_PAID', ROYALTY_PAID_SCHEMA, valid)));
  it('valid: with optional listing_id', () => assertOk(decodeWithSchema('ROYALTY_PAID', ROYALTY_PAID_SCHEMA, { ...valid, listing_id: 1n })));

  it('error: missing recipient', () => {
    const r = assertErr(decodeWithSchema('ROYALTY_PAID', ROYALTY_PAID_SCHEMA, { amount: 50n }));
    expect(r.reason).toContain('recipient');
  });

  it('error: wrong type for amount', () => {
    const r = assertErr(decodeWithSchema('ROYALTY_PAID', ROYALTY_PAID_SCHEMA, { recipient: 'GRECIP', amount: 50 }));
    expect(r.reason).toContain('amount');
  });
});

// ── PROTOCOL_FEE_COLLECTED ────────────────────────────────────────────────────

describe('decodeWithSchema — PROTOCOL_FEE_COLLECTED', () => {
  const valid = { listing_id: 1n, amount: 100n, token: 'CTOKEN', treasury: 'GTREASURY' };

  it('valid decode', () => assertOk(decodeWithSchema('PROTOCOL_FEE_COLLECTED', PROTOCOL_FEE_COLLECTED_SCHEMA, valid)));

  it('error: missing treasury', () => {
    const { treasury: _t, ...d } = valid;
    const r = assertErr(decodeWithSchema('PROTOCOL_FEE_COLLECTED', PROTOCOL_FEE_COLLECTED_SCHEMA, d));
    expect(r.reason).toContain('treasury');
  });
});

// ── ARTIST_REVOKED / REINSTATED ───────────────────────────────────────────────

describe('decodeWithSchema — ARTIST_REVOKED', () => {
  it('valid decode', () => assertOk(decodeWithSchema('ARTIST_REVOKED', ARTIST_REVOKED_SCHEMA, { artist: 'GARTIST' })));

  it('error: missing artist', () => {
    const r = assertErr(decodeWithSchema('ARTIST_REVOKED', ARTIST_REVOKED_SCHEMA, {}));
    expect(r.reason).toContain('artist');
  });
});

describe('decodeWithSchema — ARTIST_REINSTATED', () => {
  it('valid decode', () => assertOk(decodeWithSchema('ARTIST_REINSTATED', ARTIST_REINSTATED_SCHEMA, { artist: 'GARTIST' })));

  it('error: wrong type for artist', () => {
    const r = assertErr(decodeWithSchema('ARTIST_REINSTATED', ARTIST_REINSTATED_SCHEMA, { artist: 123 }));
    expect(r.reason).toContain('artist');
  });
});

// ── ADMIN events ──────────────────────────────────────────────────────────────

describe('decodeWithSchema — ADMIN_TRANSFER_PROPOSED', () => {
  const valid = { current_admin: 'GADMIN', proposed_admin: 'GNEW' };

  it('valid decode', () => assertOk(decodeWithSchema('ADMIN_TRANSFER_PROPOSED', ADMIN_TRANSFER_PROPOSED_SCHEMA, valid)));

  it('error: missing proposed_admin', () => {
    const r = assertErr(decodeWithSchema('ADMIN_TRANSFER_PROPOSED', ADMIN_TRANSFER_PROPOSED_SCHEMA, { current_admin: 'GADMIN' }));
    expect(r.reason).toContain('proposed_admin');
  });
});

describe('decodeWithSchema — ADMIN_TRANSFERRED', () => {
  const valid = { old_admin: 'GADMIN', new_admin: 'GNEW' };

  it('valid decode', () => assertOk(decodeWithSchema('ADMIN_TRANSFERRED', ADMIN_TRANSFERRED_SCHEMA, valid)));

  it('error: missing new_admin', () => {
    const r = assertErr(decodeWithSchema('ADMIN_TRANSFERRED', ADMIN_TRANSFERRED_SCHEMA, { old_admin: 'GADMIN' }));
    expect(r.reason).toContain('new_admin');
  });
});

// ── CONTRACT_PAUSED / UNPAUSED ────────────────────────────────────────────────

describe('decodeWithSchema — CONTRACT_PAUSED', () => {
  it('valid: no fields required', () => assertOk(decodeWithSchema('CONTRACT_PAUSED', CONTRACT_PAUSED_SCHEMA, {})));
  it('valid: with optional paused_by', () => assertOk(decodeWithSchema('CONTRACT_PAUSED', CONTRACT_PAUSED_SCHEMA, { paused_by: 'GADMIN' })));
  it('error: data is null', () => {
    const r = assertErr(decodeWithSchema('CONTRACT_PAUSED', CONTRACT_PAUSED_SCHEMA, null));
    expect(r.ok).toBe(false);
  });
});

describe('decodeWithSchema — CONTRACT_UNPAUSED', () => {
  it('valid: empty object', () => assertOk(decodeWithSchema('CONTRACT_UNPAUSED', CONTRACT_UNPAUSED_SCHEMA, {})));
});

// ── Deploy tuple events ───────────────────────────────────────────────────────

describe('decodeWithSchema — Deploy tuple events', () => {
  const deployTypes = [
    'DEPLOY_NORMAL_721', 'DEPLOY_NORMAL_1155',
    'DEPLOY_LAZY_721', 'DEPLOY_LAZY_1155',
  ] as const;

  for (const type of deployTypes) {
    const schema = SCHEMA_REGISTRY.get(type)!;

    it(`${type}: valid 2-element string tuple`, () => {
      const r = assertOk(decodeWithSchema(type, schema, ['GCREATOR', 'CCONTRACT']));
      expect(r.eventType).toBe(type);
    });

    it(`${type}: extra tuple elements are allowed`, () => {
      assertOk(decodeWithSchema(type, schema, ['GCREATOR', 'CCONTRACT', 'extra']));
    });

    it(`${type}: error when data is a plain object (not a tuple)`, () => {
      const r = assertErr(decodeWithSchema(type, schema, { creator: 'GCREATOR', contract: 'CCONTRACT' }));
      expect(r.reason).toContain('array');
    });

    it(`${type}: error when tuple has only 1 element`, () => {
      const r = assertErr(decodeWithSchema(type, schema, ['GCREATOR']));
      expect(r.reason).toContain('2 elements');
    });

    it(`${type}: error when tuple elements are not strings`, () => {
      const r = assertErr(decodeWithSchema(type, schema, [123, 456]));
      expect(r.reason).toContain('strings');
    });
  }
});

// ── SchemaDecodeError propagation through parseMarketplaceEvent ───────────────

// Hoist stellar-sdk mocks so they work at the top level (required by vitest)
const { mockScValToNativeDecode, mockFromXDRDecode } = vi.hoisted(() => ({
  mockScValToNativeDecode: vi.fn(),
  mockFromXDRDecode: vi.fn(() => ({})),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  xdr: { ScVal: { fromXDR: mockFromXDRDecode } },
  scValToNative: mockScValToNativeDecode,
}));

describe('parseMarketplaceEvent — SchemaDecodeError on bad data', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDRDecode.mockReturnValue({});
  });

  it('throws SchemaDecodeError when a required field is missing', async () => {
    const { parseMarketplaceEvent, SchemaDecodeError } = await import('../parser.js');

    // topic → LISTING_CREATED, but data missing required 'artist'
    mockScValToNativeDecode
      .mockReturnValueOnce('lst_crtd')
      .mockReturnValueOnce({ listing_id: 1n, price: 1000n, currency: 'USDC', collection: 'CC', token_id: 1n });

    expect(() => parseMarketplaceEvent(['t'], 'v', 1)).toThrow(SchemaDecodeError);
  });

  it('SchemaDecodeError carries the event_type and reason', async () => {
    const { parseMarketplaceEvent, SchemaDecodeError } = await import('../parser.js');

    mockScValToNativeDecode
      .mockReturnValueOnce('lst_crtd')
      .mockReturnValueOnce({ listing_id: '1', price: 1000n, currency: 'USDC', collection: 'CC', token_id: 1n, artist: 'GA' });

    try {
      parseMarketplaceEvent(['t'], 'v', 1);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDecodeError);
      const e = err as InstanceType<typeof SchemaDecodeError>;
      expect(e.eventType).toBe('LISTING_CREATED');
      expect(e.reason).toContain('listing_id');
    }
  });
});
