-- CreateTable: ReconciliationRun
-- Captures per-run metadata for the chain reconciler so operators can audit
-- health trends and individual divergences over time.
CREATE TABLE "ReconciliationRun" (
    "id"                 SERIAL       NOT NULL,
    "startedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"        TIMESTAMP(3),
    "sampledListings"    INTEGER      NOT NULL DEFAULT 0,
    "sampledAuctions"    INTEGER      NOT NULL DEFAULT 0,
    "discrepanciesFound" INTEGER      NOT NULL DEFAULT 0,
    "repairsApplied"     INTEGER      NOT NULL DEFAULT 0,
    "skippedRecords"     INTEGER      NOT NULL DEFAULT 0,
    "dryRun"             BOOLEAN      NOT NULL DEFAULT false,
    "errorMessage"       TEXT,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Discrepancy
-- One row per field-level mismatch detected between DB state and chain state.
-- resolvedAt is set (and resolved = true) when auto-repair corrects the row.
CREATE TABLE "Discrepancy" (
    "id"         SERIAL       NOT NULL,
    "runId"      INTEGER      NOT NULL,
    "kind"       TEXT         NOT NULL,
    "entityId"   TEXT         NOT NULL,
    "field"      TEXT         NOT NULL,
    "dbValue"    TEXT         NOT NULL,
    "chainValue" TEXT         NOT NULL,
    "resolved"   BOOLEAN      NOT NULL DEFAULT false,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationRun_startedAt_idx" ON "ReconciliationRun"("startedAt");

CREATE INDEX "Discrepancy_runId_idx"        ON "Discrepancy"("runId");
CREATE INDEX "Discrepancy_kind_entityId_idx" ON "Discrepancy"("kind", "entityId");
CREATE INDEX "Discrepancy_resolved_idx"     ON "Discrepancy"("resolved");
CREATE INDEX "Discrepancy_detectedAt_idx"   ON "Discrepancy"("detectedAt");

-- AddForeignKey
ALTER TABLE "Discrepancy"
    ADD CONSTRAINT "Discrepancy_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
