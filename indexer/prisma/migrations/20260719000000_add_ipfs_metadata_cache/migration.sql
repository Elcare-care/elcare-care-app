-- Migration: add_ipfs_metadata_cache
-- Adds IpfsMetadata (content-addressed IPFS cache) and IpfsQueue
-- (durable background-fetch job queue) tables.

-- ── IpfsMetadata ──────────────────────────────────────────────────────────────
CREATE TABLE "IpfsMetadata" (
    "cid"         TEXT         NOT NULL,
    "title"       TEXT,
    "description" TEXT,
    "imageUrl"    TEXT,
    "attributes"  JSONB,
    "fetchedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw"         JSONB        NOT NULL,
    CONSTRAINT "IpfsMetadata_pkey" PRIMARY KEY ("cid")
);

-- ── IpfsQueue ─────────────────────────────────────────────────────────────────
CREATE TABLE "IpfsQueue" (
    "id"          SERIAL       NOT NULL,
    "cid"         TEXT         NOT NULL,
    "attempts"    INTEGER      NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "status"      TEXT         NOT NULL DEFAULT 'pending',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IpfsQueue_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX "IpfsQueue_status_nextRetryAt_idx" ON "IpfsQueue"("status", "nextRetryAt");
CREATE INDEX "IpfsQueue_cid_idx"                ON "IpfsQueue"("cid");
