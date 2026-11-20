# Database Migrations Guide

This guide details creating, testing, deploying, and rolling back database schema changes in the indexer service using Prisma ORM and PostgreSQL.

---

## 1. Overview & Best Practices

All database schema modifications are defined in [`indexer/prisma/schema.prisma`](../../indexer/prisma/schema.prisma) and managed through Prisma Migrate.

### Zero-Downtime Migration Rules
1. **Reversible Changes Only:** Never drop a column or table in the same migration that removes code dependencies.
2. **Nullable / Default Values:** New columns added to existing tables MUST be nullable or have a `DEFAULT` constraint.
3. **Concurrently Created Indexes:** For large production tables, create indexes using `CONCURRENTLY` to avoid table locks:
   ```sql
   CREATE INDEX CONCURRENTLY "idx_listing_seller" ON "Listing" ("seller");
   ```

---

## 2. Owning Files

- [`indexer/prisma/schema.prisma`](../../indexer/prisma/schema.prisma): Source of truth for database models.
- [`indexer/prisma/migrations/`](../../indexer/prisma/migrations/): Directory containing timestamped `.sql` migration scripts.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md): Developer checklist and contribution policies.
- [`scripts/migrations/check-zero-downtime.sh`](../../scripts/migrations/check-zero-downtime.sh): Zero-downtime static analyzer for migration SQL.

---

## 3. Command Reference

### Create a New Local Migration
```bash
cd indexer
npx prisma migrate dev --name <migration_description>
```
*Expected output:* Generates `prisma/migrations/<timestamp>_<description>/migration.sql` and updates local DB.

### Deploy Migrations to Production / Staging DB
```bash
cd indexer
npx prisma migrate deploy
```

### Reset Database & Re-apply All Migrations (Local Dev Only)
```bash
cd indexer
npx prisma migrate reset
```
*Warning:* Destroys all local data and re-runs `prisma db seed`.

### Test Rollback Resolution
```bash
cd indexer
npx prisma migrate resolve --rolled-back "<migration_name>"
```

---

## 4. Decision Tree & Diagnostics for Migration Failures

```
                    [ Migration Failure / Lockout ]
                                  │
                                  ▼
                        Inspect Error Output
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       ▼                          ▼                          ▼
[ Shadow DB Failure ]     [ Migration Failed Halfway ] [ Schema Drift Warning ]
       │                          │                          │
       ▼                          ▼                          ▼
 Fix SQL syntax in        Mark migration rolled back   Run `npx prisma`
 generated `.sql` file    `npx prisma migrate`         `migrate dev` to sync
 before committing.       `resolve --rolled-back`      local DB state.
```

### First Diagnostic Steps for Common Failures

#### Failure 1: Foreign Key Constraint Failure during `migrate dev`
* **Symptom:** `P3006: Migration failed when applying to shadow database`.
* **First Diagnostic Action:** Inspect generated `.sql` file in `prisma/migrations/`. Ensure dependent tables exist before foreign key constraints are declared.

#### Failure 2: Production Migration Stuck / Locked
* **Symptom:** `P3009: Failed migrations found in target database`.
* **First Diagnostic Action:** Inspect `_prisma_migrations` table in PostgreSQL:
  ```sql
  SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE finished_at IS NULL;
  ```
  Resolve the failed migration using `npx prisma migrate resolve`.

---

## 5. Safe Redaction Guidance

> [!WARNING]
> When executing database migrations or running queries:

- Do **NOT** log connection strings containing passwords (`DATABASE_URL`).
- When attaching database logs or dumps, sanitize user addresses, email addresses (from Magic wallet accounts), or PII.

---

## 6. Migration Naming Conventions & Release Note Format

To ensure clarity, automated linting compatibility, and predictable rollbacks, all Prisma migrations must adhere to these standardized conventions:

### Directory & File Naming Syntax
```
prisma/migrations/<YYYYMMDDHHMMSS>_<action>_<subject_or_feature>/migration.sql
```
- **Timestamp Prefix:** 14-digit numeric UTC timestamp generated automatically by `prisma migrate dev`.
- **Casing & Separators:** Strictly lowercase snake_case (`_`). No hyphens or uppercase characters.
- **Length Constraint:** Max 50 characters for `<action>_<subject_or_feature>`.

### Standard Action Verbs

| Action Prefix | Purpose | Example Migration Directory |
|---|---|---|
| `add_` | Add new tables, nullable columns, views, or helper functions | `20260729000000_add_archive_tables` |
| `create_` | Create partition child tables, range partitions, or materializations | `20260827000005_ledger_range_partitioning` |
| `update_` | Non-destructive schema or index configuration adjustments | `20260827000002_add_collection_metadata_status` |
| `strengthen_` | Add uniqueness, check constraints, or idempotency keys | `20260725000001_strengthen_event_idempotency` |
| `expand_` | First phase of an expand-contract zero-downtime evolution | `20260827000000_example_expand_contract` |
| `contract_` | Final cleanup phase removing deprecated columns/tables | `20260830000000_contract_remove_legacy_price` |
| `drop_` / `remove_` | Explicit drop of legacy or quarantined structures | `20260831000000_drop_legacy_events` |

### Required Release Note Header in `migration.sql`

Every committed migration file **must** include this release metadata block at the very top:

```sql
-- Migration: <timestamp>_<action>_<subject>
-- Purpose: <Concise description of the change and issue reference, e.g. Issue #1074>
-- Phase: <expand | dual-write | contract | standalone>
-- Zero-Downtime Safe: <true | false>
-- Rollback: <Reversible SQL statements or runbook reference>
-- Backfill: <none | background job | worker script reference>
```

---

## 7. Zero-Downtime Change Sequencing Example (Expand-Contract)

Zero-downtime deployments avoid table locks and ensure backwards-compatibility across rolling updates. The following walkthrough demonstrates migrating the `currency` text field to a dedicated `settlementToken` contract address on the `Listing` table:

```
[Phase 1: Expand] ──► [Phase 2: Dual-Write] ──► [Phase 3: Backfill] ──► [Phase 4: Contract]
(Add Nullable Col)   (Write to Old & New)    (Populate History)   (Drop Old Col)
```

### Phase 1: Expand Migration (Additive Only)
Create the new column as nullable with an optional concurrent index:

```sql
-- Migration: 20260827000000_example_expand_contract
-- Purpose: Add settlementToken column for multi-currency support (Issue #849)
-- Phase: expand
-- Zero-Downtime Safe: true
-- Rollback: ALTER TABLE "Listing" DROP COLUMN IF EXISTS "settlementToken";
-- Backfill: scripts/backfill/backfill-settlement-tokens.ts

ALTER TABLE "Listing" ADD COLUMN "settlementToken" TEXT;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Listing_settlementToken_idx"
  ON "Listing" ("settlementToken");
```

*Static Analysis Gate:*
```bash
# [READ-ONLY] Validate migration safety
bash scripts/migrations/check-zero-downtime.sh indexer/prisma/migrations/20260827000000_example_expand_contract/migration.sql
# Output: VERDICT: ✓ SAFE FOR ZERO-DOWNTIME DEPLOYMENT
```

### Phase 2: Dual-Write Code Deployment
1. Deploy indexer code that writes to **both** `currency` and `settlementToken` on listing creation/update.
2. Read paths fall back to `currency` if `settlementToken` is null: `row.settlementToken ?? row.currency`.

### Phase 3: Background Backfill
Run a batched background worker to populate historical records without acquiring heavy table locks:
```sql
UPDATE "Listing"
SET "settlementToken" = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
WHERE "settlementToken" IS NULL
  AND "currency" = 'XLM'
LIMIT 5000;
```

### Phase 4: Contract Migration (Cleanup)
Once all rows have `settlementToken` and application code reads only `settlementToken`, deploy the cleanup migration:

```sql
-- Migration: 20260830000000_contract_remove_legacy_currency
-- Purpose: Remove legacy currency column after 100% backfill completion
-- Phase: contract
-- Zero-Downtime Safe: true (application code no longer references column)
-- Rollback: Requires manual restore from database backup

ALTER TABLE "Listing" ALTER COLUMN "settlementToken" SET NOT NULL;
ALTER TABLE "Listing" DROP COLUMN IF EXISTS "currency";
```

---

## 8. Operator Notes: Review and Revert Procedures

### Pre-Merge Review Checklist
1. **Naming Conformance:** Verify directory name matches `<timestamp>_<action>_<subject>` in snake_case.
2. **Release Header:** Confirm `migration.sql` contains Purpose, Phase, Zero-Downtime Safe, Rollback, and Backfill comments.
3. **Static Analysis:** Execute `bash scripts/migrations/check-zero-downtime.sh <path-to-sql>`. Must exit `0`.

### Revert Procedure
If a migration introduces unexpected locks or database errors during deployment:
1. Mark migration as rolled back in Prisma metadata:
   ```bash
   cd indexer
   npx prisma migrate resolve --rolled-back "<migration_name>"
   ```
2. Execute the corresponding SQL rollback statements documented in the migration's `-- Rollback:` header.
3. Re-deploy the previous indexer application image.

