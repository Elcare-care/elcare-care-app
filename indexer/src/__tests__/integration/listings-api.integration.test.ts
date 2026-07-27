import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import router from '../../api/routes.js';
import { errorHandler } from '../../api/errors.js';
import { waitForRedisReady } from './helpers.js';

const prisma = new PrismaClient();

const COLLECTION = 'CAQBWUKVLOR5W43QBQDFJAHSE2LUGCALRDCM7EVEO36FTWOP5P2O36ML';

async function seed() {
  await prisma.bid.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.auction.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.marketplaceEvent.deleteMany();

  await prisma.collection.create({
    data: {
      contractAddress: COLLECTION,
      kind: 'normal_1155',
      creator: 'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F',
      name: 'African Heritage NFTs',
      symbol: 'AHT',
      deployedAtLedger: 1000,
    },
  });

  for (let i = 1; i <= 3; i += 1) {
    await prisma.listing.create({
      data: {
        listingId: BigInt(i),
        artist: `GARTIST${i}`,
        owner: `GOWNER${i}`,
        price: `1${i}0.0000000`,
        currency: 'XLM',
        collection: COLLECTION,
        nftTokenId: BigInt(i),
        token: 'native',
        status: i === 3 ? 'Sold' : 'Active',
        createdAtLedger: 1000 + i,
        updatedAtLedger: 1000 + i,
      },
    });
  }
}

describe('listings-api integration', () => {
  let app: express.Express;

  beforeAll(async () => {
    await waitForRedisReady();
    await seed();

    app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET /listings returns all seeded listings', async () => {
    const res = await request(app).get('/listings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    // Route orders by updatedAtLedger DESC, so highest listingId comes first.
    expect(res.body[0].listingId).toBe('3');
    expect(res.body.some((r: { listingId: string }) => r.listingId === '1')).toBe(true);
    expect(res.body.some((r: { status: string }) => r.status === 'Sold')).toBe(true);
  });

  it('GET /listings?limit=2&offset=0 paginates and reports total', async () => {
    const res = await request(app).get('/listings?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('listings');
    expect(res.body).toHaveProperty('total', 3);
    expect(res.body.listings).toHaveLength(2);
  });

  it('GET /collections returns seeded collection', async () => {
    const res = await request(app).get('/collections');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((c: { name: string }) => c.name === 'African Heritage NFTs')).toBe(true);
  });
});
