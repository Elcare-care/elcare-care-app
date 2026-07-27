# Indexer Ingestion & Polling Guide

This guide details the indexer's ledger ingestion pipeline, RPC polling logic, re-org handling, stall detection, and gap repair procedures.

---

## 1. How Ingestion Works

The indexer continuously polls Soroban RPC for contract events emitted by the Marketplace and Launchpad smart contracts.

```
Stellar Soroban RPC (Default 5s poll interval)
        │
        ▼
   poller.ts ────────► 1. Check last indexed ledger (SyncState in PostgreSQL)
        │
        ▼
 event-sync.ts ──────► 2. Fetch events in ledger range [lastLedger + 1, currentLedger]
        │
        ▼
   parser.ts  ───────► 3. Decode XDR events & compute unique eventHash
        │
        ▼
   poller.ts  ───────► 4. Check ledger hash continuity (Re-org Detection)
        │                 - If Hash Mismatch: Roll back DB state to safe checkpoint
        │                 - If Hash Valid: Apply events in Prisma transaction
        │
        ▼
    db.ts     ───────► 5. Upsert Listing/Auction/Offer state & write MarketplaceEvent audit log
        │
        ▼
   stall.ts   ───────► 6. Update `recordProgress()` & broadcast SSE event to frontend
```

---

## 2. Owning Files

- [`indexer/src/poller.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/poller.ts): Main polling loop, re-org rollback, and transaction commit.
- [`indexer/src/stall.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/stall.ts): Stall detection timer (`STALL_THRESHOLD_MS`, default 60000ms).
- [`indexer/src/gap-repair.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/gap-repair.ts): Scans for missing ledger gaps and schedules repair.
- [`indexer/src/reconciler.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/reconciler.ts): Cross-checks on-chain storage with database state.
- [`indexer/prisma/schema.prisma`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/prisma/schema.prisma): Database model (`SyncState`, `MarketplaceEvent`, `Listing`, `Auction`, `Offer`).

---

## 3. Command Reference

### Start Indexer in Watch Mode
```bash
cd indexer
npm run dev
```

### Run Unit Tests
```bash
cd indexer
npm run test
```

### Run Integration Tests (Requires Postgres + Redis)
```bash
cd indexer
docker compose up -d db redis
npm run test:integration
```

### Backfill Missed Ledger Ranges
If the indexer was offline and missed ledgers past the RPC retention window:
```bash
cd indexer
npm run backfill -- --start=123400 --end=123900 --rpc=https://soroban-testnet.stellar.org
```
*Expected output:*
```text
[info] Starting backfill from ledger 123400 to 123900...
[info] Processed 500 ledgers. Ingested 14 events. Backfill complete.
```

---

## 4. Decision Tree & First Diagnostic Steps

```
                   [ Indexer Ingestion Issue ]
                                │
                                ▼
                       Check Indexer Logs
                                │
       ┌────────────────────────┼────────────────────────┐
       ▼                        ▼                        ▼
[ "Indexer Stalled" ]    [ "Re-org Detected" ]    [ "RPC Rate Limit / 429" ]
       │                        │                        │
       ▼                        ▼                        ▼
 Check Stall Diagnostic:  Normal behavior. Indexer Check RPC Config:
 1. Check RPC endpoint    rolls back affected      1. Increase `POLL_INTERVAL_MS`
    availability          ledgers automatically.   2. Configure fallback RPC
 2. Verify `STALL_        If stuck in loop, check     in `.env`
    THRESHOLD_MS`         DB `SyncState`.
```

### First Diagnostic Steps for Ingestion Failures

#### Scenario 1: Stalled Cursor / No New Events Processed
* **Sample Log:**
  ```text
  [warn] Indexer ingestion stalled. No progress recorded for 60000ms. Prometheus gauge set to 1.
  ```
* **First Diagnostic Action:**
  1. Test RPC connectivity:
     ```bash
     curl -s -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
       https://soroban-testnet.stellar.org
     ```
     *Expected response:* `{"jsonrpc":"2.0","id":1,"result":{"status":"healthy"}}`
  2. Inspect current sync state in database:
     ```sql
     SELECT * FROM "SyncState";
     ```

#### Scenario 2: Ledger Re-org Rollback Triggered
* **Sample Log:**
  ```text
  [warn] Re-org detected at ledger 145020. Stored hash [a1b2c3...] does not match network hash [d4e5f6...].
  [info] Rolling back events from ledger 145015 to 145020...
  [info] Rollback complete. Resuming ingestion from safe ledger 145014.
  ```
* **First Diagnostic Action:**
  If the rollback loop repeats continuously, check if the RPC endpoint was changed to a different node on a different branch or network, or reset `SyncState` to a known safe checkpoint.

---

## 5. Safe Redaction Guidance

> [!WARNING]
> When posting indexer logs or issue reports:

- Do **NOT** include raw `DATABASE_URL` strings containing database passwords.
- Ledger sequences (`123456`), transaction hashes (`a1b2c3...`), and event hashes are **public on-chain data** and safe to share.
- API Keys (`X-API-Key`) used in indexer authorization headers must be redacted (`X-API-Key: [REDACTED]`).
