import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { cacheMiddleware } from '../../api/cache-middleware.js';
import { waitForRedisReady } from './helpers.js';

const prisma = new PrismaClient();

describe('cache integration', () => {
  let app: express.Express;
  let redis: Awaited<ReturnType<typeof waitForRedisReady>>;

  beforeAll(async () => {
    redis = await waitForRedisReady();
    await prisma.marketplaceEvent.deleteMany();
    await prisma.marketplaceEvent.create({
      data: {
        eventType: 'LISTING_CREATED',
        actor: 'GCACHEACTOR',
        data: { version: 'v1' },
        ledgerSequence: 100,
      },
    });

    app = express();
    app.get('/events', cacheMiddleware(30), async (_req, res) => {
      const rows = await prisma.marketplaceEvent.findMany({
        orderBy: { ledgerSequence: 'asc' },
      });
      res.json(rows);
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('serves the second request from Redis, not the database', async () => {
    const cacheKey = 'cache:/events';
    await redis.del(cacheKey);

    const first = await request(app).get('/events');
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(1);
    expect(first.body[0].data.version).toBe('v1');

    const cachedPayload = await redis.get(cacheKey);
    expect(cachedPayload).toBeTruthy();

    // Mutate the DB after the first response. If Redis is hit on the second
    // call, the response must still report `v1` (proving the cache served it).
    await prisma.marketplaceEvent.updateMany({
      where: { actor: 'GCACHEACTOR' },
      data: { data: { version: 'v2' } },
    });

    const second = await request(app).get('/events');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
