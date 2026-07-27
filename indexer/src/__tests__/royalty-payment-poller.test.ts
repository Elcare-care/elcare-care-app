/**
 * royalty-payment-poller.test.ts
 *
 * Verifies processEvent() persists ROYALTY_PAID events as one RoyaltyPayment
 * row per breakdown recipient in a single createMany call (Issue #201).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0),
  },
  auction: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0),
  },
  royaltyPayment: {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  marketplaceEvent: { create: vi.fn().mockResolvedValue({}) },
}));

const mockInvalidatePattern = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../db', () => ({ default: mockPrisma }));
// poller.ts → prisma-write; provide the same mock to avoid real DB init
vi.mock('../prisma-write', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: { isReady: false, get: vi.fn(), setEx: vi.fn() },
  invalidatePattern: mockInvalidatePattern,
  invalidateKey: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/routes.js', () => ({ emitSSEEvent: vi.fn() }));
vi.mock('../ipfs-cache.js', () => ({ enqueueIpfsFetch: vi.fn().mockResolvedValue(undefined) }));

import { processEvent } from '../poller';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ARTIST = 'G' + 'ARTIST'.padEnd(55, 'A');
const COLLAB = 'G' + 'COLLAB'.padEnd(55, 'B');

// Matches parser output: bigints already stringified by convertBigInts.
const royaltyEvent = (data: Record<string, unknown>) => ({
  eventType: 'ROYALTY_PAID',
  listingId: BigInt(1),
  actor: '',
  ledgerSequence: 500,
  data,
  eventHash: `hash-${Math.random()}`,
  contractId: 'C',
  txHash: 'TX',
  eventIndex: 0,
});

describe('processEvent — ROYALTY_PAID', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one RoyaltyPayment row per recipient for a listing sale', async () => {
    await processEvent(
      royaltyEvent({
        listing_id: '1',
        auction_id: null,
        sale_price: '10000000',
        protocol_fee_amount: '500000',
        token: 'CTOKEN',
        recipients: [
          { address: ARTIST, amount: '6650000' },
          { address: COLLAB, amount: '2850000' },
        ],
        ledger_sequence: '500',
      }),
      undefined,
      true
    );

    expect(mockPrisma.royaltyPayment.createMany).toHaveBeenCalledTimes(1);
    const { data } = mockPrisma.royaltyPayment.createMany.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      listingId: BigInt(1),
      auctionId: null,
      recipient: ARTIST,
      amount: '6650000',
      salePrice: '10000000',
      ledgerSequence: 500,
    });
    expect(data[1]).toMatchObject({
      listingId: BigInt(1),
      auctionId: null,
      recipient: COLLAB,
      amount: '2850000',
    });
  });

  it('records auctionId (and null listingId) for an auction settlement', async () => {
    await processEvent(
      royaltyEvent({
        listing_id: null,
        auction_id: '9',
        sale_price: '2000000',
        protocol_fee_amount: '100000',
        token: 'CTOKEN',
        recipients: [{ address: ARTIST, amount: '1900000' }],
      }),
      undefined,
      true
    );

    const { data } = mockPrisma.royaltyPayment.createMany.mock.calls[0][0];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      listingId: null,
      auctionId: BigInt(9),
      recipient: ARTIST,
      amount: '1900000',
      salePrice: '2000000',
    });
  });

  it('does not write rows when the recipients vector is empty', async () => {
    await processEvent(
      royaltyEvent({
        listing_id: '1',
        auction_id: null,
        sale_price: '10000000',
        protocol_fee_amount: '0',
        token: 'CTOKEN',
        recipients: [],
      }),
      undefined,
      true
    );

    expect(mockPrisma.royaltyPayment.createMany).not.toHaveBeenCalled();
  });

  it('invalidates the royalty-breakdown cache for each recipient', async () => {
    await processEvent(
      royaltyEvent({
        listing_id: '1',
        auction_id: null,
        sale_price: '10000000',
        protocol_fee_amount: '0',
        token: 'CTOKEN',
        recipients: [
          { address: ARTIST, amount: '7000000' },
          { address: COLLAB, amount: '3000000' },
        ],
      }),
      undefined,
      true
    );

    const patterns = mockInvalidatePattern.mock.calls.map((c) => c[0]);
    expect(patterns).toContain(`cache:*/wallets/${ARTIST}/royalty-breakdown*`);
    expect(patterns).toContain(`cache:*/wallets/${COLLAB}/royalty-breakdown*`);
  });

  it('uses the transaction client when one is provided', async () => {
    const tx = {
      marketplaceEvent: { create: vi.fn().mockResolvedValue({}) },
      royaltyPayment: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await processEvent(
      royaltyEvent({
        listing_id: '1',
        auction_id: null,
        sale_price: '1000',
        protocol_fee_amount: '0',
        token: 'CTOKEN',
        recipients: [{ address: ARTIST, amount: '1000' }],
      }),
      tx,
      true
    );

    expect(tx.royaltyPayment.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.royaltyPayment.createMany).not.toHaveBeenCalled();
  });
});
