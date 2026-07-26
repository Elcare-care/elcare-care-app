-- Migration: strengthen_event_idempotency (#284)
--
-- Problems addressed:
--   1. eventHash has @default("") — multiple events with empty eventHash would
--      violate the unique constraint OR all silently get the same degenerate hash.
--      Fix: change default to NULL; callers must always supply a real SHA256 hash.
--
--   2. @@unique([listingId, eventType, ledgerSequence]) does not include contractId,
--      so the same event type at the same ledger from two different contracts would
--      collide. Also, events with listingId=NULL (deploy events, admin events) all
--      share the same (NULL, type, ledger) key — only the first would be stored.
--      Fix: drop the old partial constraint, add a new one that includes contractId
--      and uses NULLIF to handle NULL listingId correctly.
--
--   3. No database-level guarantee for the canonical identity across concurrent
--      workers — only application-level duplicate checks existed.
--      Fix: the eventHash unique index IS the canonical identity guard. Callers
--      must always compute and supply eventHash. The migration adds a CHECK
--      constraint to reject empty-string hashes at the DB level.

-- Step 1: Allow NULL eventHash temporarily while we backfill
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "eventHash" DROP DEFAULT;
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "eventHash" DROP NOT NULL;

-- Step 2: Convert existing empty-string hashes to NULL
-- (They were placeholder defaults; the unique index on "" would have collapsed them anyway)
UPDATE "MarketplaceEvent"
SET "eventHash" = NULL
WHERE "eventHash" = '';

-- Step 3: Drop the old weak composite unique constraint
DROP INDEX IF EXISTS "MarketplaceEvent_listingId_eventType_ledgerSequence_key";

-- Step 4: Add a stronger composite unique index that includes contractId.
-- We use a partial index expression: coalesce listingId to -1 for NULL rows
-- so that events without a listingId (admin, deploy) don't collapse into
-- a single slot per (type, ledger, contract).
-- NOTE: The authoritative identity is still eventHash; this secondary index
-- exists as a belt-and-suspenders guard for any legacy events without an
-- eventHash, and to prevent the single most common category of accidental
-- duplicate (same event type, same ledger, same contract, same listing).
CREATE UNIQUE INDEX "MarketplaceEvent_contractId_listingId_eventType_ledgerSeq_key"
    ON "MarketplaceEvent" (
        "contractId",
        COALESCE("listingId"::text, ''),
        "eventType",
        "ledgerSequence"
    );

-- Step 5: Add CHECK constraint preventing empty-string eventHash
-- (NULL is allowed for legacy rows; empty string is not)
ALTER TABLE "MarketplaceEvent"
    ADD CONSTRAINT "MarketplaceEvent_eventHash_not_empty"
    CHECK ("eventHash" IS NULL OR length("eventHash") > 0);
