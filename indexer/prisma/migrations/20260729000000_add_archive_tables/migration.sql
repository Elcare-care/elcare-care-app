-- Create archive tables for retention policy (Issue #295)
-- These tables receive rows moved from hot/warm tables once they exceed
-- the retention window. Rows are append-only and never updated.

CREATE TABLE IF NOT EXISTS "ArchivedMarketplaceEvent" (
  id             SERIAL PRIMARY KEY,
  listingId       BIGINT,
  eventType       TEXT NOT NULL,
  actor           TEXT NOT NULL,
  data            JSONB NOT NULL,
  ledgerSequence  INTEGER NOT NULL,
  ledgerTimestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  eventHash       TEXT,
  contractId      TEXT NOT NULL DEFAULT '',
  confirmed       BOOLEAN NOT NULL DEFAULT false,
  archivedAt      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedPriceHistory" (
  id              SERIAL PRIMARY KEY,
  listingId        BIGINT NOT NULL,
  oldPrice         DECIMAL(32,7) NOT NULL,
  newPrice         DECIMAL(32,7) NOT NULL,
  changedBy        TEXT NOT NULL DEFAULT '',
  changedAtLedger  INTEGER NOT NULL,
  changedAt        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivedAt       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedLedgerCheckpoint" (
  id              SERIAL PRIMARY KEY,
  contractId      TEXT NOT NULL,
  windowStart     INTEGER NOT NULL,
  windowEnd       INTEGER NOT NULL,
  ledgerHash      TEXT,
  eventCount      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'fetched',
  error           TEXT,
  createdAt       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivedAt      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedBackfillJob" (
  id               SERIAL PRIMARY KEY,
  startLedger      INTEGER NOT NULL,
  endLedger        INTEGER NOT NULL,
  checkpointLedger INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'Pending',
  rpcUrl           TEXT NOT NULL,
  error            TEXT,
  totalInserted    INTEGER NOT NULL DEFAULT 0,
  createdAt        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt        TIMESTAMPTZ NOT NULL DEFAULT now(),
  gapId            INTEGER,
  archivedAt       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedLedgerGap" (
  id             SERIAL PRIMARY KEY,
  fromLedger     INTEGER NOT NULL,
  toLedger       INTEGER NOT NULL,
  source         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Open',
  error          TEXT,
  createdAt      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivedAt     TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedDeadLetterEvent" (
  id             SERIAL PRIMARY KEY,
  network        TEXT NOT NULL DEFAULT '',
  contractId     TEXT NOT NULL,
  ledgerSequence INTEGER NOT NULL,
  txHash         TEXT NOT NULL,
  eventIndex     INTEGER NOT NULL,
  rawTopics      JSONB NOT NULL,
  rawValue       TEXT NOT NULL DEFAULT '',
  errorCode      TEXT NOT NULL,
  errorMessage   TEXT NOT NULL,
  parserVersion  TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  createdAt      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivedAt     TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedReconciliationRepair" (
  id           SERIAL PRIMARY KEY,
  modelType    TEXT NOT NULL,
  recordId     TEXT NOT NULL,
  field        TEXT NOT NULL,
  oldValue     TEXT NOT NULL,
  newValue     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  sourceLedger INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'Applied',
  createdAt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivedAt   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedReconciliationRun" (
  id                  SERIAL PRIMARY KEY,
  startedAt           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completedAt         TIMESTAMPTZ,
  sampledListings     INTEGER NOT NULL DEFAULT 0,
  sampledAuctions     INTEGER NOT NULL DEFAULT 0,
  discrepanciesFound  INTEGER NOT NULL DEFAULT 0,
  repairsApplied      INTEGER NOT NULL DEFAULT 0,
  skippedRecords      INTEGER NOT NULL DEFAULT 0,
  dryRun              BOOLEAN NOT NULL DEFAULT false,
  errorMessage        TEXT,
  archivedAt          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedDiscrepancy" (
  id           SERIAL PRIMARY KEY,
  runId        INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  entityId     TEXT NOT NULL,
  field        TEXT NOT NULL,
  dbValue      TEXT NOT NULL,
  chainValue   TEXT NOT NULL,
  resolved     BOOLEAN NOT NULL DEFAULT false,
  detectedAt   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvedAt   TIMESTAMPTZ,
  archivedAt   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ArchivedKeeperAction" (
  id          SERIAL PRIMARY KEY,
  targetType  TEXT NOT NULL,
  targetId    BIGINT NOT NULL,
  txHash      TEXT,
  status      TEXT NOT NULL DEFAULT 'Pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  lastError   TEXT,
  feePaid     BIGINT,
  createdAt   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivedAt  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archiveChecksum TEXT NOT NULL
);

-- Indexes for archive tables
CREATE INDEX IF NOT EXISTS "ArchivedMarketplaceEvent_ledgerSequence_idx" ON "ArchivedMarketplaceEvent" ("ledgerSequence");
CREATE INDEX IF NOT EXISTS "ArchivedMarketplaceEvent_contractId_ledgerSequence_idx" ON "ArchivedMarketplaceEvent" ("contractId", "ledgerSequence");
CREATE INDEX IF NOT EXISTS "ArchivedMarketplaceEvent_archivedAt_idx" ON "ArchivedMarketplaceEvent" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedPriceHistory_listingId_idx" ON "ArchivedPriceHistory" ("listingId");
CREATE INDEX IF NOT EXISTS "ArchivedPriceHistory_archivedAt_idx" ON "ArchivedPriceHistory" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedLedgerCheckpoint_contractId_windowEnd_idx" ON "ArchivedLedgerCheckpoint" ("contractId", "windowEnd");
CREATE INDEX IF NOT EXISTS "ArchivedLedgerCheckpoint_archivedAt_idx" ON "ArchivedLedgerCheckpoint" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedBackfillJob_status_idx" ON "ArchivedBackfillJob" ("status");
CREATE INDEX IF NOT EXISTS "ArchivedBackfillJob_archivedAt_idx" ON "ArchivedBackfillJob" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedLedgerGap_status_idx" ON "ArchivedLedgerGap" ("status");
CREATE INDEX IF NOT EXISTS "ArchivedLedgerGap_archivedAt_idx" ON "ArchivedLedgerGap" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedDeadLetterEvent_status_idx" ON "ArchivedDeadLetterEvent" ("status");
CREATE INDEX IF NOT EXISTS "ArchivedDeadLetterEvent_contractId_ledgerSequence_idx" ON "ArchivedDeadLetterEvent" ("contractId", "ledgerSequence");
CREATE INDEX IF NOT EXISTS "ArchivedDeadLetterEvent_archivedAt_idx" ON "ArchivedDeadLetterEvent" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedReconciliationRepair_modelType_recordId_idx" ON "ArchivedReconciliationRepair" ("modelType", "recordId");
CREATE INDEX IF NOT EXISTS "ArchivedReconciliationRepair_archivedAt_idx" ON "ArchivedReconciliationRepair" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedReconciliationRun_startedAt_idx" ON "ArchivedReconciliationRun" ("startedAt");
CREATE INDEX IF NOT EXISTS "ArchivedReconciliationRun_archivedAt_idx" ON "ArchivedReconciliationRun" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedDiscrepancy_runId_idx" ON "ArchivedDiscrepancy" ("runId");
CREATE INDEX IF NOT EXISTS "ArchivedDiscrepancy_kind_entityId_idx" ON "ArchivedDiscrepancy" ("kind", "entityId");
CREATE INDEX IF NOT EXISTS "ArchivedDiscrepancy_archivedAt_idx" ON "ArchivedDiscrepancy" ("archivedAt");

CREATE INDEX IF NOT EXISTS "ArchivedKeeperAction_targetType_status_idx" ON "ArchivedKeeperAction" ("targetType", "status");
CREATE INDEX IF NOT EXISTS "ArchivedKeeperAction_archivedAt_idx" ON "ArchivedKeeperAction" ("archivedAt");
