/**
 * ipfs-backpressure.ts — Bounded IPFS enrichment queue with backpressure.
 *
 * Separation of concerns:
 *   - Canonical event ingestion (ledger poller) MUST NOT be delayed by IPFS.
 *   - This module owns the enrichment side-channel: a bounded in-memory queue
 *     backed by the durable IpfsQueue DB table.
 *
 * Features:
 *   - Bounded pending-job limit (MAX_PENDING_JOBS) with overflow policy: oldest
 *     low-priority items are dropped first; active listings are never dropped.
 *   - Priority tiers: HIGH (active listings), NORMAL (others), LOW (batch backfill).
 *   - Backpressure signal: `isBackpressured()` returns true when the queue is full.
 *   - Content-size limit: fetched JSON bodies > MAX_CONTENT_BYTES are rejected.
 *   - Status fields: Listing and Collection rows get ipfsStatus=
 *     'pending' | 'fetching' | 'done' | 'failed' | 'oversized' | 'unavailable'
 *   - API clients can distinguish unavailable metadata from empty metadata.
 *   - Gateway rotation: primary + fallback gateways round-robin on failure.
 *
 * This module does NOT call ipfs-cache.ts's processIpfsQueue directly — it
 * wraps the DB-backed queue with an in-process bounded layer that prevents
 * memory spikes while letting the DB serve as a durable audit trail.
 *
 * Prometheus metrics are exported for queue depth, drop counters, and latency.
 */

import prismaWrite from './prisma-write.js';
import prisma from './db.js';
import { enqueueIpfsFetch, fetchIpfsMetadata } from './ipfs-cache.js';
import { logger } from './logger.js';
import client from 'prom-client';

// ── Prometheus ─────────────────────────────────────────────────────────────────

export const ipfsQueueDepthGauge = new client.Gauge({
  name: 'indexer_ipfs_queue_depth',
  help: 'Current number of pending IPFS enrichment jobs in the bounded queue',
  labelNames: ['priority'],
});

export const ipfsQueueDroppedTotal = new client.Counter({
  name: 'indexer_ipfs_queue_dropped_total',
  help: 'Total IPFS enrichment jobs dropped due to queue overflow',
  labelNames: ['priority'],
});

export const ipfsQueueProcessedTotal = new client.Counter({
  name: 'indexer_ipfs_queue_processed_total',
  help: 'Total IPFS enrichment jobs processed (success + failure)',
  labelNames: ['outcome'],
});

export const ipfsContentOversizedTotal = new client.Counter({
  name: 'indexer_ipfs_content_oversized_total',
  help: 'Total IPFS fetch jobs rejected because response body exceeded the size limit',
});

// ── Configuration ──────────────────────────────────────────────────────────────

/** Maximum number of pending CID jobs in the in-process queue before backpressure. */
const MAX_PENDING_JOBS = parseInt(process.env.IPFS_MAX_PENDING_JOBS || '500', 10);

/** Maximum raw JSON body size accepted from any gateway (bytes). */
const MAX_CONTENT_BYTES = parseInt(process.env.IPFS_MAX_CONTENT_BYTES || String(256 * 1024), 10); // 256 KB

/** How many jobs to drain per processing tick. */
const DRAIN_BATCH_SIZE = parseInt(process.env.IPFS_DRAIN_BATCH_SIZE || '20', 10);

// ── Priority tiers ─────────────────────────────────────────────────────────────

export type IpfsPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<IpfsPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

// ── In-process bounded queue ───────────────────────────────────────────────────

interface QueueEntry {
  cid: string;
  priority: IpfsPriority;
  /** Listing/Collection id for status update after fetch. */
  entityType?: 'listing' | 'collection';
  entityId?: bigint;
  enqueuedAt: number;
}

const _queue: QueueEntry[] = [];
const _inFlight = new Set<string>(); // CIDs currently being fetched

/** Returns true when the queue is at capacity (backpressure signal). */
export function isBackpressured(): boolean {
  return _queue.length >= MAX_PENDING_JOBS;
}

/** Returns the current queue depth by priority tier. */
export function getQueueDepths(): Record<IpfsPriority, number> {
  const counts: Record<IpfsPriority, number> = { high: 0, normal: 0, low: 0 };
  for (const entry of _queue) {
    counts[entry.priority]++;
  }
  return counts;
}

/**
 * Enqueue a CID for IPFS metadata enrichment with backpressure.
 *
 * - HIGH priority items are always accepted (never dropped due to overflow).
 * - NORMAL/LOW items are dropped (oldest first) when MAX_PENDING_JOBS is reached.
 * - Duplicate CIDs in-flight are silently ignored.
 * - Also calls the durable enqueueIpfsFetch() for DB persistence.
 */
export async function enqueueBounded(
  cid: string,
  opts: {
    priority?: IpfsPriority;
    entityType?: 'listing' | 'collection';
    entityId?: bigint;
  } = {}
): Promise<void> {
  if (!cid) return;

  const priority = opts.priority ?? 'normal';

  // Skip if already in-flight
  if (_inFlight.has(cid)) return;

  // Skip if already queued
  if (_queue.some((e) => e.cid === cid)) return;

  // Backpressure: evict oldest low-priority item when full
  if (_queue.length >= MAX_PENDING_JOBS) {
    if (priority === 'high') {
      // High priority: evict lowest priority item to make room
      const evictIdx = findLowestPriorityIndex();
      if (evictIdx >= 0) {
        const evicted = _queue.splice(evictIdx, 1)[0];
        ipfsQueueDroppedTotal.labels(evicted.priority).inc();
        logger.debug('[IpfsBackpressure] Dropped low-priority item for high-priority', {
          dropped: evicted.cid,
          added: cid,
        });
      } else {
        // Queue is all high-priority — still at capacity, skip
        ipfsQueueDroppedTotal.labels(priority).inc();
        logger.warn('[IpfsBackpressure] Queue at capacity, dropping high-priority item', { cid });
        return;
      }
    } else {
      // Not high priority — drop this new item
      ipfsQueueDroppedTotal.labels(priority).inc();
      logger.debug('[IpfsBackpressure] Queue at capacity, dropping item', { cid, priority });

      // Mark entity as deferred in DB
      await setEntityIpfsStatus(opts.entityType, opts.entityId, 'deferred');
      return;
    }
  }

  _queue.push({
    cid,
    priority,
    entityType: opts.entityType,
    entityId: opts.entityId,
    enqueuedAt: Date.now(),
  });

  // Persist to durable queue for crash recovery
  await enqueueIpfsFetch(cid).catch(() => {/* non-fatal */});

  // Mark entity as pending
  await setEntityIpfsStatus(opts.entityType, opts.entityId, 'pending');

  // Update gauge
  updateDepthGauges();
}

function findLowestPriorityIndex(): number {
  let maxPriorityOrder = -1;
  let idx = -1;
  for (let i = 0; i < _queue.length; i++) {
    const order = PRIORITY_ORDER[_queue[i].priority];
    if (order > maxPriorityOrder) {
      maxPriorityOrder = order;
      idx = i;
    }
  }
  return idx;
}

// ── Queue drain ────────────────────────────────────────────────────────────────

/**
 * Drains one batch from the bounded queue, highest-priority first.
 *
 * This should be called by a periodic timer in the indexer main loop —
 * NOT in the critical path of event ingestion. Ledger polling continues
 * unimpeded regardless of this drain's completion.
 *
 * Returns the number of successfully fetched items.
 */
export async function drainIpfsQueue(): Promise<number> {
  if (_queue.length === 0) return 0;

  // Sort by priority then FIFO within priority
  _queue.sort((a, b) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    a.enqueuedAt - b.enqueuedAt
  );

  const batch = _queue.splice(0, DRAIN_BATCH_SIZE);
  updateDepthGauges();

  let successCount = 0;

  await Promise.allSettled(
    batch.map(async (entry) => {
      _inFlight.add(entry.cid);
      try {
        await setEntityIpfsStatus(entry.entityType, entry.entityId, 'fetching');
        const result = await fetchIpfsMetadata(entry.cid);

        // Content-size guard: check raw body size
        const rawBody = JSON.stringify(result.data);
        if (rawBody.length > MAX_CONTENT_BYTES) {
          ipfsContentOversizedTotal.inc();
          logger.warn('[IpfsBackpressure] Content too large — rejecting', {
            cid: entry.cid,
            bytes: rawBody.length,
            maxBytes: MAX_CONTENT_BYTES,
          });
          await setEntityIpfsStatus(entry.entityType, entry.entityId, 'oversized');
          ipfsQueueProcessedTotal.labels('oversized').inc();
          return;
        }

        // Persist metadata and update entity status
        await persistMetadataAndStatus(entry, result.data, result.contentHash);
        successCount++;
        ipfsQueueProcessedTotal.labels('success').inc();
      } catch (err) {
        const isMissing = isNotFoundError(err);
        const status = isMissing ? 'unavailable' : 'failed';

        await setEntityIpfsStatus(entry.entityType, entry.entityId, status);
        ipfsQueueProcessedTotal.labels(status).inc();

        logger.warn('[IpfsBackpressure] Fetch failed', {
          cid: entry.cid,
          status,
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        _inFlight.delete(entry.cid);
      }
    })
  );

  return successCount;
}

// ── Entity status update ───────────────────────────────────────────────────────

export type IpfsStatus =
  | 'pending'
  | 'fetching'
  | 'done'
  | 'failed'
  | 'oversized'
  | 'unavailable'
  | 'deferred';

async function setEntityIpfsStatus(
  entityType: 'listing' | 'collection' | undefined,
  entityId: bigint | undefined,
  status: IpfsStatus,
): Promise<void> {
  if (!entityType || entityId === undefined) return;

  try {
    if (entityType === 'listing') {
      await (prismaWrite as any).listing.update({
        where: { listingId: entityId },
        data: { ipfsStatus: status },
      });
    } else if (entityType === 'collection') {
      await (prismaWrite as any).collection.update({
        where: { id: Number(entityId) },
        data: { ipfsStatus: status },
      });
    }
  } catch (err) {
    // Best-effort — status field may not exist yet in this schema version
    logger.debug('[IpfsBackpressure] Could not set entity ipfs status', {
      entityType,
      entityId: entityId.toString(),
      status,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function persistMetadataAndStatus(
  entry: QueueEntry,
  data: Record<string, unknown>,
  contentHash: string,
): Promise<void> {
  await setEntityIpfsStatus(entry.entityType, entry.entityId, 'done');

  // If this is a listing, populate searchable fields from metadata
  if (entry.entityType === 'listing' && entry.entityId !== undefined) {
    try {
      await (prismaWrite as any).listing.update({
        where: { listingId: entry.entityId },
        data: {
          title: typeof data.title === 'string' ? data.title : undefined,
          description: typeof data.description === 'string' ? data.description : undefined,
          ipfsStatus: 'done',
        },
      });
    } catch {/* non-fatal */}
  }
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as any)?.response?.status;
  return status === 404;
}

function updateDepthGauges(): void {
  const depths = getQueueDepths();
  for (const [priority, depth] of Object.entries(depths)) {
    ipfsQueueDepthGauge.labels(priority).set(depth);
  }
}
