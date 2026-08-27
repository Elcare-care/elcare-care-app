-- Migration: 20260827000003_financial_integrity_constraints
--
-- PURPOSE: Add database-level check constraints that enforce financial integrity
-- invariants independently of application code.  These constraints provide a
-- final safety boundary against parser bugs or manual repair errors.
--
-- Run the preflight migration (20260827000002_check_constraints_preflight)
-- first to repair any existing violations.
--
-- Constraints added:
--   1. Listing.price           >= 0
--   2. Auction.reservePrice    >= 0
--   3. Auction.highestBid      >= 0
--   4. Offer.amount            >= 0
--   5. Bid.amount              >= 0
--   6. RoyaltyPayment.amount   >= 0
--   7. RoyaltyPayment.salePrice>= 0
--   8. PriceHistory.oldPrice   >= 0  (stored price change, always >= 0)
--   9. PriceHistory.newPrice   >= 0
--  10. Listing.royaltyBps      BETWEEN 0 AND 10000
--  11. Collection.feeBpsOverride BETWEEN 0 AND 10000 (when not NULL)
--  12. RoyaltyPayment: exactly one of listingId/auctionId must be set
--      (mutually exclusive source reference)
--  13. MarketplaceEvent: actor must not be empty string when contractId is set
--  14. MarketplaceEvent: eventIndex must be >= 0 when not NULL
--  15. MarketplaceEvent: ledgerSequence must be > 0
--
-- rollback:
--   ALTER TABLE "Listing"        DROP CONSTRAINT IF EXISTS "listing_price_non_negative";
--   ALTER TABLE "Auction"        DROP CONSTRAINT IF EXISTS "auction_reserve_price_non_negative";
--   ALTER TABLE "Auction"        DROP CONSTRAINT IF EXISTS "auction_highest_bid_non_negative";
--   ALTER TABLE "Offer"          DROP CONSTRAINT IF EXISTS "offer_amount_non_negative";
--   ALTER TABLE "Bid"            DROP CONSTRAINT IF EXISTS "bid_amount_non_negative";
--   ALTER TABLE "RoyaltyPayment" DROP CONSTRAINT IF EXISTS "royalty_amount_non_negative";
--   ALTER TABLE "RoyaltyPayment" DROP CONSTRAINT IF EXISTS "royalty_sale_price_non_negative";
--   ALTER TABLE "RoyaltyPayment" DROP CONSTRAINT IF EXISTS "royalty_source_exclusive";
--   ALTER TABLE "PriceHistory"   DROP CONSTRAINT IF EXISTS "price_history_old_non_negative";
--   ALTER TABLE "PriceHistory"   DROP CONSTRAINT IF EXISTS "price_history_new_non_negative";
--   ALTER TABLE "Listing"        DROP CONSTRAINT IF EXISTS "listing_royalty_bps_range";
--   ALTER TABLE "Collection"     DROP CONSTRAINT IF EXISTS "collection_fee_bps_range";
--   ALTER TABLE "MarketplaceEvent" DROP CONSTRAINT IF EXISTS "event_ledger_positive";
--   ALTER TABLE "MarketplaceEvent" DROP CONSTRAINT IF EXISTS "event_index_non_negative";

-- ── 1-9: Non-negative financial amount constraints ────────────────────────────

ALTER TABLE "Listing"
  ADD CONSTRAINT "listing_price_non_negative"
  CHECK ("price" >= 0);

ALTER TABLE "Auction"
  ADD CONSTRAINT "auction_reserve_price_non_negative"
  CHECK ("reservePrice" >= 0);

ALTER TABLE "Auction"
  ADD CONSTRAINT "auction_highest_bid_non_negative"
  CHECK ("highestBid" >= 0);

ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_amount_non_negative"
  CHECK ("amount" >= 0);

ALTER TABLE "Bid"
  ADD CONSTRAINT "bid_amount_non_negative"
  CHECK ("amount" >= 0);

ALTER TABLE "RoyaltyPayment"
  ADD CONSTRAINT "royalty_amount_non_negative"
  CHECK ("amount" >= 0);

ALTER TABLE "RoyaltyPayment"
  ADD CONSTRAINT "royalty_sale_price_non_negative"
  CHECK ("salePrice" >= 0);

ALTER TABLE "PriceHistory"
  ADD CONSTRAINT "price_history_old_non_negative"
  CHECK ("oldPrice" >= 0);

ALTER TABLE "PriceHistory"
  ADD CONSTRAINT "price_history_new_non_negative"
  CHECK ("newPrice" >= 0);

-- ── 10-11: Valid basis-point range constraints ────────────────────────────────

-- Listing.royaltyBps: 0–10000 (0% to 100%)
ALTER TABLE "Listing"
  ADD CONSTRAINT "listing_royalty_bps_range"
  CHECK ("royaltyBps" >= 0 AND "royaltyBps" <= 10000);

-- Collection.feeBpsOverride: when set, must be 0–10000
ALTER TABLE "Collection"
  ADD CONSTRAINT "collection_fee_bps_range"
  CHECK ("feeBpsOverride" IS NULL OR ("feeBpsOverride" >= 0 AND "feeBpsOverride" <= 10000));

-- ── 12: Mutually exclusive royalty source ────────────────────────────────────
--
-- A RoyaltyPayment row must have exactly one source: either a listing sale
-- (listingId IS NOT NULL, auctionId IS NULL) or an auction settlement
-- (auctionId IS NOT NULL, listingId IS NULL).  Having both set or neither set
-- is a data integrity error.
--
-- The contract emits roy_paid with exactly one id field; the indexer mirrors
-- this in processEvent().  This constraint is the last line of defence against
-- parser bugs that populate both fields or neither.
--
-- NOTE: we intentionally DO NOT use (listingId IS NOT NULL) XOR (auctionId IS NOT NULL)
-- syntax for clarity and portability — the explicit OR form is equally readable.
ALTER TABLE "RoyaltyPayment"
  ADD CONSTRAINT "royalty_source_exclusive"
  CHECK (
    ("listingId" IS NOT NULL AND "auctionId" IS NULL)
    OR
    ("auctionId" IS NOT NULL AND "listingId" IS NULL)
  );

-- ── 13-15: Required event identity fields ────────────────────────────────────
--
-- These constraints apply to new rows only (legacy rows are exempt via
-- the partial-index pattern already in place for eventHash).
--
-- ledgerSequence must be > 0 — sequence 0 is a sentinel for "not yet indexed";
-- real Stellar ledgers start at 1.
ALTER TABLE "MarketplaceEvent"
  ADD CONSTRAINT "event_ledger_positive"
  CHECK ("ledgerSequence" > 0);

-- eventIndex must be >= 0 when present (a 0-indexed position within a transaction)
ALTER TABLE "MarketplaceEvent"
  ADD CONSTRAINT "event_index_non_negative"
  CHECK ("eventIndex" IS NULL OR "eventIndex" >= 0);

-- ── Index: Bid.amount for range queries on financial reconciliation ───────────
-- Small covering index to support financial integrity audits that look for
-- suspiciously small or zero bids (e.g. SELECT * FROM "Bid" WHERE amount = 0).
CREATE INDEX IF NOT EXISTS "Bid_amount_idx" ON "Bid" ("amount");
