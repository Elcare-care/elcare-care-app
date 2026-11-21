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
- [API Documentation (Swagger UI)](#api-documentation-swagger-ui)
- [OpenAPI Route Changelog](#openapi-route-changelog)
- [API Reference](#api-reference)
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

# 3. Update network configuration (default: testnet)
#    For testnet (default): leave STELLAR_NETWORK=testnet and use Soroban testnet RPC
#    For mainnet: set STELLAR_NETWORK=mainnet and provide mainnet contract IDs
#    Note: Mainnet configuration requires intentional deployment values.

# 4. Start PostgreSQL + Redis
docker compose up -d db redis

# 5. Run database migrations
npx prisma migrate dev

# 6. Start the indexer in watch mode
npm run dev
```

The API is now available at **http://localhost:4000**

**Network note:** By default, the indexer runs against **Stellar testnet** (`STELLAR_NETWORK=testnet`). This is safe for local development and testing. To run against mainnet, you must intentionally configure the environment variables with mainnet contract IDs and RPC endpoints.

### Docker (full stack)

```bash
# Edit docker-compose.yml — set MARKETPLACE_CONTRACT_ID
docker compose up --build
```

This starts PostgreSQL, Redis, and the indexer together.

### Backfill missed ledgers

If the indexer was offline and the live RPC window has moved past your last indexed ledger, backfill from an archival RPC:

```bash
# MUTATING: writes events and projections; run the READ-ONLY dry review first
npm run backfill -- --start=123456 --end=124999 --rpc=https://your-archival-rpc
```

Operational runbooks:
- [Gap repair](../docs/runbooks/gap-repair.md): dry review (READ-ONLY) vs. repair execution (MUTATING), expected logs, rollback boundaries, reconciliation.
- [BackfillJob status](../docs/runbooks/backfill-job-status.md): status table, safe restart, stuck-job ownership, read-only diagnostic SQL.
- [Dead-letter review](../docs/runbooks/dead-letter-review.md): view → classify → redact → resolve → replay for parser failures (`/admin/dead-letters*`).

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `DB_CONNECTION_LIMIT` | ⬜ | `10` | Max connections in pool. Recommended: 10-20 for single instance, up to 50 for high-traffic production |
| `DB_STATEMENT_TIMEOUT` | ⬜ | `30000` | Max query execution time (ms). Recommended: 30000 for typical queries, 10000 for strict SLA |
| `DB_IDLE_TIMEOUT` | ⬜ | `30000` | Connection idle timeout (ms). Recommended: 30000 |
| `DB_ACQUIRE_TIMEOUT` | ⬜ | `10000` | Max time to acquire connection from pool (ms). Increase if seeing "too many clients" errors under peak load |
| `MARKETPLACE_CONTRACT_ID` | ✅ | — | Soroban marketplace contract address (56 characters starting with `C`; network-specific placeholder `C<MARKETPLACE_CONTRACT_ID>`) |
| `LAUNCHPAD_CONTRACT_ID` | ✅ | — | Launchpad factory contract address (56 characters starting with `C`; network-specific placeholder `C<LAUNCHPAD_CONTRACT_ID>`) |
| `REDIS_URL` | ✅ | `redis://localhost:6379` | Redis connection string |
| `STELLAR_RPC_URL` | ✅ | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `STELLAR_NETWORK` | ✅ | `testnet` | **Target network: `testnet` or `mainnet`.** Local development uses `testnet` by default. Mainnet requires intentional deployment configuration. |
| `STELLAR_HORIZON_URL` | ⬜ | `https://horizon-testnet.stellar.org` | Horizon REST API |
| `PORT` | ⬜ | `4000` | HTTP server port |
| `POLL_INTERVAL_MS` | ⬜ | `5000` | Polling interval in milliseconds |
| `CORS_ORIGIN` | ⬜ | — | Comma-separated list of allowed origins (see CORS section) |
| `LOG_LEVEL` | ⬜ | `info` | Minimum log level emitted: `debug` \| `info` \| `warn` \| `error` (see [Logging](#logging)) |
| `LOG_FORMAT` | ⬜ | `json` | `json` for machine-readable logs, `pretty` for colorized human-readable local dev output |

**Startup configuration report.** At boot the indexer logs `[startup] configuration report`. It lists
the network, passphrase label, contract IDs, RPC/Horizon/DB/Redis targets (scheme, host and port
only: credentials, paths and query strings are never logged), poll settings, and the **names** of
the credentials that are set. It also logs one `[startup] configuration warning: <CODE>` line per
testnet/mainnet misconfiguration it detects. See
[Startup configuration report](../docs/runbooks/startup-config-report.md).

### Connection Pool Sizing Matrix

The indexer manages two isolated connection pools to prevent write spikes from impacting API reads:
- **API Read Pool (`db.ts`):** `DB_CONNECTION_LIMIT` (default: 10)
- **Poller Write Pool (`prisma-write.ts`):** `DB_WRITE_CONNECTION_LIMIT` (default: 3)

| Environment | Topology / Instances | Read Pool (`DB_CONNECTION_LIMIT`) | Write Pool (`DB_WRITE_CONNECTION_LIMIT`) | Total / Instance | PostgreSQL `max_connections` | Headroom |
|---|---|---|---|---|---|---|
| **Local Dev** (Docker) | 1 instance | 10 | 3 | 13 | 50 | 37 (74%) |
| **Staging** (Single Host) | 2 replicas | 15 | 5 | 20 | 100 | 60 (60%) |
| **Production (Standard)** | 4 replicas | 25 | 5 | 30 | 200 | 80 (40%) |
| **Production (High-Load)** | 8 replicas (with PgBouncer) | 30 (to pooler) | 5 (direct) | 35 | 300 | 100 (33%) |

**Pool Acquisition Failure Validation:**
If logs output `Timed out fetching a new connection from the connection pool` (`P2024` / `P1001`), verify active connections with:
```sql
SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY state;
```
See the [Database Outage Runbook](../docs/runbooks/database-outage.md#database-connection-pool-sizing-matrix--failure-validation) for triage details.

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

## OpenAPI Route Changelog

This changelog records public and operator route interface evolutions, authentication policy adjustments, payload additions, and deprecation schedules across the indexer route families.

### Route Evolution Guidelines
1. **Additive Schema Updates:** New response properties must be additive and optional/nullable for existing consumers.
2. **Deprecation Window:** Deprecated fields or routes must maintain backwards-compatibility for at least one minor release cycle with documented transition paths.
3. **Authentication Transparency:** Any addition of authentication gates (`X-Operator-Token`, JWT, or session) must be documented with explicit status code expectations (`401 Unauthorized` vs `403 Forbidden`).
4. **Reversibility:** Every route change must have an operator revert strategy preserving previous client contracts if downstream errors emerge.

---

### Seeded Route Families Changelog

#### 1. Listings Route Family (`/listings`, `/listings/:id`, `/listings/:id/history`)
- **Category:** Marketplace Core
- **Authentication:** Public (None).
- **Responses:**
  - Added `priceDecimal` (7-decimal formatted string) alongside raw integer `price` (stroops in i128) to eliminate client-side float division rounding errors.
  - Standardized response list envelope: `{ data: Listing[], total: number, limit: number, offset: number }`.
- **Deprecation Notice:** The use of raw unscaled `price` for direct frontend display is deprecated; clients should adopt `priceDecimal`. Unpaginated listing array responses are deprecated.

#### 2. Auctions Route Family (`/auctions`, `/auctions/:id`, `/auctions/:id/bids`)
- **Category:** Marketplace Auctions
- **Authentication:** Public (None).
- **Responses:**
  - Added `reservePriceDecimal` and `highestBidDecimal` human-readable representations.
  - Added bid timeline cursor pagination support for high-frequency auction listings.
- **Deprecation Notice:** Client reliance on client-side math for `reservePrice` scaling is deprecated in favor of `reservePriceDecimal`.

#### 3. Offers Route Family (`/offers`, `/offers/:id`)
- **Category:** Marketplace Offers
- **Authentication:** Public (None).
- **Responses:**
  - Added `amountDecimal` human-readable representation.
  - Added `expiresAt` optional ledger timestamp field for time-limited offers.
- **Deprecation Notice:** Unfiltered offer queries without a `listing_id` target parameter are deprecated to prevent query cost escalation.

#### 4. Collections Route Family (`/collections`, `/collections/:id`, `/collections/:id/tokens`)
- **Category:** Launchpad & Collections
- **Authentication:** Public (None).
- **Responses:**
  - Standardized collection contract responses (`contractAddress`, `kind`, `creator`, `name`, `symbol`, `deployedAtLedger`).
  - Added support for both `normal_721` and `normal_1155` collection variants.
- **Deprecation Notice:** Legacy non-standard collection kind identifiers are deprecated.

#### 5. Analytics & Royalties Route Family (`/stats`, `/stats/overview`, `/royalties`)
- **Category:** Telemetry & Accounting
- **Authentication:** Public (None); rate-limited.
- **Responses:**
  - Added `totalVolume` and `floorPrice` as exact decimal strings.
  - Added `conversionRate` (0 – 1) and unique user metrics.
- **Deprecation Notice:** Millisecond integer timestamps in stats filters are deprecated in favor of ISO-8601 UTC date strings (`YYYY-MM-DD`).

#### 6. Operational & Audit Route Family (`/audit/logs`, `/audit/export`)
- **Category:** Operator Tools & Security
- **Authentication:** **Protected** — requires `X-Operator-Token` header.
- **Responses:**
  - Structured audit trail JSON and CSV exports.
  - Automatic pseudonymization of wallet addresses (`GCAT…ZXAB`) and redaction of request IDs in compliance with logging policy.
- **Deprecation Notice:** Deprecated unauthenticated diagnostic inspection endpoints.

#### 7. Wallet Notifications Route Family (`/wallets/:address/notifications`)
- **Category:** User Activity Feeds
- **Authentication:** Public wallet address path parameter; rate-limited (20 req/min).
- **Responses:**
  - Paginated notification events categorized by `domain` (`marketplace`, `auction`, `admin`) and `priority` (`HIGH`, `MEDIUM`, `LOW`).
- **Deprecation Notice:** Deprecated polling without domain/priority filters on mobile clients.

---

### Operator & Developer Notes: Route Change Review & Revert

#### Developer Review Procedure
1. Edit Zod schema and route definitions in `indexer/src/api/openapi.ts` and `indexer/src/api/routes.ts`.
2. Regenerate the OpenAPI JSON spec:
   ```bash
   # [DEVELOPER] Regenerate specification
   npm run generate-openapi --prefix indexer
   ```
3. Validate OpenAPI consistency against git:
   ```bash
   # [READ-ONLY] Validate schema parity
   bash scripts/check-openapi.sh
   ```
4. Append a changelog entry in this section specifying: route path, auth requirements, payload delta, and deprecation details.

#### Revert Procedure
If a route modification breaks frontend clients or external indexer consumers:
1. Revert the route code and schema commit:
   ```bash
   git revert <commit-sha>
   ```
2. Re-run spec generation and validation:
   ```bash
   npm run generate-openapi --prefix indexer
   bash scripts/check-openapi.sh
   ```
3. Deploy the rolled-back indexer container.

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
| `/listings` | 10 s | Invalidated on new events |
| `/listings/:id` | 60 s | Invalidated on listing events |
| `/auctions` | 10 s | Invalidated on new events |
| `/auctions/:id` | 5 s | Invalidated on auction events |
| `/collections` | 60 s | Rarely changes |

The full per-route table is in [docs/runbooks/cache-ttl-reference.md](../docs/runbooks/cache-ttl-reference.md). That page is the source of truth and is checked by `src/__tests__/redis-ops-docs.test.ts`. Key prefixes are listed in [docs/runbooks/redis-key-registry.md](../docs/runbooks/redis-key-registry.md). `REDIS_CACHE_TTL_SECONDS` is currently not read by any route.

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

### Run a specific test file

Vitest accepts file paths as positional filters. To run a single test file (e.g., `collection-conformance.test.ts`):

```bash
npm run test -- tests/collection-conformance.test.ts
```

This runs only the tests in that file without requiring a live production endpoint.

### Filter tests by name pattern

Use `--testNamePattern` (short `-t`) to run tests whose full names match a regular expression:

```bash
npm run test -- -t "collections"
```

The test suite uses **Vitest** (configured in `vitest.config.mts` with ESM mode) and **Supertest** for API integration tests. Tests are in `src/__tests__/` and `tests/` and cover the poller, parser, event-sync, API routes, cache middleware, rate limiting, Redis integration, and re-org handling.

---

## Architecture & Debugging Guides

For deeper indexer troubleshooting, schema changes, and ingestion diagnostics, refer to:
- 🏗️ **[Local Architecture](../docs/guides/local-architecture.md)**
- 🔄 **[Indexer Ingestion Guide](../docs/guides/indexer-ingestion.md)**
- 🏷️ **[Event Parsing Guide](../docs/guides/event-parsing.md)**
- 🗄️ **[Database Migrations Guide](../docs/guides/database-migrations.md)**
- 🚀 **[Deployment Guide](../docs/guides/deployment.md)**
- 🛡️ **[Security Triage Guide](../docs/guides/security-triage.md)**

---

## Graceful Shutdown

The indexer handles graceful shutdown gracefully when Kubernetes sends `SIGTERM` or Docker runs `docker stop`. This ensures:

- **No stale polling** — The poller completes its current batch and saves cursor state
- **No open HTTP handlers** — The server drains in-flight requests before closing
- **No incomplete Prisma transactions** — All database transactions commit or rollback cleanly
- **No stale SSE connections** — Connected clients receive a `server-shutdown` event before disconnection

See **[Graceful Shutdown Handling](docs/graceful-shutdown.md)** for:
- Full shutdown sequence documentation
- Kubernetes/Docker timing configuration
- Verification scripts for production operators
- Smoke checks to validate health during termination

---

## Configuration

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
| `STELLAR_NETWORK` | ✅ | `testnet` | **Target network: `testnet` or `mainnet`.** Local development uses `testnet` by default. Mainnet requires intentional deployment configuration. |
| `STELLAR_HORIZON_URL` | ⬜ | `https://horizon-testnet.stellar.org` | Horizon REST API |
| `PORT` | ⬜ | `4000` | HTTP server port |
| `POLL_INTERVAL_MS` | ⬜ | `5000` | Polling interval in milliseconds |
| `CORS_ORIGIN` | ⬜ | — | Comma-separated list of allowed origins (see CORS section) |
| `LOG_LEVEL` | ⬜ | `info` | Minimum log level emitted: `debug` \| `info` \| `warn` \| `error` (see [Logging](#logging)) |
| `LOG_FORMAT` | ⬜ | `json` | `json` for machine-readable logs, `pretty` for colorized human-readable local dev output |
| `SHUTDOWN_TIMEOUT_MS` | ⬜ | `30000` | Seconds to wait for HTTP requests to drain before force-closing. Keep ≥30s in production to allow full drain |

