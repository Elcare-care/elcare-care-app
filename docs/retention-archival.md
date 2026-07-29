# Database Retention and Archival Strategy

## Overview

Marketplace activity and raw events grow continuously. This document defines the
retention periods, archival procedures, and restore mechanisms for every major
table in the indexer PostgreSQL database.

## Table classification

### Hot — kept in primary PostgreSQL tables indefinitely

| Table | Reason |
|-------|--------|
| `Listing` | Active marketplace state; queried by every browse/search request |
| `Auction` | Active auction state; queried by auction detail and bid flows |
| `Offer` | Active offer state; queried by listing detail and offer history |
| `Collection` | Deployment metadata; queried by browse and creator pages |
| `Bid` | Auction bid history; needed for auction detail and blocked-bidders |
| `RoyaltyPayment` | Secondary-sale audit trail; needed for royalty breakdowns |
| `SyncState` | Single-row cursor; never archived |
| `TrackedContract` | Small registry; never archived |

### Warm — retained in primary tables with time-bound retention

| Table | Retention | Rationale |
|-------|-----------|-----------|
| `MarketplaceEvent` | 90 days hot, then archive | Primary event history for listings, wallet activity, stats |
| `PriceHistory` | 90 days hot, then archive | Price-chart data for active listings |
| `LedgerCheckpoint` | 30 days hot, then archive | Operational polling state; rarely queried after commit |
| `BackfillJob` | 30 days hot, then archive | Operational backfill tracking |
| `LedgerGap` | 30 days hot, then archive | Operational gap tracking |
| `DeadLetterEvent` | 30 days hot, then archive | Parser failure queue |
| `ReconciliationRepair` | 90 days hot, then archive | Field-level correction audit trail |
| `ReconciliationRun` | 90 days hot, then archive | Reconciliation run metadata |
| `Discrepancy` | 90 days hot, then archive | Per-run discrepancy details |
| `KeeperAction` | 30 days hot, then archive | Keeper action idempotency records |

### Cold / Archive — moved to immutable archive tables

Archived rows are moved to dedicated tables with the same schema plus
`archivedAt` and `archiveChecksum` fields. The archive tables are append-only;
rows are never updated or deleted after insertion.

| Source table | Archive table | Trigger |
|--------------|---------------|---------|
| `MarketplaceEvent` | `ArchivedMarketplaceEvent` | `ledgerSequence < now() - INTERVAL '90 days'` |
| `PriceHistory` | `ArchivedPriceHistory` | `changedAt < now() - INTERVAL '90 days'` |
| `LedgerCheckpoint` | `ArchivedLedgerCheckpoint` | `createdAt < now() - INTERVAL '30 days'` |
| `BackfillJob` | `ArchivedBackfillJob` | `createdAt < now() - INTERVAL '30 days'` |
| `LedgerGap` | `ArchivedLedgerGap` | `createdAt < now() - INTERVAL '30 days'` |
| `DeadLetterEvent` | `ArchivedDeadLetterEvent` | `createdAt < now() - INTERVAL '30 days'` |
| `ReconciliationRepair` | `ArchivedReconciliationRepair` | `createdAt < now() - INTERVAL '90 days'` |
| `ReconciliationRun` | `ArchivedReconciliationRun` | `startedAt < now() - INTERVAL '90 days'` |
| `Discrepancy` | `ArchivedDiscrepancy` | `detectedAt < now() - INTERVAL '90 days'` |
| `KeeperAction` | `ArchivedKeeperAction` | `updatedAt < now() - INTERVAL '30 days'` |

## Archival job

The archival job (`src/archive.ts`) runs as a bounded, resumable batch process:

1. Queries source tables for rows older than the retention threshold.
2. Writes rows to the corresponding archive table with `archivedAt` and
   `archiveChecksum` (SHA-256 of the serialised row).
3. Deletes the source rows in batches of 10,000.
4. Emits metrics: `archive_job_duration_seconds`, `archive_rows_moved_total`.
5. Is safe to restart: if interrupted mid-batch, already-archived rows have
   unique constraints preventing duplicates, and remaining source rows are
   re-processed on the next run.

### Concurrency

- Runs during low-traffic windows (configurable via `ARCHIVE_START_HOUR` /
  `ARCHIVE_END_HOUR`, default 03:00–05:00 UTC).
- Max 1 archival job per database; enforced by `pg_try_advisory_lock`.
- Each table is processed sequentially to bound transaction size.

## Restore procedure

To restore archived rows to the hot tables:

1. Stop the indexer poller and API.
2. For each archive table, run:
   ```sql
   INSERT INTO "MarketplaceEvent" SELECT * FROM "ArchivedMarketplaceEvent"
   ON CONFLICT DO NOTHING;
   ```
3. Delete the restored rows from the archive table.
4. Restart the indexer.

All archive tables include `archiveChecksum` so operators can verify row
integrity before and after restore.

## Provenance

API responses that return archived data include:

```json
{
  "archived": true,
  "archivedAt": "2026-04-15T03:00:00.000Z",
  "archiveChecksum": "sha256:abcdef..."
}
```

This allows frontend provenance pages to explain when data was archived while
still retrieving it on demand.

## Observability

- `archive_job_runs_total` — counter of archival job executions
- `archive_rows_archived_total{table}` — counter of rows moved per table
- `archive_job_errors_total{table}` — counter of failures per table
- Alert when `archive_job_errors_total` increases for any table
