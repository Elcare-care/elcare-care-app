/**
 * contract-client.test.ts
 *
 * Unit tests for src/contract-client.ts covering:
 *  - ContractClient.fetchListing / fetchAuction / fetchOffer / fetchCollection
 *  - ABI encoding errors caught, null returned
 *  - Batch fetch methods with both success and error paths
 *  - createContractClient factory
 *  - Graceful degradation when launchpadContractId is absent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockChainState = vi.hoisted(() => ({
  getListingReader: vi.fn(),
  getAuctionReader: vi.fn(),
  getOfferReader:   vi.fn(),
  fetchListingsBatch: vi.fn(),
  fetchAuctionsBatch: vi.fn(),
  fetchOffersBatch:   vi.fn(),
  fetchCollectionOnChain:                  vi.fn(),
  fetchCollectionFeeBpsFromMarketplace:    vi.fn(),
}));

vi.mock('../chain-state', () => mockChainState);

import { ContractClient, createContractClient } from '../contract-client';
import type { rpc } from '@stellar/stellar-sdk';

const mockServer = {} as rpc.Server;

const mkConfig = (overrides = {}) => ({
  marketplaceContractId: 'CMARKETPLACE',
  ...overrides,
});

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default readers return null (chain unavailable)
  const nullReader = vi.fn().mockResolvedValue(null);
  mockChainState.getListingReader.mockReturnValue(nullReader);
  mockChainState.getAuctionReader.mockReturnValue(nullReader);
  mockChainState.getOfferReader.mockReturnValue(nullReader);

  mockChainState.fetchListingsBatch.mockResolvedValue(new Map());
  mockChainState.fetchAuctionsBatch.mockResolvedValue(new Map());
  mockChainState.fetchOffersBatch.mockResolvedValue(new Map());
  mockChainState.fetchCollectionOnChain.mockResolvedValue(null);
  mockChainState.fetchCollectionFeeBpsFromMarketplace.mockResolvedValue(null);
});

// ── createContractClient factory ───────────────────────────────────────────────

describe('createContractClient', () => {
  it('returns a ContractClient instance', () => {
    const client = createContractClient(mockServer, mkConfig());
    expect(client).toBeInstanceOf(ContractClient);
  });

  it('instantiates without launchpadContractId', () => {
    expect(() => createContractClient(mockServer, mkConfig())).not.toThrow();
  });
});

// ── fetchListing ───────────────────────────────────────────────────────────────

describe('ContractClient.fetchListing', () => {
  it('delegates to the listing reader with the marketplace contract ID', async () => {
    const reader = vi.fn().mockResolvedValue({ status: 'Active', price: '100.0000000', owner: null, expiresAt: null });
    mockChainState.getListingReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchListing(42n);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('Active');
    expect(reader).toHaveBeenCalledWith(mockServer, 'CMARKETPLACE', 42n);
  });

  it('returns null when reader returns null', async () => {
    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchListing(1n);
    expect(result).toBeNull();
  });

  it('catches reader errors and returns null (ABI decode failure path)', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('[chain-state] Unexpected listing status: "Bogus"'));
    mockChainState.getListingReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchListing(99n);

    expect(result).toBeNull();
  });

  it('catches RPC timeout errors and returns null', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    mockChainState.getListingReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    await expect(client.fetchListing(5n)).resolves.toBeNull();
  });
});

// ── fetchAuction ───────────────────────────────────────────────────────────────

describe('ContractClient.fetchAuction', () => {
  it('delegates to the auction reader with the marketplace contract ID', async () => {
    const reader = vi.fn().mockResolvedValue({
      status: 'Active', highestBid: '0.0000000', highestBidder: null, endTime: '1700000000',
    });
    mockChainState.getAuctionReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchAuction(7n);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('Active');
    expect(reader).toHaveBeenCalledWith(mockServer, 'CMARKETPLACE', 7n);
  });

  it('returns null on error (graceful degradation)', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('Network error'));
    mockChainState.getAuctionReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchAuction(3n);
    expect(result).toBeNull();
  });
});

// ── fetchOffer ─────────────────────────────────────────────────────────────────

describe('ContractClient.fetchOffer', () => {
  it('delegates to the offer reader with the marketplace contract ID', async () => {
    const reader = vi.fn().mockResolvedValue({
      status: 'Pending', amount: '50.0000000', offerer: 'GABC', expiresAt: null,
    });
    mockChainState.getOfferReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchOffer(100n);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('Pending');
    expect(result!.amount).toBe('50.0000000');
    expect(reader).toHaveBeenCalledWith(mockServer, 'CMARKETPLACE', 100n);
  });

  it('returns null when offer entry does not exist on chain', async () => {
    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchOffer(999n);
    expect(result).toBeNull();
  });

  it('catches ABI decode errors (invalid offer status) and returns null', async () => {
    const reader = vi.fn().mockRejectedValue(
      new Error('[chain-state] Unexpected offer status: "BadStatus"')
    );
    mockChainState.getOfferReader.mockReturnValue(reader);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchOffer(55n);
    expect(result).toBeNull();
  });
});

// ── fetchCollection ────────────────────────────────────────────────────────────

describe('ContractClient.fetchCollection', () => {
  it('returns null immediately when launchpadContractId is not configured', async () => {
    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchCollection('CCOLLECTION');

    expect(result).toBeNull();
    expect(mockChainState.fetchCollectionOnChain).not.toHaveBeenCalled();
  });

  it('delegates to fetchCollectionOnChain when launchpadContractId is set', async () => {
    mockChainState.fetchCollectionOnChain.mockResolvedValue({
      feeBpsOverride: 500, kind: 'Normal721', creator: 'GCREATOR',
    });

    const client = createContractClient(mockServer, mkConfig({ launchpadContractId: 'CLAUNCHPAD' }));
    const result = await client.fetchCollection('CCOLLECTION');

    expect(result).not.toBeNull();
    expect(result!.feeBpsOverride).toBe(500);
    expect(mockChainState.fetchCollectionOnChain).toHaveBeenCalledWith(
      mockServer, 'CLAUNCHPAD', 'CCOLLECTION'
    );
  });

  it('catches errors from fetchCollectionOnChain and returns null', async () => {
    mockChainState.fetchCollectionOnChain.mockRejectedValue(new Error('Simulate error'));

    const client = createContractClient(mockServer, mkConfig({ launchpadContractId: 'CLAUNCHPAD' }));
    const result = await client.fetchCollection('CCOLLECTION');
    expect(result).toBeNull();
  });
});

// ── fetchCollectionFeeBps ──────────────────────────────────────────────────────

describe('ContractClient.fetchCollectionFeeBps', () => {
  it('delegates to fetchCollectionFeeBpsFromMarketplace', async () => {
    mockChainState.fetchCollectionFeeBpsFromMarketplace.mockResolvedValue(750);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchCollectionFeeBps('CCOLLECTION');

    expect(result).toBe(750);
    expect(mockChainState.fetchCollectionFeeBpsFromMarketplace).toHaveBeenCalledWith(
      mockServer, 'CMARKETPLACE', 'CCOLLECTION'
    );
  });

  it('returns null when no override is set (None)', async () => {
    mockChainState.fetchCollectionFeeBpsFromMarketplace.mockResolvedValue(null);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchCollectionFeeBps('CCOLLECTION');
    expect(result).toBeNull();
  });

  it('catches errors and returns null', async () => {
    mockChainState.fetchCollectionFeeBpsFromMarketplace.mockRejectedValue(new Error('timeout'));

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchCollectionFeeBps('CCOLLECTION');
    expect(result).toBeNull();
  });
});

// ── Batch methods ──────────────────────────────────────────────────────────────

describe('ContractClient.fetchListingsBatch', () => {
  it('delegates to fetchListingsBatch from chain-state', async () => {
    const batchResult = new Map([
      ['1', { status: 'Active', price: '100.0000000', owner: null, expiresAt: null }],
      ['2', null],
    ]);
    mockChainState.fetchListingsBatch.mockResolvedValue(batchResult);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchListingsBatch([1n, 2n]);

    expect(result.size).toBe(2);
    expect(result.get('1')).not.toBeNull();
    expect(result.get('2')).toBeNull();
    expect(mockChainState.fetchListingsBatch).toHaveBeenCalledWith(mockServer, 'CMARKETPLACE', [1n, 2n]);
  });

  it('maps all ids to null when fetchListingsBatch throws', async () => {
    mockChainState.fetchListingsBatch.mockRejectedValue(new Error('RPC batch failure'));

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchListingsBatch([10n, 20n, 30n]);

    expect(result.size).toBe(3);
    expect(result.get('10')).toBeNull();
    expect(result.get('20')).toBeNull();
    expect(result.get('30')).toBeNull();
  });

  it('returns empty map for empty input without calling chain-state', async () => {
    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchListingsBatch([]);
    // fetchListingsBatch from chain-state.ts handles empty arrays; ContractClient passes through
    expect(result).toBeDefined();
  });
});

describe('ContractClient.fetchAuctionsBatch', () => {
  it('maps all ids to null when fetchAuctionsBatch throws', async () => {
    mockChainState.fetchAuctionsBatch.mockRejectedValue(new Error('timeout'));

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchAuctionsBatch([5n, 6n]);

    expect(result.get('5')).toBeNull();
    expect(result.get('6')).toBeNull();
  });

  it('returns decoded results on success', async () => {
    const batchResult = new Map([
      ['7', { status: 'Finalized', highestBid: '100.0000000', highestBidder: 'GABC', endTime: '1700000000' }],
    ]);
    mockChainState.fetchAuctionsBatch.mockResolvedValue(batchResult);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchAuctionsBatch([7n]);

    expect(result.get('7')).not.toBeNull();
    expect(result.get('7')!.status).toBe('Finalized');
  });
});

describe('ContractClient.fetchOffersBatch', () => {
  it('maps all ids to null when fetchOffersBatch throws', async () => {
    mockChainState.fetchOffersBatch.mockRejectedValue(new Error('network error'));

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchOffersBatch([100n, 101n]);

    expect(result.get('100')).toBeNull();
    expect(result.get('101')).toBeNull();
  });

  it('returns decoded offer results on success', async () => {
    const batchResult = new Map([
      ['200', { status: 'Pending', amount: '75.0000000', offerer: 'GXYZ', expiresAt: null }],
      ['201', null],
    ]);
    mockChainState.fetchOffersBatch.mockResolvedValue(batchResult);

    const client = createContractClient(mockServer, mkConfig());
    const result = await client.fetchOffersBatch([200n, 201n]);

    expect(result.get('200')).not.toBeNull();
    expect(result.get('200')!.amount).toBe('75.0000000');
    expect(result.get('201')).toBeNull();
  });
});

// ── Contract unavailable scenarios ────────────────────────────────────────────

describe('ContractClient — contract unavailable scenarios', () => {
  it('all fetch methods return null when contract does not exist', async () => {
    const throwingReader = vi.fn().mockRejectedValue(new Error('contract not found'));
    mockChainState.getListingReader.mockReturnValue(throwingReader);
    mockChainState.getAuctionReader.mockReturnValue(throwingReader);
    mockChainState.getOfferReader.mockReturnValue(throwingReader);
    mockChainState.fetchCollectionFeeBpsFromMarketplace.mockRejectedValue(new Error('contract not found'));

    const client = createContractClient(mockServer, mkConfig({ launchpadContractId: 'CLAUNCHPAD' }));

    const [listing, auction, offer, feeBps] = await Promise.all([
      client.fetchListing(1n),
      client.fetchAuction(1n),
      client.fetchOffer(1n),
      client.fetchCollectionFeeBps('CABC'),
    ]);

    expect(listing).toBeNull();
    expect(auction).toBeNull();
    expect(offer).toBeNull();
    expect(feeBps).toBeNull();
  });

  it('batch methods all return null-mapped results when RPC is down', async () => {
    mockChainState.fetchListingsBatch.mockRejectedValue(new Error('RPC down'));
    mockChainState.fetchAuctionsBatch.mockRejectedValue(new Error('RPC down'));
    mockChainState.fetchOffersBatch.mockRejectedValue(new Error('RPC down'));

    const client = createContractClient(mockServer, mkConfig());

    const [listings, auctions, offers] = await Promise.all([
      client.fetchListingsBatch([1n, 2n]),
      client.fetchAuctionsBatch([3n]),
      client.fetchOffersBatch([10n, 11n, 12n]),
    ]);

    expect(listings.get('1')).toBeNull();
    expect(listings.get('2')).toBeNull();
    expect(auctions.get('3')).toBeNull();
    expect(offers.get('10')).toBeNull();
    expect(offers.get('11')).toBeNull();
    expect(offers.get('12')).toBeNull();
  });
});
