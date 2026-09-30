-- Create ModerationState enum
CREATE TYPE "ModerationState" AS ENUM (
  'PENDING',
  'APPROVED',
  'REPORTED',
  'QUARANTINED',
  'REJECTED'
);

-- Create ModerationAssetKind enum
CREATE TYPE "ModerationAssetKind" AS ENUM (
  'IMAGE',
  'METADATA'
);

-- Create ReportCategory enum
CREATE TYPE "ReportCategory" AS ENUM (
  'PROHIBITED_CONTENT',
  'INTELLECTUAL_PROPERTY',
  'MISLEADING_METADATA',
  'SPAM',
  'MALWARE_SUSPECTED',
  'OTHER'
);

-- Create AppealStatus enum
CREATE TYPE "AppealStatus" AS ENUM (
  'PENDING',
  'UNDER_REVIEW',
  'UPHELD',
  'OVERTURNED'
);

-- Create ModerationCase table
CREATE TABLE "ModerationCase" (
  "id" SERIAL PRIMARY KEY,
  "cid" TEXT NOT NULL,
  "kind" "ModerationAssetKind" NOT NULL,
  "state" "ModerationState" NOT NULL DEFAULT 'PENDING',
  "reportCount" INTEGER NOT NULL DEFAULT 0,
  "uploaderAddress" TEXT,
  "listingId" BIGINT,
  "reason" TEXT,
  "reviewedBy" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX "ModerationCase_cid_key" ON "ModerationCase"("cid");
CREATE INDEX "ModerationCase_state_idx" ON "ModerationCase"("state");
CREATE INDEX "ModerationCase_listingId_idx" ON "ModerationCase"("listingId");
CREATE INDEX "ModerationCase_uploaderAddress_idx" ON "ModerationCase"("uploaderAddress");
CREATE INDEX "ModerationCase_kind_idx" ON "ModerationCase"("kind");

-- Create ModerationReport table
CREATE TABLE "ModerationReport" (
  "id" SERIAL PRIMARY KEY,
  "caseId" INTEGER NOT NULL,
  "cid" TEXT NOT NULL,
  "category" "ReportCategory" NOT NULL,
  "description" TEXT,
  "reporterAddress" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModerationReport_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ModerationReport_cid_reporterAddress_key" ON "ModerationReport"("cid", "reporterAddress");
CREATE INDEX "ModerationReport_caseId_idx" ON "ModerationReport"("caseId");
CREATE INDEX "ModerationReport_cid_idx" ON "ModerationReport"("cid");

-- Create ModerationDecision table
CREATE TABLE "ModerationDecision" (
  "id" SERIAL PRIMARY KEY,
  "caseId" INTEGER NOT NULL,
  "previousState" "ModerationState" NOT NULL,
  "newState" "ModerationState" NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModerationDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ModerationDecision_caseId_idx" ON "ModerationDecision"("caseId");
CREATE INDEX "ModerationDecision_createdAt_idx" ON "ModerationDecision"("createdAt");

-- Create ModerationAppeal table
CREATE TABLE "ModerationAppeal" (
  "id" SERIAL PRIMARY KEY,
  "caseId" INTEGER NOT NULL,
  "appellantAddress" TEXT NOT NULL,
  "statement" TEXT NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
  "decidedBy" TEXT,
  "decisionReason" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP,
  CONSTRAINT "ModerationAppeal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ModerationAppeal_caseId_idx" ON "ModerationAppeal"("caseId");
CREATE INDEX "ModerationAppeal_status_idx" ON "ModerationAppeal"("status");

-- Comments
COMMENT ON TABLE "ModerationCase" IS 'One row per moderated asset (image/metadata CID). Overlay only — never deletes or rewrites Listing rows or on-chain provenance.';
COMMENT ON TABLE "ModerationReport" IS 'User-submitted abuse reports. description/reporterAddress are operator-only and must never be returned from a public endpoint.';
COMMENT ON TABLE "ModerationDecision" IS 'Append-only audit trail of moderator state transitions on a ModerationCase.';
COMMENT ON TABLE "ModerationAppeal" IS 'Creator/uploader appeals against a QUARANTINED or REJECTED decision.';
