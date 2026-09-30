-- Migration: dead_letter_replay_audit_and_snapshots
-- Adds:
--   1. New fields on DeadLetterEvent for replay audit (remediationReason, replayedBy,
--      lockedAt, idempotencyKey)
--   2. DeadLetterReplayAttempt — append-only per-attempt audit trail
--   3. New AuditActionType enum values (DeadLetterRemediate, SnapshotWrite, SnapshotVerify,
--      ReorgRollback)
--   4. SnapshotStatus enum + IndexerSnapshot model for immutable recovery checkpoints

-- ── 1. DeadLetterEvent new columns ───────────────────────────────────────────

ALTER TABLE "DeadLetterEvent"
  ADD COLUMN IF NOT EXISTS "remediationReason" TEXT,
  ADD COLUMN IF NOT EXISTS "replayedBy"        TEXT,
  ADD COLUMN IF NOT EXISTS "lockedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "idempotencyKey"    TEXT;

-- Unique constraint on idempotencyKey (nullable — only constrains non-NULL values)
CREATE UNIQUE INDEX IF NOT EXISTS "DeadLetterEvent_idempotencyKey_key"
  ON "DeadLetterEvent" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "DeadLetterEvent_lockedAt_idx"
  ON "DeadLetterEvent" ("lockedAt");

-- ── 2. DeadLetterReplayAttempt table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "DeadLetterReplayAttempt" (
  "id"                   SERIAL PRIMARY KEY,
  "deadLetterId"         INTEGER       NOT NULL,
  "actor"                TEXT          NOT NULL,
  "outcome"              TEXT          NOT NULL,
  "errorMessage"         TEXT,
  "parsedEventType"      TEXT,
  "projectionCommitted"  BOOLEAN       NOT NULL DEFAULT false,
  "dryRun"               BOOLEAN       NOT NULL DEFAULT false,
  "idempotencyKey"       TEXT,
  "attemptedAt"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "durationMs"           INTEGER,

  CONSTRAINT "DeadLetterReplayAttempt_deadLetterId_fkey"
    FOREIGN KEY ("deadLetterId") REFERENCES "DeadLetterEvent" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "DeadLetterReplayAttempt_deadLetterId_idx"
  ON "DeadLetterReplayAttempt" ("deadLetterId");

CREATE INDEX IF NOT EXISTS "DeadLetterReplayAttempt_actor_idx"
  ON "DeadLetterReplayAttempt" ("actor");

CREATE INDEX IF NOT EXISTS "DeadLetterReplayAttempt_attemptedAt_idx"
  ON "DeadLetterReplayAttempt" ("attemptedAt");

-- ── 3. New AuditActionType enum values ───────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'DeadLetterRemediate'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditActionType')
  ) THEN
    ALTER TYPE "AuditActionType" ADD VALUE 'DeadLetterRemediate';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'SnapshotWrite'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditActionType')
  ) THEN
    ALTER TYPE "AuditActionType" ADD VALUE 'SnapshotWrite';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'SnapshotVerify'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditActionType')
  ) THEN
    ALTER TYPE "AuditActionType" ADD VALUE 'SnapshotVerify';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'ReorgRollback'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditActionType')
  ) THEN
    ALTER TYPE "AuditActionType" ADD VALUE 'ReorgRollback';
  END IF;
END $$;

-- ── 4. SnapshotStatus enum + IndexerSnapshot table ───────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SnapshotStatus') THEN
    CREATE TYPE "SnapshotStatus" AS ENUM ('Pending', 'Verified', 'Mismatch', 'Invalid');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "IndexerSnapshot" (
  "id"               SERIAL PRIMARY KEY,
  "ledgerSequence"   INTEGER       NOT NULL,
  "ledgerHash"       TEXT          NOT NULL,
  "contractCursors"  JSONB         NOT NULL,
  "eventCount"       BIGINT        NOT NULL DEFAULT 0,
  "schemaVersion"    TEXT          NOT NULL,
  "rpcVerified"      BOOLEAN       NOT NULL DEFAULT false,
  "hashMismatch"     BOOLEAN       NOT NULL DEFAULT false,
  "rpcHash"          TEXT,
  "status"           "SnapshotStatus" NOT NULL DEFAULT 'Pending',
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "IndexerSnapshot_ledgerSequence_idx"
  ON "IndexerSnapshot" ("ledgerSequence");

CREATE INDEX IF NOT EXISTS "IndexerSnapshot_status_idx"
  ON "IndexerSnapshot" ("status");

CREATE INDEX IF NOT EXISTS "IndexerSnapshot_createdAt_idx"
  ON "IndexerSnapshot" ("createdAt");

-- Composite index for recovery query: latest Verified snapshot at or before ledger X
CREATE INDEX IF NOT EXISTS "IndexerSnapshot_status_ledgerSequence_idx"
  ON "IndexerSnapshot" ("status", "ledgerSequence");
