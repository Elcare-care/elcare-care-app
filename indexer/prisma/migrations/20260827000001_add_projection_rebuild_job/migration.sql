-- Migration: 20260827000001_add_projection_rebuild_job
--
-- Adds the ProjectionRebuildJob table used by rebuild-projections.ts to
-- track resumable, observable projection-rebuild operations.
--
-- rollback: DROP TABLE IF EXISTS "ProjectionRebuildJob";
--           DROP TYPE IF EXISTS "ProjectionRebuildStatus";

CREATE TYPE "ProjectionRebuildStatus" AS ENUM (
  'Pending',
  'Running',
  'Completed',
  'Failed',
  'Cancelled',
  'DryRunComplete'
);

CREATE TABLE "ProjectionRebuildJob" (
    "id"               SERIAL PRIMARY KEY,
    "projections"      TEXT[]                        NOT NULL DEFAULT '{}',
    "ledgerFrom"       INTEGER                       NOT NULL DEFAULT 0,
    "ledgerTo"         INTEGER                       NOT NULL DEFAULT 0,
    "entityId"         TEXT,
    "checkpointLedger" INTEGER                       NOT NULL DEFAULT 0,
    "processedEvents"  INTEGER                       NOT NULL DEFAULT 0,
    "totalEvents"      INTEGER                       NOT NULL DEFAULT 0,
    "affectedRows"     INTEGER                       NOT NULL DEFAULT 0,
    "conflictsDetected" INTEGER                      NOT NULL DEFAULT 0,
    "checksumBefore"   TEXT,
    "checksumAfter"    TEXT,
    "status"           "ProjectionRebuildStatus"     NOT NULL DEFAULT 'Pending',
    "dryRun"           BOOLEAN                       NOT NULL DEFAULT false,
    "sseSuppressed"    BOOLEAN                       NOT NULL DEFAULT true,
    "error"            TEXT,
    "startedAt"        TIMESTAMP(3),
    "completedAt"      TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)                  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ProjectionRebuildJob_status_idx"       ON "ProjectionRebuildJob"("status");
CREATE INDEX "ProjectionRebuildJob_createdAt_idx"    ON "ProjectionRebuildJob"("createdAt");
CREATE INDEX "ProjectionRebuildJob_ledgerRange_idx"  ON "ProjectionRebuildJob"("ledgerFrom", "ledgerTo");
