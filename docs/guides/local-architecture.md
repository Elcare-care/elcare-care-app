# Local Architecture Guide

This guide provides a comprehensive overview of ElcareHub's system architecture for local development, detailing how individual components interact, where key business logic resides, and how to troubleshoot end-to-end issues across service boundaries.

---

## 1. System Overview

ElcareHub is a full-stack decentralized marketplace for African art built on the **Stellar Blockchain** using **Soroban Smart Contracts**. The local environment consists of three primary application tiers supported by infrastructure services:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         1. FRONTEND TIER                                 │
│                Next.js 14 App Router (Port 3000)                         │
│                                                                          │
│  - React UI & Design System       - Wallet Adapters (Freighter, Magic)   │
│  - Direct Soroban RPC Calls       - REST & SSE Client for Indexer        │
└───────────────────┬──────────────────────────────────┬───────────────────┘
                    │                                  │
      Signed WASM   │                                  │ HTTP REST & SSE
      Transactions  │                                  │ Data Queries
                    ▼                                  ▼
┌───────────────────────────────┐     ┌────────────────────────────────────┐
│      2. BLOCKCHAIN TIER       │     │          3. INDEXER TIER           │
│   Stellar Soroban Testnet     │     │     Node.js + Express (Port 4000)  │
│                               │     │                                    │
│  - Soroban Smart Contracts    │     │  - RPC Event Poller (5s interval)  │
│  - On-Chain State Storage     │────►│  - XDR Event Parser & Decoder      │
│  - Contract Event Emitter     │ RPC │  - Re-org Detection & Rollback     │
└───────────────────────────────┘     └─────────────────┬──────────────────┘
                                                        │ Prisma ORM
                                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     4. INFRASTRUCTURE SERVICES                           │
│                                                                          │
│  - PostgreSQL (Port 5432): Persists structured marketplace events & state │
│  - Redis (Port 6379): API response caching & TTL management              │
│  - IPFS / Pinata: Artwork images and JSON metadata storage               │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Owning Files & Repository Structure

| Component | Responsible Directory / File | Description |
|---|---|---|
| **Smart Contracts** | [`contracts/soroban-marketplace/src/contract.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/soroban-marketplace/src/contract.rs) | Marketplace core logic (listings, auctions, offers, royalties) |
| | [`contracts/soroban-marketplace/src/types.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/soroban-marketplace/src/types.rs) | Contract data types and error codes (`MarketplaceError`) |
| | [`contracts/soroban-marketplace/src/storage.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/soroban-marketplace/src/storage.rs) | Soroban persistent & instance storage helpers |
| | [`contracts/launchpad/src/lib.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/launchpad/src/lib.rs) | NFT Collection deployer factory contract |
| **Indexer** | [`indexer/src/poller.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/poller.ts) | Soroban RPC polling engine & transaction management |
| | [`indexer/src/event-sync.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/event-sync.ts) | Event extraction and batch application |
| | [`indexer/src/parser.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/parser.ts) | XDR topic decoding & event hashing (`computeEventHash`) |
| | [`indexer/prisma/schema.prisma`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/prisma/schema.prisma) | PostgreSQL database schema definition |
| **Frontend** | [`frontend/elcarehub-app/src/lib/contract.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/lib/contract.ts) | Soroban SDK client wrapper for invoke operations |
| | [`frontend/elcarehub-app/src/lib/indexer.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/lib/indexer.ts) | Client fetching data from indexer REST endpoints |
| | [`frontend/elcarehub-app/src/context/WalletContext.tsx`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/context/WalletContext.tsx) | Wallet connection & signing context provider |

---

## 3. Core Local Commands

### 1. Start Infrastructure (PostgreSQL & Redis)
```bash
cd indexer
docker compose up -d db redis
```
*Expected output:* `Container indexer-db-1  Started`, `Container indexer-redis-1  Started`

### 2. Run Database Migrations
```bash
cd indexer
npx prisma migrate dev
```
*Expected output:* `Already in sync` or `The following migration(s) have been applied`

### 3. Start Indexer Dev Server
```bash
cd indexer
npm run dev
```
*Expected output:* `[info] Indexer listening on port 4000`

### 4. Start Frontend Dev Server
```bash
cd frontend/elcarehub-app
npm run dev
```
*Expected output:* `Ready in 1.5s` on `http://localhost:3000`

### 5. Execute Smart Contract Tests
```bash
cargo test
```
*Expected output:* `test result: ok. X passed; 0 failed`

---

## 4. End-to-End Decision Tree & Diagnostic Steps

When an issue occurs locally (e.g. user purchases an artwork but UI doesn't update), follow this decision tree to isolate the boundary:

```
                  [ Issue Reported / UI Out of Sync ]
                                  │
                                  ▼
               Check Browser Console & Network Tab
                                  │
         ┌────────────────────────┴────────────────────────┐
         ▼                                                 ▼
[ Transaction Failed / Signing Error ]          [ REST/SSE Response Outdated ]
         │                                                 │
         ▼                                                 ▼
   Go to Guide:                                  Check Indexer Health
   Frontend Transaction Debugging                `GET http://localhost:4000/healthz`
                                                           │
                                           ┌───────────────┴───────────────┐
                                           ▼                               ▼
                                    [ Health OK ]                  [ Health Failing ]
                                           │                               │
                                           ▼                               ▼
                                 Check Indexer Logs              Check Infrastructure
                                 `stalled` or RPC errors?       PostgreSQL / Redis running?
                                           │                               │
                                   ┌───────┴───────┐                       ▼
                                   ▼               ▼             Go to Guide: Database
                             Go to Guide:     Go to Guide:       Migrations & Indexer Ingestion
                             Indexer Ingest   Event Parsing
```

---

## 5. Safe Redaction Guidance

> [!WARNING]
> When collecting logs or reporting architecture issues, **NEVER** expose sensitive keys or secret values.

* **Never share or log:**
  * Secret keys / Private keys starting with `S...` (e.g. `SD...`)
  * Wallet seed phrases / Mnemonic words (12 or 24 words)
  * Database passwords or full `DATABASE_URL` strings containing passwords
  * IPFS API Secrets or Pinata JWT tokens
* **Always redact before sharing logs:**
  ```text
  # BAD:
  DATABASE_URL="postgresql://postgres:MySecretPass123@localhost:5432/elcarehub"
  SECRET_KEY="SBXXXXXXXXXXXXX..."

  # GOOD:
  DATABASE_URL="postgresql://postgres:[REDACTED]@localhost:5432/elcarehub"
  SECRET_KEY="[REDACTED_STELLAR_SECRET_KEY]"
  ```
