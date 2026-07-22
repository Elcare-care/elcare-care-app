import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { revertLedgers } from '../../poller.js';

const prisma = new PrismaClient();

const SAFE_LEDGER = 100;

async function seed() {
  await prisma.bid.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.auction.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.marketplaceEvent.deleteMany();
  await prisma.syncState.deleteMany();

  await prisma.syncState.create({
    data: { id: 1, lastLedger: 150, lastLedgerHash: 'canonical' },
  });

  // Listing A: created before the safe ledger — must survive unchanged.
  await prisma.listing.create({
    data: {
      listingId: 1n,
      artist: 'GA',
      price: '10.0000000',
      currency: 'XLM',
      collection: 'CC',
      nftTokenId: 1n,
      token: 'native',
      status: 'Active',
      createdAtLedger: 50,
      updatedAtLedger: 50,
    },
  });

  // Listing B: created after the safe ledger — must be deleted.
  await prisma.listing.create({
    data: {
      listingId: 2n,
      artist: 'GB',
      price: '20.0000000',
      currency: 'XLM',
      collection: 'CC',
      nftTokenId: 2n,
      token: 'native',
      status: 'Active',
      createdAtLedger: 150,
      updatedAtLedger: 160,
    },
  });

  // Listing C: created before, but its status changed after — must be rolled
  // back to Active with updatedAtLedger = safe ledger.
  await prisma.listing.create({
    data: {
      listingId: 3n,
      artist: 'GC',
      price: '30.0000000',
      currency: 'XLM',
      collection: 'CC',
      nftTokenId: 3n,
      token: 'native',
      status: 'Sold',
      createdAtLedger: 60,
      updatedAtLedger: 180,
    },
  });

  // Event before safe ledger — survives. Event after — deleted.
  await prisma.marketplaceEvent.create({
    data: {
      eventType: 'LISTING_CREATED',
      actor: 'GA',
      data: {},
      ledgerSequence: 50,
      eventHash: 'seed-before-safe',
    },
  });
  await prisma.marketplaceEvent.create({
    data: {
      eventType: 'ARTWORK_SOLD',
      actor: 'GC',
      data: {},
      ledgerSequence: 180,
      eventHash: 'seed-after-safe',
    },
  });

  // Collection deployed after safe ledger — must be deleted.
  await prisma.collection.create({
    data: {
      contractAddress: 'CAFTER',
      kind: 'normal_721',
      creator: 'GA',
      deployedAtLedger: 150,
    },
  });
}

describe('reorg integration', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reverts SyncState to the safe ledger with a null hash', async () => {
    await revertLedgers(SAFE_LEDGER);
    const state = await prisma.syncState.findUnique({ where: { id: 1 } });
    expect(state?.lastLedger).toBe(SAFE_LEDGER);
    expect(state?.lastLedgerHash).toBeNull();
  });

  it('deletes listings and events created after the safe ledger', async () => {
    await revertLedgers(SAFE_LEDGER);
    const listings = await prisma.listing.findMany({ orderBy: { listingId: 'asc' } });
    expect(listings.map((l) => l.listingId.toString())).toEqual(['1', '3']);

    const events = await prisma.marketplaceEvent.findMany({ orderBy: { ledgerSequence: 'asc' } });
    expect(events).toHaveLength(1);
    expect(events[0].ledgerSequence).toBe(50);
  });

  it('rolls back status changes for listings updated after the safe ledger', async () => {
    await revertLedgers(SAFE_LEDGER);
    const listing = await prisma.listing.findUnique({ where: { listingId: 3n } });
    expect(listing?.status).toBe('Active');
    expect(listing?.updatedAtLedger).toBe(SAFE_LEDGER);
  });

  it('deletes collections deployed after the safe ledger', async () => {
    await revertLedgers(SAFE_LEDGER);
    const collections = await prisma.collection.findMany();
    expect(collections).toHaveLength(0);
  });
});
