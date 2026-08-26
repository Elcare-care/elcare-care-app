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
- [API Documentation (Swagger UI)](#api-documentation-swagger-ui)
- [Database Schema](#database-schema)
- [Re-org Handling](#re-org-handling)
- [Redis Caching](#redis-caching)
- [Metrics](#metrics)
- [Logging](#logging)
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
| `LOG_LEVEL` | ⬜ | `info` | Minimum log level emitted: `debug` \| `info` \| `warn` \| `error` (see [Logging](#logging)) |
| `LOG_FORMAT` | ⬜ | `json` | `json` for machine-readable logs, `pretty` for colorized human-readable local dev output |

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

## API Documentation (Swagger UI)

The indexer ships a machine-readable OpenAPI 3.0 specification generated directly from the Zod route schemas.

| Endpoint | Description |
|----------|-------------|
| `GET /docs` | Interactive Swagger UI (no external CDN — assets served from `swagger-ui-dist`) |
| `GET /openapi.json` | Raw OpenAPI 3.0 JSON spec |

### Keeping the spec in sync

The spec is generated from `src/api/openapi.ts` and committed as `openapi.json`. A CI job (`Check OpenAPI Spec`) regenerates the spec on every PR and fails if the output differs from the committed file.

To update the spec locally after changing routes:

```bash
npm run generate-openapi
# then commit the updated openapi.json
```

---

## API Reference

> **Prefer the interactive docs at `/docs`** for the canonical, always-up-to-date reference.

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

## Logging

The indexer emits **structured JSON logs** (one JSON object per line) via [pino](https://getpino.io), so logs are directly parseable by log aggregators, `jq`, CloudWatch Insights, Datadog, etc. — no regex scraping required.

Every log line includes:

| Field | Description |
|-------|-------------|
| `level` | `debug` \| `info` \| `warn` \| `error` |
| `time` | Unix epoch milliseconds |
| `msg` | The log message |
| `service` | Always `elcarehub-indexer` |
| `version` | The `version` field from `package.json`, for pinning a log line to a deploy |
| *(contextual fields)* | e.g. `ledger`, `eventType`, `listingId`, `auctionId`, `offerId`, `requestId` — whatever was passed as the second argument to the log call |

Example log line:

```json
{"level":"info","time":1721912400123,"service":"elcarehub-indexer","version":"1.0.0","msg":"ARTWORK_SOLD: listing not found — sale not recorded","eventType":"ARTWORK_SOLD","listingId":"42","ledger":581920}
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Minimum level emitted. Set to `debug` locally for verbose tracing (e.g. duplicate-event skips), or `warn`/`error` in noisy environments. |
| `LOG_FORMAT` | `json` | `json` (default) emits one-line JSON, suitable for production and log shippers. `pretty` pipes output through [`pino-pretty`](https://github.com/pinojs/pino-pretty) for colorized, human-readable lines — use this for local development (`LOG_FORMAT=pretty npm run dev`). |
| `ALLOW_RAW_BODY_LOGGING` | `false` | Opts into unredacted request bodies / full XDR blobs for local debugging. Ignored (no-op, with a one-time warning) when `NODE_ENV=production`. See [Logging Policy](../docs/LOGGING_POLICY.md). |

### Request correlation IDs

Every HTTP request is tagged with a request ID (`indexer/src/api/request-id-middleware.ts`):

- If the caller sends an `X-Request-Id` header, that value is reused (so IDs can be threaded through from an upstream gateway or the frontend).
- Otherwise a new UUID is generated with `crypto.randomUUID()`.
- The ID is echoed back as the `X-Request-Id` response header and attached to `res.locals.requestId` for any downstream handler to read.
- Two structured log lines bracket each request — `"request started"` and `"request completed"` — both carrying `requestId`, `method`, `route`, and (on completion) `statusCode` and `durationMs`. This makes it trivial to filter a log stream down to every line produced by a single request, or to grep production logs by the request ID returned to a user reporting an issue.

`/health`, `/readyz`, and `/metrics` are excluded from request logging to avoid drowning real traffic in health-check noise (they're polled every few seconds by orchestrators/Prometheus).

### Redaction & privacy-safe logging

Every log line is sanitized before it reaches pino (`indexer/src/log-redaction.ts`, wired in via `logger.ts`'s `wrap()`): Stellar secret keys, JWTs, `authorization`/`cookie`/`password`/`token`-shaped fields, credentials embedded in URLs (`postgres://user:pass@host` → `postgres://[REDACTED]@host`), and raw Soroban transaction XDR blobs are all redacted or truncated automatically, including inside nested objects and `Error.cause` chains. `requestId`, `statusCode`, `durationMs`, and similar diagnostic fields are never touched.

Full request bodies / raw XDR are available for local debugging only via `ALLOW_RAW_BODY_LOGGING=true`, which is a hard no-op when `NODE_ENV=production`. See **[Logging Policy](../docs/LOGGING_POLICY.md)** for the full allowed/forbidden field list and the guarded-override behavior.

### Log Shipping

The indexer writes logs to `stdout` only — it never writes to files — so shipping is entirely a matter of how the container runtime/orchestrator collects `stdout`. Two documented paths:

**AWS CloudWatch Logs.** Use Docker's built-in [`awslogs` log driver](https://docs.docker.com/engine/logging/drivers/awslogs/). A commented example is included in `docker-compose.yml` next to the `indexer` service — uncomment it and set `awslogs-region`/`awslogs-group` for your account. Requires the CloudWatch Logs group to exist and AWS credentials to be visible to the Docker daemon (e.g. an EC2 instance role or `~/.aws/credentials`). Because every line is already valid JSON, CloudWatch Logs Insights can query fields like `eventType` or `requestId` directly with no custom parser.

**Datadog.** The simplest path is the [Datadog Agent's Docker log collection](https://docs.datadoghq.com/containers/docker/log/): run the Agent as a sidecar/daemon with `DD_LOGS_ENABLED=true` and `DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=true`, and it tails every container's `json-file` logs automatically (no per-service driver change needed — see the commented `json-file` + `com.datadoghq.ad.logs` label example in `docker-compose.yml`). At a high level, the Agent (or an APM-instrumented process) uses:

| Variable | Description |
|----------|-------------|
| `DD_API_KEY` | Datadog API key used by the Agent to ship logs/metrics |
| `DD_SERVICE` | Service name tag — set to `elcarehub-indexer` to match the `service` field already in every log line |
| `DD_ENV` | Environment tag (`production`, `staging`, etc.) |

Because pino output is already JSON with a `service`/`level`/`msg` shape, Datadog's log pipelines can parse it with the built-in JSON parser with no grok rules required.

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

---

## Architecture & Debugging Guides

For deeper indexer troubleshooting, schema changes, and ingestion diagnostics, refer to:
- 🏗️ **[Local Architecture](../docs/guides/local-architecture.md)**
- 🔄 **[Indexer Ingestion Guide](../docs/guides/indexer-ingestion.md)**
- 🏷️ **[Event Parsing Guide](../docs/guides/event-parsing.md)**
- 🗄️ **[Database Migrations Guide](../docs/guides/database-migrations.md)**
- 🚀 **[Deployment Guide](../docs/guides/deployment.md)**
- 🛡️ **[Security Triage Guide](../docs/guides/security-triage.md)**

