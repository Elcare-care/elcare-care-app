-- Add eventIndex to MarketplaceEvent for same-ledger deterministic ordering
ALTER TABLE "MarketplaceEvent" ADD COLUMN IF NOT EXISTS "eventIndex" INTEGER;

-- Composite index: (ledgerSequence, eventIndex) enables ordered provenance queries
CREATE INDEX IF NOT EXISTS "MarketplaceEvent_ledgerSequence_eventIndex_idx"
  ON "MarketplaceEvent"("ledgerSequence", COALESCE("eventIndex", 0));
