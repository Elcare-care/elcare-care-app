# Migration Guide — Zero-Downtime Expand-Contract Procedure

The ElcareHub indexer ingests Stellar events continuously.  Schema migrations
must never interrupt ingestion.  This guide defines the **expand-contract**
pattern that every non-trivial migration must follow.

---

## Table of contents

1. [Why expand-contract](#why-expand-contract)
2. [The four phases](#the-four-phases)
3. [What CI checks](#what-ci-checks)
4. [Approved SQL patterns](#approved-sql-patterns)
5. [Banned patterns and alternatives](#banned-patterns-and-alternatives)
6. [Backfill progress and completion](#backfill-progress-and-completion)
7. [Rollback notes](#rollback-notes)
8. [Example walkthrough: adding settlementToken](#example-walkthrough)
9. [Emergency procedure](#emergency-procedure)

---

## Why expand-contract

The indexer poller runs inside a persistent process.  A migration that holds
an `AccessExclusiveLock` (e.g. `DROP COLUMN`) stalls every transaction that
touches the table, including the poller's event writes.  On busy tables even a
`CREATE INDEX` without `CONCURRENTLY` can block for tens of seconds.

The expand-contract pattern keeps the indexer available through the entire
deployment by spreading schema changes across multiple releases so that at no
point does a migration require a lock incompatible with an active ingestion
transaction.

---

## The four phases

| Phase | Release | What happens |
|-------|---------|-------------|
| **Expand** | N | Add new columns (nullable or with DEFAULT), new tables, new indexes (`CONCURRENTLY`). Old code keeps working because nothing is removed. |
| **Dual-write** | N (same) or N+1 | Application writes to **both** old and new columns. Reads still use the old column. |
| **Backfill** | N+1 | Background job populates the new column for all existing rows. Progress is observable (see below). **Do not proceed to contract until backfill is 100% complete.** |
| **Contract** | N+2 | Switch all reads to the new column. Remove writes to the old column. Drop the old column in this release's migration. |

Each phase ships as an independent PR and deployment.  A production rollback
during any phase reverts only that phase — it never causes data loss because
no data has been deleted yet.

---

## What CI checks

The `migration-safety` CI job runs on every push and pull request:

1. **`lint-migration.sh`** — scans **all** migration SQL files for banned
   patterns.  Any `ERROR`-level match blocks the merge.

2. **`check-zero-downtime.sh`** — generates a structured zero-downtime
   assessment report for every changed migration in the PR.  The report is
   advisory (it does not block merge by itself) but must be reviewed before
   approval.

Run locally:

```bash
# Lint everything
bash scripts/migrations/lint-migration.sh

# Lint only files changed vs main
bash scripts/migrations/lint-migration.sh --changed-only

# Check a specific file
bash scripts/migrations/check-zero-downtime.sh \
  indexer/prisma/migrations/<timestamp>_my_migration/migration.sql
```

---

## Approved SQL patterns

These patterns are safe to deploy without downtime:

```sql
-- Adding a nullable column (instantaneous in PG 11+)
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "settlementToken" TEXT DEFAULT NULL;

-- Adding a column with a constant DEFAULT (stored in catalog, no rewrite)
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "version" INTEGER DEFAULT 0 NOT NULL;

-- Creating a new table
CREATE TABLE "NewFeatureLog" ( ... );

-- Non-blocking index creation
-- migrate:disable_ddl_transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Listing_settlementToken_idx"
  ON "Listing" ("settlementToken");

-- Deferred NOT NULL constraint (avoids full table scan on ALTER)
ALTER TABLE "Listing" ADD COLUMN "requiredField" TEXT;
-- ... backfill ...
ALTER TABLE "Listing" ALTER COLUMN "requiredField" SET NOT NULL;

-- Adding a foreign key with NOT VALID (validate separately)
ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_settlementToken_fkey"
  FOREIGN KEY ("settlementToken") REFERENCES "WhitelistedToken"("address")
  NOT VALID;
-- In a later release or a separate transaction:
ALTER TABLE "Offer" VALIDATE CONSTRAINT "Offer_settlementToken_fkey";
```

---

## Banned patterns and alternatives

| Banned | Alternative |
|--------|-------------|
| `DROP TABLE` | Archive rows first (`INSERT INTO archive SELECT … FROM old`), then drop in contract phase after all code is updated |
| `DROP COLUMN` | Remove application reads/writes (deploy code without references), then drop in contract phase |
| `ALTER COLUMN … TYPE` | Add new typed column → dual-write → backfill → switch reads → drop old column |
| `RENAME TABLE` | Create new table → dual-write → backfill → switch reads → drop old table |
| `RENAME COLUMN` | Add new column → dual-write → backfill → switch reads → drop old column |
| `TRUNCATE` | Background batched `DELETE` job outside the migration |
| Bulk `DELETE FROM` at top level | Batched background job with `LIMIT` and `pg_sleep` |
| `CREATE INDEX` without `CONCURRENTLY` | `CREATE INDEX CONCURRENTLY` outside a transaction block |
| `ADD COLUMN NOT NULL` without `DEFAULT` | Add nullable first, backfill, then `SET NOT NULL` |

---

## Backfill progress and completion

Never enter the contract phase until the backfill is 100% complete and
confirmed on **production**.

### Checking completeness

```sql
-- Count rows still needing backfill
SELECT COUNT(*) FROM "Listing" WHERE "settlementToken" IS NULL;
-- Must be 0 before proceeding to contract phase.
```

### Batched backfill template

Run this loop from a migration script or a one-off job:

```sql
DO $$
DECLARE
  updated INT;
BEGIN
  LOOP
    UPDATE "Listing"
    SET "settlementToken" = "currency"
    WHERE id IN (
      SELECT id FROM "Listing"
      WHERE "settlementToken" IS NULL
      LIMIT 10000
    );
    GET DIAGNOSTICS updated = ROW_COUNT;
    EXIT WHEN updated = 0;
    PERFORM pg_sleep(0.1);  -- yield to ingestion between batches
  END LOOP;
END $$;
```

### Observable via ProjectionRebuildJob

The `rebuild-projections` CLI tool (see `indexer/src/rebuild-projections.ts`)
records a `ProjectionRebuildJob` row.  Check progress:

```sql
SELECT id, status, "processedEntities", "totalEntities",
       ROUND(100.0 * "processedEntities" / NULLIF("totalEntities", 0), 1) AS pct
FROM "ProjectionRebuildJob"
ORDER BY "createdAt" DESC
LIMIT 5;
```

---

## Rollback notes

Every migration file must include a `-- rollback:` comment describing how to
undo the change if a hot rollback is needed before the contract phase:

```sql
-- rollback: ALTER TABLE "Listing" DROP COLUMN IF EXISTS "settlementToken";
--           DROP INDEX IF EXISTS "Listing_settlementToken_idx";
```

Rollback of an expand-phase migration is safe because no data has been deleted
or transformed yet.  The new column simply drops away.

---

## Example walkthrough

See `indexer/prisma/migrations/20260827000000_example_expand_contract/migration.sql`
for a fully annotated expand-phase migration that:

- Adds `settlementToken TEXT DEFAULT NULL` to `Listing`
- Creates a `CONCURRENTLY` index
- Documents the backfill loop
- Includes a `-- rollback:` note
- Lists the exact contract-phase statements (commented out) so reviewers can
  see the full plan in one file

---

## Emergency procedure

If a migration must be deployed immediately (critical security fix):

1. Take a backup: `bash scripts/backup/backup.sh`
2. Use `pg_dump --schema-only` to snapshot the current DDL
3. Apply the migration in a **maintenance window** (set `indexer` replicas to 0)
4. Bring the indexer back up; verify sync resumes within 60 s via
   `elcarehub_sync_lag_ledgers` in Grafana
5. File a follow-up ticket to refactor the migration into expand-contract form
   before the next non-emergency release
