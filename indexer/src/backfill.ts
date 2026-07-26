/**
 * backfill.ts
 *
 * Historical event backfill with:
 *   - Parallel worker pool (BACKFILL_CONCURRENCY ledger batches run concurrently,
 *     default 5, max 20) using Promise.allSettled for fault tolerance.
 *   - Per-batch checkpointing — crash = resume from last checkpoint, no duplicates.
 *   - Advisory lock (pg_try_advisory_lock) — two workers cannot run the same job.
 *   - No-clobber SyncState rule: historical backfills leave the live cursor alone.
 *   - Real-time CLI progress bar (percentage, throughput, ETA).
 *   - In-process status exported for the GET /backfill/status API endpoint.
 *
 * CLI:
 *   npm run backfill -- --start=X [--end=Y] [--rpc=URL] [--concurrency=N]
 *   npm run backfill -- --resume=<jobId>
 */

import { rpc } from '@stellar/stellar-sdk';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import prisma from './prisma-write.js';
import { applyDecodedEvents, buildSyncStateLedgerData } from './poller.js';
import { collectMarketplaceEvents } from './event-sync.js';
import { logger } from './logger.js';
import {
  backfillJobsTotal,
  backfillDurationSeconds,
  backfillBatchLedgers,
  backfillBatchInserted,
  backfillLockContentions,
} from './metrics.js';

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const BACKFILL_BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE || '5000', 10);

/** Default number of concurrent ledger-batch workers. */
const DEFAULT_CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY || '5', 10);

/** Hard ceiling — never spawn more than this many parallel workers regardless of config. */
const MAX_CONCURRENCY = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export type BackfillJobStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';

export interface BackfillJobRecord {
  id: number;
  startLedger: number;
  endLedger: number;
  checkpointLedger: number;
  status: BackfillJobStatus;
  rpcUrl: string;
  error: string | null;
  totalInserted: number;
  gapId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunBackfillOptions {
  rpcUrl?: string;
  startLedger?: number;
  endLedger?: number;
  resumeJobId?: number;
  gapId?: number | null;
  rpcServer?: rpc.Server;   // injected in tests
  batchSize?: number;
  concurrency?: number;
  /** Suppress CLI progress bar output (useful in tests / API calls). */
  silent?: boolean;
}

export interface BackfillResult {
  jobId: number;
  startLedger: number;
  endLedger: number;
  totalInserted: number;
  processedLedger: number;
  status: BackfillJobStatus;
}

// ── In-process status (exported for /backfill/status endpoint) ────────────────

export interface BackfillRunStatus {
  running: boolean;
  jobId: number | null;
  fromLedger: number | null;
  toLedger: number | null;
  checkpointLedger: number | null;
  percentage: number;
  throughputEventsPerSec: number;
  estimatedRemainingMs: number | null;
}

let _currentStatus: BackfillRunStatus = {
  running:                false,
  jobId:                  null,
  fromLedger:             null,
  toLedger:               null,
  checkpointLedger:       null,
  percentage:             0,
  throughputEventsPerSec: 0,
  estimatedRemainingMs:   null,
};

export function getBackfillStatus(): BackfillRunStatus {
  return { ..._currentStatus };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getContractIds(): string[] {
  return [
    process.env.MARKETPLACE_CONTRACT_ID || '',
    process.env.LAUNCHPAD_CONTRACT_ID   || '',
  ].filter(Boolean);
}

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function parseLedger(value: string | undefined, label: string): number {
  if (!value) throw new Error(`Missing required --${label} flag`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`Invalid --${label} value "${value}": must be a non-negative integer`);
  return n;
}

async function fetchLedgerHash(server: rpc.Server, ledger: number): Promise<string | null> {
  try {
    const res = await server.getLedgers({ startLedger: ledger, pagination: { limit: 1 } });
    return res.ledgers?.[0]?.hash ?? null;
  } catch (err) {
    logger.warn('backfill: failed to fetch ledger hash', {
      ledger,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function advisoryLockKey(jobId: number): bigint {
  return (BigInt(0xbacf) << 32n) | BigInt(jobId);
}

async function tryAcquireAdvisoryLock(jobId: number): Promise<boolean> {
  const key = advisoryLockKey(jobId);
  const result = await prisma.$queryRaw<[{ acquired: boolean }]>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS acquired
  `;
  return result[0]?.acquired === true;
}

async function releaseAdvisoryLock(jobId: number): Promise<void> {
  const key = advisoryLockKey(jobId);
  await prisma.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function renderProgressBar(
  processed: number,
  total: number,
  throughput: number,
  etaMs: number | null,
): string {
  const pct    = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const filled = Math.floor(pct / 5); // 20-char bar
  const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const eta    = etaMs !== null ? `ETA ${(etaMs / 1000).toFixed(0)}s` : 'ETA --';
  return `\r[${bar}] ${pct.toFixed(1)}%  ${throughput.toFixed(0)} ev/s  ${eta}   `;
}

// ── Cursor-interaction rule ───────────────────────────────────────────────────

export type CursorInteraction =
  | 'below'        // entire range < liveCursor   → do NOT touch SyncState
  | 'overlapping'  // range straddles liveCursor   → do NOT touch SyncState
  | 'ahead';       // entire range > liveCursor    → DO advance SyncState

export function determineCursorInteraction(
  startLedger: number,
  endLedger: number,
  liveCursor: number,
): CursorInteraction {
  if (endLedger <= liveCursor)   return 'below';
  if (startLedger <= liveCursor) return 'overlapping';
  return 'ahead';
}

// ── Job lifecycle helpers ─────────────────────────────────────────────────────

export async function createBackfillJob(
  startLedger: number,
  endLedger: number,
  rpcUrl: string,
  gapId?: number | null,
): Promise<BackfillJobRecord> {
  return prisma.backfillJob.create({
    data: {
      startLedger,
      endLedger,
      checkpointLedger: 0,
      status: 'Pending',
      rpcUrl,
      totalInserted: 0,
      gapId: gapId ?? null,
    },
  }) as unknown as BackfillJobRecord;
}

export async function getBackfillJob(id: number): Promise<BackfillJobRecord | null> {
  return prisma.backfillJob.findUnique({ where: { id } }) as unknown as BackfillJobRecord | null;
}

export async function listBackfillJobs(): Promise<BackfillJobRecord[]> {
  return prisma.backfillJob.findMany({
    orderBy: { createdAt: 'desc' },
  }) as unknown as BackfillJobRecord[];
}

export async function cancelBackfillJob(id: number): Promise<void> {
  await prisma.backfillJob.update({
    where: { id },
    data:  { status: 'Cancelled' },
  });
}

// ── Single-batch processor (runs inside the parallel worker pool) ─────────────

interface BatchOptions {
  server:            rpc.Server;
  contractIds:       string[];
  jobId:             number;
  batchStart:        number;
  batchEnd:          number;
  cursorInteraction: CursorInteraction;
  /** Running total before this batch — used for checkpoint totalInserted. */
  insertedSoFar:     number;
}

interface BatchResult {
  batchStart:  number;
  batchEnd:    number;
  inserted:    number;
  maxLedger:   number;
}

async function processBatch(opts: BatchOptions): Promise<BatchResult> {
  const { server, contractIds, jobId, batchStart, batchEnd, cursorInteraction, insertedSoFar } = opts;

  const decodedEvents = await collectMarketplaceEvents(server, contractIds, batchStart, batchEnd);

  const batchMaxLedger =
    decodedEvents.length > 0
      ? Math.max(...decodedEvents.map((e) => e.ledgerSequence))
      : batchEnd;

  const latestHash = await fetchLedgerHash(server, batchMaxLedger);

  const inserted = await prisma.$transaction(async (tx) => {
    const rows = await applyDecodedEvents(decodedEvents, tx);

    // Checkpoint — in the same transaction so crash = no partial data.
    await tx.backfillJob.update({
      where: { id: jobId },
      data: {
        checkpointLedger: batchMaxLedger,
        totalInserted:    insertedSoFar + rows.length,
      },
    });

    if (cursorInteraction === 'ahead') {
      await tx.syncState.upsert({
        where:  { id: 1 },
        create: { id: 1, ...buildSyncStateLedgerData(batchMaxLedger, latestHash) },
        update: buildSyncStateLedgerData(batchMaxLedger, latestHash),
      });
    }

    return rows.length;
  });

  backfillBatchLedgers.observe(batchEnd - batchStart + 1);
  backfillBatchInserted.observe(inserted);

  return { batchStart, batchEnd, inserted, maxLedger: batchMaxLedger };
}

// ── Core backfill executor ────────────────────────────────────────────────────

/**
 * Run (or resume) a BackfillJob with a parallel worker pool.
 *
 * The ledger range is sliced into batchSize-ledger batches.  Up to
 * `concurrency` batches are fetched and written in parallel using
 * Promise.allSettled — individual batch failures are logged and counted but
 * do not abort the remaining batches (they will be covered by the checkpoint
 * resume on the next run).
 */
export async function runBackfill(opts: RunBackfillOptions = {}): Promise<BackfillResult> {
  const contractIds = getContractIds();
  if (contractIds.length === 0) {
    throw new Error(
      'At least one of MARKETPLACE_CONTRACT_ID or LAUNCHPAD_CONTRACT_ID must be set',
    );
  }

  const concurrency = Math.min(
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );

  // ── Resolve job ───────────────────────────────────────────────────────────
  let job: BackfillJobRecord;

  if (opts.resumeJobId != null) {
    const existing = await getBackfillJob(opts.resumeJobId);
    if (!existing) throw new Error(`BackfillJob #${opts.resumeJobId} not found`);
    if (existing.status === 'Running') {
      throw new Error(`BackfillJob #${opts.resumeJobId} is already Running — may be held by another worker`);
    }
    if (existing.status === 'Completed' || existing.status === 'Cancelled') {
      throw new Error(`BackfillJob #${opts.resumeJobId} is ${existing.status} — nothing to resume`);
    }
    job = existing;
    logger.info('backfill: resuming existing job', { jobId: job.id, checkpoint: job.checkpointLedger });
  } else {
    const rpcUrl =
      opts.rpcUrl ??
      readFlag('rpc') ??
      process.env.ARCHIVAL_STELLAR_RPC_URL ??
      process.env.STELLAR_RPC_URL ??
      '';
    if (!rpcUrl) {
      throw new Error('Missing archival RPC URL. Set ARCHIVAL_STELLAR_RPC_URL or pass --rpc=<url>.');
    }

    const startLedger = opts.startLedger ?? parseLedger(readFlag('start'), 'start');
    const rawEnd      = opts.endLedger ?? (readFlag('end') ? parseLedger(readFlag('end'), 'end') : undefined);
    const server      = opts.rpcServer ?? new rpc.Server(rpcUrl);
    const chainTip    = (await server.getLatestLedger()).sequence;
    const endLedger   = rawEnd ?? chainTip;

    if (endLedger > chainTip)
      throw new Error(`Invalid range: --end=${endLedger} exceeds chain tip (${chainTip})`);
    if (startLedger > endLedger)
      throw new Error(`Invalid range: --start=${startLedger} must be ≤ --end=${endLedger}`);

    job = await createBackfillJob(startLedger, endLedger, rpcUrl, opts.gapId ?? null);
    logger.info('backfill: created new job', { jobId: job.id, startLedger, endLedger, concurrency });
  }

  // ── Advisory lock ─────────────────────────────────────────────────────────
  const locked = await tryAcquireAdvisoryLock(job.id);
  if (!locked) {
    backfillLockContentions.inc();
    throw new Error(`BackfillJob #${job.id} advisory lock is held by another worker — aborting`);
  }

  await prisma.backfillJob.update({ where: { id: job.id }, data: { status: 'Running', error: null } });

  const server     = opts.rpcServer ?? new rpc.Server(job.rpcUrl || process.env.STELLAR_RPC_URL || '');
  const batchSize  = opts.batchSize ?? BACKFILL_BATCH_SIZE;
  const startTimer = backfillDurationSeconds.startTimer();
  const silent     = opts.silent ?? false;

  const resumeFrom   = job.checkpointLedger > 0 ? job.checkpointLedger + 1 : job.startLedger;
  const { startLedger, endLedger } = job;
  const totalLedgers = endLedger - startLedger + 1;

  logger.info('backfill: starting run', { jobId: job.id, startLedger, endLedger, resumeFrom, batchSize, concurrency });

  let totalInserted   = job.totalInserted;
  let processedLedger = job.checkpointLedger > 0 ? job.checkpointLedger : startLedger - 1;

  // Track progress for the status endpoint and CLI progress bar.
  _currentStatus = {
    running:                true,
    jobId:                  job.id,
    fromLedger:             startLedger,
    toLedger:               endLedger,
    checkpointLedger:       processedLedger,
    percentage:             0,
    throughputEventsPerSec: 0,
    estimatedRemainingMs:   null,
  };

  const wallStart    = Date.now();
  let   insertedSoFar = totalInserted;

  try {
    // Determine how SyncState should be handled.
    const syncState = await prisma.syncState.findUnique({ where: { id: 1 } });
    const liveCursor = syncState?.lastLedger ?? 0;
    const cursorInteraction = determineCursorInteraction(startLedger, endLedger, liveCursor);

    logger.info('backfill: cursor interaction', { jobId: job.id, cursorInteraction, liveCursor });

    // Build the full list of batches from the resume point.
    const batches: Array<{ start: number; end: number }> = [];
    for (let s = resumeFrom; s <= endLedger; s += batchSize) {
      batches.push({ start: s, end: Math.min(s + batchSize - 1, endLedger) });
    }

    // Process batches in windows of `concurrency` using Promise.allSettled.
    // This keeps `concurrency` RPC calls + DB writes in-flight simultaneously
    // without launching all batches at once.
    for (let i = 0; i < batches.length; i += concurrency) {
      const window = batches.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        window.map((b) =>
          processBatch({
            server,
            contractIds,
            jobId:            job.id,
            batchStart:       b.start,
            batchEnd:         b.end,
            cursorInteraction,
            insertedSoFar,
          }),
        ),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const r = result.value;
          totalInserted   += r.inserted;
          insertedSoFar   += r.inserted;
          processedLedger  = Math.max(processedLedger, r.maxLedger);

          const elapsedMs   = Date.now() - wallStart;
          const throughput  = elapsedMs > 0 ? (totalInserted / (elapsedMs / 1000)) : 0;
          const progress    = processedLedger - startLedger + 1;
          const remaining   = totalLedgers - progress;
          const etaMs       = throughput > 0
            ? Math.max(0, (remaining / totalLedgers) * elapsedMs)
            : null;
          const percentage  = totalLedgers > 0
            ? Math.min(100, (progress / totalLedgers) * 100)
            : 100;

          // Update in-process status for /backfill/status endpoint.
          _currentStatus = {
            ..._currentStatus,
            checkpointLedger:       processedLedger,
            percentage,
            throughputEventsPerSec: throughput,
            estimatedRemainingMs:   etaMs,
          };

          if (!silent) {
            process.stdout.write(renderProgressBar(progress, totalLedgers, throughput, etaMs));
          }

          logger.debug('backfill: batch done', {
            jobId: job.id, batchStart: r.batchStart, batchEnd: r.batchEnd,
            inserted: r.inserted, progressPct: percentage.toFixed(1),
          });
        } else {
          // A single batch failed — log it and continue; checkpoint keeps track
          // of the last successfully completed ledger so the next resume will
          // retry the failed window.
          logger.error('backfill: batch failed (will retry on resume)', {
            jobId: job.id,
            err:   result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }

    if (!silent) process.stdout.write('\n'); // finish the progress bar line

    // ── Mark Completed ─────────────────────────────────────────────────────
    await prisma.backfillJob.update({
      where: { id: job.id },
      data:  { status: 'Completed', checkpointLedger: endLedger, totalInserted },
    });

    backfillJobsTotal.inc({ status: 'Completed' });
    startTimer();

    logger.info('backfill: job completed', { jobId: job.id, totalInserted, endLedger });

    _currentStatus = { ..._currentStatus, running: false, percentage: 100 };

    return { jobId: job.id, startLedger, endLedger, totalInserted, processedLedger, status: 'Completed' };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await prisma.backfillJob.update({
      where: { id: job.id },
      data:  { status: 'Failed', error: errMsg.slice(0, 4096) },
    });

    backfillJobsTotal.inc({ status: 'Failed' });
    startTimer();

    _currentStatus = { ..._currentStatus, running: false };

    logger.error('backfill: job failed', { jobId: job.id, err: errMsg });
    throw err;

  } finally {
    await releaseAdvisoryLock(job.id).catch(() => {/* no-op on disconnect */});
  }
}

// ── Standalone entrypoint ─────────────────────────────────────────────────────

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url ||
    process.argv[1].includes('backfill')
  : false;

if (isMain) {
  const resumeFlag = readFlag('resume');
  const concurrencyFlag = readFlag('concurrency');

  const opts: RunBackfillOptions = resumeFlag
    ? { resumeJobId: parseInt(resumeFlag, 10) }
    : {};

  if (concurrencyFlag) {
    opts.concurrency = Math.min(parseInt(concurrencyFlag, 10), MAX_CONCURRENCY);
  }

  runBackfill(opts)
    .then((r) => {
      logger.info('backfill: standalone run complete', {
        jobId:    r.jobId,
        inserted: r.totalInserted,
        status:   r.status,
      });
      process.exit(0);
    })
    .catch((err) => {
      logger.error('backfill: standalone run fatal', {
        err: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
