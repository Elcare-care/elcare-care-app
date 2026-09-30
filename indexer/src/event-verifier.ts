/**
 * event-verifier.ts — Read-only event integrity verifier.
 *
 * Compares expected event identities from the Stellar RPC with indexed
 * identities in the database and reports:
 *   - duplicates     : same eventHash appears more than once in DB
 *   - omissions      : events visible on RPC not found in DB
 *   - orphan projections : DB events with no matching on-chain identity
 *   - ledger discontinuities : gaps in the DB ledger cursor within the range
 *
 * This verifier is READ-ONLY — it never mutates production data.
 * It streams comparisons in ledger-window batches to avoid memory spikes
 * and supports a resumable cursor so large ranges can be checkpointed.
 *
 * Usage (CLI):
 *   npm run cli -- verify --from=1000000 --to=1010000 [--contract=C...]
 *
 * Usage (API):
 *   GET /admin/verify-events?from=1000000&to=1010000&contract=C...
 */

import { rpc } from '@stellar/stellar-sdk';
import prisma from './db.js';
import { collectMarketplaceEvents } from './event-sync.js';
import { computeEventHash } from './parser.js';
import { logger } from './logger.js';
import client from 'prom-client';

// ── Prometheus counters ────────────────────────────────────────────────────────

export const verifierDuplicatesTotal = new client.Counter({
  name: 'indexer_verifier_duplicates_total',
  help: 'Total duplicate event hashes detected during event integrity verification',
});

export const verifierOmissionsTotal = new client.Counter({
  name: 'indexer_verifier_omissions_total',
  help: 'Total events found on RPC but missing from the DB during verification',
});

export const verifierOrphansTotal = new client.Counter({
  name: 'indexer_verifier_orphans_total',
  help: 'Total DB events with no matching on-chain identity during verification',
});

export const verifierDiscontinuitiesTotal = new client.Counter({
  name: 'indexer_verifier_discontinuities_total',
  help: 'Total ledger discontinuities (gaps) detected within the verified range',
});

export const verifierLedgersScannedTotal = new client.Counter({
  name: 'indexer_verifier_ledgers_scanned_total',
  help: 'Total ledgers scanned by the event verifier',
});

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VerifierOptions {
  /** First ledger of the range to verify (inclusive). */
  fromLedger: number;
  /** Last ledger of the range to verify (inclusive). */
  toLedger: number;
  /** Contract IDs to verify. Defaults to all tracked contracts. */
  contractIds?: string[];
  /** Batch size in ledgers for each streaming window (default 500). */
  windowSize?: number;
  /**
   * Resumable cursor: ledger to start from when resuming a previous run.
   * The verifier writes progress to this cursor after each window.
   */
  cursorLedger?: number;
  /** RPC URL override (defaults to STELLAR_RPC_URL env var). */
  rpcUrl?: string;
}

export interface VerifierDiscrepancy {
  kind: 'duplicate' | 'omission' | 'orphan' | 'discontinuity';
  ledger?: number;
  fromLedger?: number;
  toLedger?: number;
  eventHash?: string;
  contractId?: string;
  txHash?: string;
  eventIndex?: number;
  detail: string;
}

export interface VerifierResult {
  /** Ledger range that was actually scanned. */
  fromLedger: number;
  toLedger: number;
  scannedLedgers: number;
  rpcEventCount: number;
  dbEventCount: number;
  duplicates: VerifierDiscrepancy[];
  omissions: VerifierDiscrepancy[];
  orphans: VerifierDiscrepancy[];
  discontinuities: VerifierDiscrepancy[];
  /** Resumable cursor — the last ledger that was fully verified. */
  cursor: number;
  /** Whether the entire requested range was covered. */
  complete: boolean;
}

// ── Batch window size ─────────────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 500;

// ── Core verifier ─────────────────────────────────────────────────────────────

/**
 * Verifies event integrity over a bounded ledger range.
 *
 * Streams ledger windows to avoid memory spikes.  On each window:
 *   1. Fetch events from RPC.
 *   2. Query matching event hashes from DB.
 *   3. Diff: identify omissions (RPC-only) and orphans (DB-only).
 *   4. Count duplicates (same hash more than once in DB).
 *   5. Check ledger continuity against TrackedContract cursors.
 *
 * Returns a structured report and updates Prometheus counters.
 * Never writes to any domain table.
 */
export async function runEventVerifier(
  opts: VerifierOptions,
  _server?: rpc.Server // injectable for tests
): Promise<VerifierResult> {
  const {
    fromLedger,
    toLedger,
    windowSize = DEFAULT_WINDOW_SIZE,
    cursorLedger,
    rpcUrl = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  } = opts;

  const server = _server ?? new rpc.Server(rpcUrl);

  // Resolve contract IDs to verify
  let contractIds = opts.contractIds ?? [];
  if (contractIds.length === 0) {
    const contracts = await prisma.trackedContract.findMany({
      where: { active: true },
      select: { contractId: true },
    });
    contractIds = contracts.map((c: { contractId: string }) => c.contractId);
  }

  if (contractIds.length === 0) {
    logger.warn('[EventVerifier] No contract IDs to verify');
  }

  const result: VerifierResult = {
    fromLedger,
    toLedger,
    scannedLedgers: 0,
    rpcEventCount: 0,
    dbEventCount: 0,
    duplicates: [],
    omissions: [],
    orphans: [],
    discontinuities: [],
    cursor: cursorLedger ?? fromLedger - 1,
    complete: false,
  };

  // ── Ledger discontinuity check ─────────────────────────────────────────────
  // Check for DB-recorded gaps (LedgerGap rows) within the requested range.
  await checkLedgerDiscontinuities(fromLedger, toLedger, result);

  // ── Streaming window comparison ────────────────────────────────────────────
  const startLedger = Math.max(fromLedger, (cursorLedger ?? fromLedger - 1) + 1);

  for (
    let windowStart = startLedger;
    windowStart <= toLedger;
    windowStart += windowSize
  ) {
    const windowEnd = Math.min(windowStart + windowSize - 1, toLedger);

    await verifyWindow(
      server,
      contractIds,
      windowStart,
      windowEnd,
      result,
    );

    // Advance cursor after each window so callers can checkpoint progress
    result.cursor = windowEnd;
    result.scannedLedgers += windowEnd - windowStart + 1;
    verifierLedgersScannedTotal.inc(windowEnd - windowStart + 1);

    logger.info('[EventVerifier] Window verified', {
      windowStart,
      windowEnd,
      cumulativeOmissions: result.omissions.length,
      cumulativeOrphans: result.orphans.length,
      cumulativeDuplicates: result.duplicates.length,
    });
  }

  result.complete = result.cursor >= toLedger;

  return result;
}

// ── Window comparison ──────────────────────────────────────────────────────────

async function verifyWindow(
  server: rpc.Server,
  contractIds: string[],
  windowStart: number,
  windowEnd: number,
  result: VerifierResult,
): Promise<void> {
  // Step 1: Fetch events from RPC for this window
  let rpcEvents: Awaited<ReturnType<typeof collectMarketplaceEvents>>;
  try {
    rpcEvents = await collectMarketplaceEvents(
      server,
      contractIds,
      windowStart,
      windowEnd,
    );
  } catch (err) {
    logger.error('[EventVerifier] RPC fetch failed for window', {
      windowStart,
      windowEnd,
      err: err instanceof Error ? err.message : String(err),
    });
    // Record discontinuity for this window — we couldn't verify it
    const disc: VerifierDiscrepancy = {
      kind: 'discontinuity',
      fromLedger: windowStart,
      toLedger: windowEnd,
      detail: `RPC fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    result.discontinuities.push(disc);
    verifierDiscontinuitiesTotal.inc();
    return;
  }

  // Build a map: eventHash → rpc event for O(1) lookup
  const rpcHashMap = new Map<string, { ledger: number; contractId: string; txHash: string; eventIndex: number }>();
  for (const ev of rpcEvents) {
    if (ev.eventHash) {
      rpcHashMap.set(ev.eventHash, {
        ledger: ev.ledgerSequence,
        contractId: ev.contractId,
        txHash: ev.txHash,
        eventIndex: ev.eventIndex,
      });
    }
  }

  result.rpcEventCount += rpcEvents.length;

  // Step 2: Fetch all DB event hashes for this window
  const dbEvents = await prisma.marketplaceEvent.findMany({
    where: {
      ledgerSequence: { gte: windowStart, lte: windowEnd },
      contractId: { in: contractIds },
    },
    select: {
      eventHash: true,
      ledgerSequence: true,
      contractId: true,
      eventIndex: true,
    },
  });

  result.dbEventCount += dbEvents.length;

  // Step 3: Detect duplicates — same eventHash appearing more than once in DB
  const dbHashCounts = new Map<string, number>();
  for (const row of dbEvents) {
    if (row.eventHash) {
      dbHashCounts.set(row.eventHash, (dbHashCounts.get(row.eventHash) ?? 0) + 1);
    }
  }
  for (const [hash, count] of dbHashCounts) {
    if (count > 1) {
      const rpcInfo = rpcHashMap.get(hash);
      const dup: VerifierDiscrepancy = {
        kind: 'duplicate',
        eventHash: hash,
        contractId: rpcInfo?.contractId,
        ledger: rpcInfo?.ledger,
        detail: `eventHash ${hash.slice(0, 16)}… appears ${count} times in DB`,
      };
      result.duplicates.push(dup);
      verifierDuplicatesTotal.inc();
    }
  }

  // Build DB hash set for diff
  const dbHashes: Array<string | null> = dbEvents.map(
    (e: { eventHash: string | null; ledgerSequence: number; contractId: string; eventIndex: number | null }) => e.eventHash
  );
  const dbHashSet = new Set(dbHashes.filter((h): h is string => h !== null && h !== undefined));

  // Step 4: Detect omissions — events on RPC not found in DB
  for (const [hash, info] of rpcHashMap) {
    if (!dbHashSet.has(hash)) {
      const omission: VerifierDiscrepancy = {
        kind: 'omission',
        eventHash: hash,
        ledger: info.ledger,
        contractId: info.contractId,
        txHash: info.txHash,
        eventIndex: info.eventIndex,
        detail: `RPC event not found in DB (ledger=${info.ledger} contract=${info.contractId.slice(0, 8)}…)`,
      };
      result.omissions.push(omission);
      verifierOmissionsTotal.inc();
    }
  }

  // Step 5: Detect orphan projections — DB events with no matching on-chain identity
  for (const dbRow of dbEvents) {
    if (dbRow.eventHash && !rpcHashMap.has(dbRow.eventHash)) {
      const orphan: VerifierDiscrepancy = {
        kind: 'orphan',
        eventHash: dbRow.eventHash,
        ledger: dbRow.ledgerSequence,
        contractId: dbRow.contractId,
        eventIndex: dbRow.eventIndex ?? undefined,
        detail: `DB event hash ${dbRow.eventHash.slice(0, 16)}… has no matching RPC event`,
      };
      result.orphans.push(orphan);
      verifierOrphansTotal.inc();
    }
  }
}

// ── Ledger discontinuity check ─────────────────────────────────────────────────

async function checkLedgerDiscontinuities(
  fromLedger: number,
  toLedger: number,
  result: VerifierResult,
): Promise<void> {
  // Check DB-recorded LedgerGap rows overlapping the range
  const gaps = await prisma.ledgerGap.findMany({
    where: {
      status: { not: 'Repaired' },
      fromLedger: { lte: toLedger },
      toLedger: { gte: fromLedger },
    },
    select: {
      fromLedger: true,
      toLedger: true,
      source: true,
      status: true,
    },
  });

  for (const gap of gaps) {
    const disc: VerifierDiscrepancy = {
      kind: 'discontinuity',
      fromLedger: gap.fromLedger,
      toLedger: gap.toLedger,
      detail: `LedgerGap status=${gap.status} source=${gap.source} from=${gap.fromLedger} to=${gap.toLedger}`,
    };
    result.discontinuities.push(disc);
    verifierDiscontinuitiesTotal.inc();
  }

  // Also check TrackedContract cursor for any contracts starting past fromLedger
  const contracts = await prisma.trackedContract.findMany({
    where: { active: true },
    select: { contractId: true, startLedger: true, lastLedger: true },
  });

  for (const contract of contracts) {
    // If the contract's actual last processed ledger is below toLedger, report
    if (contract.lastLedger < toLedger && contract.lastLedger > 0) {
      const disc: VerifierDiscrepancy = {
        kind: 'discontinuity',
        fromLedger: contract.lastLedger + 1,
        toLedger,
        contractId: contract.contractId,
        detail: `Contract ${contract.contractId.slice(0, 8)}… last indexed at ledger ${contract.lastLedger}, range extends to ${toLedger}`,
      };
      result.discontinuities.push(disc);
      verifierDiscontinuitiesTotal.inc();
    }
  }
}

// ── JSON export ────────────────────────────────────────────────────────────────

/**
 * Serializes a VerifierResult to a JSON-compatible object.
 * BigInts are converted to strings; no circular references.
 */
export function serializeVerifierResult(result: VerifierResult): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(result, (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  );
}
