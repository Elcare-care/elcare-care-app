# Redis Failure Modes — Surface Behavior Matrix

**Issue:** Reliability, Security, and Operations  
**Owner:** `indexer-team` (rate limiting, caching, SSE, abuse detection); on-call SRE (escalation)  
**Source files inspected:**
- `indexer/src/redis.ts` — connection and reconnect strategy
- `indexer/src/api/cache-middleware.ts` — HTTP response cache
- `indexer/src/api/cache-service.ts` — thundering-herd lock + `getCached()`
- `indexer/src/api/abuse-detection.ts` — quota tracking and blocklist
- `indexer/src/api/rate-limit-middleware.ts` — per-endpoint rate limiting
- `indexer/src/realtime/hub.ts` — SSE fan-out via Redis Streams + Pub/Sub
- `docs/runbooks/redis-outage.md` — incident recovery procedures
- `docs/runbooks/redis-key-registry.md` — key inventory

---

## Purpose

This document answers the question: *"What happens to each Redis-dependent surface when Redis is
unavailable, partially degraded, or just restarted?"* Every surface is documented with its
fail-open behavior, its recovery observation, and the metric that makes the degradation visible.

No production changes are required to implement this document. It is evidence-based: every
behavior described below is derived directly from source code.

---

## Connection Behavior

`indexer/src/redis.ts` creates a single shared client with:

```
disableOfflineQueue: true
reconnectStrategy:   exponential backoff, 50 ms base, capped at 3 000 ms, ±100 ms jitter
```

`disableOfflineQueue: true` means **commands issued while disconnected fail immediately** (they
do not queue up and replay). Each surface must handle that failure itself — and each does, as
documented below.

Reconnection is automatic. The `error` event fires on every failed attempt and logs a `warn`
line:

```
Redis connection error — caching disabled
```

There is no manual intervention needed to reconnect; the client retries on its own schedule.

---

## Surface Behavior Matrix

### 1. HTTP Response Cache (`cache-middleware.ts`)

| State | Behavior |
|---|---|
| **Redis ready** | Cache read on every request. Hit → return cached JSON (possibly 304 if ETag matches). Miss → DB read, write result to Redis with TTL. |
| **Redis unavailable** | `isRedisReady()` returns `false`. Middleware calls `next()` immediately. All requests go to the DB. No error returned to the caller. |
| **Redis error mid-request** | `try/catch` around the `GET` and `SETEX` calls. Any Redis error calls `next()` and falls through to the DB. Cache write failures are logged but do not fail the response. |
| **Fail-open?** | ✅ Yes — requests always succeed via DB fallback. |
| **User-visible impact** | Increased API latency (Redis ~1 ms vs DB 5–50 ms). Visible at P95/P99 (`elcarehub_api_request_duration_seconds`). |
| **Data correctness** | ✅ Not affected — DB is the source of truth. |

**Observation metrics:**
- `elcarehub_cache_hits_total{resource}` stops incrementing
- `elcarehub_cache_misses_total{resource}` spikes
- `elcarehub_cache_bypass_total{resource}` increments when Redis is not ready
- `elcarehub_api_request_duration_seconds` p95/p99 increases

**Recovery:** Automatic. As soon as `isRedisReady()` returns `true`, the next request re-warms
the cache for its key. Full cache warmup typically completes within 5–10 minutes of normal traffic.

---

### 2. Thundering-Herd Lock / `getCached()` (`cache-service.ts`)

The distributed lock uses `SET NX PX` on a `lock:<cache-key>` Redis key (default 31 s TTL) to
coalesce concurrent cache misses for the same key into a single DB query.

| State | Behavior |
|---|---|
| **Redis ready** | First request acquires the lock and executes the DB query. Concurrent requests await the result without hitting the DB. |
| **Redis unavailable** | The `distributed: true` lock path falls back to the in-process `inflight` Map (a `Map<string, Promise<T>>`). Within a single process instance concurrent misses are still coalesced. Across multiple pods, coalescing does not happen — each pod makes its own DB query on a miss. |
| **Fail-open?** | ✅ Yes — the query always executes. The distributed lock degrades to per-process coalescing. |
| **User-visible impact** | Under high concurrent load with multiple pods: temporary DB query fan-out on cache misses. Bounded by pod count × miss rate. |
| **Data correctness** | ✅ Not affected. |

**Observation metrics:**
- `elcarehub_cache_bypass_total{resource}` (lock path skipped)

---

### 3. Rate Limiting (`rate-limit-middleware.ts`)

The per-endpoint rate limiter uses `express-rate-limit` with its **default in-memory store**.
Redis is **not used** by this layer.

| State | Behavior |
|---|---|
| **Redis unavailable** | No impact. Rate limiting continues to function normally, per process. |
| **Fail-open?** | N/A — not Redis-dependent. |
| **Notes** | Limits are per-instance. A client behind multiple pods sees `N × max` effective limit, where `N` is the pod count. This is an existing architectural property, not a Redis failure artifact. |

**Observation metrics:** none Redis-specific.

---

### 4. SSE Fan-out (`realtime/hub.ts`)

The `RealtimeHub` uses Redis in two ways:

| Path | Redis usage |
|---|---|
| **Publish** | `XADD sse:events` (durable replay window, capped at 1 000 entries) + `PUBLISH sse:events:pub` (fan-out to all pods) |
| **Subscribe** | `SUBSCRIBE sse:events:pub` on a dedicated duplicate connection with auto-reconnect |
| **Replay** | `XRANGE sse:events` from `Last-Event-ID` to `+` |

**When Redis is unavailable:**

| Sub-path | Degraded behavior |
|---|---|
| **Publish** | `redisUsable()` returns `false` or `XADD`/`PUBLISH` throws → `sseRedisPublishFailuresTotal.inc()` → `sseDegradedFallbackTotal.inc()` → event written to the in-memory ring buffer (default 200 events) and fanned out to local clients only. `hub.degraded = true`. |
| **Multi-pod fan-out** | Only clients connected to the pod that ingested the event receive it. Clients on other pods miss it until they reconnect and get a REST refresh. |
| **Replay (`Last-Event-ID`)** | Redis `XRANGE` unavailable → replay falls back to the in-memory ring buffer (last 200 events). Events older than the ring buffer are lost to reconnecting clients. The client receives `: resume-not-durable\n\n` as a comment before the first live event, signaling that the replay horizon is limited. |
| **Subscriber reconnect** | The subscriber uses a `scheduleResubscribe()` loop with `reconnectDelayMs` (default 1 s). It retries indefinitely. `sseSubscriberReconnectsTotal.inc()` on each reconnect attempt. |
| **Fail-open?** | ✅ Yes — existing connected clients continue receiving events (single-pod delivery only). No requests are rejected. |

**User-visible impact:**
- Reconnecting SSE clients may miss events that arrived while they were disconnected and Redis was down (replay window is limited to the in-memory ring).
- In a multi-pod deployment, users whose pod did not process an event will not receive it until they reload the page and fetch current state from the REST API.
- Clients receive a `: resume-not-durable` comment in the event stream, which the frontend should treat as a signal to do a full REST refresh.

**Data correctness:** ✅ Not affected. The REST API reads from PostgreSQL, which is unaffected.

**Observation metrics:**
- `elcarehub_sse_redis_publish_failures_total` — spikes on Redis failure
- `elcarehub_sse_degraded_fallback_total` — counts events delivered via in-memory ring
- `elcarehub_sse_subscriber_reconnects_total` — counts reconnect attempts
- `hub.degraded` flag (accessible via `/health/details` if surfaced)

**Recovery:** When Redis reconnects, `redisUsable()` returns `true` on the next publish. `XADD` and `PUBLISH` resume. The subscriber re-attaches and fan-out becomes multi-pod again. `hub.degraded` resets to `false` on the next successful publish. No manual action needed.

---

### 5. Abuse Detection — Quota Tracking (`abuse-detection.ts`)

Per-route-family rolling request budgets stored as `abuse:quota:<family>:<subject>` keys with a 60 s TTL.

| State | Behavior |
|---|---|
| **Redis ready** | `INCR` + `EXPIRE` on each request within a route family. Requests exceeding the budget receive HTTP 429. |
| **Redis unavailable** | `isRedisReady()` returns `false` → `failOpen()` called → `abuseDetectionRedisFailureTotal.labels('quota_check').inc()` → `next()` called, request proceeds. The budget is not tracked for this request. |
| **Redis error mid-increment** | `try/catch` around quota operations → `failOpen()` → `next()`. |
| **Fail-open?** | ✅ Yes — requests always proceed. The quota enforcement window is effectively paused for the duration of the outage. |
| **Security implication** | An attacker who knows Redis is down can exceed normal quotas without hitting 429. For the duration of a Redis outage, the per-endpoint in-memory rate limiter (`rate-limit-middleware.ts`) is the sole defense. That limiter remains functional because it does not use Redis. |

**Observation metrics:**
- `elcarehub_abuse_detection_redis_failures_total{operation="quota_check"}` — increments on every bypassed check
- `elcarehub_abuse_quota_exceeded_total` — stops incrementing (no checks enforced)

---

### 6. Abuse Detection — Blocklist (`abuse-detection.ts`)

Operator-managed temporary blocklist stored as `abuse:block:<subject>` keys with configurable TTL (default 900 s).

| State | Behavior |
|---|---|
| **Redis ready** | `TTL abuse:block:<key>` check on every request within a monitored route family. Blocked keys receive HTTP 429 with `Retry-After`. |
| **Redis unavailable on `isBlocked()`** | `isRedisReady()` returns `false` → `failOpen('is_blocked', ...)` → returns `{ blocked: false, ttlSeconds: 0 }` → request proceeds. All blocked keys are effectively unblocked for the duration of the outage. |
| **Redis unavailable on `blockKey()` / `unblockKey()`** | These operator-action functions **throw** (not fail-open), because an attended admin operation should return an explicit error rather than silently doing nothing. The admin API will return 500. |
| **Fail-open?** | ✅ Yes for passive checks. ❌ Explicit error for operator write operations. |
| **Security implication** | Clients that were manually blocked can bypass the blocklist during an outage. The in-memory per-endpoint rate limiter still applies. |

**Observation metrics:**
- `elcarehub_abuse_detection_redis_failures_total{operation="is_blocked"}` — increments on each bypassed blocklist check
- `elcarehub_abuse_blocked_requests_total` — stops incrementing (blocklist not enforced)
- `elcarehub_abuse_blocklist_active` — may become stale (gauge not updated during outage)

---

## Summary: Fail-Open vs Fail-Closed

| Surface | Redis down → | Effect |
|---|---|---|
| HTTP response cache | Fail-open (DB fallback) | Higher API latency only |
| Thundering-herd lock | Fail-open (per-process coalescing) | Possible DB fan-out under heavy concurrent load |
| Per-endpoint rate limiting | **Not Redis-dependent** | No effect |
| SSE fan-out (publish) | Fail-open (in-memory ring, local delivery only) | Reconnecting clients may miss events; multi-pod clients miss cross-pod events |
| SSE replay | Fail-open (in-memory ring, last 200 events) | Events older than ring buffer are unrecoverable for reconnecting clients |
| Abuse detection — quota | Fail-open (quota not enforced) | Quota protection paused; in-memory rate limiter still active |
| Abuse detection — blocklist (passive) | Fail-open (blocked clients allowed) | Operator-blocked clients bypass the block during outage |
| Abuse detection — blocklist (write) | **Fail-closed** (throws 500) | Admin block/unblock operations fail explicitly |

**No surface affects funds, smart contract state, or data integrity in PostgreSQL.**

---

## Recovery Observation Checklist

After Redis comes back online, verify each surface has recovered:

```bash
# 1. Redis is reachable
redis-cli -u "$REDIS_URL" PING
# Expected: PONG

# 2. Indexer has reconnected (log line)
docker compose logs indexer --tail=30 | grep -i redis
# Expected: "Redis reconnected" or no further "connection error" entries

# 3. Health endpoint reports Redis healthy
curl http://localhost:4000/health | jq '.checks.redis'
# Expected: {"status": "ok"}

# 4. Cache hit rate recovering (wait 1–5 minutes of traffic)
curl -s http://localhost:4000/metrics | grep elcarehub_cache_hits_total
# Expected: incrementing (not stuck at a fixed value)

# 5. SSE degraded fallback counter stopped growing
curl -s http://localhost:4000/metrics | grep elcarehub_sse_degraded_fallback_total
# Expected: flat (not incrementing) once Redis is back

# 6. Abuse detection Redis failures stopped growing
curl -s http://localhost:4000/metrics | grep elcarehub_abuse_detection_redis_failures_total
# Expected: flat once Redis is back

# 7. Abort any in-flight admin block/unblock that failed — retry once Redis is healthy
```

---

## Configuration Reference

| Variable | Surface | Default | Notes |
|---|---|---|---|
| `REDIS_URL` | All | `redis://localhost:6379` | Connection string |
| `ABUSE_DETECTION_ENABLED` | Abuse detection | `true` | Set to `false` to disable quota + blocklist entirely |
| `ABUSE_BLOCK_DURATION_SECONDS` | Blocklist | `900` | TTL for operator-added blocks |
| `ABUSE_QUOTA_SEARCH` | Quota (search) | `60` req/60 s | Per-key rolling budget |
| `ABUSE_QUOTA_SSE` | Quota (SSE) | `30` req/60 s | Per-key rolling budget |
| `ABUSE_QUOTA_WALLET_ACTIVITY` | Quota (wallet-activity) | `40` req/60 s | Per-key rolling budget |
| `ABUSE_QUOTA_TX_LOOKUP` | Quota (tx-lookup) | `40` req/60 s | Per-key rolling budget |
| `SSE_STREAM_MAXLEN` | SSE replay | `1 000` | Max events in `sse:events` Redis Stream |

---

## Owner, Trigger, Rollback

| Field | Value |
|---|---|
| **Owner** | `indexer-team`; escalation → on-call SRE → Backend Lead |
| **Trigger** | Redis health check failure (`GET /health → checks.redis.status = "down"`) or Prometheus metric `elcarehub_sse_degraded_fallback_total` / `elcarehub_abuse_detection_redis_failures_total` increasing at rest |
| **Expected output after recovery** | All metrics in the Recovery checklist above return to baseline within 5–10 minutes of normal traffic |
| **Rollback** | This is documentation only. `git revert <commit>` removes it with no runtime effect. |

---

## Related

- [redis-outage.md](./redis-outage.md) — incident recovery procedures (restart, OOM, connection limits)
- [redis-key-registry.md](./redis-key-registry.md) — complete inventory of Redis key shapes and TTLs
- `indexer/src/redis.ts` — connection and reconnect strategy
- `indexer/src/realtime/hub.ts` — SSE fan-out implementation
- `indexer/src/api/abuse-detection.ts` — quota and blocklist implementation
- `indexer/src/api/cache-middleware.ts` — HTTP response cache implementation
