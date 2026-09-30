-- Migration: add_full_text_search
--
-- 1. Adds optional text metadata columns to "Listing":
--      title       – artwork title from IPFS metadata (weight A)
--      description – artwork description from IPFS metadata (weight C)
--      artistName  – human-readable artist name from IPFS metadata (weight B)
-- 2. Adds a generated tsvector column "searchVector" updated by a trigger.
-- 3. Creates a GIN index on "searchVector" for fast full-text queries.
-- 4. Adds a Collection full-text search vector + GIN index.
-- 5. Adds missing IpfsMetadata and IpfsQueue tables (idempotent: CREATE TABLE IF NOT EXISTS).
--
-- Weights:
--   A (1.0) – title           (most relevant)
--   B (0.4) – artistName      (secondary)
--   C (0.2) – description     (tertiary)
--   D (0.1) – collection addr (lowest — still searchable by contract address)

-- ── Step 1: New text columns on Listing ──────────────────────────────────────

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "title"       TEXT,
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "artistName"  TEXT;

-- ── Step 2: tsvector column ───────────────────────────────────────────────────

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

-- ── Step 3: Populate searchVector for all existing rows ───────────────────────

UPDATE "Listing"
SET "searchVector" =
  setweight(to_tsvector('english', coalesce("title", '')),       'A') ||
  setweight(to_tsvector('english', coalesce("artistName", '')),  'B') ||
  setweight(to_tsvector('english', coalesce("description", '')), 'C') ||
  setweight(to_tsvector('simple',  coalesce("collection", '')),  'D');

-- ── Step 4: Trigger function to keep searchVector current ─────────────────────

CREATE OR REPLACE FUNCTION listing_search_vector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."title", '')),       'A') ||
    setweight(to_tsvector('english', coalesce(NEW."artistName", '')),  'B') ||
    setweight(to_tsvector('english', coalesce(NEW."description", '')), 'C') ||
    setweight(to_tsvector('simple',  coalesce(NEW."collection", '')),  'D');
  RETURN NEW;
END;
$$;

-- Drop if it already exists (idempotent re-run support)
DROP TRIGGER IF EXISTS listing_search_vector_trigger ON "Listing";

CREATE TRIGGER listing_search_vector_trigger
BEFORE INSERT OR UPDATE OF "title", "artistName", "description", "collection"
ON "Listing"
FOR EACH ROW EXECUTE FUNCTION listing_search_vector_update();

-- ── Step 5: GIN index on searchVector ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "Listing_searchVector_idx"
  ON "Listing" USING gin("searchVector");

-- ── Step 6: Collection name/symbol search vector ─────────────────────────────
-- Allows /search to find collections by name or symbol.

ALTER TABLE "Collection"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

UPDATE "Collection"
SET "searchVector" =
  setweight(to_tsvector('english', coalesce("name", '')),   'A') ||
  setweight(to_tsvector('simple',  coalesce("symbol", '')), 'B') ||
  setweight(to_tsvector('simple',  coalesce("contractAddress", '')), 'D');

CREATE OR REPLACE FUNCTION collection_search_vector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."name", '')),   'A') ||
    setweight(to_tsvector('simple',  coalesce(NEW."symbol", '')), 'B') ||
    setweight(to_tsvector('simple',  coalesce(NEW."contractAddress", '')), 'D');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_search_vector_trigger ON "Collection";

CREATE TRIGGER collection_search_vector_trigger
BEFORE INSERT OR UPDATE OF "name", "symbol", "contractAddress"
ON "Collection"
FOR EACH ROW EXECUTE FUNCTION collection_search_vector_update();

CREATE INDEX IF NOT EXISTS "Collection_searchVector_idx"
  ON "Collection" USING gin("searchVector");

-- ── Step 7: IpfsMetadata and IpfsQueue (idempotent) ──────────────────────────
-- These were created in an earlier migration (add_ipfs_metadata_cache) on some
-- deployments.  Using IF NOT EXISTS keeps this migration safe on all paths.

CREATE TABLE IF NOT EXISTS "IpfsMetadata" (
    "cid"         TEXT         NOT NULL,
    "title"       TEXT,
    "description" TEXT,
    "imageUrl"    TEXT,
    "attributes"  JSONB,
    "fetchedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw"         JSONB        NOT NULL,
    CONSTRAINT "IpfsMetadata_pkey" PRIMARY KEY ("cid")
);

CREATE TABLE IF NOT EXISTS "IpfsQueue" (
    "id"          SERIAL       NOT NULL,
    "cid"         TEXT         NOT NULL,
    "attempts"    INTEGER      NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "status"      TEXT         NOT NULL DEFAULT 'pending',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IpfsQueue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IpfsQueue_status_nextRetryAt_idx"
  ON "IpfsQueue"("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "IpfsQueue_cid_idx"
  ON "IpfsQueue"("cid");
