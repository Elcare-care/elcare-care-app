/**
 * fenced-lease.ts — Monotonically increasing fencing tokens for lease-guarded writes.
 *
 * Problem: The existing lease.ts uses PostgreSQL rows + Redis renewal to elect
 * a single active worker. However, a paused/partitioned poller can resume with
 * a stale lease and attempt writes after another instance has become leader.
 * A lease ownerId alone is insufficient because the new leader might have the
 * same role but a different ownerId — stale writers need to be rejected at the
 * DB precondition level, not just by checking ownerId.
 *
 * Solution: Every lease acquisition increments a global monotonic fencing token
 * stored in the WorkerLease row. Write operations that must be guarded by the
 * lease include the token as a precondition. If the token in the DB has advanced
 * past the caller's token, the write is rejected — the caller is a stale writer.
 *
 * Integration:
 *   - acquireFencedLease()   — acquires lease and returns a FencedLease handle
 *   - renewFencedLease()     — renews and increments token; returns false if lost
 *   - assertCurrentToken()   — throws StaleWriterError if our token is behind DB
 *   - fencedProgressWrite()  — wraps a progress/event write with token precondition
 *
 * Existing lease.ts remains the coordination plane; this module adds the write
 * fence. Import and use this module in place of raw prisma writes in poller.ts
 * and backfill.ts for ledger-progress and event-application transactions.
 */

import prismaWrite from './prisma-write.js';
import prisma from './db.js';
import { logger } from './logger.js';
import { type LeaseRole } from './coordination/lease.js';
import client from 'prom-client';

// ── Prometheus metrics ─────────────────────────────────────────────────────────

export const fencedWriteRejectionsTotal = new client.Counter({
  name: 'indexer_fenced_write_rejections_total',
  help: 'Total write attempts rejected due to stale lease fencing token',
  labelNames: ['role'],
});

export const fencedLeaseTokenGauge = new client.Gauge({
  name: 'indexer_fenced_lease_token',
  help: 'Current fencing token held by this instance',
  labelNames: ['role'],
});

export const fencedLeaseTakeoverTotal = new client.Counter({
  name: 'indexer_fenced_lease_takeover_total',
  help: 'Total lease takeovers detected via stale token rejection',
  labelNames: ['role'],
});

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FencedLease {
  role: LeaseRole;
  ownerId: string;
  /** Current monotonic fencing token. Increments on every renewal. */
  token: bigint;
  expiresAt: Date;
}

export class StaleWriterError extends Error {
  constructor(
    public readonly role: LeaseRole,
    public readonly ourToken: bigint,
    public readonly dbToken: bigint,
  ) {
    super(
      `[FencedLease] Stale writer detected for role=${role}: ` +
      `our token=${ourToken}, DB token=${dbToken}. ` +
      `This instance lost leadership — refusing write.`
    );
    this.name = 'StaleWriterError';
  }
}

// ── Internal state ─────────────────────────────────────────────────────────────

let _fencedLease: FencedLease | null = null;
let _renewTimer: ReturnType<typeof setInterval> | null = null;

const LEASE_TTL_MS   = parseInt(process.env.LEASE_TTL_MS    || '15000', 10);
const RENEW_INTERVAL = Math.max(1000, Math.floor(LEASE_TTL_MS * 0.4));

function randomOwnerId(): string {
  return `fenced-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

const OWNER_ID = randomOwnerId();

// ── Lease acquisition ─────────────────────────────────────────────────────────

/**
 * Acquires a fenced lease for the given role.
 *
 * The fencing token is stored in the WorkerLease row and monotonically
 * increments on every renewal. All write operations guarded by this lease
 * must call assertCurrentToken() before committing — stale writers are
 * detected when the DB token has advanced past theirs.
 *
 * Returns the FencedLease on success, null if another worker holds the lease.
 */
export async function acquireFencedLease(role: LeaseRole): Promise<FencedLease | null> {
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS);
  // Token starts as current epoch ms — monotonic across restarts
  const token = BigInt(Date.now());

  try {
    const row = await (prismaWrite as any).workerLease.create({
      data: {
        role,
        ownerId: OWNER_ID,
        token,
        expiresAt,
      },
    });

    _fencedLease = {
      role: row.role as LeaseRole,
      ownerId: row.ownerId,
      token: BigInt(row.token),
      expiresAt: row.expiresAt,
    };

    fencedLeaseTokenGauge.labels(role).set(Number(token));
    logger.info('[FencedLease] Acquired', { role, ownerId: OWNER_ID, token: token.toString(), expiresAt });

    _startRenewal(role);
    return _fencedLease;
  } catch (err: any) {
    if (err.code === 'P2002') {
      // Another worker holds this role
      logger.warn('[FencedLease] Contention — another worker holds the lease', { role });
      return null;
    }
    throw err;
  }
}

/**
 * Renews the fenced lease, incrementing the fencing token.
 * Returns false if the lease was lost (another worker took over).
 */
export async function renewFencedLease(role: LeaseRole): Promise<boolean> {
  if (!_fencedLease || _fencedLease.role !== role) return false;

  const newExpiresAt = new Date(Date.now() + LEASE_TTL_MS);
  const newToken = _fencedLease.token + 1n;

  try {
    const row = await (prismaWrite as any).workerLease.update({
      where: { role_ownerId: { role, ownerId: OWNER_ID } },
      data: {
        expiresAt: newExpiresAt,
        token: newToken,
      },
    });

    _fencedLease.expiresAt = row.expiresAt;
    _fencedLease.token = BigInt(row.token);

    fencedLeaseTokenGauge.labels(role).set(Number(_fencedLease.token));
    logger.debug('[FencedLease] Renewed', { role, token: _fencedLease.token.toString() });
    return true;
  } catch {
    logger.warn('[FencedLease] Renewal failed — lost lease', { role, ownerId: OWNER_ID });
    _fencedLease = null;
    fencedLeaseTokenGauge.labels(role).set(0);
    return false;
  }
}

/** Releases the fenced lease (best-effort). */
export function releaseFencedLease(role: LeaseRole): void {
  _stopRenewal();
  if (!_fencedLease || _fencedLease.role !== role) return;

  ;(prismaWrite as any).workerLease
    .delete({ where: { role_ownerId: { role, ownerId: OWNER_ID } } })
    .then(() => { logger.info('[FencedLease] Released', { role, ownerId: OWNER_ID }); })
    .catch(() => {/* best-effort */});

  _fencedLease = null;
  fencedLeaseTokenGauge.labels(role).set(0);
}

/** Returns the current fenced lease or null. */
export function getCurrentFencedLease(): FencedLease | null {
  return _fencedLease;
}

// ── Fencing precondition ───────────────────────────────────────────────────────

/**
 * Asserts that our current fencing token is still the latest in the DB.
 * Throws StaleWriterError if another leader has incremented the token past ours.
 *
 * Call this inside a DB transaction BEFORE any protected write to ensure no
 * stale commit can corrupt the canonical cursor.
 *
 * @param role   The lease role to check.
 * @param tx     The Prisma transaction client (use the same tx as the write).
 */
export async function assertCurrentToken(role: LeaseRole, tx: any): Promise<void> {
  if (!_fencedLease || _fencedLease.role !== role) {
    throw new StaleWriterError(role, 0n, 0n);
  }

  const ourToken = _fencedLease.token;

  // Read the DB token inside the transaction for a consistent view
  const row = await tx.workerLease.findFirst({
    where: { role },
    select: { token: true, ownerId: true },
  });

  if (!row) {
    // Lease row is gone — we lost leadership
    fencedWriteRejectionsTotal.labels(role).inc();
    fencedLeaseTakeoverTotal.labels(role).inc();
    logger.error('[FencedLease] Lease row missing — stale writer detected', {
      role,
      ourToken: ourToken.toString(),
    });
    throw new StaleWriterError(role, ourToken, 0n);
  }

  const dbToken = BigInt(row.token);

  if (dbToken > ourToken) {
    // Another leader has renewed past our token
    fencedWriteRejectionsTotal.labels(role).inc();
    fencedLeaseTakeoverTotal.labels(role).inc();
    logger.error('[FencedLease] Stale writer detected — DB token ahead of ours', {
      role,
      ourToken: ourToken.toString(),
      dbToken: dbToken.toString(),
      dbOwnerId: row.ownerId,
    });
    throw new StaleWriterError(role, ourToken, dbToken);
  }
}

// ── Guarded write helper ───────────────────────────────────────────────────────

/**
 * Executes a write function inside a Prisma transaction with a fencing
 * precondition. If the fencing check fails (stale writer), the transaction
 * is rolled back and StaleWriterError is thrown without touching DB state.
 *
 * Usage in poller.ts ledger-progress writes:
 *
 *   await fencedWrite('poller', async (tx) => {
 *     await applyDecodedEvents(events, tx);
 *     await commitCheckpoint(cp, count, hash, contractId, tx);
 *   });
 *
 * @param role  The lease role that must be held.
 * @param fn    Write function; receives a Prisma transaction client.
 */
export async function fencedWrite<T>(
  role: LeaseRole,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  return (prismaWrite as any).$transaction(async (tx: any) => {
    // Assert fencing token first — rolls back if stale
    await assertCurrentToken(role, tx);
    return fn(tx);
  });
}

// ── Internals ─────────────────────────────────────────────────────────────────

function _startRenewal(role: LeaseRole): void {
  _stopRenewal();
  _renewTimer = setInterval(() => {
    void renewFencedLease(role);
  }, RENEW_INTERVAL);
}

function _stopRenewal(): void {
  if (_renewTimer) {
    clearInterval(_renewTimer);
    _renewTimer = null;
  }
}
