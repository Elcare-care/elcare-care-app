-- Add offer and collection sampling counters to ReconciliationRun so the
-- accounting reconciliation pass (offers + collections) can be tracked
-- alongside the primary pass (listings + auctions).

ALTER TABLE "ReconciliationRun"
  ADD COLUMN IF NOT EXISTS "sampledOffers"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sampledCollections"  INTEGER NOT NULL DEFAULT 0;
