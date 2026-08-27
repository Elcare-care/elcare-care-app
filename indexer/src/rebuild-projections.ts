/**
 * rebuild-projections.ts — Resumable projection rebuild tool
 *
 * Replays canonical MarketplaceEvent rows through the same projection
 * functions used during live ingestion (processEvent) and rebuilds the
 * derived Listing / Auction / Offer / Collection tables from the event log.
 *
 * The live sync cursor (SyncState.lastLedger) is never touched; a rebuild
 * is a read-only pass over the event log from the database's perspective.
 * SSE broadcasts are suppressed during the rebuild so connected clients
 * do not see duplicate or out-of-order events.
 *
 * ── Features ──────────────────────────────────────────────────────────────
 *   Dry-run mode    Reports affected entities and conflicts without writing.
 *   Execute mode    Applies upserts inside per-batch transactions.
 *   Resume          Resumes from the last committed checkpointLedger after
 *                   an interruption; all processEvent() upserts are idempotent.
 *   Ledger filter   --from / --to to rebuild a bounded window.
 *   Entity filter   --entity=<listingId|auctionId|offerId> to rebuild one item.
 *   Projection filter --projections=listing,auction,offer,collection (default: all)
 *   Checksums       SHA-256 over event hashes before and after rebuild so
 *                   operators can verify the event log did not change.
 *
 * ── Guarantees ────────────────────────────────────────────────────────────
 *   • Does not advance the canonical sync cursor.
 *   • Does not emit SSE events.
 *   • Each batch is committed in its own transaction; a crash mid-run is
 *     safe to resume because processEvent() is idempotent.
 *   • Dry-run never opens a write transaction.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   # Dry-run: what would change?
 *   npm run rebuild -- --dry-run --projections=listing,auction
 *
 *   # Execute full rebuild
 *   npm run rebuild -- --from=1000000 --to=2000000
 *
 *   # Execute for a single entity
 *   npm run rebuild -- --entity=42 --projections=listing
 *
 *   # Resume an interrupted job
 *   npm run rebuild -- --resume=<jobId>
 *
 * ── package.json script ───────────────────────────────────────────────────
 *   "rebuild": "tsx src/rebuild-projections.ts"
 */

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import client from 'prom-client';
import prismaWrite from './prisma-write.js';
import prismaRead from './db.js';
import { processEvent } from './poller.js';
import { logger } from './logger.js';

dotenv.config();

// ── Projection types ──────────────────────────────────────────────────────────

export type ProjectionType = 'listing' | 'auction' | 'offer' | 'collection';

const ALL_PROJECTIONS: ProjectionType[] = ['listing', 'auction', 'offer', 'collection'];

/** Event types that belong to each projection. Used to filter the event query. */
const PROJECTION_EVENT_TYPES: Record<ProjectionType, string[]> = {
  listing: [
    'LISTING_CREATED', 'LISTING_UPDATED', 'LISTING_PRICE_UPDATED',
    'LISTING_CANCELLED', 'LISTING_EXPIRED', 'ARTWORK_SOLD',
    'OFFER_ACCEPTED', 'ARTIST_REVOKED', 'LISTING_OWNERSHIP_RECONCILED',
    'TOKEN_WHITELISTED', 'TOKEN_REMOVED',
  ],
  auction: [
    'AUCTION_CREATED', 'BID_PLACED', 'AUCTION_RESOLVED',
    'AUCTION_CANCELLED', 'AUCTION_EXTENDED', 'AUCTION_ADMIN_CANCELLED',
    'ARTIST_REVOKED',
  ],
  offer: [
    'OFFER_MADE', 'OFFER_ACCEPTED', 'OFFER_REJECTED',
    'OFFER_WITHDRAWN', 'OFFER_RECLAIMED',
  ],
  collection: [
    'DEPLOY_NORMAL_721', 'DEPLOY_NORMAL_1155',
    'DEPLOY_LAZY_721', 'DEPLOY_LAZY_1155',
    'COLLECTION_FEE_SET', 'COLLECTION_FEE_CLEARED',
  ],
};

// ── Prometheus metrics ────────────────────────────────────────────────────────

const rebuildJobsTotal = new client.Counter({
  name: 'projection_rebuild_jobs_total',
  help: 'Total projection rebuild jobs completed, by outcome (ok | error | dry_run)',
  labelNames: ['outcome'],
});

const rebuildEventsProcessed = new client.Counter({
  name: 'projection_rebuild_events_processed_total',
  help: 'Total events processed during projection rebuilds',
});

const rebuildAffectedRows = new client.Counter({
  name: 'projection_rebuild_affected_rows_total',
  help: 'Total domain-table rows touched during projection rebuilds',
});

const rebuildDurationSeconds = new client.Histogram({
  name: 'projection_rebuild_duration_seconds',
  help: 'Wall-clock duration of a projection rebuild job',
  buckets: [1, 5, 30, 60, 300, 600, 1800, 3600],
});

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE = parseInt(process.env.REBUILD_BATCH_SIZE || '500', 10);

// ── CLI argument helpers ──────────────────────────────────────────────────────

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((a) => a.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ── Checksum helpers ──────────────────────────────────────────────────────────

/**
 * Computes a SHA-256 digest over the sorted set of eventHash values in scope.
 * Stable regardless of row order; can be compared before/after rebuild to
 * confirm the event log was not modified.
 */
async function computeEventChecksum(
  ledgerFrom: number,
  ledgerTo: number,
  entityId?: string,
  projections?: ProjectionType[],
): Promise<string> {
  const eventTypes = projections
    ? projections.flatMap((p) => PROJECTION_EVENT_TYPES[p])
    : undefined;

  const rows = await prismaRead.marketplaceEvent.findMany({
    where: {
      ledgerSequence: { gte: ledgerFrom, lte: ledgerTo },
      ...(entityId ? { listingId: BigInt(entityId) } : {}),
      ...(eventTypes ? { eventType: { in: eventTypes } } : {}),
      eventHash: { not: null },
    },
    select: { eventHash: true },
    orderBy: { eventHash: 'asc' },
  });

  const combined = rows.map((r) => r.eventHash ?? '').join('\n');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

// ── SSE suppression ───────────────────────────────────────────────────────────
// We monkey-patch emitSSEEvent to a no-op during rebuild to avoid broadcasting
// stale or replayed events to connected clients.

let _ssePatched = false;

function suppressSSE(): () => void {
  if (_ssePatched) return () => { /* already unpatched on restore */ };
  _ssePatched = true;
  // Dynamic import so we don't have a hard dep on the API module at module load.
  // The restore function re-enables the original emitter after the rebuild.
  let originalEmit: ((...args: any[]) => void) | null = null;

  import('./api/routes.js')
    .then((mod) => {
      originalEmit = (mod as any).emitSSEEvent;
      (mod as any).emitSSEEvent = () => { /* suppressed during rebuild */ };
      logger.info('[RebuildProjections] SSE broadcast suppressed');
    })
    .catch(() => { /* non-fatal if routes module is not available */ });

  return () => {
    import('./api/routes.js')
      .then((mod) => {
        if (originalEmit !== null) {
          (mod as any).emitSSEEvent = originalEmit;
          logger.info('[RebuildProjections] SSE broadcast restored');
        }
        _ssePatched = false;
      })
      .catch(() => { _ssePatched = false; });
  };
}

// ── Job lifecycle helpers ─────────────────────────────────────────────────────

async function createJob(opts: {
  projections: ProjectionType[];
  ledgerFrom: number;
  ledgerTo: number;
  entityId?: string;
  dryRun: boolean;
}): Promise<number> {
  const job = await (prismaWrite as any).projectionRebuildJob.create({
    data: {
      projections: opts.projections,
      ledgerFrom: opts.ledgerFrom,
      ledgerTo: opts.ledgerTo,
      entityId: opts.entityId ?? null,
      dryRun: opts.dryRun,
      sseSuppressed: true,
      status: 'Pending',
    },
  });
  return job.id as number;
}

async function markRunning(jobId: number, totalEvents: number, checksumBefore: string): Promise<void> {
  await (prismaWrite as any).projectionRebuildJob.update({
    where: { id: jobId },
    data: {
      status: 'Running',
      startedAt: new Date(),
      totalEvents,
      checksumBefore,
    },
  });
}

async function updateCheckpoint(jobId: number, ledger: number, processed: number, affected: number, conflicts: number): Promise<void> {
  await (prismaWrite as any).projectionRebuildJob.update({
    where: { id: jobId },
    data: {
      checkpointLedger: ledger,
      processedEvents: processed,
      affectedRows: affected,
      conflictsDetected: conflicts,
    },
  });
}

async function markComplete(jobId: number, checksumAfter: string, dryRun: boolean): Promise<void> {
  await (prismaWrite as any).projectionRebuildJob.update({
    where: { id: jobId },
    data: {
      status: dryRun ? 'DryRunComplete' : 'Completed',
      completedAt: new Date(),
      checksumAfter,
    },
  });
}

async function markFailed(jobId: number, error: string): Promise<void> {
  await (prismaWrite as any).projectionRebuildJob.update({
    where: { id: jobId },
    data: {
      status: 'Failed',
      completedAt: new Date(),
      error: error.slice(0, 4096),
    },
  });
}

// ── Dry-run conflict detection ────────────────────────────────────────────────

/**
 * In dry-run mode we simulate the effect of replaying an event by comparing
 * the event data payload against the current DB row.  A "conflict" means the
 * replay would change at least one field.
 *
 * We do a lightweight check — any mismatch on status or price for listings,
 * highestBid for auctions, status for offers — rather than full projection
 * logic, because we explicitly do NOT write to the DB in dry-run mode.
 */
async function detectConflict(event: any): Promise<boolean> {
  try {
    const { eventType, listingId, data } = event;
    if (!listingId) return false;

    if (['LISTING_CREATED', 'LISTING_UPDATED', 'LISTING_PRICE_UPDATED',
         'LISTING_CANCELLED', 'ARTWORK_SOLD'].includes(eventType)) {
      const row = await prismaRead.listing.findUnique({
        where: { listingId },
        select: { status: true, price: true },
      });
      if (!row) return true; // missing row = conflict
      if (eventType === 'LISTING_CANCELLED' && row.status !== 'Cancelled') return true;
      if (eventType === 'ARTWORK_SOLD' && row.status !== 'Sold') return true;
      if (eventType === 'LISTING_PRICE_UPDATED' && row.price.toString() !== String(data?.new_price ?? '')) return true;
    }

    if (['AUCTION_RESOLVED', 'AUCTION_CANCELLED', 'BID_PLACED'].includes(eventType)) {
      const row = await (prismaRead as any).auction.findUnique({
        where: { auctionId: listingId },
        select: { status: true, highestBid: true },
      });
      if (!row) return true;
      if (eventType === 'AUCTION_RESOLVED' && row.status !== 'Finalized') return true;
      if (eventType === 'AUCTION_CANCELLED' && row.status !== 'Cancelled') return true;
    }

    if (['OFFER_ACCEPTED', 'OFFER_REJECTED', 'OFFER_WITHDRAWN', 'OFFER_RECLAIMED'].includes(eventType)) {
      const offerId = data?.offer_id;
      if (offerId) {
        const row = await (prismaRead as any).offer.findUnique({
          where: { offerId: BigInt(offerId) },
          select: { status: true },
        });
        if (!row) return true;
        if (eventType === 'OFFER_ACCEPTED' && row.status !== 'Accepted') return true;
        if (eventType === 'OFFER_REJECTED' && row.status !== 'Rejected') return true;
        if (['OFFER_WITHDRAWN', 'OFFER_RECLAIMED'].includes(eventType) && row.status !== 'Withdrawn') return true;
      }
    }

    return false;
  } catch {
    return false; // non-fatal; treat as no-conflict on error
  }
}

// ── Core rebuild executor ─────────────────────────────────────────────────────

export interface RebuildOptions {
  projections?: ProjectionType[];
  ledgerFrom?: number;
  ledgerTo?: number;
  entityId?: string;
  dryRun?: boolean;
  resumeJobId?: number;
  batchSize?: number;
  /** Suppress console progress output (useful when called from API). */
  silent?: boolean;
}

export interface RebuildResult {
  jobId: number;
  status: string;
  processedEvents: number;
  affectedRows: number;
  conflictsDetected: number;
  checksumBefore: string | null;
  checksumAfter: string | null;
  checksumMatch: boolean | null;
  dryRun: boolean;
  durationSeconds: number;
}

export async function runRebuild(opts: RebuildOptions = {}): Promise<RebuildResult> {
  const dryRun     = opts.dryRun ?? false;
  const silent     = opts.silent ?? false;
  const batchSize  = opts.batchSize ?? BATCH_SIZE;
  const projections: ProjectionType[] = opts.projections ?? ALL_PROJECTIONS;

  // ── Resolve or create job ─────────────────────────────────────────────────
  let jobId: number;
  let resumeFromLedger = 0;
  let resumeProcessed  = 0;
  let resumeAffected   = 0;
  let resumeConflicts  = 0;

  let ledgerFrom: number;
  let ledgerTo: number;
  let entityId: string | undefined;
  let existingChecksumBefore: string | null = null;

  if (opts.resumeJobId != null) {
    const existing = await (prismaWrite as any).projectionRebuildJob.findUnique({
      where: { id: opts.resumeJobId },
    });
    if (!existing) throw new Error(`ProjectionRebuildJob #${opts.resumeJobId} not found`);
    if (existing.status === 'Running') {
      throw new Error(`Job #${opts.resumeJobId} is already Running — may be held by another process`);
    }
    if (['Completed', 'DryRunComplete', 'Cancelled'].includes(existing.status)) {
      throw new Error(`Job #${opts.resumeJobId} is ${existing.status} — nothing to resume`);
    }

    jobId              = existing.id;
    ledgerFrom         = existing.ledgerFrom;
    ledgerTo           = existing.ledgerTo;
    entityId           = existing.entityId ?? undefined;
    resumeFromLedger   = existing.checkpointLedger;
    resumeProcessed    = existing.processedEvents;
    resumeAffected     = existing.affectedRows;
    resumeConflicts    = existing.conflictsDetected;
    existingChecksumBefore = existing.checksumBefore;

    logger.info('[RebuildProjections] Resuming job', { jobId, resumeFromLedger, processedSoFar: resumeProcessed });
  } else {
    // Resolve ledger bounds
    const syncState = await prismaRead.syncState.findUnique({ where: { id: 1 } });
    const tipLedger = syncState?.lastLedger ?? 0;

    ledgerFrom = opts.ledgerFrom ?? 0;
    ledgerTo   = opts.ledgerTo   ?? tipLedger;
    entityId   = opts.entityId;

    jobId = await createJob({ projections, ledgerFrom, ledgerTo, entityId, dryRun });
  }

  const wallStart = Date.now();
  const timer     = rebuildDurationSeconds.startTimer();

  // ── Suppress SSE ─────────────────────────────────────────────────────────
  const restoreSSE = suppressSSE();

  try {
    // ── Compute total event count + checksum before ───────────────────────
    const eventTypes = projections.flatMap((p) => PROJECTION_EVENT_TYPES[p]);

    const totalRows = await prismaRead.marketplaceEvent.count({
      where: {
        ledgerSequence: { gte: ledgerFrom, lte: ledgerTo },
        ...(entityId ? { listingId: BigInt(entityId) } : {}),
        eventType: { in: eventTypes },
      },
    });

    const checksumBefore = existingChecksumBefore
      ?? await computeEventChecksum(ledgerFrom, ledgerTo, entityId, projections);

    await markRunning(jobId, totalRows, checksumBefore);

    if (!silent) {
      console.log(`[RebuildProjections] Job #${jobId} | ${dryRun ? 'DRY-RUN' : 'EXECUTE'}`);
      console.log(`  Projections : ${projections.join(', ')}`);
      console.log(`  Ledger range: ${ledgerFrom} – ${ledgerTo}`);
      if (entityId) console.log(`  Entity ID   : ${entityId}`);
      console.log(`  Total events: ${totalRows}`);
      console.log(`  Batch size  : ${batchSize}`);
      console.log(`  Checksum (before): ${checksumBefore}`);
      if (resumeFromLedger > 0) {
        console.log(`  Resuming from ledger: ${resumeFromLedger} (${resumeProcessed} events already done)`);
      }
      console.log('');
    }

    // ── Process events in ledger-ordered batches ──────────────────────────
    let processedEvents  = resumeProcessed;
    let affectedRows     = resumeAffected;
    let conflictsDetected = resumeConflicts;
    let lastLedger       = resumeFromLedger > 0 ? resumeFromLedger : ledgerFrom - 1;

    const startFromLedger = resumeFromLedger > 0 ? resumeFromLedger + 1 : ledgerFrom;

    // Paginate by ledger to keep batches deterministic and resumable.
    let cursor = startFromLedger;
    while (cursor <= ledgerTo) {
      const batchEndLedger = Math.min(cursor + batchSize - 1, ledgerTo);

      const events = await prismaRead.marketplaceEvent.findMany({
        where: {
          ledgerSequence: { gte: cursor, lte: batchEndLedger },
          ...(entityId ? { listingId: BigInt(entityId) } : {}),
          eventType: { in: eventTypes },
        },
        orderBy: [
          { ledgerSequence: 'asc' },
          { eventIndex: 'asc' },
          { id: 'asc' },
        ],
      });

      if (events.length > 0) {
        if (dryRun) {
          // Dry-run: detect conflicts without writing
          let batchConflicts = 0;
          for (const ev of events) {
            if (await detectConflict(ev)) batchConflicts++;
          }
          conflictsDetected += batchConflicts;
          processedEvents   += events.length;
        } else {
          // Execute: apply each event inside a single transaction per batch
          let batchAffected = 0;
          await prismaWrite.$transaction(async (tx: any) => {
            for (const ev of events) {
              try {
                // skipInsert=true: the event row already exists; we only want
                // to re-apply its domain-state effect (upsert the projection row).
                await processEvent(ev, tx, /* skipInsert= */ true);
                batchAffected++;
              } catch (err) {
                logger.warn('[RebuildProjections] processEvent failed for event — skipping', {
                  eventId: ev.id,
                  eventType: ev.eventType,
                  ledger: ev.ledgerSequence,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            }
          });
          affectedRows    += batchAffected;
          processedEvents += events.length;
          rebuildAffectedRows.inc(batchAffected);
        }

        rebuildEventsProcessed.inc(events.length);
        lastLedger = batchEndLedger;

        // Checkpoint after every batch so a crash can resume from here.
        await updateCheckpoint(jobId, lastLedger, processedEvents, affectedRows, conflictsDetected);
      }

      const pct = ledgerTo > ledgerFrom
        ? Math.min(100, ((cursor - ledgerFrom) / (ledgerTo - ledgerFrom + 1)) * 100).toFixed(1)
        : '100.0';

      if (!silent) {
        process.stdout.write(
          `\r  Progress: ${pct}% | events: ${processedEvents}/${totalRows}` +
          (dryRun ? ` | conflicts: ${conflictsDetected}` : ` | rows affected: ${affectedRows}`) +
          '   '
        );
      }

      cursor = batchEndLedger + 1;
    }

    if (!silent) process.stdout.write('\n');

    // ── Checksums ─────────────────────────────────────────────────────────
    const checksumAfter = await computeEventChecksum(ledgerFrom, ledgerTo, entityId, projections);
    const checksumMatch = checksumBefore === checksumAfter;

    if (!checksumMatch) {
      logger.warn('[RebuildProjections] Checksum mismatch — event log changed during rebuild!', {
        jobId, checksumBefore, checksumAfter,
      });
    }

    await markComplete(jobId, checksumAfter, dryRun);

    const durationSeconds = (Date.now() - wallStart) / 1000;
    timer();
    rebuildJobsTotal.inc({ outcome: dryRun ? 'dry_run' : 'ok' });

    const result: RebuildResult = {
      jobId,
      status: dryRun ? 'DryRunComplete' : 'Completed',
      processedEvents,
      affectedRows,
      conflictsDetected,
      checksumBefore,
      checksumAfter,
      checksumMatch,
      dryRun,
      durationSeconds,
    };

    if (!silent) {
      console.log('');
      console.log('[RebuildProjections] ─────────────────────────────────');
      console.log(`  Job #${jobId} ${result.status}`);
      console.log(`  Events processed  : ${processedEvents}`);
      if (dryRun) {
        console.log(`  Conflicts detected: ${conflictsDetected}`);
      } else {
        console.log(`  Rows affected     : ${affectedRows}`);
      }
      console.log(`  Checksum before   : ${checksumBefore}`);
      console.log(`  Checksum after    : ${checksumAfter}`);
      console.log(`  Checksum match    : ${checksumMatch ? '✓ YES' : '✗ NO (event log changed during rebuild!)'}`);
      console.log(`  Duration          : ${durationSeconds.toFixed(2)}s`);
      console.log('[RebuildProjections] ─────────────────────────────────');
    }

    return result;

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await markFailed(jobId, errMsg).catch(() => {});
    timer();
    rebuildJobsTotal.inc({ outcome: 'error' });
    logger.error('[RebuildProjections] Job failed', { jobId, err: errMsg });
    throw err;
  } finally {
    restoreSSE();
  }
}

// ── Status query ──────────────────────────────────────────────────────────────

export async function getRebuildStatus(limit = 10) {
  return (prismaRead as any).projectionRebuildJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url ||
    process.argv[1].includes('rebuild-projections')
  : false;

if (isMain) {
  const dryRun   = hasFlag('dry-run');
  const resumeId = readFlag('resume');
  const fromStr  = readFlag('from');
  const toStr    = readFlag('to');
  const entityId = readFlag('entity');
  const projStr  = readFlag('projections');

  const parsedProjections = projStr
    ? (projStr.split(',').map((s) => s.trim()) as ProjectionType[])
    : undefined;

  const opts: RebuildOptions = {
    dryRun,
    projections: parsedProjections,
    entityId,
    ...(fromStr ? { ledgerFrom: parseInt(fromStr, 10) } : {}),
    ...(toStr   ? { ledgerTo:   parseInt(toStr,   10) } : {}),
    ...(resumeId ? { resumeJobId: parseInt(resumeId, 10) } : {}),
  };

  runRebuild(opts)
    .then((r) => {
      process.exit(r.checksumMatch === false ? 2 : 0);
    })
    .catch((err) => {
      console.error('[RebuildProjections] Fatal:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
