# Database Migrations Guide

This guide details creating, testing, deploying, and rolling back database schema changes in the indexer service using Prisma ORM and PostgreSQL.

---

## 1. Overview & Best Practices

All database schema modifications are defined in [`indexer/prisma/schema.prisma`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/prisma/schema.prisma) and managed through Prisma Migrate.

### Zero-Downtime Migration Rules
1. **Reversible Changes Only:** Never drop a column or table in the same migration that removes code dependencies.
2. **Nullable / Default Values:** New columns added to existing tables MUST be nullable or have a `DEFAULT` constraint.
3. **Concurrently Created Indexes:** For large production tables, create indexes using `CONCURRENTLY` to avoid table locks:
   ```sql
   CREATE INDEX CONCURRENTLY "idx_listing_seller" ON "Listing" ("seller");
   ```

---

## 2. Owning Files

- [`indexer/prisma/schema.prisma`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/prisma/schema.prisma): Source of truth for database models.
- [`indexer/prisma/migrations/`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/prisma/migrations/): Directory containing timestamped `.sql` migration scripts.
- [`CONTRIBUTING-SCHEMA-CHANGES.md`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/CONTRIBUTING-SCHEMA-CHANGES.md): Developer checklist for PR approval.

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
