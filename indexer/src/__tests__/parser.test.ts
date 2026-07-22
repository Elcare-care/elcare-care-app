import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock factories so they are available inside vi.mock() closures
const { mockScValToNative, mockFromXDR } = vi.hoisted(() => ({
  mockScValToNative: vi.fn(),
  mockFromXDR: vi.fn(() => ({})),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  xdr: {
    ScVal: {
      fromXDR: mockFromXDR,
    },
  },
  Address: class {},
  scValToNative: mockScValToNative,
}));

import { parseMarketplaceEvent, KNOWN_EVENT_TYPES, DecodedEvent } from '../parser';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Sets up mocks for a single parseMarketplaceEvent call.
 * - topicSymbol: the symbol the XDR topic decodes to (e.g. 'lst_crtd')
 * - valueData:   the plain object returned by scValToNative for the value XDR
 */
function setupMocks(topicSymbol: string, valueData: any) {
  // First scValToNative call → topic symbol
  // Second scValToNative call → event value data
  mockScValToNative
    .mockReturnValueOnce(topicSymbol)
    .mockReturnValueOnce(valueData);
}

// ── Minimal complete fixtures per event type for schema validation ─────────────
// These are the smallest payloads that satisfy each event schema.

const LISTING_FIXTURE = {
  listing_id: 1n, artist: 'GA1', price: 100n,
  currency: 'USDC', collection: 'CC', token_id: 1n,
};
const ARTWORK_SOLD_FIXTURE = { listing_id: 1n, buyer: 'GB1', price: 100n };
const LISTING_CANCELLED_FIXTURE = { listing_id: 1n };
const LISTING_UPDATED_FIXTURE = { listing_id: 1n, new_price: 200n };
const BID_PLACED_FIXTURE = { auction_id: 1n, bidder: 'GB1', bid_amount: 100n };
const AUCTION_RESOLVED_FIXTURE = { auction_id: 1n, amount: 100n };
const AUCTION_CANCELLED_FIXTURE = { auction_id: 1n };
const OFFER_MADE_FIXTURE = { offer_id: 1n, listing_id: 1n, offerer: 'GO1', amount: 50n, token: 'CT' };
const OFFER_ACCEPTED_FIXTURE = { offer_id: 1n, listing_id: 1n, offerer: 'GO1' };
const OFFER_REJECTED_FIXTURE = { offer_id: 1n, listing_id: 1n, offerer: 'GO1' };
const OFFER_WITHDRAWN_FIXTURE = { offer_id: 1n, listing_id: 1n, offerer: 'GO1' };
const AUCTION_CREATED_FIXTURE = {
  auction_id: 1n, creator: 'GC1', reserve_price: 50n,
  token: 'CT', collection: 'CC', token_id: 1n, end_time: 1800000000n,
};
const DEPLOY_FIXTURE = ['GCREATOR', 'CCONTRACT'];

// ── topic → eventType mapping ─────────────────────────────────────────────────

describe('parseMarketplaceEvent — topic mapping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  // All 24 marketplace symbols from contracts/soroban-marketplace/src/events.rs
  // plus the 4 launchpad deploy symbols. This table pins symbol → type.
  const cases: [string, string][] = [
    ['lst_crtd', 'LISTING_CREATED'],
    ['art_sold', 'ARTWORK_SOLD'],
    ['lst_cncl', 'LISTING_CANCELLED'],
    ['lst_updt', 'LISTING_UPDATED'],
    ['lst_pru', 'LISTING_PRICE_UPDATED'],
    ['lst_expd', 'LISTING_EXPIRED'],
    ['bid_plcd', 'BID_PLACED'],
    ['auc_rslv', 'AUCTION_RESOLVED'],
    ['auc_cncl', 'AUCTION_CANCELLED'],
    ['auc_ext', 'AUCTION_EXTENDED'],
    ['ofr_made', 'OFFER_MADE'],
    ['ofr_accp', 'OFFER_ACCEPTED'],
    ['ofr_rjct', 'OFFER_REJECTED'],
    ['ofr_wdrn', 'OFFER_WITHDRAWN'],
    ['ofr_rclm', 'OFFER_RECLAIMED'],
    ['roy_paid', 'ROYALTY_PAID'],
    ['fee_cltd', 'PROTOCOL_FEE_COLLECTED'],
    ['adm_prop', 'ADMIN_TRANSFER_PROPOSED'],
    ['adm_xfrd', 'ADMIN_TRANSFERRED'],
    ['art_rvkd', 'ARTIST_REVOKED'],
    ['art_rnst', 'ARTIST_REINSTATED'],
    ['ctr_psd', 'CONTRACT_PAUSED'],
    ['ctr_unpsd', 'CONTRACT_UNPAUSED'],
    ['auc_crtd', 'AUCTION_CREATED'],
    ['dep_n721', 'DEPLOY_NORMAL_721'],
    ['dep_n1155', 'DEPLOY_NORMAL_1155'],
    ['dep_l721', 'DEPLOY_LAZY_721'],
    ['dep_l1155', 'DEPLOY_LAZY_1155'],
  ];

  for (const [symbol, expectedType, fixture] of cases) {
    it(`maps '${symbol}' → '${expectedType}'`, () => {
      setupMocks(symbol, fixture);
      const result = parseMarketplaceEvent(['topic_xdr'], 'value_xdr', 42);
      expect(result).not.toBeNull();
      expect(result!.eventType).toBe(expectedType);
    });
  }

  it('covers every known event type exactly once (no unmapped topics)', () => {
    const expectedTypes = cases.map(([, type]) => type).sort();
    expect([...KNOWN_EVENT_TYPES].sort()).toEqual(expectedTypes);
    expect(KNOWN_EVENT_TYPES).toHaveLength(28);
  });

  it('returns null for an unknown topic symbol', () => {
    setupMocks('unknown_sym', {});
    expect(parseMarketplaceEvent(['topic_xdr'], 'value_xdr', 1)).toBeNull();
  });
});

// ── launchpad 2-topic deploy format ──────────────────────────────────────────

describe('parseMarketplaceEvent — launchpad deploy topics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('resolves deploy event from ("deploy", "dep_n721") 2-topic format', () => {
    // Launchpad emits topics = ["deploy", kind_tag]
    mockScValToNative
      .mockReturnValueOnce('deploy')  // topics[0]
      .mockReturnValueOnce('dep_n721') // topics[1]
      .mockReturnValueOnce(['GCREATOR', 'CCONTRACT']); // value

    const result = parseMarketplaceEvent(['t1', 't2'], 'v', 100);
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('DEPLOY_NORMAL_721');
    expect(result!.actor).toBe('GCREATOR');
  });

  it('returns null for unknown tag in 2-topic deploy format', () => {
    mockScValToNative
      .mockReturnValueOnce('deploy')
      .mockReturnValueOnce('unknown_tag');
    const result = parseMarketplaceEvent(['t1', 't2'], 'v', 100);
    expect(result).toBeNull();
  });
});

// ── fallback path (raw string topic) ─────────────────────────────────────────

describe('parseMarketplaceEvent — XDR fallback', () => {
  beforeEach(() => vi.resetAllMocks());

  it('falls back to the raw topic string when XDR parsing throws', () => {
    mockFromXDR
      .mockImplementationOnce(() => { throw new Error('bad XDR'); })
      .mockReturnValueOnce({});
    mockScValToNative.mockReturnValueOnce({
      listing_id: 99n, artist: 'GFALLBACK', price: 1n,
      currency: 'XLM', collection: 'CC', token_id: 1n,
    });

    const result = parseMarketplaceEvent(['lst_crtd'], 'value_xdr', 10);
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('LISTING_CREATED');
    expect(result!.actor).toBe('GFALLBACK');
  });

  it('returns null when raw fallback topic is not in TOPIC_MAP', () => {
    mockFromXDR.mockImplementationOnce(() => { throw new Error('bad XDR'); });
    const result = parseMarketplaceEvent(['not_a_topic'], 'value_xdr', 10);
    expect(result).toBeNull();
  });
});

// ── SchemaDecodeError thrown on invalid data ──────────────────────────────────

describe('parseMarketplaceEvent — SchemaDecodeError on invalid data', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('throws SchemaDecodeError when a required field is missing', async () => {
    const { SchemaDecodeError } = await import('../parser.js');
    // listing_id present but price/currency/collection/token_id all missing
    setupMocks('lst_crtd', { listing_id: 1n, artist: 'GA' });
    expect(() => parseMarketplaceEvent(['t'], 'v', 1)).toThrow(SchemaDecodeError);
  });

  it('SchemaDecodeError.eventType identifies the failing event type', async () => {
    const { SchemaDecodeError } = await import('../parser.js');
    // bid_placed missing required auction_id
    setupMocks('bid_plcd', { bidder: 'GB', bid_amount: 100n });
    try {
      parseMarketplaceEvent(['t'], 'v', 1);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDecodeError);
      expect((err as InstanceType<typeof SchemaDecodeError>).eventType).toBe('BID_PLACED');
    }
  });
});

// ── listingId extraction ──────────────────────────────────────────────────────

describe('parseMarketplaceEvent — listingId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('extracts listing_id as BigInt', () => {
    setupMocks('lst_crtd', { ...LISTING_FIXTURE, listing_id: 5n });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.listingId).toBe(5n);
  });

  it('extracts auction_id as listingId for auction events', () => {
    setupMocks('auc_crtd', { ...AUCTION_CREATED_FIXTURE, auction_id: 7n });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.listingId).toBe(7n);
  });

  it('sets listingId to null when neither listing_id nor auction_id present', () => {
    setupMocks('dep_n721', DEPLOY_FIXTURE);
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.listingId).toBeNull();
  });
});

// ── actor extraction ──────────────────────────────────────────────────────────

describe('parseMarketplaceEvent — actor priority', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('picks artist when present', () => {
    setupMocks('lst_crtd', { ...LISTING_FIXTURE, artist: 'GA_ARTIST' });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.actor).toBe('GA_ARTIST');
  });

  it('picks creator when artist is absent', () => {
    setupMocks('auc_crtd', { ...AUCTION_CREATED_FIXTURE, creator: 'GA_CREATOR' });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.actor).toBe('GA_CREATOR');
  });

  it('picks offerer when artist and creator are absent', () => {
    setupMocks('ofr_made', { ...OFFER_MADE_FIXTURE, offerer: 'GA_OFFERER' });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.actor).toBe('GA_OFFERER');
  });

  it('picks bidder when others are absent', () => {
    setupMocks('bid_plcd', { ...BID_PLACED_FIXTURE, bidder: 'GA_BIDDER' });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.actor).toBe('GA_BIDDER');
  });

  it('picks buyer when others are absent', () => {
    setupMocks('art_sold', { ...ARTWORK_SOLD_FIXTURE, buyer: 'GA_BUYER' });
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.actor).toBe('GA_BUYER');
  });

  it('leaves actor as empty string when no known actor field present', () => {
    setupMocks('lst_updt', LISTING_UPDATED_FIXTURE);
    expect(parseMarketplaceEvent(['t'], 'v', 1)!.actor).toBe('');
  });
});

// ── ledgerSequence passthrough ────────────────────────────────────────────────

describe('parseMarketplaceEvent — ledgerSequence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('preserves the supplied ledger sequence number', () => {
    setupMocks('lst_crtd', LISTING_FIXTURE);
    expect(parseMarketplaceEvent(['t'], 'v', 12345)!.ledgerSequence).toBe(12345);
  });
});

// ── convertBigInts (via data field) ──────────────────────────────────────────

describe('parseMarketplaceEvent — BigInt serialisation in data', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('converts top-level BigInt values to strings in the data payload', () => {
    setupMocks('lst_crtd', {
      listing_id: 1n, artist: 'GA', price: 10_000_000n,
      currency: 'USDC', collection: 'CC', token_id: 42n,
    });
    const result = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(typeof result.data.listing_id).toBe('string');
    expect(result.data.listing_id).toBe('1');
    expect(result.data.price).toBe('10000000');
  });

  it('converts nested BigInt values to strings', () => {
    setupMocks('bid_plcd', {
      ...BID_PLACED_FIXTURE,
      nested: { amount: 999n },
    });
    const result = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(result.data.nested.amount).toBe('999');
  });

  it('converts BigInt values inside arrays to strings', () => {
    setupMocks('ofr_made', {
      ...OFFER_MADE_FIXTURE,
      amounts: [100n, 200n],
    });
    const result = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(result.data.amounts).toEqual(['100', '200']);
  });
});

// ── per-event-type fixtures ───────────────────────────────────────────────────

describe('parseMarketplaceEvent — LISTING_CREATED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('extracts listingId, actor, ledger and serialises all BigInt fields', () => {
    setupMocks('lst_crtd', {
      listing_id: 1n, artist: 'GARTIST000', price: 10_000_000n,
      currency: 'USDC', collection: 'CCOLLECTION', token_id: 42n, token: 'CTOKEN',
    });
    const r = parseMarketplaceEvent(['topic_xdr'], 'value_xdr', 500)!;
    expect(r.eventType).toBe('LISTING_CREATED');
    expect(r.listingId).toBe(1n);
    expect(r.actor).toBe('GARTIST000');
    expect(r.ledgerSequence).toBe(500);
    expect(r.data.price).toBe('10000000');
    expect(r.data.token_id).toBe('42');
    expect(r.data.listing_id).toBe('1');
    expect(r.data.currency).toBe('USDC');
  });

  it('handles absent optional recipients field without throwing', () => {
    setupMocks('lst_crtd', {
      listing_id: 2n, artist: 'GARTIST000', price: 500n,
      currency: 'USDC', collection: 'CC', token_id: 1n,
    });
    const r = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(r.listingId).toBe(2n);
    expect(r.data.recipients).toBeUndefined();
  });

  it('preserves recipient percentage as string when nested BigInts present', () => {
    setupMocks('lst_crtd', {
      listing_id: 3n, artist: 'GA', price: 100n,
      currency: 'USDC', collection: 'CC', token_id: 1n,
      recipients: [{ address: 'GRECIP', percentage: 500n }],
    });
    const r = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(r.data.recipients[0].percentage).toBe('500');
    expect(r.data.recipients[0].address).toBe('GRECIP');
  });
});

describe('parseMarketplaceEvent — ARTWORK_SOLD fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('extracts buyer as actor and serialises price', () => {
    setupMocks('art_sold', { listing_id: 8n, buyer: 'GBUYER111', price: 25_000_000n });
    const r = parseMarketplaceEvent(['t'], 'v', 800)!;
    expect(r.eventType).toBe('ARTWORK_SOLD');
    expect(r.listingId).toBe(8n);
    expect(r.actor).toBe('GBUYER111');
    expect(r.data.price).toBe('25000000');
    expect(r.data.buyer).toBe('GBUYER111');
  });
});

describe('parseMarketplaceEvent — LISTING_CANCELLED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('maps listing_id and leaves actor empty when no actor field present', () => {
    setupMocks('lst_cncl', { listing_id: 3n });
    const r = parseMarketplaceEvent(['t'], 'v', 300)!;
    expect(r.eventType).toBe('LISTING_CANCELLED');
    expect(r.listingId).toBe(3n);
    expect(r.actor).toBe('');
    expect(r.data.listing_id).toBe('3');
  });
});

describe('parseMarketplaceEvent — LISTING_UPDATED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('serialises new_price BigInt and carries token_id', () => {
    setupMocks('lst_updt', { listing_id: 5n, new_price: 20_000_000n, token_id: 7n });
    const r = parseMarketplaceEvent(['t'], 'v', 350)!;
    expect(r.eventType).toBe('LISTING_UPDATED');
    expect(r.listingId).toBe(5n);
    expect(r.data.new_price).toBe('20000000');
    expect(r.data.token_id).toBe('7');
  });
});

describe('parseMarketplaceEvent — AUCTION_CREATED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('maps auction_id to listingId and serialises reserve_price and end_time', () => {
    setupMocks('auc_crtd', {
      auction_id: 11n, creator: 'GCREATOR', reserve_price: 50_000_000n,
      end_time: 1_800_000_000n, token: 'CTOKEN', collection: 'CAUC', token_id: 99n,
    });
    const r = parseMarketplaceEvent(['t'], 'v', 600)!;
    expect(r.eventType).toBe('AUCTION_CREATED');
    expect(r.listingId).toBe(11n);
    expect(r.actor).toBe('GCREATOR');
    expect(r.data.reserve_price).toBe('50000000');
    expect(r.data.end_time).toBe('1800000000');
    expect(r.data.token_id).toBe('99');
  });

  it('sets listingId to null when auction_id is absent', () => {
    // Missing auction_id triggers SchemaDecodeError — that is the correct new behaviour.
    // The test now verifies the error is thrown with the right type.
    setupMocks('auc_crtd', { creator: 'GCREATOR' });
    expect(() => parseMarketplaceEvent(['t'], 'v', 1)).toThrow();
  });
});

describe('parseMarketplaceEvent — BID_PLACED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('extracts bidder as actor and serialises bid_amount', () => {
    setupMocks('bid_plcd', { auction_id: 11n, bidder: 'GBIDDER', bid_amount: 55_000_000n });
    const r = parseMarketplaceEvent(['t'], 'v', 610)!;
    expect(r.eventType).toBe('BID_PLACED');
    expect(r.actor).toBe('GBIDDER');
    expect(r.data.bid_amount).toBe('55000000');
  });
});

describe('parseMarketplaceEvent — AUCTION_RESOLVED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('serialises final amount and preserves winner address', () => {
    setupMocks('auc_rslv', { auction_id: 11n, winner: 'GWINNER', amount: 55_000_000n });
    const r = parseMarketplaceEvent(['t'], 'v', 620)!;
    expect(r.eventType).toBe('AUCTION_RESOLVED');
    expect(r.data.amount).toBe('55000000');
    expect(r.data.winner).toBe('GWINNER');
  });

  it('handles null winner (no-bid resolution) without throwing', () => {
    setupMocks('auc_rslv', { auction_id: 12n, amount: 0n, winner: null });
    const r = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(r.data.winner).toBeNull();
    expect(r.data.amount).toBe('0');
  });
});

describe('parseMarketplaceEvent — AUCTION_CANCELLED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('maps auction_id to listingId for AUCTION_CANCELLED', () => {
    setupMocks('auc_cncl', { auction_id: 13n });
    const r = parseMarketplaceEvent(['t'], 'v', 615)!;
    expect(r.eventType).toBe('AUCTION_CANCELLED');
    expect(r.listingId).toBe(13n);
  });
});

describe('parseMarketplaceEvent — OFFER_MADE fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('extracts offerer as actor and serialises offer_id, listing_id and amount', () => {
    setupMocks('ofr_made', {
      offer_id: 1n, listing_id: 42n, offerer: 'GOFFERER', amount: 30_000_000n, token: 'CTOKEN',
    });
    const r = parseMarketplaceEvent(['t'], 'v', 630)!;
    expect(r.eventType).toBe('OFFER_MADE');
    expect(r.actor).toBe('GOFFERER');
    expect(r.data.offer_id).toBe('1');
    expect(r.data.listing_id).toBe('42');
    expect(r.data.amount).toBe('30000000');
  });
});

describe('parseMarketplaceEvent — OFFER_ACCEPTED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('serialises offer_id and listing_id', () => {
    setupMocks('ofr_accp', { offer_id: 1n, listing_id: 42n, offerer: 'GOFFERER' });
    const r = parseMarketplaceEvent(['t'], 'v', 640)!;
    expect(r.eventType).toBe('OFFER_ACCEPTED');
    expect(r.data.offer_id).toBe('1');
    expect(r.data.listing_id).toBe('42');
  });
});

describe('parseMarketplaceEvent — OFFER_REJECTED fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('maps offer_id to data', () => {
    setupMocks('ofr_rjct', { offer_id: 2n, listing_id: 5n, offerer: 'GO' });
    const r = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(r.eventType).toBe('OFFER_REJECTED');
    expect(r.data.offer_id).toBe('2');
  });
});

describe('parseMarketplaceEvent — OFFER_WITHDRAWN fixture', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  it('maps offer_id to data', () => {
    setupMocks('ofr_wdrn', { offer_id: 3n, listing_id: 7n, offerer: 'GO' });
    const r = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(r.eventType).toBe('OFFER_WITHDRAWN');
    expect(r.data.offer_id).toBe('3');
  });
});

describe('parseMarketplaceEvent — deploy event fixtures', () => {
  beforeEach(() => { vi.resetAllMocks(); mockFromXDR.mockReturnValue({}); });

  const deployTypes: [string, string][] = [
    ['dep_n721',  'DEPLOY_NORMAL_721'],
    ['dep_n1155', 'DEPLOY_NORMAL_1155'],
    ['dep_l721',  'DEPLOY_LAZY_721'],
    ['dep_l1155', 'DEPLOY_LAZY_1155'],
  ];

  for (const [symbol, expectedType] of deployTypes) {
    it(`${expectedType}: extracts creator from tuple index 0`, () => {
      setupMocks(symbol, ['GCREATOR', 'CCONTRACT']);
      const r = parseMarketplaceEvent(['t'], 'v', 700)!;
      expect(r.eventType).toBe(expectedType);
      expect(r.actor).toBe('GCREATOR');
      expect(r.listingId).toBeNull();
    });
  }

  it('DEPLOY_NORMAL_721: sets listingId to null (no listing_id in deploy data)', () => {
    setupMocks('dep_n721', ['GCREATOR', 'CCONTRACT']);
    const r = parseMarketplaceEvent(['t'], 'v', 1)!;
    expect(r.listingId).toBeNull();
  });
});

// ── newly mapped topic fixtures (#191) — payloads per events.rs structs ──────

describe('parseMarketplaceEvent — LISTING_PRICE_UPDATED fixture', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('extracts updated_by as actor and serialises old/new price', () => {
    setupMocks('lst_pru', {
      listing_id: 4n,
      old_price: 10_000_000n,
      new_price: 12_000_000n,
      updated_by: 'GSELLER',
    });

    const r = parseMarketplaceEvent(['t'], 'v', 900)!;
    expect(r.eventType).toBe('LISTING_PRICE_UPDATED');
    expect(r.listingId).toBe(4n);
    expect(r.actor).toBe('GSELLER');
    expect(r.data.old_price).toBe('10000000');
    expect(r.data.new_price).toBe('12000000');
  });
});

describe('parseMarketplaceEvent — LISTING_EXPIRED fixture', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('maps listing_id and serialises expired_at', () => {
    setupMocks('lst_expd', {
      listing_id: 6n,
      expired_at: 1_800_000_000n,
      ledger_sequence: 901,
    });

    const r = parseMarketplaceEvent(['t'], 'v', 901)!;
    expect(r.eventType).toBe('LISTING_EXPIRED');
    expect(r.listingId).toBe(6n);
    expect(r.actor).toBe('');   // expire_listing is permissionless
    expect(r.data.expired_at).toBe('1800000000');
  });
});

describe('parseMarketplaceEvent — AUCTION_EXTENDED fixture', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('maps auction_id to listingId and serialises new_end_time', () => {
    setupMocks('auc_ext', {
      auction_id: 11n,
      new_end_time: 1_800_000_600n,
    });

    const r = parseMarketplaceEvent(['t'], 'v', 902)!;
    expect(r.eventType).toBe('AUCTION_EXTENDED');
    expect(r.listingId).toBe(11n);
    expect(r.data.new_end_time).toBe('1800000600');
  });
});

describe('parseMarketplaceEvent — OFFER_RECLAIMED fixture', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('extracts offerer as actor and serialises offer_id and amount', () => {
    setupMocks('ofr_rclm', {
      offer_id: 9n,
      listing_id: 42n,
      offerer: 'GOFFERER',
      amount: 30_000_000n,
    });

    const r = parseMarketplaceEvent(['t'], 'v', 903)!;
    expect(r.eventType).toBe('OFFER_RECLAIMED');
    expect(r.listingId).toBe(42n);
    expect(r.actor).toBe('GOFFERER');
    expect(r.data.offer_id).toBe('9');
    expect(r.data.amount).toBe('30000000');
  });
});

describe('parseMarketplaceEvent — PROTOCOL_FEE_COLLECTED fixture', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('maps listing_id and serialises amount, token and treasury', () => {
    setupMocks('fee_cltd', {
      listing_id: 42n,
      amount: 250_000n,
      token: 'CTOKEN',
      treasury: 'GTREASURY',
    });

    const r = parseMarketplaceEvent(['t'], 'v', 904)!;
    expect(r.eventType).toBe('PROTOCOL_FEE_COLLECTED');
    expect(r.listingId).toBe(42n);
    expect(r.data.amount).toBe('250000');
    expect(r.data.token).toBe('CTOKEN');
    expect(r.data.treasury).toBe('GTREASURY');
  });
});

describe('parseMarketplaceEvent — admin & moderation fixtures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('ADMIN_TRANSFER_PROPOSED: current_admin is the actor', () => {
    setupMocks('adm_prop', {
      current_admin: 'GADMIN_OLD',
      proposed_admin: 'GADMIN_NEW',
    });

    const r = parseMarketplaceEvent(['t'], 'v', 905)!;
    expect(r.eventType).toBe('ADMIN_TRANSFER_PROPOSED');
    expect(r.listingId).toBeNull();
    expect(r.actor).toBe('GADMIN_OLD');
  });

  it('ADMIN_TRANSFERRED: new_admin (the accepting admin) is the actor', () => {
    setupMocks('adm_xfrd', {
      old_admin: 'GADMIN_OLD',
      new_admin: 'GADMIN_NEW',
    });

    const r = parseMarketplaceEvent(['t'], 'v', 906)!;
    expect(r.eventType).toBe('ADMIN_TRANSFERRED');
    expect(r.actor).toBe('GADMIN_NEW');
  });

  it('ARTIST_REVOKED: artist is the recorded actor', () => {
    setupMocks('art_rvkd', { artist: 'GARTIST' });
    const r = parseMarketplaceEvent(['t'], 'v', 907)!;
    expect(r.eventType).toBe('ARTIST_REVOKED');
    expect(r.actor).toBe('GARTIST');
    expect(r.listingId).toBeNull();
  });

  it('ARTIST_REINSTATED: artist is the recorded actor', () => {
    setupMocks('art_rnst', { artist: 'GARTIST' });
    const r = parseMarketplaceEvent(['t'], 'v', 908)!;
    expect(r.eventType).toBe('ARTIST_REINSTATED');
    expect(r.actor).toBe('GARTIST');
  });

  it('CONTRACT_PAUSED: tolerates a unit (void) payload without crashing', () => {
    setupMocks('ctr_psd', undefined as any);
    const r = parseMarketplaceEvent(['t'], 'v', 909)!;
    expect(r.eventType).toBe('CONTRACT_PAUSED');
    expect(r.listingId).toBeNull();
    expect(r.actor).toBe('');
  });

  it('CONTRACT_UNPAUSED: tolerates a bare address payload without crashing', () => {
    setupMocks('ctr_unpsd', 'GADMIN');
    const r = parseMarketplaceEvent(['t'], 'v', 910)!;
    expect(r.eventType).toBe('CONTRACT_UNPAUSED');
    expect(r.listingId).toBeNull();
    expect(r.actor).toBe('');
  });

  it('ROYALTY_PAID: passes payload through and maps listing_id when present', () => {
    setupMocks('roy_paid', {
      listing_id: 42n,
      amount: 1_000n,
      recipient: 'GRECIP',
    });

    const r = parseMarketplaceEvent(['t'], 'v', 911)!;
    expect(r.eventType).toBe('ROYALTY_PAID');
    expect(r.listingId).toBe(42n);
    expect(r.data.amount).toBe('1000');
  });

  it('LISTING_CANCELLED: cancelled_by is the recorded actor when present', () => {
    setupMocks('lst_cncl', {
      listing_id: 3n,
      cancelled_by: 'GADMIN',
      reason: 3,
    });

    const r = parseMarketplaceEvent(['t'], 'v', 912)!;
    expect(r.actor).toBe('GADMIN');
  });
});

// ── malformed payloads must throw so the caller can count decode errors ──────

describe('parseMarketplaceEvent — malformed payloads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('propagates value-XDR decode failures (caller increments decodeErrorsCounter)', () => {
    // Topic decodes fine; the value XDR is corrupt
    mockScValToNative.mockReturnValueOnce('lst_pru');
    mockFromXDR
      .mockReturnValueOnce({})
      .mockImplementationOnce(() => { throw new Error('corrupt value XDR'); });

    expect(() => parseMarketplaceEvent(['t'], 'corrupt', 1)).toThrow('corrupt value XDR');
  });

  it('throws on a numeric-string payload where a struct was expected (BigInt coercion)', () => {
    // listing_id present but not coercible → BigInt throws → caller counts it
    setupMocks('lst_pru', { listing_id: 'not-a-number' });
    expect(() => parseMarketplaceEvent(['t'], 'v', 1)).toThrow();
  });

  it('does not throw for new topics when payload is an unexpected primitive', () => {
    for (const symbol of ['lst_expd', 'auc_ext', 'ofr_rclm', 'fee_cltd', 'roy_paid']) {
      setupMocks(symbol, 'unexpected-primitive' as any);
      const r = parseMarketplaceEvent(['t'], 'v', 1)!;
      expect(r).not.toBeNull();
      expect(r.listingId).toBeNull();
      expect(r.actor).toBe('');
    }
  });
});

// ── identity & ordering passthrough (#191) ───────────────────────────────────

describe('parseMarketplaceEvent — eventId and ordering fields', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFromXDR.mockReturnValue({});
  });

  it('carries eventId, txHash, txIndex and eventIndex through to the decoded event', () => {
    setupMocks('lst_crtd', { listing_id: 1n, artist: 'GA' });

    const r = parseMarketplaceEvent(['t'], 'v', 100, 'CONTRACT', 'txabc', 3, '429496729600-0000000003', 7)!;
    expect(r.eventId).toBe('429496729600-0000000003');
    expect(r.txHash).toBe('txabc');
    expect(r.txIndex).toBe(7);
    expect(r.eventIndex).toBe(3);
  });

  it('falls back to eventHash as eventId when the RPC id is absent', () => {
    setupMocks('lst_crtd', { listing_id: 1n, artist: 'GA' });

    const r = parseMarketplaceEvent(['t'], 'v', 100, 'CONTRACT', 'txabc', 3)!;
    expect(r.eventId).toBe(r.eventHash);
    expect(r.eventId).toHaveLength(64);
  });
});
