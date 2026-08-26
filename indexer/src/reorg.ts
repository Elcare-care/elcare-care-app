/**
 * reorg.ts — Reorganization handling with configurable confirmation depth (#286).
 *
 * Overview
 * --------
 * Stellar testnet/mainnet achieves practical finality within 1–2 ledgers, but
 * serving data from very recent ledgers risks exposing rows that a chain reorg
 * later invalidates.  This module implements a two-tier event model:
 *
 *   provisional — written to the DB; not yet CONFIRMATION_DEPTH ledgers old.
 *   confirmed   — promoted once CONFIRMATION_DEPTH ledgers have accumulated
 *                 on top of the event's ledger.
 *
 * On reorg the existing hard-delete rollback in poller.ts runs unchanged.
 * All deleted rows were provisional by definition (they were within the reorg
 * window).  SSE clients receive a "reorg" correction event so they can flush
 * their local state and re-fetch from the REST API.
 *
 * Confirmation promotion
 * ----------------------
 * After each polling cycle the poller calls promoteConfirmedEvents() which
 * bulk-updates events whose ledger is <= (networkTip - confirmationDepth)
 * from confirmed=false to confirmed=true.
 *
 * API / SSE exposure
 * ------------------
 * REST endpoints include "confirmed: boolean" in event responses.
 * SSE clients receive a synthetic "REORG" event with the safe ledger number
 * when a rollback occurs so they know to invalidate their replay buffer.
 */

import { logger } from './logger.js';
import prisma from './prisma-write.js';
import { emitSSEEvent } from './api/routes.js';
import { bumpConfirmedVersion } from './api/etag-middleware.js';
import { invalidateStats, invalidateAllActivity } from './cache-invalidation.js';

// ── Confirmation promotion ────────────────────────────────────────────────────

/**
 * Promote events that are now deep enough to be considered confirmed.
 *
 * Called after each successful polling cycle with the current network tip
 * and the configured confirmation depth.
 *
 * @param networkTip       Latest ledger sequence from the Stellar RPC.
 * @param confirmationDepth Number of ledgers required before an event is confirmed.
 * @returns                Number of events promoted in this call.
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

    // Issue #508: provisional→confirmed transition changes the "confirmed" field
    // in the response body, so all cached ETags derived from those representations
    // are now stale.  Bump the global version counter so the next request produces
    // a different ETag even when the raw DB payload bytes are identical.
    bumpConfirmedVersion();

    // Invalidate stats and activity cache keys whose responses may now include
    // newly-confirmed events that were previously filtered or labelled provisional.
    await Promise.all([
      invalidateStats(),
      invalidateAllActivity(),
    ]).catch((err) => {
      // Non-fatal — Redis unavailability must not stall the poller.
      logger.warn('reorg: cache invalidation after promotion failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return result.count;
}

// ── Reorg SSE signal ──────────────────────────────────────────────────────────

/**
 * Synthetic event shape emitted over SSE when a chain reorg is detected.
 *
 * SSE clients that receive a "REORG" eventType MUST:
 *   1. Discard any locally cached events with ledgerSequence > safeLedger.
 *   2. Re-fetch affected resources from the REST API.
 *
 * The 'safeLedger' field is the last ledger known to be correct; clients
 * should treat all state built from ledgers > safeLedger as invalid.
 */
export interface ReorgSseEvent {
  eventType: 'REORG';
  safeLedger: number;
  detectedAt: string; // ISO-8601 timestamp
}

/**
 * Emit a synthetic REORG correction event to all connected SSE clients.
 * Called immediately after a reorg rollback completes.
 *
 * @param safeLedger The last ledger confirmed to be on the canonical chain.
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
    // Never crash the poller because of an SSE emit failure
    logger.error('reorg: failed to emit SSE correction event', {
      safeLedger,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Reorg rollback (enhanced) ─────────────────────────────────────────────────

/**
 * Enhanced rollback that also resets domain state affected by a reorg and
 * emits an SSE correction signal.
 *
 * This is a drop-in enhancement on top of the existing revertLedgers() in
 * poller.ts.  Call this function instead of revertLedgers() + the old cursor
 * reset, or call revertLedgers() first and then this function to emit the
 * SSE signal.
 *
 * The hard-delete rollback (MarketplaceEvent, Listing, Auction, Collection)
 * already runs in revertLedgers() — this function adds:
 *   1. Offer rollback (reverts accepted/rejected offers to Pending for affected ledgers).
 *   2. Auction bid rollback (removes bids placed after safeLedger).
 *   3. SSE correction event emission.
 *
 * @param safeAtLedger The last ledger that is confirmed on the canonical chain.
 * @param tx           Optional Prisma transaction client; if omitted, prisma is used directly.
 */
export async function rollbackReorg(
  safeAtLedger: number,
  tx?: any,
): Promise<void> {
  const db = tx ?? prisma;

  logger.warn('reorg: rolling back domain state', { safeAtLedger });

  // Reset offers whose status changed after the safe point
  await db.offer.updateMany({
    where: { updatedAtLedger: { gt: safeAtLedger } },
    data: { status: 'Pending', updatedAtLedger: safeAtLedger },
  });

  // Remove bids placed after the safe point
  await db.bid.deleteMany({
    where: { ledgerSequence: { gt: safeAtLedger } },
  });

  logger.info('reorg: domain rollback complete', { safeAtLedger });

  // Issue #508: every cached ETag that was computed from data at ledgers
  // > safeAtLedger is now invalid.  Bump the confirmed-version counter so
  // subsequent requests (even for unchanged data) receive a new ETag and
  // clients are forced to re-validate.
  bumpConfirmedVersion();

  // Broad cache purge: stats aggregates, activity feeds, and wallet views may
  // all reference events that were just rolled back.
  await Promise.all([
    invalidateStats(),
    invalidateAllActivity(),
  ]).catch((err) => {
    logger.warn('reorg: cache invalidation after rollback failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  // Emit SSE correction event so connected clients know to flush their state
  emitReorgSseEvent(safeAtLedger);
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
