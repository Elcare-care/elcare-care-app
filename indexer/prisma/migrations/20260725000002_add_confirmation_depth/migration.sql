-- Migration: add_confirmation_depth (#286)
--
-- Adds a 'confirmed' flag to MarketplaceEvent.
-- Events are initially written as provisional (confirmed = false).
-- The poller promotes them to confirmed once they are CONFIRMATION_DEPTH
-- ledgers behind the network tip.
--
-- On reorg rollback, events beyond the safe ledger are hard-deleted
-- (as before), which naturally removes all provisional records in the
-- rolled-back range. The 'confirmed' column lets API consumers and SSE
-- clients distinguish "seen on-chain" from "finalized-enough".

ALTER TABLE "MarketplaceEvent"
    ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT false;

-- Index for efficient confirmation promotion queries
-- (poller runs: UPDATE WHERE ledgerSequence <= confirmThreshold AND confirmed = false)
CREATE INDEX "MarketplaceEvent_confirmed_ledgerSequence_idx"
    ON "MarketplaceEvent" ("confirmed", "ledgerSequence");
