# Database Retention and Archival Strategy

## Overview

Marketplace activity and raw events grow continuously. This document defines the
retention periods, archival procedures, and restore mechanisms for every major
table in the indexer PostgreSQL database.

## Wallet data — retention classes

ElcareHub is non-custodial. There is no `User` table; a wallet is identified
solely by its public key (a 56-character Stellar `G…` address). Wallet keys
are public ledger data; they are not treated as PII. The table below
catalogues every field in the off-chain database that contains or derives from
a wallet address and assigns a retention class to it.

| Field | Table | Class | Retention | Notes |
|-------|-------|-------|-----------|-------|
| `artist` | `Listing` | **canonical** | Indefinite | On-chain provenance — cannot be deleted |
| `owner` | `Listing` | **canonical** | Indefinite | Current on-chain owner — cannot be deleted |
| `originalCreator` | `Listing` | **canonical** | Indefinite | Attribution for royalty calculations |
| `creator` | `Auction` | **canonical** | Indefinite | On-chain provenance |
| `highestBidder` | `Auction` | **canonical** | Indefinite | On-chain state |
| `offerer` | `Offer` | **canonical** | Indefinite | On-chain provenance |
| `creator` | `Collection` | **canonical** | Indefinite | On-chain provenance |
| `bidder` | `Bid` | **canonical** | Indefinite | On-chain bid history |
| `actor` | `MarketplaceEvent` | **warm** | 90 days hot, then archive | Mirrors on-chain signer; pseudonymised in analytics exports |
| `data` (wallet keys embedded in JSON) | `MarketplaceEvent` | **warm** | 90 days hot, then archive | `buyer`, `artist`, `offerer`, `bidder`, `winner`, `creator` JSON paths — redacted in debug logs |
| `actor` | `ArchivedMarketplaceEvent` | **cold** | Indefinite archive | Append-only; not deleted |
| `recipient` | `RoyaltyPayment` | **canonical** | Indefinite | Financial audit trail |
| `actor` | `OperationalAudit` | **operational** | 90 days, then delete | Operator identity; pseudonymised in CSV exports |
| `addedBy` / `removedBy` | `WhitelistedToken` | **canonical** | Indefinite | On-chain governance trail |
| `changedBy` | `PriceHistory` | **warm** | 90 days hot, then archive | Mirrors on-chain signer |
| `ipAddress` | `OperationalAudit` | **operational** | 90 days, then delete | Never exported in analytics; omitted from CSV if pseudonymisation flag set |

### Retention class definitions

| Class | Description |
|-------|-------------|
| **canonical** | Mirrors public on-chain state. Cannot be deleted without destroying the integrity of the indexer. No deletion scheduled. |
| **warm** | Derived from on-chain data but not the authoritative source. Archived to immutable tables after the hot retention window; no deletion from archive. |
| **operational** | Internal bookkeeping (audit logs, request metadata). Deleted after the retention window. Not included in analytics exports in raw form. |

### Analytics / export pseudonymisation

Analytics queries (`stats.ts`, CSV exports from `audit-routes.ts`) that
surface wallet addresses **must** use `pseudonymizeWallet()` from
`src/wallet-privacy.ts` rather than emitting raw keys. The function returns
the first 4 and last 4 characters of the key separated by `…` (e.g.
`GCAT…ZXAB`), consistent with the privacy policy (§2).

### Debug-log redaction

Wallet addresses embedded in `data` JSON fields of `MarketplaceEvent` rows
are public on-chain data and may appear in full in audit logs and error
messages where the address is the subject of the operation. They must **not**
appear in generic debug/error log lines where the address is incidental
context. Routes that log wallet addresses must pass the address through the
`maybeRedactWallet()` helper (`src/wallet-privacy.ts`) which applies the
pseudonymisation transform when the current log level is `debug` or lower.

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

> **Note on Storage-Level Partition Maintenance:**
> In addition to application-level archival tables, storage-level range partitions for `MarketplaceEvent`, `Bid`, and `RoyaltyPayment` must follow the [Partition Maintenance Checklist](../indexer/docs/partitioning-operations.md#partition-maintenance-checklist-pre-destructive-action) before any partition is detached or dropped.

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

To restore archived rows to the hot tables without data loss or downtime:

1. Stop the indexer poller and API during the restore operation.
2. Complete the [Archive Restore Proof Procedure](#archive-restore-proof-procedure) below.
3. Restart the indexer once proof verification passes.

---

## Archive Restore Proof Procedure

This procedure provides a copy/paste sequence that restores archived data to primary tables while **strictly prohibiting `DELETE` or `TRUNCATE` actions**.
All diagnostic steps are marked `[READ-ONLY]`. Archive tables remain intact as immutable cold records.

### Proof Principles & Invariants
- **Non-Destructive Guarantee:** Restored rows are inserted using `ON CONFLICT DO NOTHING`. Archive source tables are **never** deleted or truncated.
- **Canonical Table Safety Invariant:** Canonical tables (`Listing`, `Auction`, `Offer`, `Bid`, `RoyaltyPayment`, `Collection`, `WhitelistedToken`, `SyncState`, `TrackedContract`) represent authoritative on-chain state. They are strictly excluded from restore mutation.
- **Reconciliation Proof:** Restoration is considered complete only when the post-restore row count proof returns `0` discrepancy.

---

### Step 1: Canonical-Table Safety Baseline [READ-ONLY]

Record row count baselines for canonical tables before initiating any restore:

```sql
-- [READ-ONLY] Baseline canonical table safety check
SELECT 'Listing' AS canonical_table, COUNT(*) AS baseline_count FROM "Listing"
UNION ALL
SELECT 'Auction', COUNT(*) FROM "Auction"
UNION ALL
SELECT 'Offer', COUNT(*) FROM "Offer"
UNION ALL
SELECT 'Bid', COUNT(*) FROM "Bid"
UNION ALL
SELECT 'RoyaltyPayment', COUNT(*) FROM "RoyaltyPayment"
UNION ALL
SELECT 'Collection', COUNT(*) FROM "Collection";
```

---

### Step 2: Pre-Restore Row Count & Range Proof [READ-ONLY]

Audit the candidate rows in the archive table for the target ledger window:

```sql
-- [READ-ONLY] Count target archive records and determine boundary
SELECT
  COUNT(*) AS candidate_archive_rows,
  MIN("ledgerSequence") AS min_ledger,
  MAX("ledgerSequence") AS max_ledger
FROM "ArchivedMarketplaceEvent"
WHERE "ledgerSequence" BETWEEN $START_LEDGER AND $END_LEDGER;
```

---

### Step 3: Non-Destructive Restore Execution [NON-DESTRUCTIVE RESTORE]

Execute idempotent copy into the primary table without modifying or deleting archive source rows:

```sql
-- [NON-DESTRUCTIVE RESTORE] Insert into hot table; preserve archive intact
INSERT INTO "MarketplaceEvent" (
  "id",
  "eventType",
  "actor",
  "data",
  "ledgerSequence",
  "eventHash",
  "confirmed",
  "listingId",
  "createdAt",
  "updatedAt"
)
SELECT
  "id",
  "eventType",
  "actor",
  "data",
  "ledgerSequence",
  "eventHash",
  "confirmed",
  "listingId",
  "createdAt",
  "updatedAt"
FROM "ArchivedMarketplaceEvent"
WHERE "ledgerSequence" BETWEEN $START_LEDGER AND $END_LEDGER
ON CONFLICT ("id") DO NOTHING;
```

---

### Step 4: Post-Restore Reconciliation Proof [READ-ONLY]

Verify that 100% of candidate archive records now exist in the hot table:

```sql
-- [READ-ONLY] Prove full reconciliation between archive and hot table
SELECT
  archive_stats.total_archived,
  hot_stats.total_hot,
  (archive_stats.total_archived - hot_stats.total_hot) AS missing_rows
FROM
  (SELECT COUNT(*) AS total_archived
   FROM "ArchivedMarketplaceEvent"
   WHERE "ledgerSequence" BETWEEN $START_LEDGER AND $END_LEDGER) archive_stats,
  (SELECT COUNT(*) AS total_hot
   FROM "MarketplaceEvent"
   WHERE "ledgerSequence" BETWEEN $START_LEDGER AND $END_LEDGER) hot_stats;
-- Expected output: missing_rows = 0
```

---

### Step 5: Checksum Integrity Proof [READ-ONLY]

Verify checksum and provenance values attached to the archived rows:

```sql
-- [READ-ONLY] Inspect checksum integrity across restored samples
SELECT
  a."id",
  a."ledgerSequence",
  a."eventHash",
  a."archiveChecksum",
  a."archivedAt"
FROM "ArchivedMarketplaceEvent" a
INNER JOIN "MarketplaceEvent" m ON m."id" = a."id"
WHERE a."ledgerSequence" BETWEEN $START_LEDGER AND $END_LEDGER
LIMIT 25;
```

---

### Step 6: Post-Restore Canonical Safety Verification [READ-ONLY]

Re-run the canonical table count query to prove that no canonical records were mutated:

```sql
-- [READ-ONLY] Assert canonical tables match baseline counts exactly
SELECT 'Listing' AS canonical_table, COUNT(*) FROM "Listing"
UNION ALL
SELECT 'Auction', COUNT(*) FROM "Auction"
UNION ALL
SELECT 'Offer', COUNT(*) FROM "Offer"
UNION ALL
SELECT 'Bid', COUNT(*) FROM "Bid"
UNION ALL
SELECT 'RoyaltyPayment', COUNT(*) FROM "RoyaltyPayment"
UNION ALL
SELECT 'Collection', COUNT(*) FROM "Collection";
```

---

### Operator Notes: Review & Rollback Procedures

#### Review Checklist
1. Pre- and post-canonical table counts must match identically.
2. Step 4 reconciliation query must yield `missing_rows = 0`.
3. Confirm no `DELETE FROM "ArchivedMarketplaceEvent"` or `TRUNCATE` was run.
4. Record operator handle, execution date, ledger sequence window, and checksum samples in the maintenance log.

#### Rollback Procedure
If a restore was executed with an erroneous ledger range or caused unexpected query latency:
1. Since the archive source table was never modified or deleted, original archival provenance remains completely preserved.
2. Remove only the restored rows from the hot table:
   ```sql
   DELETE FROM "MarketplaceEvent"
   WHERE "id" IN (
     SELECT "id" FROM "ArchivedMarketplaceEvent"
     WHERE "ledgerSequence" BETWEEN $START_LEDGER AND $END_LEDGER
   );
   ```
3. Verify that `ArchivedMarketplaceEvent` row count and checksums remain untouched.


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

## OperationalAudit retention

`OperationalAudit` rows are not archived — they are deleted after 90 days.
The `deleteOldRecords(90)` call in `audit-service.ts` is the deletion
mechanism. Deletion is gated on the same advisory lock and time-window checks
used by the archival job.

```sql
DELETE FROM "OperationalAudit"
WHERE "createdAt" < now() - INTERVAL '90 days';
```

`ipAddress` is included in the deleted rows. It is never written to an archive
table.

## Legal-hold exclusions

A legal hold prevents deletion of rows that are under active regulatory or
litigation hold. The archival and retention jobs consult the `LEGAL_HOLD_IDS`
environment variable — a comma-separated list of `OperationalAudit.requestId`
values — and skip any row whose `requestId` is in that list.

The archive job similarly skips `MarketplaceEvent` rows whose `eventHash` is
listed in `LEGAL_HOLD_EVENT_HASHES`. Canonical tables (`Listing`, `Auction`,
etc.) are never deleted by the retention job and are not subject to this
exclusion mechanism.

## Cleanup verification

The retention and archival jobs are tested in
`src/__tests__/retention-cleanup.test.ts` which verifies:

1. Every wallet-related field has a documented retention class (static
   catalogue assertion).
2. `archiveTable()` moves eligible off-chain rows to archive tables without
   touching `Listing`, `Auction`, `Offer`, `Bid`, `RoyaltyPayment`, or
   `Collection` rows (canonical tables must not be deleted).
3. `deleteOldOperationalAuditRecords()` removes `OperationalAudit` rows
   outside the retention window and preserves legal-hold rows.
4. Redaction tests confirm that `pseudonymizeWallet()` and
   `maybeRedactWallet()` produce the correct output.
