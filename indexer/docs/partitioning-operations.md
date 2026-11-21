# Ledger-Range Partitioning — Operational Guide

Migration: `20260827000005_ledger_range_partitioning`

## Overview

`MarketplaceEvent`, `Bid`, and `RoyaltyPayment` are partitioned by
`ledgerSequence` using PostgreSQL declarative range partitioning.
Older partitions can be detached and archived once they exit the query
hot-path, keeping index scans and vacuum operations on the remaining
partitions fast.

---

## Partition layout

| Partition name                       | Ledger range           | Status    |
|--------------------------------------|------------------------|-----------|
| `MarketplaceEvent_p_0_to_1m`         | 1 – 999 999            | cold/warm |
| `MarketplaceEvent_p_1m_to_5m`        | 1 000 000 – 4 999 999  | warm      |
| `MarketplaceEvent_p_5m_to_10m`       | 5 000 000 – 9 999 999  | warm      |
| `MarketplaceEvent_p_10m_to_20m`      | 10 000 000 – 19 999 999| warm      |
| `MarketplaceEvent_p_20m_plus`        | 20 000 000 – MAXVALUE  | **hot**   |

The same layout applies to `Bid` and `RoyaltyPayment`.

Stellar produces roughly one ledger every 5 seconds → ~518 400 ledgers per month.
A 5-million-ledger partition spans ≈ 9.6 months.

---

## Creating the next partition (monthly cron)

Run this before the hot partition's MAXVALUE boundary is needed (i.e. before
the network tip reaches 25 000 000):

```sql
SELECT create_next_ledger_partition('MarketplaceEvent', 25000000, 30000000);
SELECT create_next_ledger_partition('Bid',              25000000, 30000000);
SELECT create_next_ledger_partition('RoyaltyPayment',   25000000, 30000000);
```

Or call the TypeScript helper from the keeper/cron:

```typescript
import prisma from './prisma-write.js';

async function createNextPartition(
  tableName: string,
  rangeStart: number,
  rangeEnd: number,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `SELECT create_next_ledger_partition($1, $2, $3)`,
    tableName,
    rangeStart,
    rangeEnd,
  );
}
```

> **Rule:** Always create the next partition when the current tip is
> within 10 000 000 ledgers of the MAXVALUE boundary of the latest
> named partition. Monitor via:
>
> ```sql
> SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
> FROM pg_tables
> WHERE tablename LIKE 'MarketplaceEvent_p_%'
> ORDER BY tablename;
> ```

---

## Verifying row counts after migration

Run after migration to confirm all rows copied correctly:

```sql
SELECT
  (SELECT COUNT(*) FROM "MarketplaceEvent_legacy") AS legacy_events,
  (SELECT COUNT(*) FROM "MarketplaceEvent")        AS new_events,
  (SELECT COUNT(*) FROM "Bid_legacy")              AS legacy_bids,
  (SELECT COUNT(*) FROM "Bid")                     AS new_bids,
  (SELECT COUNT(*) FROM "RoyaltyPayment_legacy")   AS legacy_royalties,
  (SELECT COUNT(*) FROM "RoyaltyPayment")          AS new_royalties;
```

All three pairs must match before proceeding.  Only drop legacy tables after
this verification passes in staging and production.

Drop legacy tables (run once counts match):

```sql
DROP TABLE IF EXISTS "MarketplaceEvent_legacy";
DROP TABLE IF EXISTS "Bid_legacy";
DROP TABLE IF EXISTS "RoyaltyPayment_legacy";
```

---

## Confirming event hash uniqueness across partitions

The unique index on `eventHash` is defined on the parent table and propagates
to all partitions (PostgreSQL 11+).  Verify with:

```sql
-- Should return 0
SELECT COUNT(*) FROM (
  SELECT "eventHash", COUNT(*) AS n
  FROM "MarketplaceEvent"
  WHERE "eventHash" IS NOT NULL
  GROUP BY "eventHash"
  HAVING COUNT(*) > 1
) dups;
```

---

---

## Partition Maintenance Checklist (Pre-Destructive Action)

Before performing any destructive or partition-detaching action (`detach_ledger_partition`,
dropping legacy tables, or dropping detached partition tables), operators **must** complete this
checklist. All diagnostics are strictly **read-only** and bounded.

### Scope & Safety Principles
- **Bounded Scope:** Maintenance operations must target a single named partition per run. Never run bulk partition detachments across multiple ledger ranges simultaneously.
- **Reversibility Guarantee:** Partitions marked for retirement must always remain in a detached (quarantined) state for at least 7 days before issuing any `DROP TABLE` command.
- **Read-Only Verification:** All preflight checks execute read-only queries. Never combine diagnostic inspection with write or DDL transactions.

---

### Phase 1: Pre-Maintenance Inspection [READ-ONLY]

Run these read-only SQL queries to inventory disk footprint, ledger boundaries, and active lock states:

1. **Partition Disk Footprint & Row Estimates [READ-ONLY]:**
   ```sql
   SELECT
     schemaname,
     tablename,
     pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
     pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS table_size,
     pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS index_size
   FROM pg_tables
   WHERE tablename LIKE 'MarketplaceEvent_p_%'
      OR tablename LIKE 'Bid_p_%'
      OR tablename LIKE 'RoyaltyPayment_p_%'
   ORDER BY tablename;
   ```

2. **Ledger Boundary & Hot-Retention Window Check [READ-ONLY]:**
   ```sql
   -- Verify target partition ledger range is strictly below the retention threshold
   -- (e.g. older than 90 days hot window: ~1,555,200 ledgers at 5s/ledger)
   SELECT
     MIN("ledgerSequence") AS min_ledger,
     MAX("ledgerSequence") AS max_ledger,
     COUNT(*) AS row_count
   FROM "MarketplaceEvent_p_0_to_1m";

   -- Compare against current sync tip
   SELECT "lastLedger" AS current_sync_tip FROM "SyncState" LIMIT 1;
   ```

3. **Global Event Hash Uniqueness Check [READ-ONLY]:**
   ```sql
   -- Must return 0 rows before any partition change
   SELECT "eventHash", COUNT(*)
   FROM "MarketplaceEvent"
   WHERE "eventHash" IS NOT NULL
   GROUP BY "eventHash"
   HAVING COUNT(*) > 1;
   ```

4. **Active Connection & Lock Status [READ-ONLY]:**
   ```sql
   -- Confirm no long-running transactions hold locks on target partitions
   SELECT pid, now() - query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE query ILIKE '%MarketplaceEvent%'
     AND state != 'idle'
     AND pid <> pg_backend_pid();
   ```

---

### Phase 2: Ingestion Backlog & Queue Verification [READ-ONLY]

Confirm that no inflight ingestion or reconciliation tasks depend on the partition range:

1. **Dead Letter Queue Inspection [READ-ONLY]:**
   ```sql
   -- Ensure zero unhandled dead letters in target ledger range
   SELECT COUNT(*) AS pending_dlq_count
   FROM "DeadLetterEvent"
   WHERE "ledgerSequence" BETWEEN 1 AND 1000000
     AND "status" != 'RESOLVED';
   ```

2. **Active Backfill & Gap Repair Tasks [READ-ONLY]:**
   ```sql
   -- Must return 0 active jobs touching target range
   SELECT "id", "fromLedger", "toLedger", "status"
   FROM "BackfillJob"
   WHERE "status" IN ('RUNNING', 'PENDING')
     AND ("fromLedger" <= 1000000 AND "toLedger" >= 1);
   ```

---

### Phase 3: Escalation Triggers & Approvals

Do **NOT** proceed with partition detachment or dropping if any of the following escalation triggers are met:

| Condition | Trigger Threshold | Escalation Path |
|---|---|---|
| **Retention Violation** | `max_ledger` within last 90 days of tip | Abort detachment; notify Data Lead |
| **Pending DLQ Items** | `pending_dlq_count > 0` | Pause detachment; resolve replay queue first |
| **Active Backfill/Repair** | Active `BackfillJob` or `LedgerGap` in range | Abort detachment until jobs terminate |
| **Excessive Lock Wait** | DDL lock wait > 5 seconds | Cancel DDL; reschedule during low-traffic window |
| **Replica Lag** | Replication lag > 30 seconds | Abort until read replicas catch up |

**Sign-off requirement:** Detaching or dropping any partition requires peer review from at least one backend engineer and sign-off in the incident or maintenance issue.

---

### Phase 4: Bounded & Reversible Execution Workflow

1. **Pre-Action Standalone Backup:**
   ```bash
   # [BACKUP] Generate verified backup with SHA-256 checksum
   pg_dump -t '"MarketplaceEvent_p_0_to_1m"' "$DATABASE_URL" | gzip > /backups/MarketplaceEvent_p_0_to_1m_$(date +%Y%m%d).sql.gz
   sha256sum /backups/MarketplaceEvent_p_0_to_1m_$(date +%Y%m%d).sql.gz > /backups/MarketplaceEvent_p_0_to_1m_$(date +%Y%m%d).sql.gz.sha256
   ```

2. **Bounded Detach (Quarantine Phase):**
   ```sql
   -- Detach partition from routing; table remains intact as standalone table
   SELECT detach_ledger_partition('MarketplaceEvent', 'MarketplaceEvent_p_0_to_1m');
   ```

3. **7-Day Quarantine Window:**
   - Keep `"MarketplaceEvent_p_0_to_1m"` in place as a detached table for 7 days.
   - Monitor application error logs for any queries expecting historical events in that range.

4. **Permanent Drop (Post-Quarantine Only):**
   ```sql
   -- Execute ONLY after 7-day quarantine and verified backup
   DROP TABLE IF EXISTS "MarketplaceEvent_p_0_to_1m";
   ```

---

### Operator & Developer Notes: Review and Revert Procedures

#### Review Procedure
1. Check that all Phase 1 and Phase 2 queries ran and returned zero blocker rows.
2. Confirm backup file exists and SHA-256 checksum matches the generated hash.
3. Record operator handle, execution timestamp, and target partition in the maintenance ticket.

#### Revert Procedure (Immediate Rollback)
If historical queries or reconciliation jobs require the detached partition immediately:

1. **If table was detached but NOT dropped:**
   ```sql
   -- Immediate re-attach: zero data movement, instantaneous
   ALTER TABLE "MarketplaceEvent"
     ATTACH PARTITION "MarketplaceEvent_p_0_to_1m"
     FOR VALUES FROM (1) TO (1000000);
   ```

2. **If table was already dropped (Restore from backup):**
   ```sql
   -- 1. Re-create child partition schema
   CREATE TABLE "MarketplaceEvent_p_0_to_1m"
     PARTITION OF "MarketplaceEvent"
     FOR VALUES FROM (1) TO (1000000);

   -- 2. Restore data from verified backup
   gunzip -c /backups/MarketplaceEvent_p_0_to_1m_20260901.sql.gz | psql "$DATABASE_URL"
   ```

---

## Archiving a cold partition

Archival detaches the partition from query routing and preserves it as a
standalone table for backup. Only detach partitions that are entirely below
your retention window (e.g. all rows ingested > 18 months ago).

**Step 1 — verify the partition is cold (no writes in > retention window):**

```sql
SELECT MAX("ledgerSequence") FROM "MarketplaceEvent_p_0_to_1m";
-- Compare to current network tip; if (tip - max_ledger) > retention_ledgers → eligible
```

**Step 2 — back up the partition:**

```bash
pg_dump -t '"MarketplaceEvent_p_0_to_1m"' $DATABASE_URL \
  -f /backups/MarketplaceEvent_p_0_to_1m_$(date +%Y%m%d).sql
```

**Step 3 — detach:**

```sql
SELECT detach_ledger_partition('MarketplaceEvent', 'MarketplaceEvent_p_0_to_1m');
```

The detached table remains queryable as `"MarketplaceEvent_p_0_to_1m"` until
dropped. The ArchivedMarketplaceEvent table (migration 20260729) holds the
application-level archive view; this partition archive is the storage-level
complement.

**Step 4 — drop after backup confirmed:**

```sql
DROP TABLE IF EXISTS "MarketplaceEvent_p_0_to_1m";
```

**Step 5 — update the operational runbook** (this doc) to mark the partition
as dropped.

---

## Restore procedure (partial)

To restore a detached partition and re-attach it:

```sql
-- Re-create with the same range boundary
CREATE TABLE "MarketplaceEvent_p_0_to_1m"
  PARTITION OF "MarketplaceEvent"
  FOR VALUES FROM (1) TO (1000000);

-- Restore from backup
\i /backups/MarketplaceEvent_p_0_to_1m_20260901.sql
```

All indexes and constraints on the parent propagate automatically to the
re-attached partition. Existing rows in the range from the backup do not need
to be re-inserted if the partition was empty at re-creation time.

---

## Prisma and raw-query compatibility

Prisma's generated client treats the partitioned parent tables identically to
unpartitioned tables. No Prisma schema changes are required for routine
partitioning operations.

**Write path:** `prisma.marketplaceEvent.create()` / `upsert()` automatically
routes to the correct child partition based on `ledgerSequence`.

**Read path:** `prisma.marketplaceEvent.findMany({ where: { ledgerSequence: { gte: X, lte: Y } } })`
uses partition pruning automatically when `ledgerSequence` is in the WHERE
clause.

**Raw queries** (e.g. in stats.ts, reconciler.ts) that reference
`"MarketplaceEvent"` by name continue to work unchanged — the parent table
name is stable.

**Unique constraints across partitions:** PostgreSQL 11+ enforces unique
indexes on the parent globally. The `eventHash` unique index and the
`(listingId, eventType, ledgerSequence)` unique index both cover all partitions.

---

## Expected query-plan improvements

Run `EXPLAIN (ANALYZE, BUFFERS)` on hot API queries before and after applying
this migration to confirm partition pruning is active:

```sql
-- Should show only MarketplaceEvent_p_20m_plus scanned for recent ledgers
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "MarketplaceEvent"
WHERE "ledgerSequence" > 20000000
ORDER BY "ledgerSequence" DESC
LIMIT 50;
```

Look for `Seq Scan on marketplaceevent_p_20m_plus` (or an index scan on it)
rather than a scan over all partitions.

---

## Rollback procedure

If the migration must be rolled back before the legacy tables are dropped:

```sql
-- Drop the new partitioned parent (cascade removes all child partitions)
DROP TABLE IF EXISTS "MarketplaceEvent" CASCADE;
DROP TABLE IF EXISTS "Bid"             CASCADE;
DROP TABLE IF EXISTS "RoyaltyPayment"  CASCADE;

-- Restore the original tables
ALTER TABLE "MarketplaceEvent_legacy" RENAME TO "MarketplaceEvent";
ALTER TABLE "Bid_legacy"              RENAME TO "Bid";
ALTER TABLE "RoyaltyPayment_legacy"   RENAME TO "RoyaltyPayment";
```

**Important:** this rollback is only possible while the `_legacy` tables
still exist. Do not drop them until the new partitioned tables have been
fully verified in production.
