/**
 * checkpoint.ts — Durable cursor checkpoint protocol for crash-safe polling.
 *
 * The lifecycle of a polling window is:
 *
 *   1. fetched   — RPC data retrieved; domain writes not started.
 *   2. applying  — DB transaction open; cursor not yet advanced.
 *   3. committed — Transaction committed; TrackedContract.lastLedger reflects windowEnd.
 *   4. failed    — Unrecoverable error; operator inspection required.
 *
 * The public cursor (TrackedContract.lastLedger) is ONLY advanced inside the
 * same DB transaction that commits the domain writes. If the process crashes
 * between steps 1–2, the checkpoint remains in "fetched" state and the window
 * is replayed on restart. Because all event writes use the eventHash unique
 * constraint they are idempotent — replay never creates duplicates.
 *
 * Usage in the polling loop:
 *
 *   const cp = await openCheckpoint(contractId, startLedger, endLedger);
 *   try {
 *     const events = await collectMarketplaceEvents(...);
 *     await commitCheckpointWithEvents(cp, events, contractRow, latestHash, tx);
 *   } catch (err) {
 *     await failCheckpoint(cp, err);
 *     throw err;
 *   }
 */

import { logger } from './logger.js';
import prisma from './prisma-write.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckpointStatus = 'fetched' | 'applying' | 'committed' | 'failed';

export interface Checkpoint {
  id: number;
  contractId: string;
  windowStart: number;
  windowEnd: number;
  ledgerHash: string | null;
  eventCount: number;
  status: CheckpointStatus;
}

// ── Open a new checkpoint ─────────────────────────────────────────────────────

/**
 * Create a checkpoint row in "fetched" state.
 * Called immediately after the RPC window data is retrieved.
 */
export async function openCheckpoint(
  contractId: string,
  windowStart: number,
  windowEnd: number,
): Promise<Checkpoint> {
  const row = await prisma.ledgerCheckpoint.create({
    data: {
      contractId,
      windowStart,
      windowEnd,
      status: 'fetched',
      eventCount: 0,
    },
  });
  logger.debug('checkpoint: opened', { id: row.id, contractId, windowStart, windowEnd });
  return row as unknown as Checkpoint;
}

// ── Advance checkpoint to "applying" ─────────────────────────────────────────

/**
 * Mark the checkpoint as "applying" before opening the DB transaction that
 * writes domain rows.  The transition is a single UPDATE so it is crash-safe:
 * if the process dies after this call but before the transaction commits, the
 * checkpoint stays in "applying" state and startup recovery replays the window.
 */
export async function markApplying(checkpoint: Checkpoint): Promise<void> {
  await prisma.ledgerCheckpoint.update({
    where: { id: checkpoint.id },
    data: { status: 'applying' },
  });
  checkpoint.status = 'applying';
  logger.debug('checkpoint: applying', { id: checkpoint.id });
}

// ── Commit checkpoint inside the domain transaction ───────────────────────────

/**
 * Advance the public cursor and mark the checkpoint as "committed".
 *
 * MUST be called inside the same Prisma interactive transaction that writes
 * the domain rows (MarketplaceEvent, Listing, Auction, Offer, etc.).
 * This guarantees that the cursor advance and the domain writes are atomic.
 *
 * @param checkpoint  The checkpoint object returned by openCheckpoint.
 * @param eventCount  Number of new events written in this window.
 * @param ledgerHash  Hash of the windowEnd ledger (null if unavailable).
 * @param contractDbId The TrackedContract.id to advance.
 * @param tx          The Prisma transaction client.
 */
export async function commitCheckpoint(
  checkpoint: Checkpoint,
  eventCount: number,
  ledgerHash: string | null,
  contractDbId: number,
  tx: any,
): Promise<void> {
  // 1. Advance the contract cursor — the authoritative public position.
  await tx.trackedContract.update({
    where: { id: contractDbId },
    data: {
      lastLedger: checkpoint.windowEnd,
      ...(ledgerHash ? { lastLedgerHash: ledgerHash } : {}),
    },
  });

  // 2. Keep the shared SyncState in sync with the most-advanced contract.
  await tx.syncState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: checkpoint.windowEnd, lastLedgerHash: ledgerHash },
    update: {
      lastLedger: checkpoint.windowEnd,
      ...(ledgerHash ? { lastLedgerHash: ledgerHash } : {}),
    },
  });

  // 3. Mark the checkpoint committed.
  await tx.ledgerCheckpoint.update({
    where: { id: checkpoint.id },
    data: {
      status: 'committed',
      eventCount,
      ...(ledgerHash ? { ledgerHash } : {}),
    },
  });

  checkpoint.status = 'committed';
  checkpoint.eventCount = eventCount;
  checkpoint.ledgerHash = ledgerHash;

  logger.debug('checkpoint: committed', {
    id: checkpoint.id,
    windowEnd: checkpoint.windowEnd,
    eventCount,
  });
}

// ── Fail a checkpoint ─────────────────────────────────────────────────────────

/**
 * Mark the checkpoint as "failed" with an error message.
 * Failed checkpoints do not block the poller — the window will be retried on
 * the next cycle.  Operators can inspect them via the /health/details endpoint
 * or directly in the database.
 */
export async function failCheckpoint(
  checkpoint: Checkpoint,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await prisma.ledgerCheckpoint.update({
      where: { id: checkpoint.id },
      data: { status: 'failed', error: message.slice(0, 2048) },
    });
    checkpoint.status = 'failed';
  } catch (updateErr) {
    // Non-fatal — never crash the poller because of a checkpoint update failure.
    logger.error('checkpoint: failed to persist failure state', {
      id: checkpoint.id,
      originalErr: message,
      updateErr: updateErr instanceof Error ? updateErr.message : String(updateErr),
    });
  }
  logger.warn('checkpoint: failed', { id: checkpoint.id, error: message });
}

// ── Startup recovery ──────────────────────────────────────────────────────────

/**
 * Find all incomplete checkpoints (status = "fetched" | "applying") for a
 * given contract, ordered by windowStart ascending.
 *
 * Called during startup before the polling loop begins so the poller can
 * replay any windows that were interrupted by a crash.
 *
 * Incomplete checkpoints in "applying" state indicate that the DB transaction
 * was open when the process died — the cursor was NOT advanced so the window
 * needs to be replayed.  Because event writes are idempotent this is safe.
 */
export async function findIncompleteCheckpoints(
  contractId: string,
): Promise<Checkpoint[]> {
  const rows = await prisma.ledgerCheckpoint.findMany({
    where: {
      contractId,
      status: { in: ['fetched', 'applying'] },
    },
    orderBy: { windowStart: 'asc' },
  });
  return rows as unknown as Checkpoint[];
}

/**
 * Reset a stale "applying" checkpoint back to "fetched" state so the recovery
 * loop treats it as a normal pending window rather than an in-progress one.
 *
 * Called during startup recovery for any checkpoint that was stuck in
 * "applying" when the process crashed.
 */
export async function resetApplyingCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await prisma.ledgerCheckpoint.update({
    where: { id: checkpoint.id },
    data: { status: 'fetched', error: 'reset after crash during apply phase' },
  });
  checkpoint.status = 'fetched';
  logger.info('checkpoint: reset stale applying checkpoint', {
    id: checkpoint.id,
    contractId: checkpoint.contractId,
    windowStart: checkpoint.windowStart,
    windowEnd: checkpoint.windowEnd,
  });
}

// ── Health summary ────────────────────────────────────────────────────────────

/**
 * Return a summary of checkpoint health for use in /health/details.
 * Returns counts by status and the oldest incomplete checkpoint if any.
 */
export async function getCheckpointHealthSummary(): Promise<{
  total: number;
  committed: number;
  failed: number;
  incomplete: number;
  oldestIncompleteWindowStart: number | null;
}> {
  const [counts, oldest] = await Promise.all([
    prisma.ledgerCheckpoint.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
    prisma.ledgerCheckpoint.findFirst({
      where: { status: { in: ['fetched', 'applying'] } },
      orderBy: { windowStart: 'asc' },
      select: { windowStart: true },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    byStatus[row.status as string] = row._count.id;
    total += row._count.id;
  }

  return {
    total,
    committed: byStatus['committed'] ?? 0,
    failed: byStatus['failed'] ?? 0,
    incomplete: (byStatus['fetched'] ?? 0) + (byStatus['applying'] ?? 0),
    oldestIncompleteWindowStart: oldest?.windowStart ?? null,
  };
}
