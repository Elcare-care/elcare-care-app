-- Migration: add_voucher_and_listing_royalty_fields
--
-- 1. Adds originalCreator and royaltyBps columns to "Listing"
--    (needed for secondary-royalty attribution in /wallets/:address/royalty-stats).
-- 2. Creates the "Voucher" table for lazy-mint nonce tracking.

-- ── Step 1: Listing royalty / attribution fields ──────────────────────────────

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "originalCreator" TEXT,
  ADD COLUMN IF NOT EXISTS "royaltyBps"      INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "Listing_originalCreator_idx"
  ON "Listing"("originalCreator");

-- ── Step 2: Voucher table ─────────────────────────────────────────────────────
-- Tracks lazy-mint voucher lifecycle: Issued → Redeemed / Revoked / Expired.

CREATE TABLE IF NOT EXISTS "Voucher" (
  "id"              SERIAL       NOT NULL,
  "collection"      TEXT         NOT NULL,
  "nonce"           BIGINT       NOT NULL,
  "tokenId"         BIGINT,
  "status"          TEXT         NOT NULL DEFAULT 'Issued',
  "redeemer"        TEXT,
  "createdAtLedger" INTEGER      NOT NULL,
  "updatedAtLedger" INTEGER      NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Voucher_collection_nonce_key"
  ON "Voucher"("collection", "nonce");

CREATE INDEX IF NOT EXISTS "Voucher_collection_idx"
  ON "Voucher"("collection");

CREATE INDEX IF NOT EXISTS "Voucher_collection_status_idx"
  ON "Voucher"("collection", "status");

CREATE INDEX IF NOT EXISTS "Voucher_createdAtLedger_idx"
  ON "Voucher"("createdAtLedger");
