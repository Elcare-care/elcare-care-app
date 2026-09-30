-- Create AuditActionType enum
CREATE TYPE "AuditActionType" AS ENUM (
  'AdminRoleChange',
  'RecoveryOperation',
  'CacheInvalidation',
  'ReplayJob',
  'ContractUpgrade',
  'EmergencyPause',
  'DataCorrection',
  'BackfillJob',
  'GapRepair',
  'DeadLetterReplay'
);

-- Create AuditOutcome enum
CREATE TYPE "AuditOutcome" AS ENUM (
  'Success',
  'Failure',
  'Partial'
);

-- Create OperationalAudit table
CREATE TABLE "OperationalAudit" (
  "id" SERIAL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "actionType" "AuditActionType" NOT NULL,
  "target" TEXT,
  "requestId" TEXT NOT NULL,
  "outcome" "AuditOutcome" NOT NULL,
  "redactedContext" JSONB NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for efficient querying
CREATE INDEX "OperationalAudit_actor_idx" ON "OperationalAudit"("actor");
CREATE INDEX "OperationalAudit_actionType_idx" ON "OperationalAudit"("actionType");
CREATE INDEX "OperationalAudit_createdAt_idx" ON "OperationalAudit"("createdAt");
CREATE INDEX "OperationalAudit_actor_actionType_idx" ON "OperationalAudit"("actor", "actionType");
CREATE INDEX "OperationalAudit_actionType_createdAt_idx" ON "OperationalAudit"("actionType", "createdAt");
CREATE INDEX "OperationalAudit_requestId_idx" ON "OperationalAudit"("requestId");

-- Add comment to table
COMMENT ON TABLE "OperationalAudit" IS 'Append-only audit log for high-risk operational actions. Records cannot be edited through the application.';
