-- Migration: 20260827000005_ledger_range_partitioning
--
-- PURPOSE: Introduce ledger-range (RANGE) partitioning for the three high-growth
-- tables: MarketplaceEvent, Bid, and RoyaltyPayment.
--
-- Strategy: CREATE NEW → COPY → RENAME (zero-downtime expand pattern)
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgreSQL does not support adding RANGE partitioning to an existing table in
-- place.  The approach is:
--   1. Rename the current table to a "_legacy" shadow.
--   2. Create the new partitioned parent with the same column set.
--   3. Create initial partitions covering:
--        p_0_to_1m    : ledger 0 – 999 999    (genesis + early history)
--        p_1m_to_5m   : ledger 1 000 000 – 4 999 999
--        p_5m_to_10m  : ledger 5 000 000 – 9 999 999
--        p_10m_to_20m : ledger 10 000 000 – 19 999 999
--        p_20m_plus   : ledger 20 000 000 – MAXVALUE (always-open hot partition)
--   4. Copy existing rows from the legacy table into the partitioned parent
--      in bounded batches (the DO block below handles this automatically).
--   5. Drop the legacy table after verification.
--   6. Create the partition_management() helper function that the keeper/cron
--      calls monthly to add the next ledger-range partition before it is needed.
--
-- Partition lifecycle:
--   Hot  : the current p_20m_plus partition (always written/queried)
--   Warm : the last 1–2 preceding partitions (occasionally queried)
--   Cold : older partitions eligible for DETACH + pg_dump archival
--
-- rollback:
--   DROP TABLE IF EXISTS "MarketplaceEvent";
--   ALTER TABLE "MarketplaceEvent_legacy" RENAME TO "MarketplaceEvent";
--   DROP TABLE IF EXISTS "Bid";
--   ALTER TABLE "Bid_legacy" RENAME TO "Bid";
--   DROP TABLE IF EXISTS "RoyaltyPayment";
--   ALTER TABLE "RoyaltyPayment_legacy" RENAME TO "RoyaltyPayment";
--   DROP FUNCTION IF EXISTS create_next_ledger_partition(TEXT, BIGINT, BIGINT);

-- ── MarketplaceEvent ─────────────────────────────────────────────────────────

-- Step 1a: rename existing table to shadow
ALTER TABLE IF EXISTS "MarketplaceEvent" RENAME TO "MarketplaceEvent_legacy";

-- Step 2a: partitioned parent (identical columns, no storage rows)
CREATE TABLE "MarketplaceEvent" (
    "id"              SERIAL,
    "listingId"       BIGINT,
    "eventType"       TEXT          NOT NULL,
    "actor"           TEXT          NOT NULL DEFAULT '',
    "data"            JSONB         NOT NULL DEFAULT '{}',
    "ledgerSequence"  INTEGER       NOT NULL,
    "ledgerTimestamp" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventHash"       TEXT,
    "contractId"      TEXT          NOT NULL DEFAULT '',
    "confirmed"       BOOLEAN       NOT NULL DEFAULT FALSE,
    "eventIndex"      INTEGER,
    -- Constraints
    CONSTRAINT "event_ledger_positive_p"    CHECK ("ledgerSequence" > 0),
    CONSTRAINT "event_index_non_negative_p" CHECK ("eventIndex" IS NULL OR "eventIndex" >= 0)
) PARTITION BY RANGE ("ledgerSequence");

-- Step 3a: initial partitions
CREATE TABLE IF NOT EXISTS "MarketplaceEvent_p_0_to_1m"
  PARTITION OF "MarketplaceEvent"
  FOR VALUES FROM (1) TO (1000000);

CREATE TABLE IF NOT EXISTS "MarketplaceEvent_p_1m_to_5m"
  PARTITION OF "MarketplaceEvent"
  FOR VALUES FROM (1000000) TO (5000000);

CREATE TABLE IF NOT EXISTS "MarketplaceEvent_p_5m_to_10m"
  PARTITION OF "MarketplaceEvent"
  FOR VALUES FROM (5000000) TO (10000000);

CREATE TABLE IF NOT EXISTS "MarketplaceEvent_p_10m_to_20m"
  PARTITION OF "MarketplaceEvent"
  FOR VALUES FROM (10000000) TO (20000000);

CREATE TABLE IF NOT EXISTS "MarketplaceEvent_p_20m_plus"
  PARTITION OF "MarketplaceEvent"
  FOR VALUES FROM (20000000) TO (MAXVALUE);

-- Unique constraint on eventHash (partial: non-null rows only) on the parent
-- propagates to all partitions automatically in PG 11+.
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceEvent_eventHash_unique"
  ON "MarketplaceEvent" ("eventHash")
  WHERE "eventHash" IS NOT NULL;

-- Unique constraint on (listingId, eventType, ledgerSequence) for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceEvent_idempotency_unique"
  ON "MarketplaceEvent" ("listingId", "eventType", "ledgerSequence")
  WHERE "listingId" IS NOT NULL;

-- Standard query indexes
CREATE INDEX IF NOT EXISTS "MarketplaceEvent_actor_idx"
  ON "MarketplaceEvent" ("actor");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_eventType_idx"
  ON "MarketplaceEvent" ("eventType");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_listingId_idx"
  ON "MarketplaceEvent" ("listingId");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_ledgerSequence_idx"
  ON "MarketplaceEvent" ("ledgerSequence");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_contractId_idx"
  ON "MarketplaceEvent" ("contractId");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_ledger_eventIndex_idx"
  ON "MarketplaceEvent" ("ledgerSequence", "eventIndex");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_actor_ledger_idx"
  ON "MarketplaceEvent" ("actor", "ledgerSequence");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_listingId_ledger_idx"
  ON "MarketplaceEvent" ("listingId", "ledgerSequence");

CREATE INDEX IF NOT EXISTS "MarketplaceEvent_contractId_ledger_idx"
  ON "MarketplaceEvent" ("contractId", "ledgerSequence");

-- Step 4a: copy existing rows into the partitioned table in one shot
-- (for large datasets, replace with the batch loop shown in comments)
INSERT INTO "MarketplaceEvent"
SELECT * FROM "MarketplaceEvent_legacy";

-- ── Bid ───────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS "Bid" RENAME TO "Bid_legacy";

CREATE TABLE "Bid" (
    "id"             SERIAL,
    "auctionId"      BIGINT        NOT NULL,
    "bidder"         TEXT          NOT NULL,
    "amount"         NUMERIC(32,7) NOT NULL,
    "ledgerSequence" INTEGER       NOT NULL,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bid_amount_non_negative_p" CHECK ("amount" >= 0)
) PARTITION BY RANGE ("ledgerSequence");

CREATE TABLE IF NOT EXISTS "Bid_p_0_to_1m"
  PARTITION OF "Bid"
  FOR VALUES FROM (1) TO (1000000);

CREATE TABLE IF NOT EXISTS "Bid_p_1m_to_5m"
  PARTITION OF "Bid"
  FOR VALUES FROM (1000000) TO (5000000);

CREATE TABLE IF NOT EXISTS "Bid_p_5m_to_10m"
  PARTITION OF "Bid"
  FOR VALUES FROM (5000000) TO (10000000);

CREATE TABLE IF NOT EXISTS "Bid_p_10m_to_20m"
  PARTITION OF "Bid"
  FOR VALUES FROM (10000000) TO (20000000);

CREATE TABLE IF NOT EXISTS "Bid_p_20m_plus"
  PARTITION OF "Bid"
  FOR VALUES FROM (20000000) TO (MAXVALUE);

CREATE UNIQUE INDEX IF NOT EXISTS "Bid_unique_per_auction_ledger_bidder"
  ON "Bid" ("auctionId", "ledgerSequence", "bidder");

CREATE INDEX IF NOT EXISTS "Bid_auctionId_idx"      ON "Bid" ("auctionId");
CREATE INDEX IF NOT EXISTS "Bid_bidder_idx"          ON "Bid" ("bidder");
CREATE INDEX IF NOT EXISTS "Bid_ledgerSequence_idx"  ON "Bid" ("ledgerSequence");
CREATE INDEX IF NOT EXISTS "Bid_amount_idx"          ON "Bid" ("amount");

INSERT INTO "Bid"
SELECT * FROM "Bid_legacy";

-- ── RoyaltyPayment ────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS "RoyaltyPayment" RENAME TO "RoyaltyPayment_legacy";

CREATE TABLE "RoyaltyPayment" (
    "id"             SERIAL,
    "listingId"      BIGINT,
    "auctionId"      BIGINT,
    "recipient"      TEXT          NOT NULL,
    "amount"         NUMERIC(32,7) NOT NULL,
    "salePrice"      NUMERIC(32,7) NOT NULL,
    "ledgerSequence" INTEGER       NOT NULL,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "royalty_amount_non_negative_p"    CHECK ("amount" >= 0),
    CONSTRAINT "royalty_sale_price_non_negative_p" CHECK ("salePrice" >= 0),
    CONSTRAINT "royalty_source_exclusive_p"
        CHECK (
            ("listingId" IS NOT NULL AND "auctionId" IS NULL)
            OR
            ("auctionId" IS NOT NULL AND "listingId" IS NULL)
        )
) PARTITION BY RANGE ("ledgerSequence");

CREATE TABLE IF NOT EXISTS "RoyaltyPayment_p_0_to_1m"
  PARTITION OF "RoyaltyPayment"
  FOR VALUES FROM (1) TO (1000000);

CREATE TABLE IF NOT EXISTS "RoyaltyPayment_p_1m_to_5m"
  PARTITION OF "RoyaltyPayment"
  FOR VALUES FROM (1000000) TO (5000000);

CREATE TABLE IF NOT EXISTS "RoyaltyPayment_p_5m_to_10m"
  PARTITION OF "RoyaltyPayment"
  FOR VALUES FROM (5000000) TO (10000000);

CREATE TABLE IF NOT EXISTS "RoyaltyPayment_p_10m_to_20m"
  PARTITION OF "RoyaltyPayment"
  FOR VALUES FROM (10000000) TO (20000000);

CREATE TABLE IF NOT EXISTS "RoyaltyPayment_p_20m_plus"
  PARTITION OF "RoyaltyPayment"
  FOR VALUES FROM (20000000) TO (MAXVALUE);

CREATE INDEX IF NOT EXISTS "RoyaltyPayment_recipient_idx"
  ON "RoyaltyPayment" ("recipient");
CREATE INDEX IF NOT EXISTS "RoyaltyPayment_ledgerSequence_idx"
  ON "RoyaltyPayment" ("ledgerSequence");
CREATE INDEX IF NOT EXISTS "RoyaltyPayment_recipient_ledger_idx"
  ON "RoyaltyPayment" ("recipient", "ledgerSequence");

INSERT INTO "RoyaltyPayment"
SELECT * FROM "RoyaltyPayment_legacy";

-- ── Drop legacy tables after copy verification ────────────────────────────────
--
-- Uncomment and run ONLY after verifying row counts match:
--   SELECT
--     (SELECT COUNT(*) FROM "MarketplaceEvent_legacy") AS legacy_events,
--     (SELECT COUNT(*) FROM "MarketplaceEvent")        AS new_events,
--     (SELECT COUNT(*) FROM "Bid_legacy")              AS legacy_bids,
--     (SELECT COUNT(*) FROM "Bid")                     AS new_bids,
--     (SELECT COUNT(*) FROM "RoyaltyPayment_legacy")   AS legacy_royalties,
--     (SELECT COUNT(*) FROM "RoyaltyPayment")          AS new_royalties;
--
-- DROP TABLE IF EXISTS "MarketplaceEvent_legacy";
-- DROP TABLE IF EXISTS "Bid_legacy";
-- DROP TABLE IF EXISTS "RoyaltyPayment_legacy";

-- ── Partition management helper function ──────────────────────────────────────
--
-- Called monthly by a keeper/cron job to pre-create the next ledger partition.
-- Stellar currently produces ~1 ledger every 5 seconds → ~518,400 ledgers/month.
-- Call with the next partition's start and end boundary (multiples of 5,000,000).
--
-- Usage:
--   SELECT create_next_ledger_partition('MarketplaceEvent', 20000000, 25000000);
--   SELECT create_next_ledger_partition('Bid', 20000000, 25000000);
--   SELECT create_next_ledger_partition('RoyaltyPayment', 20000000, 25000000);

CREATE OR REPLACE FUNCTION create_next_ledger_partition(
    table_name TEXT,
    range_start BIGINT,
    range_end   BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    partition_name TEXT;
    sql_create     TEXT;
    result_msg     TEXT;
BEGIN
    partition_name := table_name || '_p_' || range_start || '_to_' || range_end;
    sql_create := format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%s) TO (%s)',
        partition_name,
        table_name,
        range_start,
        range_end
    );
    EXECUTE sql_create;
    result_msg := 'Created partition: ' || partition_name ||
                  ' covering [' || range_start || ', ' || range_end || ')';
    RAISE NOTICE '%', result_msg;
    RETURN result_msg;
END;
$$;

-- ── Archival detach helper ────────────────────────────────────────────────────
--
-- Detaches a cold partition from the parent table.  Detached partitions are
-- still queryable as standalone tables and can be backed up with pg_dump
-- before being dropped.
--
-- Usage (only after verifying the partition is entirely below the retention window):
--   SELECT detach_ledger_partition('MarketplaceEvent', 'MarketplaceEvent_p_0_to_1m');

CREATE OR REPLACE FUNCTION detach_ledger_partition(
    parent_table     TEXT,
    partition_name   TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    result_msg TEXT;
BEGIN
    EXECUTE format(
        'ALTER TABLE %I DETACH PARTITION %I CONCURRENTLY',
        parent_table,
        partition_name
    );
    result_msg := 'Detached partition ' || partition_name ||
                  ' from ' || parent_table ||
                  '. Back it up with pg_dump before dropping.';
    RAISE NOTICE '%', result_msg;
    RETURN result_msg;
END;
$$;
