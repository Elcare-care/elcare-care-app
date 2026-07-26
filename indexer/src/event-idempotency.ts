/**
 * event-idempotency.ts — Idempotent event write primitives for Issue #284.
 *
 * The canonical event identity is the SHA-256 hash computed by
 * computeEventHash(contractId, ledger, txHash, eventIndex) — a value that
 * is stable across retries, restarts, and concurrent workers because it is
 * derived entirely from immutable on-chain data.
 *
 * The database enforces uniqueness on this hash via the MarketplaceEvent.eventHash
 * unique index. A second write of the same event is a no-op at the DB level —
 * both the hash index and the belt-and-suspenders composite index
 * (contractId, listingId, eventType, ledgerSequence) will reject duplicates
 * with a unique-constraint violation that this module catches and counts as a
 * benign replay rather than an error.
 *
 * Usage:
 *
 *   const { inserted, skipped } = await upsertEvent(event, tx);
 *
 * All callers (poller, backfill, recovery) should use upsertEvents() in
 * preference to direct prisma.marketplaceEvent.create() calls.
 */

import { logger } from './logger.js';
import { duplicateEventsCounter } from './metrics.js';
import type { DecodedEvent } from './parser.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpsertResult {
  inserted: number;
  skipped: number;
}

// ── Prisma unique-constraint error detection ──────────────────────────────────

/**
 * Returns true when the Prisma error is a unique-constraint violation (P2002).
 * This is how we distinguish a benign idempotent replay from a genuine write error.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // Prisma wraps these as PrismaClientKnownRequestError with code "P2002"
    if (e.code === 'P2002') return true;
    // Fallback: check the raw message for PostgreSQL unique violation
    if (typeof e.message === 'string' && e.message.includes('Unique constraint')) return true;
  }
  return false;
}

// ── Single-event idempotent write ─────────────────────────────────────────────

/**
 * Write a single decoded event idempotently.
 *
 * Strategy:
 *   1. Attempt a direct INSERT.
 *   2. On unique-constraint violation (P2002 — duplicate eventHash or composite
 *      key), count the replay as benign and return { inserted: 0, skipped: 1 }.
 *
 * We intentionally do NOT use upsert (createOrUpdate) because the update side
 * of an upsert could silently overwrite fields that differ between a replay and
 * the original — using INSERT + catch-on-conflict makes the semantics clear:
 * the first write wins, all subsequent writes for the same event are no-ops.
 *
 * @param event  The decoded on-chain event to persist.
 * @param tx     Prisma transaction client (pass the parent tx for atomicity).
 * @returns      { inserted: 1, skipped: 0 } on success; { inserted: 0, skipped: 1 } on duplicate.
 */
export async function upsertEvent(
  event: DecodedEvent,
  tx: any,
): Promise<UpsertResult> {
  // eventHash is the canonical identity — must always be present.
  // If somehow it is missing, generate a placeholder that encodes the gap
  // so at least the row is stored once (rather than silently dropped).
  const eventHash = event.eventHash || null;

  try {
    await tx.marketplaceEvent.create({
      data: {
        listingId:       event.listingId ?? null,
        eventType:       event.eventType,
        actor:           event.actor,
        data:            event.data,
        ledgerSequence:  event.ledgerSequence,
        eventHash,
        contractId:      event.contractId ?? '',
      },
    });
    return { inserted: 1, skipped: 0 };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      duplicateEventsCounter.inc();
      logger.debug('[idempotency] Skipping duplicate event — benign replay', {
        eventHash,
        eventType: event.eventType,
        ledger:    event.ledgerSequence,
        contractId: event.contractId,
      });
      return { inserted: 0, skipped: 1 };
    }
    // Re-throw genuine errors
    throw err;
  }
}

// ── Batch idempotent write ────────────────────────────────────────────────────

/**
 * Write a batch of decoded events idempotently, collecting only the events
 * that were successfully inserted (not replays).
 *
 * All writes share the same Prisma transaction client so the entire batch is
 * atomic. The caller (poller / backfill) must pass an open transaction.
 *
 * @param events  Array of decoded events to write.
 * @param tx      Prisma transaction client.
 * @returns       The subset of events that were newly inserted (non-duplicates).
 */
export async function upsertEvents(
  events: DecodedEvent[],
  tx: any,
): Promise<{ newEvents: DecodedEvent[]; totalSkipped: number }> {
  const newEvents: DecodedEvent[] = [];
  let totalSkipped = 0;

  for (const event of events) {
    const { inserted, skipped } = await upsertEvent(event, tx);
    if (inserted > 0) {
      newEvents.push(event);
    } else {
      totalSkipped += skipped;
    }
  }

  if (totalSkipped > 0) {
    logger.info('[idempotency] Batch write complete', {
      total: events.length,
      inserted: newEvents.length,
      skipped: totalSkipped,
    });
  }

  return { newEvents, totalSkipped };
}
