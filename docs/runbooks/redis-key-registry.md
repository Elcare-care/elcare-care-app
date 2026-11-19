# Redis Key Registry

**Issue:** #1061 · **Audience:** operators and indexer contributors · **Scope:** documentation only (no runtime change)

Redis is shared by four indexer features: the HTTP response cache, the
thundering-herd lock, abuse detection, and SSE fan-out. This page is the
single inventory of every key shape the indexer writes, so new keys do not
collide with old ones and TTL inspection is predictable.

All values below were taken from source in this repository. If code and this
page disagree, the code wins — fix this page in the same PR.
`indexer/src/__tests__/redis-ops-docs.test.ts` fails when a listed prefix
disappears from source.

---

## 1. Registry

| Prefix / key | Redis type | Example | TTL | Written by | Read / deleted by |
|---|---|---|---|---|---|
| `cache:<request path + query>` | STRING (JSON) | `cache:/listings/42`, `cache:/listings?status=Active&limit=20&offset=0` | Per route, see [cache-ttl-reference.md](./cache-ttl-reference.md) | `indexer/src/api/cache-middleware.ts` (`setEx`), `indexer/src/cache-warmer.ts` | `cache-middleware.ts` (GET); deleted by `indexer/src/poller.ts`, `indexer/src/cache-invalidation.ts`, `indexer/src/token-metadata.ts` |
| `activity:recent` | STRING (JSON) | `activity:recent` | 30 s (`TTL.ACTIVITY_RECENT`) | `getCached()` in `indexer/src/api/cache-service.ts`, called from `GET /activity/recent` | same |
| `collection_fee:<collection address>` | STRING (JSON) | `collection_fee:CABC…` | 30 s (literal in `GET /collections/:address/fee`) | `getCached()` via `indexer/src/api/routes.ts` | same |
| `lock:<cache key>` | STRING (`"1"`) | `lock:activity:recent` | `CACHE_FETCH_TIMEOUT_MS` + 1000 ms (default 31 000 ms), set with `NX PX` | `indexer/src/api/cache-service.ts` (only when `distributed: true`) | same (`EXISTS`, `DEL`) |
| `abuse:quota:<family>:<subject>` | STRING (counter) | `abuse:quota:search:ip:3f2a9c0d1e4b5a67` | 60 s window, set by `EXPIRE` on first `INCR` | `indexer/src/api/abuse-detection.ts` | same |
| `abuse:block:<subject>` | STRING (reason) | `abuse:block:wallet:GABC…` | `ABUSE_BLOCK_DURATION_SECONDS` (default 900 s), set with `EX` | `abuse-detection.ts` via `POST /admin/abuse/block` | `GET/DELETE /admin/abuse/block/:key`, `GET /admin/abuse/blocklist` |
| `sse:events` | STREAM | `sse:events` | None. Length capped by `XADD MAXLEN ~ SSE_STREAM_MAXLEN` (default 1000) | `indexer/src/realtime/hub.ts` (`XADD`) | `hub.ts` (`XRANGE` for `Last-Event-ID` replay) |
| `sse:events:pub` | Pub/Sub channel (not a key) | `sse:events:pub` | n/a | `hub.ts` (`PUBLISH`) | `hub.ts` subscriber (`redis.duplicate()`) |

`<family>` is one of `search`, `sse`, `wallet-activity`, `tx-lookup`.
`<subject>` is `wallet:<G… address>` or `ip:<16 hex chars>`. IP subjects are
always a truncated SHA-256 hash (`hashIp()`), never a raw IP.

### Not in Redis

These look like Redis keys in source but are kept in process memory:

- **Per-endpoint rate limits** (`indexer/src/api/rate-limit-middleware.ts`):
  `express-rate-limit` with its default in-memory store. The `wallet:…` /
  `ip:…` strings there are store keys, not Redis keys. Limits are per instance.
- **SSE concurrency counts** (`sseConnectionCounts` Map in the same file).
- **In-flight cache coalescing** (`inflight` Map in `cache-service.ts`).

### Known inconsistencies (recorded, not changed here)

1. `buildCacheKey()` / `buildCachePattern()` in `cache-invalidation.ts`
   produce shapes such as `cache:listing:42*`, and `token-metadata.ts` deletes
   `cache:listing:*`, `cache:auction:*` and `cache:offer:*`. No current writer
   produces keys in that `cache:<kind>:<id>` form. The middleware writes
   URL-shaped keys (`cache:/listings/42`), and the poller deletes those
   directly. Those patterns delete nothing today. They are harmless, but do
   not rely on them.
2. `getCached()` keys (`activity:recent`, `collection_fee:*`) have **no**
   `cache:` prefix. Because of that, `cache:*` invalidation patterns never
   reach them, and they expire only by TTL.
3. `abuse-detection.ts` lists keys with `KEYS abuse:block:*`, and
   `invalidateCache()` in `cache-middleware.ts` uses `KEYS` too. Use `SCAN`
   in anything new (as `invalidatePattern()` in `indexer/src/redis.ts` does).

---

## 2. Naming convention for new keys

1. `<feature>:<sub-namespace>:<identifier>`, lowercase, `:`-separated.
   Use one of the existing top-level namespaces (`cache`, `lock`, `abuse`,
   `sse`) or add a new one to the table above.
2. HTTP response cache entries go through `cacheMiddleware()` and therefore
   start with `cache:/`. Programmatic `getCached()` keys should start with
   `cache:` as well, so pattern invalidation can reach them.
3. Every key except the SSE stream **must** have a TTL (`EX`/`PX`/`setEx`).
   Unbounded keys need a length cap (like `MAXLEN`) and a line in this table.
4. Never embed raw PII (IP addresses, emails, tokens) in a key. Wallet
   addresses are public chain identifiers and are allowed. Hash anything else.
5. Define the prefix once as a constant next to the code that owns it
   (for example `QUOTA_PREFIX`, `BLOCK_PREFIX`, the `streamKey` default).

---

## 3. Read-only inspection commands

> **READ-ONLY.** Every command here only reads. Do not run `DEL`, `FLUSHDB`,
> `FLUSHALL`, `EXPIRE`, or `KEYS` against production. `KEYS` blocks the
> server; use `SCAN`.

```bash
# READ-ONLY — count keys per top-level namespace (SCAN is non-blocking)
redis-cli -u "$REDIS_URL" --scan --pattern 'cache:*'        | wc -l
redis-cli -u "$REDIS_URL" --scan --pattern 'abuse:quota:*'  | wc -l
redis-cli -u "$REDIS_URL" --scan --pattern 'abuse:block:*'  | wc -l

# READ-ONLY — find keys that have no TTL (TTL == -1). Expect only sse:events.
# One round-trip per key: run against local/staging, or narrow --pattern in prod.
redis-cli -u "$REDIS_URL" --scan --pattern '*' | while read -r k; do
  t=$(redis-cli -u "$REDIS_URL" TTL "$k"); [ "$t" = "-1" ] && echo "NO TTL: $k"
done

# READ-ONLY — remaining TTL and type for one key
redis-cli -u "$REDIS_URL" TYPE 'cache:/listings/42'
redis-cli -u "$REDIS_URL" TTL  'cache:/listings/42'

# READ-ONLY — SSE replay window size
redis-cli -u "$REDIS_URL" XLEN sse:events
```

In local compose, run the same commands with
`docker compose -f indexer/docker-compose.yml exec redis redis-cli …`.

---

## 4. Review checklist (PRs that add or change Redis usage)

- [ ] The new key or prefix is in the registry table above, with type, TTL, writer and reader.
- [ ] The prefix is a named constant, not an inline string repeated across files.
- [ ] The key has a TTL, or an explicit length cap that is documented here.
- [ ] No raw IP, email, secret or session token appears in the key or the value.
- [ ] Any pattern deletion uses `SCAN` (`invalidatePattern()`), not `KEYS`.
- [ ] Invalidation patterns match the shape that is actually written (see Known inconsistency 1).
- [ ] The TTL is reflected in [cache-ttl-reference.md](./cache-ttl-reference.md) if it is a response cache.
- [ ] Any new env var is in `indexer/.env.example` with its default.
- [ ] `cd indexer && npx vitest run src/__tests__/redis-ops-docs.test.ts` passes.

---

## 5. Reviewing and reverting this page

- **Review:** for each table row, open the named file and confirm the prefix
  constant and TTL. Then run the focused test above.
- **Revert:** this is documentation plus one static test. `git revert <commit>`
  removes it with no runtime effect. No data, keys, or config are touched.
