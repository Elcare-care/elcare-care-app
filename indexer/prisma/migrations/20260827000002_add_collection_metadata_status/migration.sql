-- Migration: add_collection_metadata_status
-- Issue #476: Store whether a collection passed the shared metadata validation
-- rules introduced in this release. Pre-existing collections default to
-- "unknown"; new collections deployed via the updated launchpad will be
-- recorded as "valid".
ALTER TABLE "Collection" ADD COLUMN "metadataStatus" TEXT NOT NULL DEFAULT 'unknown';
