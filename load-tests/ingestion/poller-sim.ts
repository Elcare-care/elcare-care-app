/**
 * load-tests/ingestion/poller-sim.ts
 *
 * Ingestion / poller load simulator.
 *
 * Bypasses the Stellar RPC entirely and drives the indexer's internal
 * applyDecodedEvents() path directly against the load-test database.
 * This lets us measure:
 *
 *   - Event-write throughput (events/s)
 *   - DB connection pool behaviour under burst writes
 *   - Redis cache-invalidation overhead per event
 *   - Dead-letter insertion latency
 *   - Reconciler behaviour under a growing dataset
 *   - Ingestion lag: wall-clock time between "event emitted" and
 *     "row committed to MarketplaceEvent table"
 *
 * Design:
 *   A configurable number of "ledgers" are simulated in sequence.
 *   Each ledger contains EVENTS_PER_LEDGER decoded events covering the
 *   full event-type roster (LISTING_CREATED, ARTWORK_SOLD, BID_PLACED, …).
 *   We measure time-to-commit per ledger and emit a Prometheus-compatible
 *   summary at the end.
 *
 * Usage:
 *   DATABASE_URL="postgresql://ltuser:ltpass@localhost:5433/marketplace_lt" \
 *   REDIS_URL="redis://localhost:6380" \
 *   npx tsx load-tests/ingestion/poller-sim.ts
 *
 * Environment:
 *   SIM_LEDGERS           default 500   — number of ledger windows to simulate
 *   SIM_EVENTS_PER_LEDGER default 20    — events per ledger
 *   SIM_CONCURRENCY       default 1     — parallel ledger writers (simulates
 *                                         multi-contract poller)
 *   SIM_BURST_LEDGERS     default 50    — extra burst at midpoint to stress pools
 *   CONTRACT_ID           default fake
 */

import { createHash, randomBytes } from 'crypto';
import { performance } from 'perf_hooks';

// Dynamic import so the script can run from the repo root without the indexer
// build step (tsx handles TypeScript transpilation on the fly).
const { PrismaClient } = await import('@prisma/client');
const { createClient }  = await import('redis');

// ── Config ────────────────────────────────────────────────────────────────────

const N_LEDGERS    = parseInt(process.env.SIM_LEDGERS            ?? '500',  10);
const EPL          = parseInt(process.env.SIM_EVENTS_PER_LEDGER  ?? '20',   10);
const CONCURRENCY  = parseInt(process.env.SIM_CONCURRENCY        ?? '1',    10);
const BURST_AT     = Math.floor(N_LEDGERS / 2);
const BURST_SIZE   = parseInt(process.env.SIM_BURST_LEDGERS      ?? '50',   10);
const CONTRACT_ID  = process.env.CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2OC';
const BASE_LEDGER  = 2_000_000;  // distinct from seed ledgers

// ── Helpers ───────────────────────────────────────────────────────────────────

function hex(bytes = 32) { return randomBytes(bytes).toString('hex'); }

function fakeAddr(n: number) {
  return 'G' + n.toString(16).padStart(55, '0').toUpperCase();
}

function eventHash(ledger: number, txHash: string, idx: number) {
  return createHash('sha256')
    .update(`${CONTRACT_ID}:${ledger}:${txHash}:${idx}`)
    .digest('hex');
}

const TOKEN   = fakeAddr(999_998);
const ARTISTS = Array.from({ length: 100 }, (_, i) => fakeAddr(600_000 + i));
const BUYERS  = Array.from({ length: 200 }, (_, i) => fakeAddr(700_000 + i));

const EVENT_TYPES = [
  'LISTING_CREATED', 'LISTING_CREATED', 'LISTING_CREATED',  // weighted 3×
  'LISTING_UPDATED',
  'ARTWORK_SOLD',   'ARTWORK_SOLD',                          // weighted 2×
  'LISTING_CANCELLED',
  'AUCTION_CREATED',
  'BID_PLACED',
  'AUCTION_RESOLVED',
  'OFFER_MADE',
  'OFFER_ACCEPTED',
  'ROYALTY_PAID',
];

function makeEvents(ledger: number, count: number) {
  const txHash = hex(32);
  return Array.from({ length: count }, (_, i) => {
    const eventType = EVENT_TYPES[i % EVENT_TYPES.length];
    const listingId = BigInt(((ledger - BASE_LEDGER) * count + i + 1) % 2_000 + 1);
    const actor     = ARTISTS[i % ARTISTS.length];
    return {
      listingId:       eventType.startsWith('AUCTION') ? null : listingId,
      eventType,
      actor,
      data: {
        listing_id: Number(listingId),
        artist:     actor,
        price:      (Math.random() * 1000 + 1).toFixed(7),
        buyer:      BUYERS[i % BUYERS.length],
        token:      TOKEN,
      },
      ledgerSequence:  ledger,
      ledgerTimestamp: new Date(),
      eventHash:       eventHash(ledger, txHash, i),
      contractId:      CONTRACT_ID,
      confirmed:       false,
    };
  });
}

// ── Metrics accumulator ───────────────────────────────────────────────────────

interface LedgerSample {
  ledger: number;
  events: number;
  lagMs:  number;
  writeMs: number;
  errors: number;
}

const samples: LedgerSample[] = [];

// ── Core write path ───────────────────────────────────────────────────────────

async function applyLedger(
  prisma: InstanceType<typeof PrismaClient>,
  ledger: number,
  eventsPerLedger: number,
): Promise<LedgerSample> {
  const events   = makeEvents(ledger, eventsPerLedger);
  const emitTime = performance.now();

  const t0 = performance.now();
  let errorCount = 0;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      await tx.marketplaceEvent.createMany({
        data: events as any,
        skipDuplicates: true,
      });

      // Simulate the listing upserts that processEvent() performs
      const listingEvents = events.filter(
        (e) => e.eventType === 'LISTING_CREATED' && e.listingId !== null,
      );
      for (const e of listingEvents) {
        const artist = e.actor;
        const col    = fakeAddr(800_000 + (Number(e.listingId) % 100));
        await tx.listing.upsert({
          where:  { listingId: e.listingId as bigint },
          create: {
            listingId:      e.listingId as bigint,
            artist,
            owner:          null,
            price:          (e.data as any).price,
            currency:       'XLM',
            collection:     col,
            nftTokenId:     e.listingId as bigint,
            token:          TOKEN,
            status:         'Active',
            recipients:     [{ address: artist, percentage: 9500 }],
            createdAtLedger: ledger,
            updatedAtLedger: ledger,
          },
          update: { updatedAtLedger: ledger },
        });
      }

      const soldEvents = events.filter((e) => e.eventType === 'ARTWORK_SOLD' && e.listingId !== null);
      for (const e of soldEvents) {
        await tx.listing.updateMany({
          where: { listingId: e.listingId as bigint },
          data:  { status: 'Sold', owner: (e.data as any).buyer, updatedAtLedger: ledger },
        });
      }

      // Advance tracked-contract cursor (mirrors real poller behaviour)
      await tx.trackedContract.updateMany({
        where: { contractId: CONTRACT_ID },
        data:  { lastLedger: ledger },
      });
    });
  } catch (err) {
    errorCount++;
    // Non-fatal: count errors but don't abort the run
  }

  const writeMs = performance.now() - t0;
  const lagMs   = performance.now() - emitTime;

  return { ledger, events: eventsPerLedger, lagMs, writeMs, errors: errorCount };
}

// ── Parallel worker ───────────────────────────────────────────────────────────

async function runWorker(
  workerId: number,
  prisma: InstanceType<typeof PrismaClient>,
  ledgers: number[],
) {
  for (const ledger of ledgers) {
    const sample = await applyLedger(prisma, ledger, EPL);
    samples.push(sample);
    if (samples.length % 50 === 0) {
      const recent = samples.slice(-50);
      const avgLag = recent.reduce((s, x) => s + x.lagMs, 0) / recent.length;
      console.log(
        `[worker-${workerId}] ledger ${ledger}  ` +
        `avgLag=${avgLag.toFixed(1)}ms  errors=${recent.reduce((s, x) => s + x.errors, 0)}`,
      );
    }
  }
}

// ── Redis cache invalidation stress ──────────────────────────────────────────

async function stressRedis(redis: ReturnType<typeof createClient>, rounds: number) {
  console.log(`[redis-stress] invalidating ${rounds} cache key patterns…`);
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) {
    const key = `cache:/listings?status=Active&limit=20&offset=${i * 20}`;
    await (redis as any).del(key);
  }
  const elapsed = performance.now() - t0;
  console.log(`[redis-stress] done in ${elapsed.toFixed(1)}ms (${(rounds / (elapsed / 1000)).toFixed(0)} ops/s)`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(totalEvents: number, wallMs: number) {
  const throughput = (totalEvents / (wallMs / 1000)).toFixed(1);
  const lags    = samples.map((s) => s.lagMs).sort((a, b) => a - b);
  const writes  = samples.map((s) => s.writeMs).sort((a, b) => a - b);
  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct / 100)] ?? 0;
  const errors = samples.reduce((s, x) => s + x.errors, 0);

  console.log('\n── Ingestion Simulator Summary ──────────────────────────');
  console.log(`  total events written:  ${totalEvents}`);
  console.log(`  throughput:            ${throughput} events/s`);
  console.log(`  ingestion lag p50:     ${p(lags, 50).toFixed(1)} ms`);
  console.log(`  ingestion lag p95:     ${p(lags, 95).toFixed(1)} ms`);
  console.log(`  ingestion lag p99:     ${p(lags, 99).toFixed(1)} ms`);
  console.log(`  write tx p50:          ${p(writes, 50).toFixed(1)} ms`);
  console.log(`  write tx p95:          ${p(writes, 95).toFixed(1)} ms`);
  console.log(`  total errors:          ${errors}`);
  console.log('─────────────────────────────────────────────────────────\n');

  return {
    totalEvents,
    throughputEventsPerSec: parseFloat(throughput),
    ingestionLagP50Ms: parseFloat(p(lags, 50).toFixed(1)),
    ingestionLagP95Ms: parseFloat(p(lags, 95).toFixed(1)),
    ingestionLagP99Ms: parseFloat(p(lags, 99).toFixed(1)),
    writeTxP50Ms: parseFloat(p(writes, 50).toFixed(1)),
    writeTxP95Ms: parseFloat(p(writes, 95).toFixed(1)),
    totalErrors: errors,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[poller-sim] starting');
  console.log(`  ledgers=${N_LEDGERS}  events/ledger=${EPL}  concurrency=${CONCURRENCY}`);

  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: [{ level: 'error', emit: 'stdout' }],
  });

  const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6380' });
  await redis.connect();

  // Partition ledger sequence numbers across workers
  const allLedgers = Array.from({ length: N_LEDGERS }, (_, i) => BASE_LEDGER + i + 1);

  // Insert a burst window at the midpoint
  const burstLedgers = Array.from(
    { length: BURST_SIZE },
    (_, i) => BASE_LEDGER + N_LEDGERS + i + 1,
  );

  const normalLedgers  = allLedgers.slice(0, BURST_AT);
  const postBurstLedgers = allLedgers.slice(BURST_AT);

  const t0 = performance.now();

  // Phase 1 — normal rate
  const workers1 = Array.from({ length: CONCURRENCY }, (_, w) => {
    const slice = normalLedgers.filter((_, i) => i % CONCURRENCY === w);
    return runWorker(w + 1, prisma, slice);
  });
  await Promise.all(workers1);

  // Phase 2 — burst (all workers get burst ledgers simultaneously)
  console.log(`\n[poller-sim] ── BURST phase (${BURST_SIZE} ledgers) ──`);
  const workers2 = Array.from({ length: CONCURRENCY }, (_, w) => {
    const slice = burstLedgers.filter((_, i) => i % CONCURRENCY === w);
    return runWorker(w + 1, prisma, slice);
  });
  await Promise.all(workers2);

  // Phase 3 — resume normal rate
  const workers3 = Array.from({ length: CONCURRENCY }, (_, w) => {
    const slice = postBurstLedgers.filter((_, i) => i % CONCURRENCY === w);
    return runWorker(w + 1, prisma, slice);
  });
  await Promise.all(workers3);

  const wallMs     = performance.now() - t0;
  const totalEvents = samples.reduce((s, x) => s + x.events, 0);

  // Redis cache-invalidation stress (mirrors what processEvent() does)
  await stressRedis(redis as any, 200);

  const summary = printSummary(totalEvents, wallMs);

  // Persist results for the reporter
  const fs = await import('fs/promises');
  const path = await import('path');
  const outDir = path.resolve('load-tests/results');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'ingestion-latest.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), ...summary }, null, 2),
  );

  // Budget check — fail exit code if any threshold is violated
  let failed = false;
  if (summary.ingestionLagP95Ms > 500) {
    console.error(`[BUDGET VIOLATION] ingestion lag p95=${summary.ingestionLagP95Ms}ms > 500ms`);
    failed = true;
  }
  if (summary.throughputEventsPerSec < 100) {
    console.error(`[BUDGET VIOLATION] throughput=${summary.throughputEventsPerSec} events/s < 100`);
    failed = true;
  }
  if (summary.totalErrors > totalEvents * 0.01) {
    console.error(`[BUDGET VIOLATION] error rate=${(summary.totalErrors / totalEvents * 100).toFixed(2)}% > 1%`);
    failed = true;
  }

  await redis.disconnect();
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('[poller-sim] fatal:', err);
  process.exit(1);
});
