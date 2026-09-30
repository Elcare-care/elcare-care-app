/**
 * dead-letter-service.ts — Authenticated admin service for dead-letter management.
 *
 * Provides:
 *   - listDeadLetters()       — paginated list with status filter
 *   - inspectDeadLetter()     — full record including redacted payload
 *   - remediateDeadLetter()   — set remediationReason before replay
 *   - replayDeadLetter()      — parse + project with idempotency lock + audit record
 *
 * Design constraints:
 *   - Idempotency: requests carrying the same idempotencyKey return the stored
 *     outcome without re-running logic (prevents accidental double-replay on
 *     network retries).
 *   - Concurrency: lockedAt acts as an optimistic lock; a record already in-flight
 *     returns 409. Locks expire after REPLAY_LOCK_TTL_SECONDS.
 *   - Audit: every attempt (including failures) creates a DeadLetterReplayAttempt
 *     row AND an OperationalAudit row.
 *   - Projection safety: the event is re-projected before the dead-letter status
 *     is changed to Replayed, so a crash after commit leaves the record Pending
 *     (retryable) rather than Replayed (forgotten).
 */

import prismaWrite from './prisma-write.js';
import prismaRead  from './db.js';
import { parseMarketplaceEvent } from './parser.js';
import { processEvent } from './poller.js';
import { getAuditService } from './audit/audit-service.js';
import { logger } from './logger.js';
import {
  deadLetterReplayAttemptsTotal,
  deadLetterPendingGauge,
} from './metrics.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REPLAY_ATTEMPTS  = 3;
/** Seconds before a lockedAt timestamp is considered stale and ignored. */
const REPLAY_LOCK_TTL_SECONDS = 120;

// ── Public types ──────────────────────────────────────────────────────────────

export type DeadLetterStatusFilter = 'Pending' | 'Replayed' | 'Failed' | undefined;

export interface ListDeadLettersOptions {
  status?: DeadLetterStatusFilter;
  limit?: number;
  offset?: number;
  contractId?: string;
}

export interface ReplayOptions {
  actor: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RemediateOptions {
  remediationReason: string;
  actor: string;
  ipAddress?: string;
}

export interface ReplayResult {
  outcome: 'success' | 'parse_null' | 'parse_error' | 'projection_error' | 'duplicate';
  parsedEventType?: string;
  projectionCommitted: boolean;
  dryRun: boolean;
  durationMs: number;
  errorMessage?: string;
  attemptId: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLockStale(lockedAt: Date | null): boolean {
  if (!lockedAt) return true;
  const ageMs = Date.now() - lockedAt.getTime();
  return ageMs > REPLAY_LOCK_TTL_SECONDS * 1000;
}

/** Redact rawTopics/rawValue for safe API exposure (truncate, no stack frames). */
function redactPayload(rawTopics: unknown, rawValue: string): { rawTopics: unknown; rawValue: string } {
  const topics = Array.isArray(rawTopics)
    ? (rawTopics as string[]).map((t) => (typeof t === 'string' ? t.slice(0, 128) : t))
    : rawTopics;
  return {
    rawTopics: topics,
    rawValue: typeof rawValue === 'string' ? rawValue.slice(0, 256) : rawValue,
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listDeadLetters(opts: ListDeadLettersOptions = {}) {
  const { status, limit = 50, offset = 0, contractId } = opts;

  const where: Record<string, unknown> = {};
  if (status)     where.status     = status;
  if (contractId) where.contractId = contractId;

  const [records, total] = await Promise.all([
    (prismaRead as any).deadLetterEvent.findMany({
      where,
      take:    Math.min(limit, 200),
      skip:    offset,
      orderBy: { createdAt: 'asc' },
      select: {
        id:                true,
        status:            true,
        errorCode:         true,
        contractId:        true,
        ledgerSequence:    true,
        txHash:            true,
        eventIndex:        true,
        attempts:          true,
        remediationReason: true,
        replayedBy:        true,
        lockedAt:          true,
        createdAt:         true,
        updatedAt:         true,
        _count:            { select: { replayAttempts: true } },
      },
    }),
    (prismaRead as any).deadLetterEvent.count({ where }),
  ]);

  return { records, total, limit, offset };
}

// ── Inspect ───────────────────────────────────────────────────────────────────

export async function inspectDeadLetter(id: number) {
  const record = await (prismaRead as any).deadLetterEvent.findUnique({
    where: { id },
    include: {
      replayAttempts: {
        orderBy: { attemptedAt: 'desc' },
        take: 20,
      },
    },
  });
  if (!record) return null;

  const { rawTopics, rawValue } = redactPayload(record.rawTopics, record.rawValue);
  return { ...record, rawTopics, rawValue };
}

// ── Remediate (set reason before replay) ─────────────────────────────────────

export async function remediateDeadLetter(id: number, opts: RemediateOptions): Promise<void> {
  const record = await (prismaRead as any).deadLetterEvent.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!record) throw Object.assign(new Error(`Dead-letter record ${id} not found`), { statusCode: 404 });
  if (record.status === 'Replayed') {
    throw Object.assign(new Error(`Record ${id} is already Replayed`), { statusCode: 409 });
  }

  await (prismaWrite as any).deadLetterEvent.update({
    where: { id },
    data: {
      remediationReason: opts.remediationReason.slice(0, 1000),
      replayedBy: opts.actor,
    },
  });

  await getAuditService(prismaWrite as any).log({
    actor:      opts.actor,
    actionType: 'DeadLetterRemediate' as any,
    target:     String(id),
    outcome:    'Success' as any,
    context:    { deadLetterId: id, reason: opts.remediationReason.slice(0, 200) },
    ipAddress:  opts.ipAddress,
  }).catch((err: unknown) => {
    logger.warn('dead-letter-service: audit log failed for remediate', {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  logger.info('dead-letter-service: remediation reason set', { id, actor: opts.actor });
}

// ── Replay ────────────────────────────────────────────────────────────────────

export async function replayDeadLetter(id: number, opts: ReplayOptions): Promise<ReplayResult> {
  const start = Date.now();

  // ── Idempotency check ────────────────────────────────────────────────────
  if (opts.idempotencyKey) {
    const existing = await (prismaRead as any).deadLetterEvent.findFirst({
      where: { idempotencyKey: opts.idempotencyKey },
      include: { replayAttempts: { orderBy: { attemptedAt: 'desc' }, take: 1 } },
    });
    if (existing && existing.id !== id) {
      throw Object.assign(
        new Error(`Idempotency key already used for dead-letter ${existing.id}`),
        { statusCode: 409 },
      );
    }
    // Same record — return last attempt outcome if already replayed
    if (existing && existing.status === 'Replayed') {
      const last = existing.replayAttempts[0];
      return {
        outcome:             'duplicate',
        parsedEventType:     last?.parsedEventType ?? undefined,
        projectionCommitted: false,
        dryRun:              opts.dryRun ?? false,
        durationMs:          0,
        attemptId:           last?.id ?? 0,
      };
    }
  }

  // ── Load record ──────────────────────────────────────────────────────────
  const record = await (prismaRead as any).deadLetterEvent.findUnique({ where: { id } });
  if (!record) throw Object.assign(new Error(`Dead-letter record ${id} not found`), { statusCode: 404 });

  if (record.status === 'Replayed') {
    const attempt = await (prismaWrite as any).deadLetterReplayAttempt.create({
      data: {
        deadLetterId:        id,
        actor:               opts.actor,
        outcome:             'duplicate',
        projectionCommitted: false,
        dryRun:              opts.dryRun ?? false,
        idempotencyKey:      opts.idempotencyKey ?? null,
        durationMs:          Date.now() - start,
      },
    });
    deadLetterReplayAttemptsTotal.inc({ outcome: 'duplicate' });
    return { outcome: 'duplicate', projectionCommitted: false, dryRun: opts.dryRun ?? false, durationMs: Date.now() - start, attemptId: attempt.id };
  }

  // ── Concurrency lock ─────────────────────────────────────────────────────
  if (!isLockStale(record.lockedAt)) {
    throw Object.assign(
      new Error(`Record ${id} is currently being replayed (lockedAt=${record.lockedAt?.toISOString()})`),
      { statusCode: 409 },
    );
  }

  if (!opts.dryRun) {
    await (prismaWrite as any).deadLetterEvent.update({
      where: { id },
      data:  { lockedAt: new Date(), ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) },
    });
  }

  // ── Attempt replay ───────────────────────────────────────────────────────
  let outcome: ReplayResult['outcome'] = 'parse_error';
  let parsedEventType: string | undefined;
  let projectionCommitted = false;
  let errorMessage: string | undefined;

  try {
    const topics = Array.isArray(record.rawTopics) ? (record.rawTopics as string[]) : [];
    const decoded = parseMarketplaceEvent(
      topics,
      record.rawValue,
      record.ledgerSequence,
      record.contractId,
      record.txHash,
      record.eventIndex,
    );

    if (!decoded) {
      outcome = 'parse_null';
      logger.info('dead-letter-service: parse returned null', { id });
    } else {
      parsedEventType = decoded.eventType;
      outcome         = 'success';

      if (!opts.dryRun) {
        // Re-project the event through the normal processEvent pipeline.
        // processEvent is idempotent via the eventHash unique constraint.
        await processEvent(decoded);
        projectionCommitted = true;
      }
    }
  } catch (err) {
    outcome      = 'projection_error';
    errorMessage = err instanceof Error ? err.message.slice(0, 1000) : String(err);
    logger.warn('dead-letter-service: replay attempt failed', { id, errorMessage });
  }

  // ── Persist outcome ──────────────────────────────────────────────────────
  const durationMs = Date.now() - start;
  let attemptId = 0;

  if (!opts.dryRun) {
    const nextAttempts = record.attempts + 1;
    const newStatus = outcome === 'success'
      ? 'Replayed'
      : nextAttempts >= MAX_REPLAY_ATTEMPTS
        ? 'Failed'
        : record.status; // keep Pending

    await (prismaWrite as any).$transaction(async (tx: any) => {
      const attempt = await tx.deadLetterReplayAttempt.create({
        data: {
          deadLetterId:        id,
          actor:               opts.actor,
          outcome,
          errorMessage:        errorMessage ?? null,
          parsedEventType:     parsedEventType ?? null,
          projectionCommitted,
          dryRun:              false,
          idempotencyKey:      opts.idempotencyKey ?? null,
          durationMs,
        },
      });
      attemptId = attempt.id;

      // Only update status AFTER projection committed (if success)
      await tx.deadLetterEvent.update({
        where: { id },
        data:  {
          attempts:   { increment: 1 },
          status:     newStatus,
          replayedBy: opts.actor,
          lockedAt:   null, // always clear the lock
          ...(outcome !== 'success' && errorMessage ? { errorMessage } : {}),
        },
      });
    });

    // Update pending gauge (best-effort)
    (prismaRead as any).deadLetterEvent.count({ where: { status: 'Pending' } })
      .then((n: number) => deadLetterPendingGauge.set(n))
      .catch(() => {});
  } else {
    // dry-run: still record the attempt for audit purposes
    const attempt = await (prismaWrite as any).deadLetterReplayAttempt.create({
      data: {
        deadLetterId:        id,
        actor:               opts.actor,
        outcome,
        errorMessage:        errorMessage ?? null,
        parsedEventType:     parsedEventType ?? null,
        projectionCommitted: false,
        dryRun:              true,
        idempotencyKey:      opts.idempotencyKey ?? null,
        durationMs,
      },
    }).catch(() => ({ id: 0 }));
    attemptId = attempt.id;

    // Clear lock if we set it (we don't set it in dry-run, but guard anyway)
    await (prismaWrite as any).deadLetterEvent.update({ where: { id }, data: { lockedAt: null } }).catch(() => {});
  }

  // ── Metrics ──────────────────────────────────────────────────────────────
  deadLetterReplayAttemptsTotal.inc({ outcome });

  // ── Operational audit ────────────────────────────────────────────────────
  await getAuditService(prismaWrite as any).log({
    actor:      opts.actor,
    actionType: 'DeadLetterReplay' as any,
    target:     String(id),
    outcome:    outcome === 'success' ? 'Success' as any : 'Failure' as any,
    context:    {
      deadLetterId:        id,
      replayOutcome:       outcome,
      parsedEventType:     parsedEventType ?? null,
      projectionCommitted,
      dryRun:              opts.dryRun ?? false,
      errorMessage:        errorMessage ?? null,
    },
    ipAddress: opts.ipAddress,
    userAgent: opts.userAgent,
  }).catch((err: unknown) => {
    logger.warn('dead-letter-service: audit log failed for replay', {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  logger.info('dead-letter-service: replay complete', { id, outcome, parsedEventType, projectionCommitted, dryRun: opts.dryRun, durationMs });

  return { outcome, parsedEventType, projectionCommitted, dryRun: opts.dryRun ?? false, durationMs, attemptId };
}

// ── Batch replay ─────────────────────────────────────────────────────────────

export interface BatchReplayOptions extends ReplayOptions {
  ids?: number[];
  limit?: number;
  status?: DeadLetterStatusFilter;
}

export interface BatchReplayResult {
  total:     number;
  succeeded: number;
  failed:    number;
  skipped:   number;
  results:   Array<{ id: number; result: ReplayResult | { error: string } }>;
}

export async function replayDeadLetterBatch(opts: BatchReplayOptions): Promise<BatchReplayResult> {
  const where: Record<string, unknown> = { status: opts.status ?? 'Pending' };
  if (opts.ids?.length) where.id = { in: opts.ids };

  const records = await (prismaRead as any).deadLetterEvent.findMany({
    where,
    take:    Math.min(opts.limit ?? 10, 50),
    orderBy: { createdAt: 'asc' },
    select:  { id: true },
  });

  const results: BatchReplayResult['results'] = [];
  let succeeded = 0, failed = 0, skipped = 0;

  for (const { id } of records) {
    try {
      const result = await replayDeadLetter(id, opts);
      results.push({ id, result });
      if (result.outcome === 'success') succeeded++;
      else if (result.outcome === 'duplicate') skipped++;
      else failed++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ id, result: { error } });
      failed++;
    }
  }

  return { total: records.length, succeeded, failed, skipped, results };
}
