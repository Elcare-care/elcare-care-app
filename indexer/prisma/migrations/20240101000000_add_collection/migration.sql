-- Migration: add Collection table
CREATE TABLE "Collection" (
    "id"               SERIAL PRIMARY KEY,
    "contractAddress"  TEXT    NOT NULL UNIQUE,
    "kind"             TEXT    NOT NULL,
    "creator"          TEXT    NOT NULL,
    "name"             TEXT,
    "symbol"           TEXT,
    "deployedAtLedger" INTEGER NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
