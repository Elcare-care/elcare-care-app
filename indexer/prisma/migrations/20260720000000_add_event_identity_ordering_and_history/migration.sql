-- Event identity + intra-ledger ordering + bid/price/fee history (issue #191).
--
-- Backfill-safe per CONTRIBUTING-SCHEMA-CHANGES.md: new NOT NULL columns are
-- added nullable, backfilled from existing data, then constrained.
-- Reverse (documented for rollback):
--   DROP TABLE "ProtocolFee"; DROP TABLE "PriceHistory";
--   ALTER TABLE "MarketplaceEvent" DROP COLUMN "eventId", DROP COLUMN "txHash",
--     DROP COLUMN "txIndex", DROP COLUMN "eventIndex";
--   CREATE UNIQUE INDEX "MarketplaceEvent_listingId_eventType_ledgerSequence_key"
--     ON "MarketplaceEvent"("listingId", "eventType", "ledgerSequence");
--   (OfferStatus enum value 'Reclaimed' cannot be dropped; harmless if unused.)

-- 1. New identity/ordering columns, nullable first so existing rows survive.
ALTER TABLE "MarketplaceEvent" ADD COLUMN IF NOT EXISTS "eventId" TEXT;
ALTER TABLE "MarketplaceEvent" ADD COLUMN IF NOT EXISTS "txHash" TEXT;
ALTER TABLE "MarketplaceEvent" ADD COLUMN IF NOT EXISTS "txIndex" INTEGER;
ALTER TABLE "MarketplaceEvent" ADD COLUMN IF NOT EXISTS "eventIndex" INTEGER;

-- 2. Backfill legacy rows. eventHash is already unique per row, so it is a
--    valid surrogate eventId; rows predating eventHash fall back to a
--    row-id-derived legacy key.
UPDATE "MarketplaceEvent"
SET "eventId" = CASE
      WHEN "eventHash" IS NOT NULL AND "eventHash" <> '' THEN "eventHash"
      ELSE 'legacy-' || "id"::TEXT
    END
WHERE "eventId" IS NULL;

UPDATE "MarketplaceEvent" SET "txHash" = '' WHERE "txHash" IS NULL;
UPDATE "MarketplaceEvent" SET "txIndex" = 0 WHERE "txIndex" IS NULL;
UPDATE "MarketplaceEvent" SET "eventIndex" = 0 WHERE "eventIndex" IS NULL;

-- 3. Enforce NOT NULL + defaults now that every row has a value.
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "txHash" SET NOT NULL;
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "txHash" SET DEFAULT '';
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "txIndex" SET NOT NULL;
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "txIndex" SET DEFAULT 0;
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "eventIndex" SET NOT NULL;
ALTER TABLE "MarketplaceEvent" ALTER COLUMN "eventIndex" SET DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceEvent_eventId_key" ON "MarketplaceEvent"("eventId");
CREATE INDEX IF NOT EXISTS "MarketplaceEvent_ledgerSequence_txIndex_eventIndex_idx"
  ON "MarketplaceEvent"("ledgerSequence", "txIndex", "eventIndex");

-- 4. Drop the lossy dedupe key: two same-type events for one listing in one
--    ledger are legitimate (e.g. two OFFER_MADE from different users) and must
--    both persist. Uniqueness is now enforced by eventId (and eventHash).
DROP INDEX IF EXISTS "MarketplaceEvent_listingId_eventType_ledgerSequence_key";

-- 5. Terminal state for reclaimed offers (ofr_rclm).
--    Safe inside a transaction on PG 12+ as long as the value is not used in
--    this same migration.
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'Reclaimed';

-- 6. Price history (lst_pru events).
CREATE TABLE IF NOT EXISTS "PriceHistory" (
    "id" SERIAL NOT NULL,
    "listingId" BIGINT NOT NULL,
    "oldPrice" DECIMAL(32,7) NOT NULL,
    "newPrice" DECIMAL(32,7) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PriceHistory_eventId_key" ON "PriceHistory"("eventId");
CREATE INDEX IF NOT EXISTS "PriceHistory_listingId_idx" ON "PriceHistory"("listingId");
CREATE INDEX IF NOT EXISTS "PriceHistory_listingId_ledgerSequence_idx" ON "PriceHistory"("listingId", "ledgerSequence");

-- 7. Protocol fee revenue (fee_cltd events).
CREATE TABLE IF NOT EXISTS "ProtocolFee" (
    "id" SERIAL NOT NULL,
    "listingId" BIGINT NOT NULL,
    "amount" DECIMAL(32,7) NOT NULL,
    "token" TEXT NOT NULL,
    "treasury" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProtocolFee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProtocolFee_eventId_key" ON "ProtocolFee"("eventId");
CREATE INDEX IF NOT EXISTS "ProtocolFee_listingId_idx" ON "ProtocolFee"("listingId");
CREATE INDEX IF NOT EXISTS "ProtocolFee_treasury_idx" ON "ProtocolFee"("treasury");
CREATE INDEX IF NOT EXISTS "ProtocolFee_ledgerSequence_idx" ON "ProtocolFee"("ledgerSequence");
