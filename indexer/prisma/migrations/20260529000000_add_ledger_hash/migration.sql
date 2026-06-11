-- CreateTable SyncState (with ledger hash for chain continuity validation)
CREATE TABLE IF NOT EXISTS "SyncState" (
    "id"              INTEGER NOT NULL DEFAULT 1 PRIMARY KEY,
    "lastLedger"      INTEGER NOT NULL DEFAULT 0,
    "lastLedgerHash"  TEXT,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
