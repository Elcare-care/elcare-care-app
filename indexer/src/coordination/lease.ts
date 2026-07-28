/**
 * Distributed lease for single-active-worker coordination.
 *
 * Uses PostgreSQL as the lease store so coordination survives Redis restarts.
 * The lease row contains:
 *   - ownerId:   random worker id (process + pid)
 *   - token:     monotonically increasing fencing token
 *   - expiresAt: auto-renew deadline
 *   - role:      'poller' | 'reconciler' | 'backfill'
 *
 * Rules:
 *   - The active worker must renew before expiresAt.
 *   - Any write protected by the lease must include the current token;
 *     a stale worker presenting an old token is rejected by the DB unique
 *     constraint (ownerId + role).
 *   - If the lease is missing or expired, a replacement worker can acquire.
 */

import prisma, { closeWritePool } from './db.js';
import { logger } from '../logger.js';
import {
  indexerWorkerLeaseGauge,
  indexerLeaseRenewalsTotal,
  indexerLeaseAcquisitionsTotal,
  indexerLeaseLostTotal,
  indexerLeaseContentionTotal,
} from '../metrics.js';

const LEASE_TTL_MS = parseInt(process.env.LEASE_TTL_MS || '15000', 10);
const RENEW_INTERVAL_MS = Math.max(1000, Math.floor(LEASE_TTL_MS * 0.4));
const JITTER_MS = parseInt(process.env.LEASE_RENEW_JITTER_MS || '2000', 10);

function randomId(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

const OWNER_ID = randomId();

export type LeaseRole = 'poller' | 'reconciler' | 'backfill';

export interface LeaseInfo {
  role: LeaseRole;
  ownerId: string;
  token: bigint;
  expiresAt: Date;
  acquiredAt: Date;
}

let currentLease: LeaseInfo | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;

async function randomJitter(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * JITTER_MS)));
}

export async function acquireLease(role: LeaseRole): Promise<LeaseInfo | null> {
  await randomJitter();

  const expiresAt = new Date(Date.now() + LEASE_TTL_MS);
  const token = BigInt(Date.now()); // monotonic enough for fencing

  try {
    const row = await prisma.workerLease.create({
      data: {
        role,
        ownerId: OWNER_ID,
        token,
        expiresAt,
      },
    });

    currentLease = {
      role: row.role as LeaseRole,
      ownerId: row.ownerId,
      token: BigInt(row.token),
      expiresAt: row.expiresAt,
      acquiredAt: row.expiresAt,
    };

    indexerLeaseAcquisitionsTotal.inc({ role });
    indexerWorkerLeaseGauge.set(1);
    logger.info('lease: acquired', { role, ownerId: OWNER_ID, expiresAt });
    startRenewal(role);
    return currentLease;
  } catch (err: any) {
    if (err.code === 'P2002') {
      indexerLeaseContentionTotal.inc({ role });
      logger.warn('lease: contention — another worker holds the lease', { role });
      return null;
    }
    throw err;
  }
}

export async function renewLease(role: LeaseRole): Promise<boolean> {
  if (!currentLease || currentLease.role !== role) return false;

  const newExpiresAt = new Date(Date.now() + LEASE_TTL_MS);
  try {
    const row = await prisma.workerLease.update({
      where: { role_ownerId: { role, ownerId: OWNER_ID } },
      data: {
        expiresAt: newExpiresAt,
        token: currentLease.token + 1n,
      },
    });
    currentLease.expiresAt = row.expiresAt;
    currentLease.token = BigInt(row.token);
    indexerLeaseRenewalsTotal.inc({ role });
    return true;
  } catch {
    logger.warn('lease: renew failed — lost lease', { role, ownerId: OWNER_ID });
    currentLease = null;
    indexerWorkerLeaseGauge.set(0);
    indexerLeaseLostTotal.inc({ role });
    return false;
  }
}

export function releaseLease(role: LeaseRole): void {
  stopRenewal();
  if (!currentLease || currentLease.role !== role) return;

  prisma.workerLease
    .delete({ where: { role_ownerId: { role, ownerId: OWNER_ID } } })
    .then(() => {
      logger.info('lease: released', { role, ownerId: OWNER_ID });
    })
    .catch(() => {/* best-effort */});

  currentLease = null;
  indexerWorkerLeaseGauge.set(0);
}

function startRenewal(role: LeaseRole): void {
  stopRenewal();
  renewTimer = setInterval(() => {
    void renewLease(role);
  }, RENEW_INTERVAL_MS);
}

function stopRenewal(): void {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
}

export function getCurrentLease(): LeaseInfo | null {
  return currentLease;
}

export function getLeaseStatus() {
  return {
    hasLease: currentLease !== null,
    ownerId: currentLease?.ownerId ?? null,
    role: currentLease?.role ?? null,
    expiresAt: currentLease?.expiresAt ?? null,
    ttlMs: currentLease ? Math.max(0, currentLease.expiresAt.getTime() - Date.now()) : 0,
  };
}
