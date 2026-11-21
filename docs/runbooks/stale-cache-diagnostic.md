# Stale Cache Diagnostic (Redis vs PostgreSQL)

**Issue:** #1060 · **Severity:** LOW (diagnostic) · **Mutates data:** No

Use this runbook when a user reports that a listing or auction looks out of
date ("I cancelled it but it still shows Active"). It checks whether the
Redis-cached response differs from the PostgreSQL row, without changing
either one.

> **Every step on this page is READ-ONLY** except the optional step 4b, which
> is clearly marked and requires an operator decision.

Related: [redis-key-registry.md](./redis-key-registry.md) ·
[cache-ttl-reference.md](./cache-ttl-reference.md) ·
[admin-read-only-diagnostic.md](./admin-read-only-diagnostic.md) ·
[stalled-ingestion.md](./stalled-ingestion.md)

---

## How caching works for detail routes

| Route | Redis key | TTL | Invalidated when |
|---|---|---|---|
| `GET /listings/:id` | `cache:/listings/<id>` | 60 s | The poller ingests an event for that listing (`invalidateKey` in `indexer/src/poller.ts`) |
| `GET /auctions/:id` | `cache:/auctions/<id>` | 5 s | The poller ingests an event for that auction |

The key is the exact request path plus query string (`req.originalUrl`). A
request with a query string such as `/listings/42?x=1` gets its own key, and
the poller does **not** invalidate it by exact name. Use the `SCAN` in step 2
to find such variants.

A mismatch is therefore expected for at most one TTL after a write. If it
lasts longer, invalidation was missed (for example, Redis was briefly
unreachable when the event was ingested; invalidation failures are logged
and are non-fatal).

---

## Step 1 — Confirm the indexer has ingested the change (READ-ONLY)

If PostgreSQL itself is behind the chain, the cache is not the problem.

```bash
# READ-ONLY
curl -s "$INDEXER_URL/health" | jq '{status, sync_lag: .checks.sync_lag}'
```

If `sync_lag.status` is not `ok`, use the [poller health checklist](./poller-health-checklist.md) instead.

## Step 2 — Locate the cache entries (READ-ONLY)

```bash
# READ-ONLY — SCAN is non-blocking; do not use KEYS in production
redis-cli -u "$REDIS_URL" --scan --pattern 'cache:*listings/42*'
redis-cli -u "$REDIS_URL" TTL 'cache:/listings/42'
```

## Step 3 — Compare identifiers and timestamps (READ-ONLY)

```bash
# READ-ONLY — issues only Redis GET/TTL/EXISTS and one PostgreSQL SELECT
# in a default_transaction_read_only session
REDIS_URL=... DATABASE_URL=... \
  scripts/diagnostics/compare-cache-vs-db.sh listing 42
```

Example output:

```text
cache_key=cache:/listings/42 present=true ttl_seconds=37 sync_last_ledger=1005
source   id           status       updatedAtLedger    updatedAt
redis    42 Active 1000 2026-11-19T10:00:00.123Z
postgres 42 Cancelled 1003 2026-11-19T10:00:16.871Z
RESULT: MISMATCH. The cache is stale for up to 37s more. ...
```

| Exit | Meaning |
|---|---|
| 0 | Match, or no cache entry (reads go straight to PostgreSQL) |
| 1 | Mismatch. The cached `status`, `updatedAtLedger` or `updatedAt` differs from PostgreSQL |
| 2 | Usage error or missing tool (`redis-cli`, `psql`, `jq`) |

The script prints only id, status, ledger numbers and timestamps. It never
prints wallet addresses, metadata, or connection strings. Do not paste
`DATABASE_URL` or `REDIS_URL` into tickets.

For local compose, run the tools inside the containers, or point the
script at the published ports (`redis://localhost:6379`,
`postgresql://postgres:<local password>@localhost:5432/marketplace_indexer`).

## Step 4 — Decide

| Observation | Action |
|---|---|
| Match | Not a cache issue. Check the frontend or the chain itself. |
| Mismatch, `ttl_seconds` ≤ route TTL, and `updatedAtLedger` in PostgreSQL is recent | Expected window. Wait one TTL and re-run step 3. |
| Mismatch persists after one full TTL | Invalidation was missed. Check logs for `Redis invalidateKey failed` / `cache.invalidation_failed` and the `elcarehub_cache_invalidation_failures_total` metric. |
| `postgres <row not found>` | The row was rolled back (reorg) or never ingested. See [reorganization.md](./reorganization.md). |

### 4b — Optional remediation (WRITES TO REDIS, operator decision)

Deleting a single response-cache key is safe because the next request
re-reads PostgreSQL. It is still a write, so record it in the incident log.

```bash
# MUTATING — deletes one cache key only. Never use FLUSHDB/FLUSHALL.
redis-cli -u "$REDIS_URL" DEL 'cache:/listings/42'
```

Waiting for the TTL to expire is always an acceptable alternative.

---

## Review and revert

- **Review:** run the script against local compose for a known id and confirm
  the output matches `GET /listings/<id>`. Run `bash -n
  scripts/diagnostics/compare-cache-vs-db.sh` for a syntax check.
- **Revert:** `git revert <commit>` removes this page and the script. Neither
  is wired into the running service.
