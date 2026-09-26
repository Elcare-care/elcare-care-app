-- Migration: add_worker_lease_fencing_ipfs_status
-- Adds:
--   1. WorkerLease table with monotonic fencing token (fenced-lease.ts)
--   2. ipfsStatus column on Listing (IPFS backpressure queue status)
--   3. ipfsStatus column on Collection (IPFS backpressure queue status)
--   4. contentHash column on IpfsMetadata (content-integrity verification)

-- ── 1. WorkerLease ────────────────────────────────────────────────────────────

CREATE TABLE "WorkerLease" (
  "id"        SERIAL       PRIMARY KEY,
  "role"      TEXT         NOT NULL,
  "ownerId"   TEXT         NOT NULL,
  "token"     BIGINT       NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMPTZ  NOT NULL,
  "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One active lease per role (prevents two workers from holding the same role)
CREATE UNIQUE INDEX "WorkerLease_role_key" ON "WorkerLease"("role");

-- One row per (role, ownerId) — prevents a single worker acquiring twice
CREATE UNIQUE INDEX "WorkerLease_role_ownerId_key" ON "WorkerLease"("role", "ownerId");

-- Index for expiry-based cleanup queries
CREATE INDEX "WorkerLease_role_expiresAt_idx" ON "WorkerLease"("role", "expiresAt");

-- ── 2. ipfsStatus on Listing ─────────────────────────────────────────────────

ALTER TABLE "Listing"
  ADD COLUMN IF NOT EXISTS "ipfsStatus" TEXT;

COMMENT ON COLUMN "Listing"."ipfsStatus" IS
  'IPFS enrichment status: pending | fetching | done | failed | oversized | unavailable | deferred. NULL for rows before backpressure was introduced.';

-- ── 3. ipfsStatus on Collection ──────────────────────────────────────────────

ALTER TABLE "Collection"
  ADD COLUMN IF NOT EXISTS "ipfsStatus" TEXT;

COMMENT ON COLUMN "Collection"."ipfsStatus" IS
  'IPFS enrichment status: pending | fetching | done | failed | oversized | unavailable | deferred. NULL for rows before backpressure was introduced.';

-- ── 4. contentHash on IpfsMetadata ───────────────────────────────────────────

ALTER TABLE "IpfsMetadata"
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT;

COMMENT ON COLUMN "IpfsMetadata"."contentHash" IS
  'SHA-256 hex digest of the raw JSON body for content-integrity verification. NULL for rows fetched before this column was added.';
