-- Baseline migration: create core tables that predate tracked migrations

CREATE TABLE "SyncState" (
    "id"             INTEGER NOT NULL DEFAULT 1 PRIMARY KEY,
    "lastLedger"     INTEGER NOT NULL DEFAULT 0,
    "lastLedgerHash" TEXT,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Listing" (
    "listingId"       BIGINT          NOT NULL PRIMARY KEY,
    "artist"          TEXT            NOT NULL,
    "owner"           TEXT,
    "price"           DECIMAL(32, 7)  NOT NULL,
    "currency"        TEXT            NOT NULL,
    "metadataCid"     TEXT            NOT NULL,
    "token"           TEXT            NOT NULL,
    "status"          TEXT            NOT NULL,
    "royaltyBps"      INTEGER         NOT NULL DEFAULT 0,
    "createdAtLedger" INTEGER         NOT NULL,
    "updatedAtLedger" INTEGER         NOT NULL
);
-- Basic indexes only; additional indexes added in 20260601000000_add_missing_indexes
CREATE INDEX "Listing_artist_idx" ON "Listing"("artist");
CREATE INDEX "Listing_status_idx" ON "Listing"("status");

CREATE TABLE "MarketplaceEvent" (
    "id"              SERIAL          NOT NULL PRIMARY KEY,
    "listingId"       BIGINT,
    "eventType"       TEXT            NOT NULL,
    "actor"           TEXT            NOT NULL,
    "data"            JSONB           NOT NULL,
    "ledgerSequence"  INTEGER         NOT NULL,
    "ledgerTimestamp" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MarketplaceEvent_actor_idx"    ON "MarketplaceEvent"("actor");
CREATE INDEX "MarketplaceEvent_eventType_idx" ON "MarketplaceEvent"("eventType");
CREATE UNIQUE INDEX "MarketplaceEvent_listingId_eventType_ledgerSequence_key"
    ON "MarketplaceEvent"("listingId", "eventType", "ledgerSequence");
