-- ============================================================
-- Migration: 20260827000000_example_expand_contract
--
-- PHASE: EXPAND  (Release N)
--
-- Scenario: Add `settlementToken` to the Listing table.
--   The current column is `currency` (free-form string).  We are
--   introducing a stricter `settlementToken` column (the whitelisted
--   token address) alongside it.  The old `currency` column stays
--   readable and writable by the current code so this release can
--   be rolled back without data loss.
--
-- Expand-contract plan
-- ─────────────────────
--   Release N   (this file) — EXPAND
--     • Add `settlementToken TEXT DEFAULT NULL`
--     • Add index on new column
--
--   Release N+1 — DUAL-WRITE + BACKFILL
--     • Application writes both `currency` and `settlementToken`
--     • Background backfill job populates `settlementToken` from
--       existing `currency` values for all rows
--     • backfill progress observable via ProjectionRebuildJob or a
--       simple: SELECT COUNT(*) FROM "Listing" WHERE "settlementToken" IS NULL
--
--   Release N+2 — CONTRACT (only after backfill reports 0 NULL rows)
--     • Switch all reads to `settlementToken`
--     • Remove `currency` writes from application code
--     • Drop the `currency` column in this release's migration
--
-- rollback: ALTER TABLE "Listing" DROP COLUMN IF EXISTS "settlementToken";
-- ============================================================

-- migrate:disable_ddl_transaction
-- (CONCURRENTLY index creation must run outside a transaction block)

-- ── Step 1: Add the new column (nullable, no table rewrite) ──────────────────
--
-- Postgres 11+ stores the DEFAULT purely in the catalog for NOT NULL columns
-- with a constant default, making this instantaneous.  We use NULL here
-- because at expand time not all rows will have a value yet.
ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "settlementToken" TEXT DEFAULT NULL;

-- backfill: populate "settlementToken" from "currency" for rows where
--           "settlementToken" IS NULL in batches of 10 000:
--
--   UPDATE "Listing"
--   SET "settlementToken" = "currency"
--   WHERE id IN (
--     SELECT id FROM "Listing"
--     WHERE "settlementToken" IS NULL
--     LIMIT 10000
--   );
--
-- Run this loop until zero rows are updated, then verify:
--   SELECT COUNT(*) FROM "Listing" WHERE "settlementToken" IS NULL;  -- must be 0
--
-- Observable via: ProjectionRebuildJob table (see rebuild-projections.ts)
-- or the data-quality gauge `dq_listings_missing_ipfs` as a proxy.

-- ── Step 2: Index on the new column ─────────────────────────────────────────
-- CONCURRENTLY does not block writes.  Must run outside a transaction block
-- (hence the migrate:disable_ddl_transaction directive above).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Listing_settlementToken_idx"
  ON "Listing" ("settlementToken");

-- ── Notes for Release N+2 (contract phase — DO NOT include in this file) ────
--
-- Only uncomment and run these statements after:
--   1. All application code exclusively reads/writes "settlementToken"
--   2. The backfill above reports 0 NULL rows
--   3. At least one full release cycle has passed with no rollback
--
-- ALTER TABLE "Listing" DROP COLUMN "currency";
-- DROP INDEX IF EXISTS "Listing_currency_idx";
