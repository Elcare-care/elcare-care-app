-- Issue #213: Add PriceHistory table to track every listing price change.
-- Populated by the indexer on every LISTING_PRICE_UPDATED event so collectors
-- can audit the full price trail for any listing.

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id"              SERIAL          NOT NULL,
    "listingId"       BIGINT          NOT NULL,
    "oldPrice"        DECIMAL(32,7)   NOT NULL,
    "newPrice"        DECIMAL(32,7)   NOT NULL,
    "changedBy"       TEXT            NOT NULL DEFAULT '',
    "changedAtLedger" INTEGER         NOT NULL,
    "changedAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceHistory_listingId_idx" ON "PriceHistory"("listingId");

-- CreateIndex
CREATE INDEX "PriceHistory_listingId_changedAtLedger_idx" ON "PriceHistory"("listingId", "changedAtLedger");
