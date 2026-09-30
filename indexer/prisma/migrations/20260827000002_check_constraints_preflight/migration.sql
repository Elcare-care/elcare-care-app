-- Migration: 20260827000002_check_constraints_preflight
--
-- PURPOSE: Remediation preflight — identify and repair existing rows that would
-- violate the check constraints added in the next migration.  Run this
-- migration first; review the UPDATE counts in the DB log, then run the
-- constraint migration.
--
-- Scope of repairs:
--   1. Listing.price           < 0  → set to 0   (parser bug could store negative)
--   2. Auction.reservePrice    < 0  → set to 0
--   3. Auction.highestBid      < 0  → set to 0
--   4. Offer.amount            < 0  → set to 0
--   5. Bid.amount              < 0  → set to 0
--   6. RoyaltyPayment.amount   < 0  → set to 0
--   7. RoyaltyPayment.salePrice< 0  → set to 0
--   8. PriceHistory.oldPrice   < 0  → set to 0
--   9. PriceHistory.newPrice   < 0  → set to 0
--  10. Listing.royaltyBps   > 10000 → set to 10000
--  11. Collection.feeBpsOverride > 10000 → set to 10000
--  12. RoyaltyPayment with BOTH listingId and auctionId set — clear auctionId
--      (listing source wins; only one source is valid)
--  13. RoyaltyPayment with NEITHER listingId nor auctionId — log count only
--      (cannot auto-repair without a source; operator must review)
--  14. MarketplaceEvent rows with empty eventHash → fill with synthetic hash
--      based on contractId:ledgerSequence:eventType:id to unblock constraint
--
-- PREFLIGHT REPORT: the SELECT statements below surface violation counts;
-- run them before applying this migration in a staging environment.
--
-- rollback: not needed — this migration only writes data, not DDL.

-- ── Preflight counts (operators should inspect these before UPDATE) ──────────

-- DO $$
-- DECLARE
--   neg_listing      BIGINT;
--   neg_reserve      BIGINT;
--   neg_highest_bid  BIGINT;
--   neg_offer        BIGINT;
--   neg_bid          BIGINT;
--   neg_royalty_amt  BIGINT;
--   neg_royalty_sale BIGINT;
--   neg_price_old    BIGINT;
--   neg_price_new    BIGINT;
--   bad_listing_bps  BIGINT;
--   bad_coll_bps     BIGINT;
--   dual_source      BIGINT;
--   no_source        BIGINT;
--   missing_hash     BIGINT;
-- BEGIN
--   SELECT COUNT(*) INTO neg_listing      FROM "Listing"        WHERE "price"          < 0;
--   SELECT COUNT(*) INTO neg_reserve      FROM "Auction"        WHERE "reservePrice"   < 0;
--   SELECT COUNT(*) INTO neg_highest_bid  FROM "Auction"        WHERE "highestBid"     < 0;
--   SELECT COUNT(*) INTO neg_offer        FROM "Offer"          WHERE "amount"         < 0;
--   SELECT COUNT(*) INTO neg_bid          FROM "Bid"            WHERE "amount"         < 0;
--   SELECT COUNT(*) INTO neg_royalty_amt  FROM "RoyaltyPayment" WHERE "amount"         < 0;
--   SELECT COUNT(*) INTO neg_royalty_sale FROM "RoyaltyPayment" WHERE "salePrice"      < 0;
--   SELECT COUNT(*) INTO neg_price_old    FROM "PriceHistory"   WHERE "oldPrice"       < 0;
--   SELECT COUNT(*) INTO neg_price_new    FROM "PriceHistory"   WHERE "newPrice"       < 0;
--   SELECT COUNT(*) INTO bad_listing_bps  FROM "Listing"        WHERE "royaltyBps"     > 10000;
--   SELECT COUNT(*) INTO bad_coll_bps     FROM "Collection"     WHERE "feeBpsOverride" > 10000;
--   SELECT COUNT(*) INTO dual_source      FROM "RoyaltyPayment" WHERE "listingId" IS NOT NULL AND "auctionId" IS NOT NULL;
--   SELECT COUNT(*) INTO no_source        FROM "RoyaltyPayment" WHERE "listingId" IS NULL     AND "auctionId" IS NULL;
--   SELECT COUNT(*) INTO missing_hash     FROM "MarketplaceEvent" WHERE "eventHash" IS NULL OR "eventHash" = '';
--
--   RAISE NOTICE 'PREFLIGHT REPORT:';
--   RAISE NOTICE '  neg_listing_price:    %', neg_listing;
--   RAISE NOTICE '  neg_reserve_price:    %', neg_reserve;
--   RAISE NOTICE '  neg_highest_bid:      %', neg_highest_bid;
--   RAISE NOTICE '  neg_offer_amount:     %', neg_offer;
--   RAISE NOTICE '  neg_bid_amount:       %', neg_bid;
--   RAISE NOTICE '  neg_royalty_amount:   %', neg_royalty_amt;
--   RAISE NOTICE '  neg_royalty_salePrice:%', neg_royalty_sale;
--   RAISE NOTICE '  neg_oldPrice:         %', neg_price_old;
--   RAISE NOTICE '  neg_newPrice:         %', neg_price_new;
--   RAISE NOTICE '  bad_listing_bps:      %', bad_listing_bps;
--   RAISE NOTICE '  bad_collection_bps:   %', bad_coll_bps;
--   RAISE NOTICE '  dual_royalty_source:  %', dual_source;
--   RAISE NOTICE '  no_royalty_source:    %', no_source;
--   RAISE NOTICE '  missing_event_hash:   %', missing_hash;
-- END $$;

-- ── Remediation writes ────────────────────────────────────────────────────────

-- 1. Clamp negative Listing.price to 0
UPDATE "Listing"
SET "price" = 0
WHERE "price" < 0;

-- 2. Clamp negative Auction.reservePrice to 0
UPDATE "Auction"
SET "reservePrice" = 0
WHERE "reservePrice" < 0;

-- 3. Clamp negative Auction.highestBid to 0
UPDATE "Auction"
SET "highestBid" = 0
WHERE "highestBid" < 0;

-- 4. Clamp negative Offer.amount to 0
UPDATE "Offer"
SET "amount" = 0
WHERE "amount" < 0;

-- 5. Clamp negative Bid.amount to 0
UPDATE "Bid"
SET "amount" = 0
WHERE "amount" < 0;

-- 6. Clamp negative RoyaltyPayment.amount to 0
UPDATE "RoyaltyPayment"
SET "amount" = 0
WHERE "amount" < 0;

-- 7. Clamp negative RoyaltyPayment.salePrice to 0
UPDATE "RoyaltyPayment"
SET "salePrice" = 0
WHERE "salePrice" < 0;

-- 8-9. Clamp negative PriceHistory values to 0
UPDATE "PriceHistory"
SET "oldPrice" = 0
WHERE "oldPrice" < 0;

UPDATE "PriceHistory"
SET "newPrice" = 0
WHERE "newPrice" < 0;

-- 10. Clamp over-limit Listing.royaltyBps to 10000
UPDATE "Listing"
SET "royaltyBps" = 10000
WHERE "royaltyBps" > 10000;

-- 11. Clamp over-limit Collection.feeBpsOverride to 10000
UPDATE "Collection"
SET "feeBpsOverride" = 10000
WHERE "feeBpsOverride" IS NOT NULL AND "feeBpsOverride" > 10000;

-- 12. Resolve dual-source RoyaltyPayment: listing wins over auction
--     (the marketplace contract only ever sets one; this handles any manual-repair
--     rows written with both fields populated by mistake)
UPDATE "RoyaltyPayment"
SET "auctionId" = NULL
WHERE "listingId" IS NOT NULL AND "auctionId" IS NOT NULL;

-- 13. RoyaltyPayment with no source — cannot auto-repair.
--     These rows are left in place; the constraint migration leaves the CHECK
--     as a warning rather than blocking the row outright.
--     Operators can inspect them with:
--       SELECT * FROM "RoyaltyPayment" WHERE "listingId" IS NULL AND "auctionId" IS NULL;

-- 14. Synthetic event hash for legacy rows with NULL or empty eventHash.
--     Format: 'legacy:<contractId>:<ledgerSequence>:<eventType>:<id>' (hex-free sentinel)
--     This is stable across re-runs because the inputs are deterministic.
--     The uniqueness constraint on eventHash is PARTIAL (WHERE eventHash IS NOT NULL),
--     so NULL rows do not need to compete for distinctness — but the next migration
--     will also leave eventHash nullable for those rows.
UPDATE "MarketplaceEvent"
SET "eventHash" = 'legacy:' || "contractId" || ':' || "ledgerSequence" || ':' || "eventType" || ':' || "id"
WHERE ("eventHash" IS NULL OR "eventHash" = '')
  AND "contractId" IS NOT NULL;
