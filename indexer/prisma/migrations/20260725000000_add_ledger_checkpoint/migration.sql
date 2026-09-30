-- CreateEnum
CREATE TYPE "CheckpointStatus" AS ENUM ('fetched', 'applying', 'committed', 'failed');

-- CreateTable
CREATE TABLE "LedgerCheckpoint" (
    "id" SERIAL NOT NULL,
    "contractId" TEXT NOT NULL,
    "windowStart" INTEGER NOT NULL,
    "windowEnd" INTEGER NOT NULL,
    "ledgerHash" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "status" "CheckpointStatus" NOT NULL DEFAULT 'fetched',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerCheckpoint_contractId_status_idx" ON "LedgerCheckpoint"("contractId", "status");

-- CreateIndex
CREATE INDEX "LedgerCheckpoint_status_idx" ON "LedgerCheckpoint"("status");

-- CreateIndex
CREATE INDEX "LedgerCheckpoint_contractId_windowEnd_idx" ON "LedgerCheckpoint"("contractId", "windowEnd");
