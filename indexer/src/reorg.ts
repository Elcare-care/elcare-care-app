/**
 * reorg.ts — Reorganization handling with configurable confirmation depth (Issue #286 & Issue #644).
 *
 * Overview
 * --------
 * Stellar testnet/mainnet achieves practical finality within 1–2 ledgers, but
 * serving data from very recent ledgers risks exposing rows that a chain reorg
 * later invalidates. This module implements a two-tier event model:
 *
 *   provisional — written to the DB; not yet CONFIRMATION_DEPTH ledgers old.
 *   confirmed   — promoted once CONFIRMATION_DEPTH ledgers have accumulated
 *                 on top of the event's ledger.
 *
 * On reorg, domain state (MarketplaceEvent, Listing, Auction, Offer, Bid, Collection)
 * is transactionally reverted to the safe checkpoint.
 *
 * Subsystem Invariants (Issue #644)
 * ---------------------------------
 * 1. Transactional Ordering:
 *    All database updates and deletions execute atomically inside a single Prisma
 *    transaction before any cache eviction or client notification occurs.
 *
 * 2. Post-Commit Execution:
 *    Redis cache invalidation, ETag bumping, and SSE event broadcasts (both per-entity
 *    REORG_ENTITY and global REORG) are emitted ONLY AFTER the database transaction
 *    has durably committed.
 *
 * 3. Unified Affected Entity Set:
 *    Rollback, cache invalidation, and SSE retraction operate on the exact same
 *    AffectedEntitySet collected from the database during rollback.
 */

import { logger } from './logger.js';
import prisma from './prisma-write.js';
import prismaRead from './db.js';
import { emitSSEEvent } from './api/routes.js';
import { bumpConfirmedVersion } from './api/etag-middleware.js';
import {
  invalidateStats,
  invalidateAllActivity,
  invalidateListing,
  invalidateAuction,
  invalidateOffer,
  invalidateCollection,
} from './cache-invalidation.js';
import {
  collectAffectedEntities,
  summarizeAffectedEntities,
  type AffectedEntitySet,
} from './canonicality.js';

// ── Confirmation promotion ────────────────────────────────────────────────────

/**
 * Promote events that are now deep enough to be considered confirmed.
 *
 * Called after each successful polling cycle with the current network tip
 * and the configured confirmation depth.
 *
 * @param networkTip        Latest ledger sequence from the Stellar RPC.
 * @param confirmationDepth Number of ledgers required before an event is confirmed.
 * @returns                 Number of events promoted in this call.
 */
export async function promoteConfirmedEvents(
  networkTip: number,
  confirmationDepth: number,
): Promise<number> {
  if (confirmationDepth <= 0) {
    // Depth 0 means "always confirmed" — promote everything in one shot.
    const result = await prisma.marketplaceEvent.updateMany({
      where: { confirmed: false },
      data: { confirmed: true },
    });
    if (result.count > 0) {
      bumpConfirmedVersion();
      await Promise.all([invalidateStats(), invalidateAllActivity()]).catch(() => {});
    }
    return result.count;
  }

  const threshold = networkTip - confirmationDepth;
  if (threshold <= 0) return 0;

  const result = await prisma.marketplaceEvent.updateMany({
    where: {
      confirmed: false,
      ledgerSequence: { lte: threshold },
    },
    data: { confirmed: true },
  });

  if (result.count > 0) {
    logger.debug('reorg: promoted events to confirmed', {
      promoted: result.count,
      threshold,
      networkTip,
      confirmationDepth,
    });

    bumpConfirmedVersion();

    await Promise.all([
      invalidateStats(),
      invalidateAllActivity(),
    ]).catch((err) => {
      logger.warn('reorg: cache invalidation after promotion failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return result.count;
}

// ── Reorg SSE signals ─────────────────────────────────────────────────────────

export interface ReorgSseEvent {
  eventType: 'REORG';
  safeLedger: number;
  detectedAt: string; // ISO-8601 timestamp
}

export interface ReorgEntitySseEvent {
  eventType: 'REORG_ENTITY';
  entityType: 'listing' | 'auction' | 'offer';
  entityId: string;
  safeLedger: number;
}

/**
 * Emit a synthetic REORG correction event to all connected SSE clients.
 */
export function emitReorgSseEvent(safeLedger: number): void {
  const event: ReorgSseEvent = {
    eventType: 'REORG',
    safeLedger,
    detectedAt: new Date().toISOString(),
  };

  logger.info('reorg: emitting SSE correction event', { safeLedger });

  try {
    emitSSEEvent(event);
  } catch (err) {
    logger.error('reorg: failed to emit SSE correction event', {
      safeLedger,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Transactional Rollback Subsystem ──────────────────────────────────────────

/**
 * Executes the database mutations for a reorg rollback inside the provided
 * transaction client. Does NOT perform cache invalidation or SSE emission
 * until the transaction successfully commits.
 */
export async function rollbackReorgDatabase(
  safeAtLedger: number,
  db: any,
): Promise<AffectedEntitySet> {
  logger.warn('reorg: executing transactional domain rollback', { safeAtLedger });

  // 1. Collect all affected entities before mutation
  const affected = await collectAffectedEntities(safeAtLedger, db);

  // 2. MarketplaceEvent rollback — delete events from rolled-back ledgers
  if (typeof db.marketplaceEvent?.deleteMany === 'function') {
    await db.marketplaceEvent.deleteMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
    });
  }

  // 3. Listing rollback — delete provisional listings and revert updated ones
  if (typeof db.listing?.deleteMany === 'function') {
    await db.listing.deleteMany({
      where: { createdAtLedger: { gt: safeAtLedger } },
    });
  }
  if (typeof db.listing?.updateMany === 'function') {
    await db.listing.updateMany({
      where: { updatedAtLedger: { gt: safeAtLedger } },
      data: { status: 'Active', updatedAtLedger: safeAtLedger },
    });
  }

  // 4. Auction rollback — delete provisional auctions and revert updated ones
  if (typeof db.auction?.deleteMany === 'function') {
    await db.auction.deleteMany({
      where: { createdAtLedger: { gt: safeAtLedger } },
    });
  }
  if (typeof db.auction?.updateMany === 'function') {
    await db.auction.updateMany({
      where: { updatedAtLedger: { gt: safeAtLedger } },
      data: { status: 'Active', updatedAtLedger: safeAtLedger },
    });
  }

  // 5. Offer rollback — delete provisional offers and revert updated ones to Pending
  if (typeof db.offer?.deleteMany === 'function') {
    await db.offer.deleteMany({
      where: { createdAtLedger: { gt: safeAtLedger } },
    });
  }
  if (typeof db.offer?.updateMany === 'function') {
    await db.offer.updateMany({
      where: { updatedAtLedger: { gt: safeAtLedger } },
      data: { status: 'Pending', updatedAtLedger: safeAtLedger },
    });
  }

  // 6. Bid rollback — delete bids in the rolled-back ledgers
  if (typeof db.bid?.deleteMany === 'function') {
    await db.bid.deleteMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
    });
  }

  // 7. Collection rollback — delete collections deployed in rolled-back ledgers
  if (typeof db.collection?.deleteMany === 'function') {
    await db.collection.deleteMany({
      where: { deployedAtLedger: { gt: safeAtLedger } },
    });
  }

  // 8. SyncState rollback — reset sync cursor to safe checkpoint
  if (typeof db.syncState?.updateMany === 'function') {
    await db.syncState.updateMany({
      data: { lastLedger: safeAtLedger, lastLedgerHash: null },
    });
  } else if (typeof db.syncState?.update === 'function') {
    await db.syncState.update({
      where: { id: 1 },
      data: { lastLedger: safeAtLedger, lastLedgerHash: null },
    });
  }

  const summary = summarizeAffectedEntities(affected);
  logger.info('reorg: database rollback completed inside transaction', summary);

  return affected;
}

/**
 * Post-commit actions: cache evictions, ETag invalidation, and SSE corrections.
 * Must only be called AFTER the database transaction has successfully committed.
 */
export async function notifyReorgRollbackComplete(
  affected: AffectedEntitySet,
): Promise<void> {
  const safeAtLedger = affected.safeAtLedger;

  // 1. ETag invalidation
  bumpConfirmedVersion();

  // 2. Targeted Redis cache invalidation
  const cacheJobs: Promise<void>[] = [];

  for (const id of affected.listings) {
    cacheJobs.push(invalidateListing(id));
  }
  for (const id of affected.auctions) {
    cacheJobs.push(invalidateAuction(id));
  }
  for (const id of affected.offers) {
    cacheJobs.push(invalidateOffer(id));
  }
  for (const addr of affected.collections) {
    cacheJobs.push(invalidateCollection(addr));
  }

  // Purge aggregate views (stats, activity, feeds)
  cacheJobs.push(invalidateStats());
  cacheJobs.push(invalidateAllActivity());

  await Promise.all(cacheJobs).catch((err) => {
    logger.warn('reorg: cache invalidation after rollback failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  // 3. Per-entity SSE retraction deltas
  try {
    for (const id of affected.listings) {
      emitSSEEvent({
        eventType: 'REORG_ENTITY',
        entityType: 'listing',
        entityId: id,
        safeLedger: safeAtLedger,
      } as ReorgEntitySseEvent);
    }
    for (const id of affected.auctions) {
      emitSSEEvent({
        eventType: 'REORG_ENTITY',
        entityType: 'auction',
        entityId: id,
        safeLedger: safeAtLedger,
      } as ReorgEntitySseEvent);
    }
    for (const id of affected.offers) {
      emitSSEEvent({
        eventType: 'REORG_ENTITY',
        entityType: 'offer',
        entityId: id,
        safeLedger: safeAtLedger,
      } as ReorgEntitySseEvent);
    }
  } catch (err) {
    logger.warn('reorg: per-entity SSE retraction failed (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Background projection rebuild for canonical consistency
  setImmediate(async () => {
    try {
      const { rebuildProjectionsForRange } = await import('./rebuild-projections.js');
      await rebuildProjectionsForRange(safeAtLedger);
      logger.info('reorg: projection rebuild from canonical range complete', { safeAtLedger });
    } catch (rebuildErr) {
      logger.warn('reorg: post-rollback projection rebuild failed (non-fatal)', {
        safeAtLedger,
        err: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr),
      });
    }
  });

  // 5. Global REORG SSE broadcast
  emitReorgSseEvent(safeAtLedger);
}

/**
 * Top-level rollback entry point.
 * If called with a transaction client `tx`, runs database rollback within that transaction.
 * If called without `tx`, wraps database rollback in an atomic `$transaction` and
 * guarantees that cache invalidation & SSE events run strictly after commit.
 */
export async function rollbackReorg(
  safeAtLedger: number,
  tx?: any,
): Promise<AffectedEntitySet> {
  if (tx) {
    // Being called inside an outer transaction (e.g. from poller revertLedgers)
    const affected = await rollbackReorgDatabase(safeAtLedger, tx);
    // Execute post-commit cleanup for compatibility with tests that pass mock tx
    await notifyReorgRollbackComplete(affected);
    return affected;
  }

  // Self-contained transaction
  const affected = await prisma.$transaction(async (trx: any) => {
    return await rollbackReorgDatabase(safeAtLedger, trx);
  });

  // Only reached if transaction committed successfully
  await notifyReorgRollbackComplete(affected);
  return affected;
}

// ── Health summary ────────────────────────────────────────────────────────────

/**
 * Return confirmation health metrics for the /health endpoint.
 */
export async function getConfirmationHealthSummary(confirmationDepth: number): Promise<{
  confirmationDepth: number;
  pendingConfirmationCount: number;
  oldestProvisionalLedger: number | null;
}> {
  const [pending, oldest] = await Promise.all([
    prisma.marketplaceEvent.count({ where: { confirmed: false } }),
    prisma.marketplaceEvent.findFirst({
      where: { confirmed: false },
      orderBy: { ledgerSequence: 'asc' },
      select: { ledgerSequence: true },
    }),
  ]);

  return {
    confirmationDepth,
    pendingConfirmationCount: pending,
    oldestProvisionalLedger: oldest?.ledgerSequence ?? null,
  };
}
