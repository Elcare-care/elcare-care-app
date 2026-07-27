import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { PrismaClient } from '@prisma/client';
import prisma from '../../db.js';
import { parseMarketplaceEvent } from '../../parser.js';
import { applyDecodedEvents } from '../../poller.js';

const reader = new PrismaClient();

const ARTIST = 'GARTIST';
const COLLECTION = 'CC';
const CONTRACT_ID = 'CCONTRACT';

function encodeSymbol(symbol: string): string {
  return nativeToScVal(symbol, { type: 'symbol' }).toXDR('base64');
}

function encodeMap(value: Record<string, unknown>): string {
  // Force bigint fields to be encoded as u128/u64 — nativeToScVal infers from JS bigint.
  return nativeToScVal(value, { type: 'map' }).toXDR('base64');
}

async function parseAndApply(
  topic: string,
  value: Record<string, unknown>,
  ledger: number,
  eventIndex = 0
) {
  const decoded = parseMarketplaceEvent(
    [encodeSymbol(topic)],
    encodeMap(value),
    ledger,
    CONTRACT_ID,
    'tx-' + ledger,
    eventIndex
  );
  if (!decoded) throw new Error(`failed to decode event ${topic}`);

  // Sanity check the parser round-trips via real XDR (no mocks).
  expect(decoded.eventType).toBeTruthy();
  expect(decoded.eventHash).toBeTruthy();

  const inserted = await prisma.$transaction(async (tx) => applyDecodedEvents([decoded], tx));
  return { decoded, inserted };
}

describe('parser integration', () => {
  beforeAll(async () => {
    await reader.$connect();
  });

  beforeEach(async () => {
    await reader.bid.deleteMany();
    await reader.offer.deleteMany();
    await reader.auction.deleteMany();
    await reader.listing.deleteMany();
    await reader.collection.deleteMany();
    await reader.marketplaceEvent.deleteMany();
  });

  afterAll(async () => {
    await reader.$disconnect();
  });

  it('writes a Listing row and a MarketplaceEvent row for LISTING_CREATED', async () => {
    const { inserted } = await parseAndApply(
      'listing_created',
      {
        listing_id: 101n,
        artist: ARTIST,
        price: 100n,
        currency: 'USDC',
        collection: COLLECTION,
        token_id: 1n,
        token: 'native',
      },
      500
    );
    expect(inserted).toHaveLength(1);

    const listing = await reader.listing.findUnique({ where: { listingId: 101n } });
    expect(listing).not.toBeNull();
    expect(listing?.artist).toBe(ARTIST);
    expect(listing?.collection).toBe(COLLECTION);
    expect(listing?.status).toBe('Active');
    expect(listing?.createdAtLedger).toBe(500);

    const events = await reader.marketplaceEvent.findMany({
      where: { listingId: 101n },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('LISTING_CREATED');
    expect(events[0].actor).toBe(ARTIST);
    expect(events[0].ledgerSequence).toBe(500);
    expect(events[0].contractId).toBe(CONTRACT_ID);
  });

  it('transitions a listing to Sold on ARTWORK_SOLD', async () => {
    // Seed a listing first — ARTWORK_SOLD is an update, not an insert.
    await reader.listing.create({
      data: {
        listingId: 202n,
        artist: ARTIST,
        price: '100.0000000',
        currency: 'USDC',
        collection: COLLECTION,
        nftTokenId: 1n,
        token: 'native',
        status: 'Active',
        createdAtLedger: 100,
        updatedAtLedger: 100,
      },
    });

    const { decoded } = await parseAndApply(
      'artwork_sold',
      { listing_id: 202n, buyer: 'GBUYER', price: 200n },
      600
    );
    expect(decoded.eventType).toBe('ARTWORK_SOLD');

    const listing = await reader.listing.findUnique({ where: { listingId: 202n } });
    expect(listing?.status).toBe('Sold');
    expect(listing?.owner).toBe('GBUYER');
    expect(listing?.updatedAtLedger).toBe(600);
  });

  it('writes an Offer row for OFFER_MADE', async () => {
    await parseAndApply(
      'offer_made',
      {
        offer_id: 301n,
        listing_id: 202n,
        offerer: 'GOFFERER',
        amount: 150n,
        token: 'native',
      },
      700
    );

    const offer = await reader.offer.findUnique({ where: { offerId: 301n } });
    expect(offer).not.toBeNull();
    expect(offer?.offerer).toBe('GOFFERER');
    expect(offer?.status).toBe('Pending');
    expect(offer?.token).toBe('native');
  });
});
