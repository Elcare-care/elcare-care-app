-- Create enums for financial reconciliation
CREATE TYPE "FinancialReconcileStatus" AS ENUM ('Pending', 'Matched', 'DriftDetected', 'AlertRaised', 'Resolved');
CREATE TYPE "FinancialDriftSeverity" AS ENUM ('Low', 'Medium', 'High', 'Critical');

-- Create FinancialReconcileRun table
CREATE TABLE "FinancialReconcileRun" (
    "id" SERIAL PRIMARY KEY,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "ledgerFrom" INTEGER NOT NULL,
    "ledgerTo" INTEGER NOT NULL,
    "confirmedDepth" INTEGER NOT NULL,
    "toleranceBps" INTEGER NOT NULL DEFAULT 100,
    "includeProvisional" BOOLEAN NOT NULL DEFAULT false,
    "driftsDetected" INTEGER NOT NULL DEFAULT 0,
    "alertsRaised" INTEGER NOT NULL DEFAULT 0,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT
);

-- Create indexes for FinancialReconcileRun
CREATE INDEX "FinancialReconcileRun_startedAt_idx" ON "FinancialReconcileRun"("startedAt");
CREATE INDEX "FinancialReconcileRun_ledgerFrom_ledgerTo_idx" ON "FinancialReconcileRun"("ledgerFrom", "ledgerTo");

-- Create FinancialDrift table
CREATE TABLE "FinancialDrift" (
    "id" SERIAL PRIMARY KEY,
    "runId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "token" TEXT,
    "collection" TEXT,
    "expectedAmount" DECIMAL(32, 7) NOT NULL,
    "actualAmount" DECIMAL(32, 7) NOT NULL,
    "driftAmount" DECIMAL(32, 7) NOT NULL,
    "driftBps" INTEGER NOT NULL,
    "severity" "FinancialDriftSeverity" NOT NULL,
    "status" "FinancialReconcileStatus" NOT NULL DEFAULT 'DriftDetected',
    "reason" TEXT NOT NULL,
    "isProvisional" BOOLEAN NOT NULL DEFAULT false,
    "confirmationDepth" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNotes" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialDrift_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinancialReconcileRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Create indexes for FinancialDrift
CREATE INDEX "FinancialDrift_runId_idx" ON "FinancialDrift"("runId");
CREATE INDEX "FinancialDrift_entityType_ledgerSequence_idx" ON "FinancialDrift"("entityType", "ledgerSequence");
CREATE INDEX "FinancialDrift_status_severity_idx" ON "FinancialDrift"("status", "severity");
CREATE INDEX "FinancialDrift_token_idx" ON "FinancialDrift"("token");
CREATE INDEX "FinancialDrift_collection_idx" ON "FinancialDrift"("collection");
CREATE INDEX "FinancialDrift_isProvisional_idx" ON "FinancialDrift"("isProvisional");
CREATE INDEX "FinancialDrift_detectedAt_idx" ON "FinancialDrift"("detectedAt");

-- Create FinancialAggregateSnapshot table
CREATE TABLE "FinancialAggregateSnapshot" (
    "id" SERIAL PRIMARY KEY,
    "snapshotType" TEXT NOT NULL,
    "scopeKey" TEXT,
    "ledgerFrom" INTEGER NOT NULL,
    "ledgerTo" INTEGER NOT NULL,
    "protocolFeesTotal" DECIMAL(32, 7) NOT NULL DEFAULT 0,
    "royaltiesTotal" DECIMAL(32, 7) NOT NULL DEFAULT 0,
    "salesTotal" DECIMAL(32, 7) NOT NULL DEFAULT 0,
    "refundsTotal" DECIMAL(32, 7) NOT NULL DEFAULT 0,
    "protocolFeeCount" INTEGER NOT NULL DEFAULT 0,
    "royaltyCount" INTEGER NOT NULL DEFAULT 0,
    "saleCount" INTEGER NOT NULL DEFAULT 0,
    "refundCount" INTEGER NOT NULL DEFAULT 0,
    "confirmedOnly" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialAggregateSnapshot_snapshotType_scopeKey_ledgerFrom_ledgerTo_confirmedOnly_key" UNIQUE ("snapshotType", "scopeKey", "ledgerFrom", "ledgerTo", "confirmedOnly")
);

-- Create indexes for FinancialAggregateSnapshot
CREATE INDEX "FinancialAggregateSnapshot_snapshotType_ledgerFrom_ledgerTo_idx" ON "FinancialAggregateSnapshot"("snapshotType", "ledgerFrom", "ledgerTo");
CREATE INDEX "FinancialAggregateSnapshot_scopeKey_idx" ON "FinancialAggregateSnapshot"("scopeKey");
