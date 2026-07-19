<div align="center">

# ElcareHub — Indexer

**Off-chain event indexer and REST API for the ElcareHub marketplace.**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-blue)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7.x-red)](https://redis.io)
[![Docker](https://img.shields.io/badge/Docker-ready-blue)](https://www.docker.com)

</div>

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Re-org Handling](#re-org-handling)
- [Redis Caching](#redis-caching)
- [Metrics](#metrics)
- [Testing](#testing)

---

## Overview

The indexer is a **Node.js + Express** service that bridges the Stellar blockchain and the frontend. It polls the Stellar Soroban RPC for contract events, decodes them from XDR, and writes structured state into PostgreSQL. The frontend queries the indexer's REST API instead of the chain directly — giving it fast filtered reads, pagination, activity feeds, and royalty stats that would be expensive or impossible on-chain.

---

## How It Works

```
Stellar RPC (every 5 s)
       │
       ▼
  poller.ts  ──►  Fetch ledgers since last checkpoint
       │
       ▼
  event-sync.ts  ──►  Decode XDR contract events
       │
       ├──►  collectMarketplaceEvents()
       │           └── filter by contract ID
       │
       ▼
  poller.ts  ──►  applyDecodedEvents() inside Prisma transaction
       │           ├── upsert Listing / Auction / Offer state
       │           └── insert MarketplaceEvent audit row
       │
       ├──►  updateSyncState (lastLedger + ledgerHash)
       │
       └──►  emitSSEEvent() → broadcast to connected clients
```

**Re-org safety:** On every poll, the indexer compares the stored `lastLedgerHash` against the network. If the hash differs, it rolls back all events, listings, and auctions written past the safe checkpoint, then resumes from there.

---

## Getting Started

### Prerequisites

- **Node.js 20.x**
- **Docker + Docker Compose** (for PostgreSQL and Redis)

### Local development

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Start PostgreSQL + Redis
docker compose up -d db redis

# 4. Run database migrations
npx prisma migrate dev

# 5. Start the indexer in watch mode
npm run dev
```

The API is now available at **http://localhost:4000**

### Docker (full stack)

```bash
# Edit docker-compose.yml — set MARKETPLACE_CONTRACT_ID
docker compose up --build
```

This starts PostgreSQL, Redis, and the indexer together.

### Backfill missed ledgers

If the indexer was offline and the live RPC window has moved past your last indexed ledger, backfill from an archival RPC:

```bash
npm run backfill -- --start=123456 --end=124999 --rpc=https://your-archival-rpc
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `DB_CONNECTION_LIMIT` | ⬜ | `10` | Max connections in pool. Recommended: 10-20 for single instance, up to 50 for high-traffic production |
| `DB_STATEMENT_TIMEOUT` | ⬜ | `30000` | Max query execution time (ms). Recommended: 30000 for typical queries, 10000 for strict SLA |
| `DB_IDLE_TIMEOUT` | ⬜ | `30000` | Connection idle timeout (ms). Recommended: 30000 |
| `DB_ACQUIRE_TIMEOUT` | ⬜ | `10000` | Max time to acquire connection from pool (ms). Increase if seeing "too many clients" errors under peak load |
| `MARKETPLACE_CONTRACT_ID` | ✅ | — | Soroban marketplace contract address |
| `LAUNCHPAD_CONTRACT_ID` | ✅ | — | Launchpad factory contract address |
| `REDIS_URL` | ✅ | `redis://localhost:6379` | Redis connection string |
| `STELLAR_RPC_URL` | ✅ | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `STELLAR_NETWORK` | ✅ | `testnet` | `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL` | ⬜ | `https://horizon-testnet.stellar.org` | Horizon REST API |
| `PORT` | ⬜ | `4000` | HTTP server port |
| `POLL_INTERVAL_MS` | ⬜ | `5000` | Polling interval in milliseconds |
| `CORS_ORIGIN` | ⬜ | — | Comma-separated list of allowed origins (see CORS section) |

---

## CORS Configuration

The indexer uses a dynamic origin whitelist with per-origin credential support and preflight caching.

### How it works

- **Empty / unset `CORS_ORIGIN`** (development): every origin is reflected — no restrictions. Convenient for `localhost` and tool-based testing.
- **Non-empty `CORS_ORIGIN`** (staging / production): only origins in the list receive `Access-Control-Allow-Origin`. Requests from any other origin get no CORS headers and are blocked by the browser.

Allowed requests always include `Access-Control-Allow-Credentials: true` (required for `X-API-Key` headers) and `Access-Control-Max-Age: 86400` (preflight cached for 24 hours).

### Environment examples

**Local development** — allow everything:
```env
# leave CORS_ORIGIN unset or empty
CORS_ORIGIN=
```

**Staging** — single frontend origin:
```env
CORS_ORIGIN=https://staging.elcarehub.xyz
```

**Production** — multiple origins (frontend + registered integrators):
```env
CORS_ORIGIN=https://app.elcarehub.xyz,https://partner.example.com,https://dashboard.example.com
```

### SSE (`/events`)

The SSE endpoint adds `X-Accel-Buffering: no` so nginx reverse proxies forward chunks immediately rather than buffering the full response body.

### Debug endpoint

In non-production environments a `GET /cors-test` endpoint is available. It echoes the request origin, whether it was allowed, and the current whitelist — useful for verifying browser or curl config without reading server logs:

```bash
curl -H "Origin: http://localhost:3000" http://localhost:4000/cors-test
```

```json
{
  "origin": "http://localhost:3000",
  "allowed": true,
  "whitelist": [],
  "mode": "development (all origins)"
}
```

---

## API Reference

Base URL: `http://localhost:4000`

### Listings

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/listings` | All listings. Filters: `artist`, `status`, `minPrice`, `maxPrice`, `search`, `limit`, `offset` |
| `GET` | `/listings/:id` | Single listing |
| `GET` | `/listings/:id/history` | On-chain event history for a listing |

### Auctions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/auctions` | All auctions. Filters: `status`, `creator` |
| `GET` | `/auctions/:id` | Single auction with bid history |

### Offers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/offers` | Offers for a listing. Query: `listing_id` |

### Collections

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/collections` | All deployed collections. Filters: `kind`, `creator` |
| `GET` | `/creators/:address/collections` | Collections by creator |

### Wallets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/wallets/:address/activity` | Transaction feed for an address. Query: `limit` |
| `GET` | `/wallets/:address/royalty-stats` | Royalty earnings summary |

### System

| Method | Endpoint | Cache | Description |
|--------|----------|-------|-------------|
| `GET` | `/health` | — | Liveness check |
| `GET` | `/readyz` | — | Readiness — 503 until first ledger indexed |
| `GET` | `/metrics` | — | Prometheus metrics (bypasses rate limiting) |

---

## Database Schema

```
SyncState        — last indexed ledger + hash (re-org detection)
Listing          — NFT listings with price, status, recipients
Auction          — Auctions with bids, reserve, end time
Offer            — Offers on listings with status lifecycle
MarketplaceEvent — Immutable audit log of all on-chain events
Collection       — Deployed NFT collections from the launchpad
```

Key constraints:
- `MarketplaceEvent` has a unique index on `(listingId, eventType, ledgerSequence)` to prevent duplicate inserts
- All writes happen inside a **single Prisma transaction** per poll cycle for atomicity
- `SyncState` is an upsert — safe against concurrent startup races

---

## Re-org Handling

On every polling cycle:

1. Fetch `lastLedger` and `lastLedgerHash` from `SyncState`
2. Request that ledger from the RPC and compare hashes
3. **If hashes differ** (re-org detected):
   - Delete all `MarketplaceEvent` rows with `ledgerSequence > safeAtLedger`
   - Delete `Listing` rows created after the safe checkpoint
   - Revert `Listing` status changes to `Active`
   - Delete `Collection` rows deployed after the checkpoint
   - Reset `SyncState.lastLedger` to the safe checkpoint
4. Resume polling from the reverted state

---

## Redis Caching

High-traffic read endpoints are cached with a short TTL to protect the database under load.

| Endpoint | TTL | Notes |
|----------|-----|-------|
| `/listings` | 30 s | Invalidated on new events |
| `/auctions` | 30 s | Invalidated on new events |
| `/collections` | 60 s | Rarely changes |
| `/wallets/:address/activity` | 15 s | Per-address key |

If Redis is unavailable, the API falls back to direct PostgreSQL reads automatically. Cache errors are logged but never surface as 500s to clients.

---

## Metrics

The indexer exposes Prometheus metrics at `GET /metrics`.

| Metric | Type | Description |
|--------|------|-------------|
| `latest_ledger_processed` | Gauge | Last ledger fully indexed |
| `network_latest_ledger` | Gauge | Current tip of the Stellar network |
| `sync_latency_ledgers` | Gauge | Gap between network tip and indexed tip |
| `http_request_duration_seconds` | Histogram | Request duration by route and status |

---

## Testing

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test -- --watch

# Type-check without building
npm run lint
```

The test suite uses **Vitest** (configured in `vitest.config.mts` with ESM mode) and **Supertest** for API integration tests. Tests are in `src/__tests__/` and cover the poller, parser, event-sync, API routes, cache middleware, rate limiting, Redis integration, and re-org handling.
