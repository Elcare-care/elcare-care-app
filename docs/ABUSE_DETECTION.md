# API Abuse Detection & Quotas

Issue: #539

## Why this exists

The per-endpoint rate limiter (`indexer/src/api/rate-limit-middleware.ts`)
protects a single client from hammering a single route. It does not stop a
**distributed** client — many IPs, or many freshly generated wallet
addresses — from concentrating load across the small set of genuinely
expensive route families: full-text search, SSE streaming, wallet activity
lookups, and transaction/history lookups. `indexer/src/api/abuse-detection.ts`
adds a second, coarser layer on top of the existing limiter (not instead of
it) to catch that pattern, plus an operator workflow for temporarily
blocking a specific key.

## How it works

- **Route families.** Every request is classified into one of `search`,
  `sse`, `wallet-activity`, or `tx-lookup`. Each family has its own rolling
  request budget, tracked independently per key.
- **Keys.** A request is keyed the same way the rate limiter keys it: by
  wallet address (`X-Wallet-Address` header or `?wallet=` query) when
  present, otherwise by client IP (respecting `X-Forwarded-For` via
  `express-rate-limit`'s `ipKeyGenerator`, matching the existing limiter's
  proxy handling).
- **Rolling window.** Redis `INCR` + `EXPIRE` per `(family, key)` — a simple
  fixed window, refreshed each time the counter is first touched. This is
  intentionally not exact sliding-window accounting; it only needs to be
  good enough to signal abuse, not to bill for it.
- **Enforcement.** Exceeding a family's budget returns `429` with a
  `Retry-After` header set to the window's remaining TTL, so well-behaved
  clients (including ones that hit the limit through legitimate retries)
  get a clear, actionable signal.
- **Fail open.** If Redis is unreachable, requests are allowed through.
  Abuse detection is a defense-in-depth signal, not a hard dependency — a
  Redis outage should never turn into a blanket outage for legitimate
  traffic. Each fail-open event increments
  `elcarehub_abuse_detection_redis_failures_total` and logs a
  `abuse_detection.redis_unavailable` warning.

## Privacy stance

- **Wallet addresses are public blockchain identifiers, not identity proof.**
  Anyone can already inspect a wallet's on-chain activity; using the address
  as a tracking key adds nothing sensitive. It does **not** prove who
  controls the wallet — one person can hold many wallets, and a wallet can
  be shared or rotated. Treat a wallet key as "this on-chain address," never
  as "this person."
- **Raw IP addresses are never persisted or logged.** Before an IP is used
  as a Redis key or a metric label, it is hashed (`sha256`, truncated to 16
  hex chars) via `hashIp()`. The hash only exists for the lifetime of the
  rolling window or blocklist TTL — nothing about a client's IP persists
  indefinitely.
- **Metric labels carry the *kind* of key only** (`wallet` | `ip_hash`),
  never the key's value. Prometheus/Grafana never accumulate a per-identity
  request history from this feature.

## Configuration

All thresholds are environment-configurable, mirroring the existing
`RATE_LIMIT_*` pattern:

| Variable | Default | Meaning |
|---|---|---|
| `ABUSE_DETECTION_ENABLED` | `true` | Master on/off switch. |
| `ABUSE_QUOTA_SEARCH` | `60` | Requests/min per key for `search`. |
| `ABUSE_QUOTA_SSE` | `30` | Requests/min per key for `sse`. |
| `ABUSE_QUOTA_WALLET_ACTIVITY` | `40` | Requests/min per key for `wallet-activity`. |
| `ABUSE_QUOTA_TX_LOOKUP` | `40` | Requests/min per key for `tx-lookup`. |
| `ABUSE_BLOCK_DURATION_SECONDS` | `900` | Default TTL for an operator block. |

## Operator workflow: temporary blocks

Gated by the same operator-token auth already used for `/admin/*` and
`/reconciliation`, `/backfill`, `/keeper`, `/sync` routes
(`authMiddleware('operator')` in `indexer/src/api/auth-middleware.ts`), which
checks the `X-Operator-Token` header (or `?operator_token=`) against
`OPERATOR_TOKEN`. No new auth mechanism was introduced — this reuses the
existing one.

- `POST /admin/abuse/block` — body `{ key, durationSeconds?, reason? }`.
  `key` is the exact abuse-detection key (`wallet:<address>` or
  `ip:<hash>` — see `GET /admin/abuse/blocklist` or logs for the hashed form).
- `DELETE /admin/abuse/block/:key` — lift a block early.
- `GET /admin/abuse/blocklist` — list all currently active blocks with
  reason and remaining TTL.
- `GET /admin/abuse/block/:key` — check a single key's block status.

A blocked key gets `429` with `Retry-After` and a generic message — the
response deliberately does not explain *why* it was blocked, to avoid
leaking detection thresholds to a probing client.

Blocks are always TTL-bound; there is no permanent ban list. This keeps the
system honest about false positives — a temporary block created in error
self-heals, and a wallet/IP that changes hands isn't punished forever.

## Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `elcarehub_abuse_quota_exceeded_total` | Counter | `route_family`, `key_type` | Requests rejected for exceeding a family budget. |
| `elcarehub_abuse_anomaly_detected_total` | Counter | `route_family`, `key_type`, `reason` | Any abuse signal (`quota_exceeded`, `blocklisted`). |
| `elcarehub_abuse_blocked_requests_total` | Counter | `route_family`, `key_type` | Requests rejected because the key was already blocked. |
| `elcarehub_abuse_blocklist_active` | Gauge | — | Current size of the temporary blocklist. |
| `elcarehub_abuse_detection_redis_failures_total` | Counter | `operation` | Fail-open events, by which check failed. |

## False-positive considerations

- Budgets are deliberately looser than the per-endpoint rate limiter — this
  layer targets distributed abuse across many keys, not a single client's
  burst, which the existing limiter already handles.
- The `Retry-After` header always reflects the real remaining window, so a
  legitimate client that retries after being told to wait succeeds.
- Blocks are operator-initiated and time-bound, not automatic — the
  anomaly metrics are a *signal for a human to review*, not an auto-ban
  trigger, to keep the false-positive blast radius bounded to what an
  operator explicitly chose to enforce.
