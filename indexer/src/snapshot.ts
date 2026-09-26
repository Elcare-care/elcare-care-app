/**
 * snapshot.ts — Immutable ledger snapshots for recovery and audit.
 *
 * Overview
 * --------
 * After every SNAPSHOT_INTERVAL committed batches, writeSnapshot() creates
 * an IndexerSnapshot row capturing:
 *   - ledgerSequence + ledgerHash   — the sync cursor at this point
 *   - contractCursors               — per-contract last-ledger map
 *   - eventCount                    — total MarketplaceEvent rows
 *   - schemaVersion                 — running binary's schema string
 *
 * verifySnapshot() cross-checks the stored ledgerHash against the Stellar
 * RPC getLedger response.  On mismatch the snapshot transitions to status=Mismatch,
 * sets hashMismatch=true, and increments snapshotHashMismatchGauge — operators
 * must resolve the discrepancy before using this snapshot for recovery.
 *
 * Recovery query
 * --------------
 * Use findLastVerifiedSnapshot(atOrBeforeLedger) to locate the latest Verified
 * snapshot at or before a given ledger.  Recover to that ledger then replay
 * events forward from the event log.
 *
 * CLI
 * ---
 * tsx src/snapshot.ts --list [--limit=20]
 * tsx src/snapshot.ts --inspect --id=<n>
 * tsx src/snapshot.ts --verify  --id=<n>
 * tsx src/snapshot.ts --validate --from=<ledger> [--to=<ledger>]
 */

import prismaWrite from './prisma-write.js';
import prismaRead  from './db.js';
import { logger }  from './logger.js';
import { VERSION } from './config.js';
import { getAuditService } from './audit/audit-service.js';
import {
  snapshotsWrittenTotal,
  snapshotVerificationsTotal,
  snapshotHashMismatchGauge,
} from './metrics.js';

// ── Config ────────────────────────────────────────────────────────────────────

/** Write a snapshot every N committed batch windows. Default: 10. */
export const SNAPSHOT_INTERVAL = parseInt(process.env.SNAPSHOT_INTERVAL ?? '10', 10);

// ── Types ─────────────────────────────────────────────────────────────────────

export type SnapshotStatusFilter = 'Pending' | 'Verified' | 'Mismatch' | 'Invalid' | undefined;

export interface WriteSnapshotOptions {
  ledgerSequence: number;
  ledgerHash:     string;
  /** Map of { contractId → lastLedger } at this point. */
  contractCursors: Record<string, number>;
  /** Passed-in so the caller controls the count (avoids a separate SELECT). */
  eventCount:     bigint;
}

export interface VerifySnapshotOptions {
  actor:      string;
  ipAddress?: string;
}

export interface VerifySnapshotResult {
  id:           number;
  ledgerSequence: number;
  storedHash:   string;
  rpcHash:      string | null;
  match:        boolean;
  status:       string;
}

// ── Counter: track how many batches since last snapshot ──────────────────────

let _batchesSinceSnapshot = 0;

export function resetSnapshotCounter(): void {
  _batchesSinceSnapshot = 0;
}

/** Called after every committed batch. Returns the new snapshot if one was written. */
export async function maybeWriteSnapshot(opts: WriteSnapshotOptions): Promise<void> {
  _batchesSinceSnapshot++;
  if (_batchesSinceSnapshot < SNAPSHOT_INTERVAL) return;
  _batchesSinceSnapshot = 0;
  await writeSnapshot(opts);
}

// ── writeSnapshot ─────────────────────────────────────────────────────────────

/**
 * Persist an immutable IndexerSnapshot row.
 *
 * Safe to call from within a transaction context — uses prismaWrite directly
 * so it participates in the calling process's connection pool.
 */
export async function writeSnapshot(opts: WriteSnapshotOptions): Promise<number> {
  const schemaVersion = [VERSION.app, VERSION.dbMigration].join('/');

  const snapshot = await (prismaWrite as any).indexerSnapshot.create({
    data: {
      ledgerSequence:  opts.ledgerSequence,
      ledgerHash:      opts.ledgerHash,
      contractCursors: opts.contractCursors,
      eventCount:      opts.eventCount,
      schemaVersion,
      rpcVerified:     false,
      hashMismatch:    false,
      status:          'Pending',
    },
  });

  snapshotsWrittenTotal.inc();

  logger.info('snapshot: written', {
    id:             snapshot.id,
    ledgerSequence: opts.ledgerSequence,
    schemaVersion,
    eventCount:     opts.eventCount.toString(),
  });

  return snapshot.id;
}

// ── verifySnapshot ────────────────────────────────────────────────────────────

/**
 * Cross-check a snapshot's ledgerHash against the Stellar RPC.
 *
 * On match:    status → Verified, rpcVerified = true
 * On mismatch: status → Mismatch, hashMismatch = true, rpcHash recorded
 * On RPC error: logs warning but does not change snapshot status
 */
export async function verifySnapshot(
  id: number,
  opts: VerifySnapshotOptions,
): Promise<VerifySnapshotResult> {
  const snapshot = await (prismaRead as any).indexerSnapshot.findUnique({ where: { id } });
  if (!snapshot) {
    throw Object.assign(new Error(`Snapshot ${id} not found`), { statusCode: 404 });
  }

  // ── Fetch ledger hash from RPC ───────────────────────────────────────────
  let rpcHash: string | null = null;
  let rpcError: string | null = null;

  try {
    const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
    // Use the Stellar SDK to fetch the ledger header
    const { rpc } = await import('@stellar/stellar-sdk');
    const server   = new rpc.Server(rpcUrl);
    const ledger   = await (server as any).getLedger({ ledgerSeq: snapshot.ledgerSequence });
    rpcHash        = ledger?.ledgerHash ?? ledger?.hash ?? null;
  } catch (err) {
    rpcError = err instanceof Error ? err.message : String(err);
    logger.warn('snapshot.verify: RPC ledger fetch failed', { id, ledgerSequence: snapshot.ledgerSequence, err: rpcError });
  }

  // ── Compare ──────────────────────────────────────────────────────────────
  const match  = rpcHash !== null && rpcHash === snapshot.ledgerHash;
  const mismatch = rpcHash !== null && rpcHash !== snapshot.ledgerHash;

  if (rpcHash !== null) {
    const newStatus = match ? 'Verified' : 'Mismatch';

    await (prismaWrite as any).indexerSnapshot.update({
      where: { id },
      data: {
        rpcVerified:  true,
        rpcHash:      rpcHash,
        hashMismatch: mismatch,
        status:       newStatus,
        ...(match ? {} : { notes: `Hash mismatch detected at ${new Date().toISOString()}` }),
      },
    });

    snapshotVerificationsTotal.inc({ result: match ? 'match' : 'mismatch' });
    snapshotHashMismatchGauge.set(mismatch ? 1 : 0);

    if (mismatch) {
      logger.error('snapshot.verify: HASH MISMATCH — do not use this snapshot for automated recovery', {
        id,
        ledgerSequence: snapshot.ledgerSequence,
        storedHash:     snapshot.ledgerHash,
        rpcHash,
      });
    } else {
      logger.info('snapshot.verify: verified OK', { id, ledgerSequence: snapshot.ledgerSequence });
    }
  } else {
    snapshotVerificationsTotal.inc({ result: 'error' });
  }

  // ── Audit log ────────────────────────────────────────────────────────────
  await getAuditService(prismaWrite as any).log({
    actor:      opts.actor,
    actionType: 'SnapshotVerify' as any,
    target:     String(id),
    outcome:    rpcError ? 'Failure' as any : (match ? 'Success' as any : 'Partial' as any),
    context:    {
      snapshotId:     id,
      ledgerSequence: snapshot.ledgerSequence,
      storedHash:     snapshot.ledgerHash,
      rpcHash,
      match,
      rpcError,
    },
    ipAddress: opts.ipAddress,
  }).catch((err: unknown) => {
    logger.warn('snapshot.verify: audit log failed', { err: err instanceof Error ? err.message : String(err) });
  });

  return {
    id,
    ledgerSequence: snapshot.ledgerSequence,
    storedHash:     snapshot.ledgerHash,
    rpcHash,
    match,
    status:         rpcHash !== null ? (match ? 'Verified' : 'Mismatch') : snapshot.status,
  };
}

// ── List / inspect ────────────────────────────────────────────────────────────

export async function listSnapshots(opts: { limit?: number; offset?: number; status?: SnapshotStatusFilter } = {}) {
  const { limit = 20, offset = 0, status } = opts;
  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  const [records, total] = await Promise.all([
    (prismaRead as any).indexerSnapshot.findMany({
      where,
      orderBy: { ledgerSequence: 'desc' },
      take:    Math.min(limit, 100),
      skip:    offset,
    }),
    (prismaRead as any).indexerSnapshot.count({ where }),
  ]);

  return { records, total, limit, offset };
}

export async function getSnapshot(id: number) {
  return (prismaRead as any).indexerSnapshot.findUnique({ where: { id } });
}

/**
 * Recovery helper: find the most recent Verified snapshot at or before
 * the given ledger sequence.  Returns null if none exists.
 */
export async function findLastVerifiedSnapshot(atOrBeforeLedger: number) {
  return (prismaRead as any).indexerSnapshot.findFirst({
    where: {
      status:         'Verified',
      ledgerSequence: { lte: atOrBeforeLedger },
    },
    orderBy: { ledgerSequence: 'desc' },
  });
}

// ── Validate range ────────────────────────────────────────────────────────────

/**
 * Validate all snapshots in a ledger range.
 * Returns a summary of verified/mismatch/pending/invalid counts.
 */
export async function validateSnapshotRange(fromLedger: number, toLedger: number) {
  const snapshots = await (prismaRead as any).indexerSnapshot.findMany({
    where: {
      ledgerSequence: { gte: fromLedger, lte: toLedger },
    },
    orderBy: { ledgerSequence: 'asc' },
  });

  const summary = {
    total:    snapshots.length,
    verified: 0,
    mismatch: 0,
    pending:  0,
    invalid:  0,
    gaps:     [] as Array<{ from: number; to: number }>,
  };

  for (const s of snapshots) {
    switch (s.status) {
      case 'Verified': summary.verified++; break;
      case 'Mismatch': summary.mismatch++; break;
      case 'Pending':  summary.pending++;  break;
      default:         summary.invalid++;  break;
    }
  }

  // Detect ledger gaps between consecutive snapshots
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    // A gap is only notable if there are many ledgers between snapshots
    if (curr.ledgerSequence - prev.ledgerSequence > SNAPSHOT_INTERVAL * 100) {
      summary.gaps.push({ from: prev.ledgerSequence, to: curr.ledgerSequence });
    }
  }

  return { ...summary, snapshots };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function cliMain() {
  const argv = process.argv.slice(2);
  const flag  = (n: string) => argv.includes(`--${n}`);
  const opt   = (n: string) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.slice(n.length + 3) : undefined; };

  if (flag('list')) {
    const limit  = parseInt(opt('limit') ?? '20', 10);
    const offset = parseInt(opt('offset') ?? '0', 10);
    const status = opt('status') as SnapshotStatusFilter;
    const { records, total } = await listSnapshots({ limit, offset, status });
    console.log(`Showing ${records.length} of ${total} snapshot(s):\n`);
    for (const s of records) {
      console.log(
        `  id=${s.id}  ledger=${s.ledgerSequence}  status=${s.status}` +
        `  mismatch=${s.hashMismatch}  events=${s.eventCount}` +
        `  schema=${s.schemaVersion}  created=${new Date(s.createdAt).toISOString()}`,
      );
    }
  } else if (flag('inspect')) {
    const id = parseInt(opt('id') ?? '', 10);
    if (isNaN(id)) { console.error('--inspect requires --id=<number>'); process.exitCode = 1; return; }
    const s = await getSnapshot(id);
    if (!s) { console.error(`Snapshot ${id} not found`); process.exitCode = 1; return; }
    console.log(JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else if (flag('verify')) {
    const id = parseInt(opt('id') ?? '', 10);
    if (isNaN(id)) { console.error('--verify requires --id=<number>'); process.exitCode = 1; return; }
    const result = await verifySnapshot(id, { actor: `cli:${process.env.USER ?? 'operator'}` });
    console.log(`Verification result: id=${result.id} ledger=${result.ledgerSequence}`);
    console.log(`  storedHash=${result.storedHash}`);
    console.log(`  rpcHash=${result.rpcHash ?? '(rpc error)'}`);
    console.log(`  match=${result.match}  status=${result.status}`);
    if (!result.match && result.rpcHash !== null) {
      console.error('\n⚠ HASH MISMATCH — do not use this snapshot for automated recovery');
      process.exitCode = 1;
    }
  } else if (flag('validate')) {
    const from = parseInt(opt('from') ?? '', 10);
    if (isNaN(from)) { console.error('--validate requires --from=<ledger>'); process.exitCode = 1; return; }
    const to = parseInt(opt('to') ?? String(Number.MAX_SAFE_INTEGER), 10);
    const summary = await validateSnapshotRange(from, to);
    console.log(`Snapshot range validation: ledgers ${from}–${to}`);
    console.log(`  total=${summary.total}  verified=${summary.verified}  mismatch=${summary.mismatch}  pending=${summary.pending}  invalid=${summary.invalid}`);
    if (summary.gaps.length > 0) {
      console.log(`  gaps detected: ${summary.gaps.map((g) => `${g.from}–${g.to}`).join(', ')}`);
    }
    if (summary.mismatch > 0 || summary.invalid > 0) process.exitCode = 1;
  } else {
    console.log(
      'Usage:\n' +
      '  tsx src/snapshot.ts --list [--limit=20] [--status=Pending|Verified|Mismatch]\n' +
      '  tsx src/snapshot.ts --inspect --id=<n>\n' +
      '  tsx src/snapshot.ts --verify  --id=<n>\n' +
      '  tsx src/snapshot.ts --validate --from=<ledger> [--to=<ledger>]',
    );
  }
}

// Run as CLI only when executed directly
if (process.argv[1]?.endsWith('snapshot.ts') || process.argv[1]?.endsWith('snapshot.js')) {
  cliMain()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(async () => { await prismaWrite.$disconnect(); });
}
