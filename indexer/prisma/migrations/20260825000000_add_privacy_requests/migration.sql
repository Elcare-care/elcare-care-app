-- Issue #543: account deletion and data export controls

-- Create PrivacyRequestType enum
CREATE TYPE "PrivacyRequestType" AS ENUM (
  'EXPORT',
  'DELETION'
);

-- Create PrivacyRequestStatus enum
CREATE TYPE "PrivacyRequestStatus" AS ENUM (
  'PENDING',
  'VERIFIED',
  'PROCESSING',
  'COMPLETED',
  'REJECTED',
  'FAILED'
);

-- Create PrivacyRequest table
CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "type" "PrivacyRequestType" NOT NULL,
  "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP,
  "completedAt" TIMESTAMP,
  "exportPayload" JSONB,
  "retainedRecordsNote" TEXT,
  "auditNote" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL,

  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- Create indexes for efficient per-wallet lookups
CREATE INDEX "PrivacyRequest_walletAddress_idx" ON "PrivacyRequest"("walletAddress");
CREATE INDEX "PrivacyRequest_walletAddress_type_idx" ON "PrivacyRequest"("walletAddress", "type");
CREATE INDEX "PrivacyRequest_status_idx" ON "PrivacyRequest"("status");
CREATE INDEX "PrivacyRequest_requestedAt_idx" ON "PrivacyRequest"("requestedAt");

-- Add comment to table
COMMENT ON TABLE "PrivacyRequest" IS 'Self-service export/deletion requests for off-chain, wallet-linked application data. Never stores secrets or signatures.';
