/**
 * Archive job — moves expired rows from hot/warm tables to immutable archive tables,
 * and hard-deletes eligible off-chain metadata (OperationalAudit) after its
 * retention window expires.
 *
 * Usage:
 *   npx tsx src/archive.ts [--dry-run] [--batch-size <n>]
 *
 * Environment:
 *   ARCHIVE_DRY_RUN=true         — preview only, no writes
 *   ARCHIVE_BATCH_SIZE=10000     — rows per batch
 *   ARCHIVE_START_HOUR=3         — only run between these hours (UTC)
 *   ARCHIVE_END_HOUR=5
 *   LEGAL_HOLD_IDS=reqId1,...    — comma-separated OperationalAudit.requestId
 *                                  values that must NOT be deleted regardless
 *                                  of their age (legal / regulatory hold)
 *   LEGAL_HOLD_EVENT_HASHES=h1,h2 — comma-separated MarketplaceEvent.eventHash
 *                                    values that must NOT be archived
 *
 * Canonical tables (Listing, Auction, Offer, Bid, RoyaltyPayment, Collection,
 * WhitelistedToken, SyncState, TrackedContract) are NEVER touched by this job.
 * They mirror public on-chain state and cannot be deleted.
 */

import prisma from './db.js';
import { logger } from './logger.js';

const DRY_RUN = process.env.ARCHIVE_DRY_RUN === 'true';
const BATCH_SIZE = parseInt(process.env.ARCHIVE_BATCH_SIZE || '10000', 10);
const START_HOUR = parseInt(process.env.ARCHIVE_START_HOUR || '3', 10);
const END_HOUR = parseInt(process.env.ARCHIVE_END_HOUR || '5', 10);

// ── Legal-hold exclusion lists ────────────────────────────────────────────────
//
// Rows matching these IDs are skipped regardless of their age so that active
// legal or regulatory holds cannot be inadvertently cleared by a scheduled job.
// Populated from environment variables; empty by default.

const LEGAL_HOLD_REQUEST_IDS: Set<string> = new Set(
  (process.env.LEGAL_HOLD_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const LEGAL_HOLD_EVENT_HASHES: Set<string> = new Set(
  (process.env.LEGAL_HOLD_EVENT_HASHES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export interface ArchiveTable {
  hot: string;
  archive: string;
  retentionDays: number;
  where: any;
}

export const ARCHIVE_TABLES: ArchiveTable[] = [
  {
    hot: 'MarketplaceEvent',
    archive: 'ArchivedMarketplaceEvent',
    retentionDays: 90,
    where: { ledgerSequence: { lt: BigInt(Date.now() / 1000 - 90 * 24 * 60 * 60) } },
  },
  {
    hot: 'PriceHistory',
    archive: 'ArchivedPriceHistory',
    retentionDays: 90,
    where: { changedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'LedgerCheckpoint',
    archive: 'ArchivedLedgerCheckpoint',
    retentionDays: 30,
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'BackfillJob',
    archive: 'ArchivedBackfillJob',
    retentionDays: 30,
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'LedgerGap',
    archive: 'ArchivedLedgerGap',
    retentionDays: 30,
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'DeadLetterEvent',
    archive: 'ArchivedDeadLetterEvent',
    retentionDays: 30,
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'ReconciliationRepair',
    archive: 'ArchivedReconciliationRepair',
    retentionDays: 90,
    where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'ReconciliationRun',
    archive: 'ArchivedReconciliationRun',
    retentionDays: 90,
    where: { startedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'Discrepancy',
    archive: 'ArchivedDiscrepancy',
    retentionDays: 90,
    where: { detectedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
  },
  {
    hot: 'KeeperAction',
    archive: 'ArchivedKeeperAction',
    retentionDays: 30,
    where: { updatedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  },
];

async function sha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

async function archiveTable(table: ArchiveTable): Promise<{ archived: number; deleted: number }> {
  let archived = 0;
  let deleted = 0;

  while (true) {
    const rows = await (prisma as any)[table.hot].findMany({
      where: table.where,
      take: BATCH_SIZE,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      // ── Legal-hold check for MarketplaceEvent rows ────────────────────────
      if (
        table.hot === 'MarketplaceEvent' &&
        LEGAL_HOLD_EVENT_HASHES.size > 0
      ) {
        const hash = (row as any).eventHash;
        if (typeof hash === 'string' && LEGAL_HOLD_EVENT_HASHES.has(hash)) {
          logger.info(`[archive] Skipping ${table.hot} id=${(row as any).id} — legal hold on eventHash ${hash}`);
          continue;
        }
      }

      const checksum = await sha256(JSON.stringify(row));
      const archiveRow = {
        ...row,
        archivedAt: new Date(),
        archiveChecksum: checksum,
      };

      if (!DRY_RUN) {
        await prisma.$transaction(async (tx: any) => {
          await (tx as any)[table.archive].create({ data: archiveRow as any });
          await (tx as any)[table.hot].delete({ where: { id: (row as any).id } });
        });
      }

      archived++;
      deleted++;
    }

    logger.info(`[archive] ${table.hot}: archived ${archived} rows so far`);
  }

  return { archived, deleted };
}

/**
 * Deletes `OperationalAudit` rows older than `retentionDays` days.
 *
 * OperationalAudit rows are NOT archived — they are permanently deleted
 * after the retention window (see docs/retention-archival.md §"OperationalAudit
 * retention"). Rows whose `requestId` appears in `LEGAL_HOLD_REQUEST_IDS`
 * are excluded regardless of age.
 *
 * Returns the number of rows deleted.
 */
export async function deleteOldOperationalAuditRecords(
  retentionDays = 90,
): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Build exclusion clause for legal-hold IDs.
  const holdIds = [...LEGAL_HOLD_REQUEST_IDS];
  const holdFilter =
    holdIds.length > 0
      ? { requestId: { notIn: holdIds } }
      : {};

  if (DRY_RUN) {
    const count = await (prisma as any).operationalAudit.count({
      where: { createdAt: { lt: cutoffDate }, ...holdFilter },
    });
    logger.info(`[archive] DRY RUN: would delete ${count} OperationalAudit rows older than ${retentionDays}d`);
    return count;
  }

  const result = await (prisma as any).operationalAudit.deleteMany({
    where: { createdAt: { lt: cutoffDate }, ...holdFilter },
  });

  logger.info(`[archive] Deleted ${result.count} OperationalAudit rows older than ${retentionDays}d`, {
    retentionDays,
    cutoffDate: cutoffDate.toISOString(),
    legalHoldExcluded: holdIds.length,
  });

  return result.count;
}

async function main() {
  logger.info('[archive] Starting archival job', { dryRun: DRY_RUN, batchSize: BATCH_SIZE });

  const hour = new Date().getUTCHours();
  if (hour < START_HOUR || hour >= END_HOUR) {
    logger.info('[archive] Outside allowed window; exiting');
    process.exit(0);
  }

  const lockAcquired = await prisma.$queryRawUnsafe<[{ pg_try_advisory_lock: boolean }]>(
    'SELECT pg_try_advisory_lock(1234567890) AS pg_try_advisory_lock'
  ).then((r) => r[0]?.pg_try_advisory_lock ?? false);

  if (!lockAcquired) {
    logger.info('[archive] Another instance is running; exiting');
    process.exit(0);
  }

  try {
    // ── Archival (warm → cold) ────────────────────────────────────────────
    for (const table of ARCHIVE_TABLES) {
      logger.info(`[archive] Processing ${table.hot} (retention: ${table.retentionDays}d)`);
      const result = await archiveTable(table);
      logger.info(`[archive] ${table.hot} complete`, result);
    }

    // ── Operational metadata deletion ─────────────────────────────────────
    // OperationalAudit rows are deleted (not archived) after 90 days.
    // Canonical tables (Listing, Auction, Offer, etc.) are never touched.
    logger.info('[archive] Processing OperationalAudit deletion (retention: 90d)');
    const auditDeleted = await deleteOldOperationalAuditRecords(90);
    logger.info(`[archive] OperationalAudit deletion complete`, { deleted: auditDeleted });
  } finally {
    await prisma.$queryRawUnsafe('SELECT pg_advisory_unlock(1234567890)').catch(() => {});
  }

  logger.info('[archive] All tables processed');
}

main().catch((err) => {
  logger.error('[archive] Fatal error', err);
  process.exit(1);
});
