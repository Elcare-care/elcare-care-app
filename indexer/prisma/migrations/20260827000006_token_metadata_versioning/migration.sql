-- Migration: 20260827000006_token_metadata_versioning
--
-- PURPOSE: Version token metadata by source ledger so that when token decimals
-- or asset definitions change (registry event or config correction), the indexer
-- can detect and invalidate dependent cache entries rather than silently serving
-- stale decimal values.
--
-- Background:
--   token-metadata.ts provides human-readable decimal conversions for every
--   money field returned by the API. The decimal precision is looked up by token
--   address from a static registry + TOKEN_DECIMALS_JSON env override.
--   If a token's decimals change (e.g. a whitelisted SAC is re-defined with
--   different precision), cached API responses would disagree with the on-chain
--   asset definition until the cache TTL expired.
--
-- Changes in this migration:
--   1. Add "metadataVersion" and "sourceLedger" columns to WhitelistedToken so
--      each change to a token's metadata is stamped with the ledger that caused it.
--   2. Add a new TokenMetadataHistory table recording each version transition.
--   3. Add "tokenMetadataVersion" to Listing, Auction, Offer — a snapshot of the
--      metadata version at the time the row was last written.  When the token's
--      metadata version advances, affected rows with an older snapshot can be
--      targeted for cache invalidation.
--   4. A TokenMetadataChange event view surfaces transitions so the indexer's
--      cache-invalidation layer can key off a specific version change.
--
-- rollback:
--   DROP VIEW  IF EXISTS "token_metadata_changes";
--   DROP TABLE IF EXISTS "TokenMetadataHistory";
--   ALTER TABLE "WhitelistedToken" DROP COLUMN IF EXISTS "metadataVersion";
--   ALTER TABLE "WhitelistedToken" DROP COLUMN IF EXISTS "decimals";
--   ALTER TABLE "WhitelistedToken" DROP COLUMN IF EXISTS "symbol";
--   ALTER TABLE "WhitelistedToken" DROP COLUMN IF EXISTS "name";
--   ALTER TABLE "Listing"  DROP COLUMN IF EXISTS "tokenMetadataVersion";
--   ALTER TABLE "Auction"  DROP COLUMN IF EXISTS "tokenMetadataVersion";
--   ALTER TABLE "Offer"    DROP COLUMN IF EXISTS "tokenMetadataVersion";

-- ── 1. Extend WhitelistedToken with metadata version fields ──────────────────

-- metadataVersion: monotonically increasing per-token counter; starts at 1.
-- Incremented every time token configuration changes (decimal count or name).
ALTER TABLE "WhitelistedToken"
  ADD COLUMN IF NOT EXISTS "metadataVersion" INTEGER NOT NULL DEFAULT 1;

-- decimals: the number of decimal places for this token (7 for XLM / classic SAC).
-- NULL until explicitly set by a registry event; callers fall back to DEFAULT_TOKEN_DECIMALS.
ALTER TABLE "WhitelistedToken"
  ADD COLUMN IF NOT EXISTS "decimals" INTEGER;

-- Human-readable metadata carried by the whitelist registry event
ALTER TABLE "WhitelistedToken"
  ADD COLUMN IF NOT EXISTS "symbol" TEXT;

ALTER TABLE "WhitelistedToken"
  ADD COLUMN IF NOT EXISTS "name" TEXT;

-- sourceLedger: the ledger that triggered the most recent metadata update.
-- Matches addedAtLedger on first write; updated on each subsequent change.
ALTER TABLE "WhitelistedToken"
  ADD COLUMN IF NOT EXISTS "sourceLedger" INTEGER;

-- Constraint: decimals must be in [0, 18] when set
ALTER TABLE "WhitelistedToken"
  ADD CONSTRAINT "whitelisted_token_decimals_range"
  CHECK ("decimals" IS NULL OR ("decimals" >= 0 AND "decimals" <= 18));

ALTER TABLE "WhitelistedToken"
  ADD CONSTRAINT "whitelisted_token_metadata_version_positive"
  CHECK ("metadataVersion" >= 1);

CREATE INDEX IF NOT EXISTS "WhitelistedToken_metadataVersion_idx"
  ON "WhitelistedToken" ("metadataVersion");

-- ── 2. TokenMetadataHistory — audit trail of every metadata version change ───

CREATE TABLE IF NOT EXISTS "TokenMetadataHistory" (
    "id"              SERIAL PRIMARY KEY,
    "address"         TEXT    NOT NULL,
    "version"         INTEGER NOT NULL,
    "decimals"        INTEGER,
    "symbol"          TEXT,
    "name"            TEXT,
    "sourceLedger"    INTEGER NOT NULL,
    "active"          BOOLEAN NOT NULL DEFAULT TRUE,
    "changedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tmh_decimals_range"
        CHECK ("decimals" IS NULL OR ("decimals" >= 0 AND "decimals" <= 18)),
    CONSTRAINT "tmh_version_positive"
        CHECK ("version" >= 1),
    CONSTRAINT "tmh_source_ledger_positive"
        CHECK ("sourceLedger" > 0)
);

CREATE INDEX IF NOT EXISTS "TokenMetadataHistory_address_idx"
  ON "TokenMetadataHistory" ("address");

CREATE INDEX IF NOT EXISTS "TokenMetadataHistory_sourceLedger_idx"
  ON "TokenMetadataHistory" ("sourceLedger");

CREATE UNIQUE INDEX IF NOT EXISTS "TokenMetadataHistory_address_version_unique"
  ON "TokenMetadataHistory" ("address", "version");

-- ── 3. Snapshot column on Listing, Auction, Offer ────────────────────────────
--
-- Stores the token's metadataVersion at the time the row was last written.
-- Null for rows ingested before this migration; treated as "unknown" by the
-- cache-invalidation layer (always safe to re-validate those rows).

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "tokenMetadataVersion" INTEGER;

ALTER TABLE "Auction"
  ADD COLUMN IF NOT EXISTS "tokenMetadataVersion" INTEGER;

ALTER TABLE "Offer"
  ADD COLUMN IF NOT EXISTS "tokenMetadataVersion" INTEGER;

-- Partial indexes to efficiently find rows that need cache invalidation
-- when a specific token's metadata version advances.
CREATE INDEX IF NOT EXISTS "Listing_token_metadata_version_idx"
  ON "Listing" ("token", "tokenMetadataVersion")
  WHERE "tokenMetadataVersion" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Auction_token_metadata_version_idx"
  ON "Auction" ("token", "tokenMetadataVersion")
  WHERE "tokenMetadataVersion" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Offer_token_metadata_version_idx"
  ON "Offer" ("token", "tokenMetadataVersion")
  WHERE "tokenMetadataVersion" IS NOT NULL;

-- ── 4. Token metadata change diagnostic view ─────────────────────────────────
--
-- Joins TokenMetadataHistory with the current WhitelistedToken state to show
-- every version transition per token.  Used by:
--   a. The /admin/diagnostics endpoint.
--   b. The Grafana alert rule: SELECT COUNT(*) FROM token_metadata_changes
--      WHERE changedAt > NOW() - INTERVAL '1 hour' to detect recent changes.
--   c. The indexer's token-metadata.ts cache-invalidation hook.

CREATE OR REPLACE VIEW "token_metadata_changes" AS
SELECT
    h."id"           AS "historyId",
    h."address"      AS "tokenAddress",
    wt."active"      AS "currentlyActive",
    h."version",
    h."decimals",
    h."symbol",
    h."name",
    h."sourceLedger",
    h."changedAt",
    -- Is this version the current (latest) version for this token?
    (h."version" = wt."metadataVersion") AS "isCurrent"
FROM "TokenMetadataHistory" h
JOIN "WhitelistedToken" wt ON wt."address" = h."address"
ORDER BY h."address", h."version";

-- ── 5. Seed initial history rows for existing whitelisted tokens ──────────────
--
-- For each currently-whitelisted token, create a version-1 history row using
-- addedAtLedger as the sourceLedger.  This establishes a baseline so the
-- cache-invalidation logic has a reference point for all existing tokens.

INSERT INTO "TokenMetadataHistory" ("address", "version", "decimals", "symbol", "name", "sourceLedger")
SELECT
    wt."address",
    1                 AS "version",
    NULL              AS "decimals",   -- unknown until a registry event provides it
    NULL              AS "symbol",
    NULL              AS "name",
    wt."addedAtLedger" AS "sourceLedger"
FROM "WhitelistedToken" wt
ON CONFLICT ("address", "version") DO NOTHING;

-- ── 6. "Unknown" metadata explicit flag on API responses ─────────────────────
--
-- When the indexer returns a listing/auction/offer whose token has no entry
-- in TokenMetadataHistory (e.g. a legacy token from before this migration),
-- token-metadata.ts should return { decimals: null, isUnknown: true } instead
-- of silently defaulting to 7.  This is implemented in TypeScript (see the
-- token-metadata.ts update in this PR) — this comment documents the intent.
--
-- The DEFAULT_TOKEN_DECIMALS = 7 fallback in token-metadata.ts is retained
-- ONLY for tokens that are confirmed-unknown (no history row AND the
-- address matches the Stellar classic-SAC pattern).  All other missing entries
-- must surface as "unknown" to avoid the silent precision bug.
