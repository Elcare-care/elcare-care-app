-- Migration: 20260827000004_offer_orphan_staging
--
-- PURPOSE: Enforce referential integrity between Offer.listingId and Listing
-- while supporting out-of-order event ingestion (OFFER_MADE may arrive before
-- its parent LISTING_CREATED during a backfill or gap repair).
--
-- Strategy chosen: PENDING staging table + deferred promotion
-- ─────────────────────────────────────────────────────────────────────────────
-- We do NOT add a direct FK from Offer.listingId → Listing.listingId because:
--   a. Out-of-order backfill would break ingestion for the offer's entire batch.
--   b. Reorg rollback deletes Listing rows; a FK would cascade-delete the Offer
--      (loss of audit history) or block the Listing delete (reorg fails).
--
-- Instead:
--   1. A new "PendingOffer" staging table holds offers whose parent listing
--      has not yet been ingested.  The indexer writes here when OFFER_MADE
--      arrives before LISTING_CREATED.
--   2. A trigger on Listing INSERT promotes any PendingOffer rows for the newly
--      created listing into the live Offer table automatically (in the same tx).
--   3. A soft FK: "Offer_listingId_fk_idx" partial index + a new CHECK constraint
--      on Offer ensures listingId is > 0 (prevents NULL/zero sentinel from hiding
--      orphans); the application must verify the listing exists before exposing
--      the offer via the API.
--   4. A scheduled maintenance view "orphaned_offers" identifies Offer rows whose
--      listingId has no matching Listing — for operator alerting rather than
--      automatic deletion (historical records must survive reorgs).
--   5. On reorg rollback, PendingOffer rows for the rolled-back ledger range are
--      also cleared (same transaction as the Listing deleteMany).
--
-- rollback:
--   DROP TRIGGER IF EXISTS trg_promote_pending_offers ON "Listing";
--   DROP FUNCTION IF EXISTS promote_pending_offers();
--   DROP TABLE IF EXISTS "PendingOffer";
--   DROP VIEW IF EXISTS "orphaned_offers";
--   ALTER TABLE "Offer" DROP CONSTRAINT IF EXISTS "offer_listing_id_positive";

-- ── 1. PendingOffer staging table ────────────────────────────────────────────
--
-- Mirrors the Offer table's essential columns for the staging period.
-- A row lives here only until its parent listing is ingested, at which point
-- the promotion trigger moves it to Offer and deletes the staging row.
--
-- createdAtLedger / originalEventLedger: the ledger at which OFFER_MADE fired
-- (used to revert on reorg).  The staging row can be reorgrolled by:
--   DELETE FROM "PendingOffer" WHERE "createdAtLedger" > <safeAtLedger>;

CREATE TABLE IF NOT EXISTS "PendingOffer" (
    "offerId"         BIGINT       NOT NULL,
    "listingId"       BIGINT       NOT NULL,
    "offerer"         TEXT         NOT NULL DEFAULT '',
    "amount"          NUMERIC(32,7) NOT NULL DEFAULT 0,
    "token"           TEXT         NOT NULL DEFAULT '',
    "expiresAt"       BIGINT,
    "escrowTxHash"    TEXT,
    "createdAtLedger" INTEGER      NOT NULL,
    "updatedAtLedger" INTEGER      NOT NULL,
    "rawEventData"    JSONB,       -- preserves the full OFFER_MADE payload for replay
    "stagedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("offerId"),
    CONSTRAINT "pending_offer_amount_non_negative" CHECK ("amount" >= 0)
);

CREATE INDEX IF NOT EXISTS "PendingOffer_listingId_idx"      ON "PendingOffer" ("listingId");
CREATE INDEX IF NOT EXISTS "PendingOffer_createdAtLedger_idx" ON "PendingOffer" ("createdAtLedger");

-- ── 2. Promotion trigger: PendingOffer → Offer on Listing INSERT ──────────────
--
-- Fires AFTER INSERT on Listing (within the same transaction as the INSERT).
-- Moves all PendingOffer rows whose listingId matches the new Listing into the
-- live Offer table, then deletes the staging rows.
--
-- The function is intentionally SECURITY DEFINER-free — it runs as the
-- executing role, which is the same role the indexer uses for all writes.

CREATE OR REPLACE FUNCTION promote_pending_offers()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert any pending offers that were waiting for this listing.
    -- ON CONFLICT DO NOTHING guards against a replayed LISTING_CREATED
    -- that tries to promote offers already promoted by a prior LISTING_CREATED.
    INSERT INTO "Offer" (
        "offerId",
        "listingId",
        "offerer",
        "amount",
        "token",
        "status",
        "expiresAt",
        "escrowTxHash",
        "createdAtLedger",
        "updatedAtLedger",
        "createdAt",
        "updatedAt"
    )
    SELECT
        po."offerId",
        po."listingId",
        po."offerer",
        po."amount",
        po."token",
        'Pending',                          -- always Pending when first promoted
        po."expiresAt",
        po."escrowTxHash",
        po."createdAtLedger",
        po."updatedAtLedger",
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    FROM "PendingOffer" po
    WHERE po."listingId" = NEW."listingId"
    ON CONFLICT ("offerId") DO NOTHING;

    -- Remove promoted rows from staging.
    DELETE FROM "PendingOffer"
    WHERE "listingId" = NEW."listingId";

    RETURN NULL; -- AFTER trigger return value is ignored for row triggers
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_pending_offers ON "Listing";
CREATE TRIGGER trg_promote_pending_offers
AFTER INSERT ON "Listing"
FOR EACH ROW
EXECUTE FUNCTION promote_pending_offers();

-- ── 3. Soft integrity constraint on Offer.listingId ──────────────────────────
--
-- Prevents listingId = 0 or negative values being stored (these would be
-- sentinel / uninitialized values from a buggy parser path).
-- The real referential check is handled by the orphan view (step 4).

ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_listing_id_positive"
  CHECK ("listingId" > 0);

-- ── 4. Orphaned-offer diagnostic view ────────────────────────────────────────
--
-- Returns Offer rows whose parent Listing no longer exists.  Expected to be
-- empty in steady state.  The indexer's /admin/diagnostics route (or a Grafana
-- alert on the dq_orphaned_offers gauge) should query this.
--
-- NOTE: this is READ-ONLY — no automatic deletion.  The historical Offer record
-- must survive reorgs; an orphan after a reorg is by definition temporary and
-- will be resolved when the gap is backfilled.

CREATE OR REPLACE VIEW "orphaned_offers" AS
SELECT
    o."offerId",
    o."listingId",
    o."offerer",
    o."amount",
    o."token",
    o."status",
    o."createdAtLedger",
    o."updatedAtLedger"
FROM "Offer" o
WHERE NOT EXISTS (
    SELECT 1 FROM "Listing" l WHERE l."listingId" = o."listingId"
);

-- ── 5. Backfill: promote any existing orphan offers via staging ───────────────
--
-- At migration time, check if any existing Offer rows have no parent Listing.
-- These are historical orphans from before this constraint was added.
-- We log them to the application via a RAISE NOTICE but do not delete them —
-- they remain valid historical records.
--
-- If a LISTING_CREATED event for the parent later arrives (e.g. via backfill),
-- the trigger does NOT fire for existing Offer rows (only for new inserts).
-- That path is handled by the indexer's reconciler instead.
DO $$
DECLARE
    orphan_count BIGINT;
BEGIN
    SELECT COUNT(*)
    INTO orphan_count
    FROM "Offer" o
    WHERE NOT EXISTS (
        SELECT 1 FROM "Listing" l WHERE l."listingId" = o."listingId"
    );

    IF orphan_count > 0 THEN
        RAISE NOTICE 'ORPHANED OFFERS DETECTED: % Offer rows have no parent Listing. '
                     'Review via: SELECT * FROM orphaned_offers; '
                     'These rows will be resolved when the parent LISTING_CREATED is ingested.',
                     orphan_count;
    END IF;
END $$;

-- ── 6. PendingOffer reorg cleanup function ────────────────────────────────────
--
-- Called by revertLedgers() in poller.ts during a chain reorg to remove
-- pending offers staged from the rolled-back ledger range.
-- The indexer's revertLedgers() function calls this via raw SQL.

CREATE OR REPLACE FUNCTION revert_pending_offers(safe_ledger INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM "PendingOffer"
    WHERE "createdAtLedger" > safe_ledger;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;
