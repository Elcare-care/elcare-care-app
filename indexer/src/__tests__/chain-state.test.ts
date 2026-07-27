/**
 * chain-state.test.ts
 *
 * Unit tests for src/chain-state.ts covering:
 *  - ScVal key construction (buildListingKey, buildAuctionKey, buildLedgerKey)
 *  - XDR decode of all status variants and Option fields (decodeListingEntry, decodeAuctionEntry)
 *  - formatDecimal7 edge cases
 *  - RPC fetch helpers: entry-not-found, propagate-error, batch behaviour
 *  - Round-trip: synthesised ScVal fixture → fetchListingOnChain → decoded result
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr, scValToNative, nativeToScVal, StrKey } from '@stellar/stellar-sdk';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../retry', () => ({
  withRpcRetry: async (fn: () => Promise<any>) => fn(),
  STELLAR_RPC_RETRY_CONFIG: {},
}));

vi.mock('../logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  buildListingKey,
  buildAuctionKey,
  buildLedgerKey,
  decodeListingEntry,
  decodeAuctionEntry,
  formatDecimal7,
  fetchListingOnChain,
  fetchAuctionOnChain,
  fetchListingsBatch,
  fetchAuctionsBatch,
} from '../chain-state';

// ── Test constants ────────────────────────────────────────────────────────────

// Valid 32-byte contract StrKey (all-zero public key → standard 'A' filler address)
const TEST_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

// ── ScVal key construction ────────────────────────────────────────────────────

describe('buildListingKey', () => {
  it('produces an ScvMap with one Listing→ScvU64 entry', () => {
    const key = buildListingKey(42n);
    expect(key.switch().value).toBe(xdr.ScValType.scvMap().value);

    const entries = key.map()!;
    expect(entries).toHaveLength(1);
    expect(entries[0].key().switch().value).toBe(xdr.ScValType.scvSymbol().value);
    expect(entries[0].key().sym()).toBe('Listing');
    expect(entries[0].val().switch().value).toBe(xdr.ScValType.scvU64().value);
    expect(scValToNative(entries[0].val())).toBe(42n);
  });

  it('serialises to XDR base64 and round-trips back', () => {
    const key = buildListingKey(1234567890n);
    const b64 = key.toXDR('base64');
    const decoded = xdr.ScVal.fromXDR(b64, 'base64');
    expect(scValToNative(decoded.map()![0].val())).toBe(1234567890n);
  });

  it('accepts id=0n without throwing', () => {
    expect(() => buildListingKey(0n)).not.toThrow();
    expect(scValToNative(buildListingKey(0n).map()![0].val())).toBe(0n);
  });
});

describe('buildAuctionKey', () => {
  it('produces an ScvMap with one Auction→ScvU64 entry', () => {
    const key = buildAuctionKey(99n);
    const entries = key.map()!;
    expect(entries).toHaveLength(1);
    expect(entries[0].key().sym()).toBe('Auction');
    expect(scValToNative(entries[0].val())).toBe(99n);
  });

  it('produces distinct XDR from buildListingKey for the same id', () => {
    expect(buildListingKey(1n).toXDR('base64')).not.toBe(buildAuctionKey(1n).toXDR('base64'));
  });

  it('serialises without throwing', () => {
    expect(() => buildAuctionKey(0n).toXDR('base64')).not.toThrow();
  });
});

describe('buildLedgerKey', () => {
  it('wraps a data key into a persistent ContractData LedgerKey', () => {
    const dataKey = buildListingKey(5n);
    const ledgerKey = buildLedgerKey(TEST_CONTRACT, dataKey);
    expect(ledgerKey.switch().value).toBe(xdr.LedgerEntryType.contractData().value);

    const cd = ledgerKey.contractData();
    expect(cd.durability().value).toBe(xdr.ContractDataDurability.persistent().value);
    expect(cd.key().toXDR('base64')).toBe(dataKey.toXDR('base64'));
  });

  it('embeds the decoded contract bytes from the C-strkey', () => {
    const ledgerKey = buildLedgerKey(TEST_CONTRACT, buildListingKey(1n));
    const contractBytes = StrKey.decodeContract(TEST_CONTRACT);
    const embedded = ledgerKey.contractData().contract().contractId();
    expect(Buffer.from(embedded as any).toString('hex'))
      .toBe(Buffer.from(contractBytes).toString('hex'));
  });

  it('serialises auction key into a valid XDR base64 string', () => {
    const key = buildLedgerKey(TEST_CONTRACT, buildAuctionKey(7n));
    expect(() => key.toXDR('base64')).not.toThrow();
    expect(typeof key.toXDR('base64')).toBe('string');
  });
});

// ── Minimal ScVal fixture builder ─────────────────────────────────────────────
//
// decodeListingEntry only reads: status, price, owner, expires_at.
// A minimal ScvMap with those four keys is sufficient for all decode tests.

function makeListingScVal(opts: {
  status?: string;
  price?: bigint;
  owner?: string | null;
  expiresAt?: bigint | null;
} = {}): xdr.ScVal {
  const {
    status    = 'Active',
    price     = 1_000_000_000n,
    owner     = null,
    expiresAt = null,
  } = opts;

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('status'),
      val: xdr.ScVal.scvSymbol(status),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('price'),
      val: nativeToScVal(price, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('owner'),
      val: owner == null ? xdr.ScVal.scvVoid() : nativeToScVal(owner, { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('expires_at'),
      val: expiresAt == null ? xdr.ScVal.scvVoid() : nativeToScVal(expiresAt, { type: 'u64' }),
    }),
  ]);
}

function makeAuctionScVal(opts: {
  status?: string;
  highestBid?: bigint;
  highestBidder?: string | null;
  endTime?: bigint;
} = {}): xdr.ScVal {
  const {
    status        = 'Active',
    highestBid    = 0n,
    highestBidder = null,
    endTime       = 1_700_000_000n,
  } = opts;

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('status'),
      val: xdr.ScVal.scvSymbol(status),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('highest_bid'),
      val: nativeToScVal(highestBid, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('highest_bidder'),
      val: highestBidder == null ? xdr.ScVal.scvVoid() : nativeToScVal(highestBidder, { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('end_time'),
      val: nativeToScVal(endTime, { type: 'u64' }),
    }),
  ]);
}

// Wraps an ScVal into the LedgerEntryResult shape that getLedgerEntries returns:
//   entry.val → LedgerEntryData (XDR union)
//   entry.val.contractData() → ContractDataEntry
//   entry.val.contractData().val() → the ScVal we care about
function makeEntryResult(dataKey: xdr.ScVal, val: xdr.ScVal) {
  const contract = xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(TEST_CONTRACT));
  return {
    key: xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: dataKey,
        durability: xdr.ContractDataDurability.persistent(),
      })
    ),
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract,
        key: dataKey,
        durability: xdr.ContractDataDurability.persistent(),
        val,
      })
    ),
    lastModifiedLedgerSeq: 999,
  };
}

// ── decodeListingEntry ────────────────────────────────────────────────────────

describe('decodeListingEntry — status variants', () => {
  it.each([['Active'], ['Sold'], ['Cancelled']])('decodes %s status', (status) => {
    const native = scValToNative(makeListingScVal({ status })) as Record<string, unknown>;
    expect(decodeListingEntry(native).status).toBe(status);
  });

  it('throws on unknown status', () => {
    const native = scValToNative(makeListingScVal({ status: 'Pending' })) as Record<string, unknown>;
    expect(() => decodeListingEntry(native)).toThrow(/listing/);
  });
});

describe('decodeListingEntry — Option<owner>', () => {
  it('returns null when owner is None (ScvVoid → undefined)', () => {
    const native = scValToNative(makeListingScVal({ owner: null })) as Record<string, unknown>;
    expect(decodeListingEntry(native).owner).toBeNull();
  });

  it('returns address string when owner is Some', () => {
    const ownerAddr = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';
    const native = scValToNative(makeListingScVal({ owner: ownerAddr })) as Record<string, unknown>;
    expect(decodeListingEntry(native).owner).toBe(ownerAddr);
  });
});

describe('decodeListingEntry — Option<expires_at>', () => {
  it('returns null when expires_at is None', () => {
    const native = scValToNative(makeListingScVal({ expiresAt: null })) as Record<string, unknown>;
    expect(decodeListingEntry(native).expiresAt).toBeNull();
  });

  it('returns bigint when expires_at is Some', () => {
    const native = scValToNative(makeListingScVal({ expiresAt: 9_999_999n })) as Record<string, unknown>;
    expect(decodeListingEntry(native).expiresAt).toBe(9_999_999n);
  });
});

describe('decodeListingEntry — price formatting', () => {
  it('formats 0n price as "0.0000000"', () => {
    const native = scValToNative(makeListingScVal({ price: 0n })) as Record<string, unknown>;
    expect(decodeListingEntry(native).price).toBe('0.0000000');
  });

  it('formats large i128 price correctly', () => {
    const native = scValToNative(makeListingScVal({ price: 999_999_999_999n })) as Record<string, unknown>;
    expect(decodeListingEntry(native).price).toBe('999999999999.0000000');
  });
});

describe('decodeListingEntry — failure branches', () => {
  it('throws when price is missing', () => {
    const bad: Record<string, unknown> = { status: 'Active', owner: null, expires_at: null };
    expect(() => decodeListingEntry(bad)).toThrow();
  });

  it('throws when status is missing (undefined treated as unknown)', () => {
    const bad: Record<string, unknown> = { price: 1n, owner: null, expires_at: null };
    expect(() => decodeListingEntry(bad)).toThrow();
  });
});

// ── decodeAuctionEntry ────────────────────────────────────────────────────────

describe('decodeAuctionEntry — status variants', () => {
  it.each([['Active'], ['Finalized'], ['Cancelled']])('decodes %s status', (status) => {
    const native = scValToNative(makeAuctionScVal({ status })) as Record<string, unknown>;
    expect(decodeAuctionEntry(native).status).toBe(status);
  });

  it('throws on unknown status', () => {
    const native = scValToNative(makeAuctionScVal({ status: 'Pending' })) as Record<string, unknown>;
    expect(() => decodeAuctionEntry(native)).toThrow(/auction/);
  });
});

describe('decodeAuctionEntry — Option<highestBidder>', () => {
  it('returns null when highestBidder is None', () => {
    const native = scValToNative(makeAuctionScVal({ highestBidder: null })) as Record<string, unknown>;
    expect(decodeAuctionEntry(native).highestBidder).toBeNull();
  });

  it('returns address string when highestBidder is Some', () => {
    const bidderAddr = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';
    const native = scValToNative(makeAuctionScVal({ highestBidder: bidderAddr })) as Record<string, unknown>;
    expect(decodeAuctionEntry(native).highestBidder).toBe(bidderAddr);
  });
});

describe('decodeAuctionEntry — numeric fields', () => {
  it('formats highestBid as Decimal(32,7) string', () => {
    const native = scValToNative(makeAuctionScVal({ highestBid: 5_000_000_000n })) as Record<string, unknown>;
    expect(decodeAuctionEntry(native).highestBid).toBe('5000000000.0000000');
  });

  it('converts end_time bigint to decimal string', () => {
    const native = scValToNative(makeAuctionScVal({ endTime: 1_234_567_890n })) as Record<string, unknown>;
    expect(decodeAuctionEntry(native).endTime).toBe('1234567890');
  });
});

describe('decodeAuctionEntry — failure branches', () => {
  it('throws when end_time is missing', () => {
    const bad: Record<string, unknown> = { status: 'Active', highest_bid: 0n, highest_bidder: null };
    expect(() => decodeAuctionEntry(bad)).toThrow();
  });

  it('throws when status is unknown', () => {
    const bad: Record<string, unknown> = { status: 'Unknown', highest_bid: 0n, end_time: 1n };
    expect(() => decodeAuctionEntry(bad)).toThrow();
  });
});

// ── formatDecimal7 ────────────────────────────────────────────────────────────

describe('formatDecimal7', () => {
  it.each([
    [0n,             '0.0000000'],
    [1_000_000_000n, '1000000000.0000000'],
    [-500n,          '-500.0000000'],
  ] as [bigint, string][])('formats bigint %s correctly', (input, expected) => {
    expect(formatDecimal7(input)).toBe(expected);
  });

  it('accepts string "42"',  () => expect(formatDecimal7('42')).toBe('42.0000000'));
  it('accepts number 0',     () => expect(formatDecimal7(0)).toBe('0.0000000'));
  it('throws on null',       () => expect(() => formatDecimal7(null)).toThrow());
  it('throws on undefined',  () => expect(() => formatDecimal7(undefined)).toThrow());
  it('throws on object',     () => expect(() => formatDecimal7({})).toThrow());
  it('throws on non-numeric string', () => expect(() => formatDecimal7('abc')).toThrow());
});

// ── Mock server helper ────────────────────────────────────────────────────────

function mockServer(opts: {
  entries?: ReturnType<typeof makeEntryResult>[];
  throws?: Error;
}) {
  const { entries = [], throws } = opts;
  return {
    getLedgerEntries: throws
      ? vi.fn().mockRejectedValue(throws)
      : vi.fn().mockResolvedValue({ entries, latestLedger: 1000 }),
  } as any;
}

// ── fetchListingOnChain — RPC behaviour ───────────────────────────────────────

describe('fetchListingOnChain — entry not found', () => {
  it('returns null when getLedgerEntries returns empty entries', async () => {
    const server = mockServer({ entries: [] });
    const result = await fetchListingOnChain(server, TEST_CONTRACT, 1n);
    expect(result).toBeNull();
    expect(server.getLedgerEntries).toHaveBeenCalledOnce();
  });
});

describe('fetchListingOnChain — RPC failure', () => {
  it('propagates the RPC error', async () => {
    const server = mockServer({ throws: new Error('RPC timeout') });
    await expect(fetchListingOnChain(server, TEST_CONTRACT, 1n)).rejects.toThrow('RPC timeout');
  });
});

describe('fetchListingOnChain — XDR round-trip via synthesised fixture', () => {
  it('decodes an Active listing (owner=null, expiresAt=null)', async () => {
    const scVal = makeListingScVal({ status: 'Active', price: 1_000_000_000n });
    const server = mockServer({ entries: [makeEntryResult(buildListingKey(1n), scVal)] });
    const result = await fetchListingOnChain(server, TEST_CONTRACT, 1n);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('Active');
    expect(result!.price).toBe('1000000000.0000000');
    expect(result!.owner).toBeNull();
    expect(result!.expiresAt).toBeNull();
  });

  it('decodes a Sold listing', async () => {
    const scVal = makeListingScVal({ status: 'Sold', price: 500n });
    const server = mockServer({ entries: [makeEntryResult(buildListingKey(5n), scVal)] });
    const result = await fetchListingOnChain(server, TEST_CONTRACT, 5n);
    expect(result!.status).toBe('Sold');
    expect(result!.price).toBe('500.0000000');
  });

  it('decodes a Cancelled listing', async () => {
    const scVal = makeListingScVal({ status: 'Cancelled', price: 200n });
    const server = mockServer({ entries: [makeEntryResult(buildListingKey(7n), scVal)] });
    const result = await fetchListingOnChain(server, TEST_CONTRACT, 7n);
    expect(result!.status).toBe('Cancelled');
  });
});

// ── fetchAuctionOnChain — RPC behaviour ───────────────────────────────────────

describe('fetchAuctionOnChain — entry not found', () => {
  it('returns null when getLedgerEntries returns empty entries', async () => {
    const server = mockServer({ entries: [] });
    const result = await fetchAuctionOnChain(server, TEST_CONTRACT, 1n);
    expect(result).toBeNull();
  });
});

describe('fetchAuctionOnChain — XDR round-trip', () => {
  it('decodes an Active auction (highestBidder=null)', async () => {
    const scVal = makeAuctionScVal({ status: 'Active', highestBid: 0n, endTime: 1_700_000_000n });
    const server = mockServer({ entries: [makeEntryResult(buildAuctionKey(1n), scVal)] });
    const result = await fetchAuctionOnChain(server, TEST_CONTRACT, 1n);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('Active');
    expect(result!.highestBid).toBe('0.0000000');
    expect(result!.highestBidder).toBeNull();
    expect(result!.endTime).toBe('1700000000');
  });

  it('decodes a Finalized auction with a winner', async () => {
    const bidder = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';
    const scVal = makeAuctionScVal({ status: 'Finalized', highestBid: 5_000n, highestBidder: bidder });
    const server = mockServer({ entries: [makeEntryResult(buildAuctionKey(3n), scVal)] });
    const result = await fetchAuctionOnChain(server, TEST_CONTRACT, 3n);
    expect(result!.status).toBe('Finalized');
    expect(result!.highestBidder).toBe(bidder);
    expect(result!.highestBid).toBe('5000.0000000');
  });
});

// ── fetchListingsBatch ────────────────────────────────────────────────────────

describe('fetchListingsBatch', () => {
  it('returns empty map without calling RPC for empty input', async () => {
    const server = { getLedgerEntries: vi.fn() } as any;
    const result = await fetchListingsBatch(server, TEST_CONTRACT, []);
    expect(result.size).toBe(0);
    expect(server.getLedgerEntries).not.toHaveBeenCalled();
  });

  it('maps all ids to null when RPC returns no matching entries', async () => {
    const server = mockServer({ entries: [] });
    const result = await fetchListingsBatch(server, TEST_CONTRACT, [1n, 2n, 3n]);
    expect(result.size).toBe(3);
    expect(result.get('1')).toBeNull();
    expect(result.get('2')).toBeNull();
    expect(result.get('3')).toBeNull();
    expect(server.getLedgerEntries).toHaveBeenCalledOnce();
  });

  it('maps all ids to null when RPC throws (caught inside batch)', async () => {
    const server = mockServer({ throws: new Error('network error') });
    const result = await fetchListingsBatch(server, TEST_CONTRACT, [10n, 20n]);
    expect(result.get('10')).toBeNull();
    expect(result.get('20')).toBeNull();
  });

  it('decodes matched entries and maps missing ids to null', async () => {
    const scVal = makeListingScVal({ status: 'Active', price: 777n });
    const server = mockServer({ entries: [makeEntryResult(buildListingKey(1n), scVal)] });
    const result = await fetchListingsBatch(server, TEST_CONTRACT, [1n, 2n]);

    const entry1 = result.get('1');
    expect(entry1).not.toBeNull();
    expect(entry1!.status).toBe('Active');
    expect(entry1!.price).toBe('777.0000000');
    expect(result.get('2')).toBeNull();
  });
});

// ── fetchAuctionsBatch ────────────────────────────────────────────────────────

describe('fetchAuctionsBatch', () => {
  it('returns empty map without calling RPC for empty input', async () => {
    const server = { getLedgerEntries: vi.fn() } as any;
    const result = await fetchAuctionsBatch(server, TEST_CONTRACT, []);
    expect(result.size).toBe(0);
    expect(server.getLedgerEntries).not.toHaveBeenCalled();
  });

  it('maps all ids to null when RPC throws (caught inside batch)', async () => {
    const server = mockServer({ throws: new Error('timeout') });
    const result = await fetchAuctionsBatch(server, TEST_CONTRACT, [5n]);
    expect(result.get('5')).toBeNull();
  });

  it('decodes matched entries and maps missing ids to null', async () => {
    const scVal = makeAuctionScVal({ status: 'Finalized', highestBid: 100n, endTime: 2_000_000n });
    const server = mockServer({ entries: [makeEntryResult(buildAuctionKey(7n), scVal)] });
    const result = await fetchAuctionsBatch(server, TEST_CONTRACT, [7n, 8n]);

    const entry7 = result.get('7');
    expect(entry7).not.toBeNull();
    expect(entry7!.status).toBe('Finalized');
    expect(result.get('8')).toBeNull();
  });
});
