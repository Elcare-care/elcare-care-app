# Indexer API Consumer Guide

How to build reliable clients against the ElcareHub indexer REST + SSE API. This guide complements [indexer/README.md](../../indexer/README.md) and the [OpenAPI spec](../../indexer/openapi.yaml).

**Reference implementation:** [`frontend/elcarehub-app/src/lib/indexer.ts`](../../frontend/elcarehub-app/src/lib/indexer.ts)

**Related:** [sse-protocol.md](../sse-protocol.md) · [payment-tokens.md](./payment-tokens.md) · [reorganization.md](../runbooks/reorganization.md)

---

## 1. Authentication

| Policy | Routes | Credential |
|--------|--------|------------|
| **Public** | `/listings`, `/auctions`, `/offers`, `/collections`, `/activity/*`, `/events` (SSE), `/health` | None |
| **Authenticated** | `/artists/*`, wallet-scoped stats | Optional `X-Wallet-Address` header or `?wallet=` query |
| **Operator** | `/admin/*`, backfill, reconciliation | `Authorization: Bearer <OPERATOR_TOKEN>` |

Operator tokens are server-side secrets — never embed in browser code. The frontend uses only public + authenticated routes.

Example (server-side script):

```bash
curl -s -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "$INDEXER_URL/admin/sync-status"
```

Unauthorized operator calls return structured errors with `requestId`, `code`, and `class` fields (see §10).

---

## 2. Version negotiation

Every response includes:

```
X-API-Version: 1.0.0
```

Compare against your client's supported range at startup. The OpenAPI `info.version` and `versions.toml` → `components.indexer.api_version` must match (CI: `scripts/validate-compatibility.sh`).

**Client rule:** Log version mismatches; degrade gracefully — do not assume undocumented fields exist on older servers.

---

## 3. Pagination & cursors

List endpoints accept `page` + `limit` (defaults vary by route). Activity/history endpoints may return `hasMore: true`.

```bash
curl -s "$INDEXER_URL/listings?page=1&limit=20"
```

For large backfills prefer incremental polling by `lastIndexedLedger` from `/health` rather than deep pagination.

---

## 4. Rate limits & Retry-After

Global and per-route rate limiters apply. Responses may include:

```
RateLimit-Limit: 100
RateLimit-Remaining: 42
RateLimit-Reset: 1710000000
```

On **429 Too Many Requests**:

```
Retry-After: 30
```

**Client algorithm:**

1. Honor `Retry-After` (seconds) when present.
2. Otherwise exponential backoff: 500 ms → 1 s → 2 s (cap 30 s).
3. Do not retry non-idempotent operator mutations without idempotency keys.

SSE connections have a separate concurrency guard; excess connections receive 429 with `Retry-After: 30`.

See `indexer/src/api/rate-limit-middleware.ts` and tests in `indexer/tests/rate-limit-middleware.test.ts`.

---

## 5. Cache validation (ETag)

GET responses for stable resources (e.g. `GET /listings/:id`) include an `ETag` header.

```bash
# First fetch
ETAG=$(curl -sI "$INDEXER_URL/listings/42" | grep -i etag | awk '{print $2}' | tr -d '\r')

# Conditional fetch
curl -s -o /dev/null -w "%{http_code}" \
  -H "If-None-Match: $ETAG" \
  "$INDEXER_URL/listings/42"
# → 304 when unchanged
```

**Client rule:** Store ETag per resource; use conditional GET for polling loops to save bandwidth. After any SSE mutation event for that resource, invalidate local ETag and refetch.

Tests: `indexer/src/__tests__/compression-etag.test.ts`, `indexer/tests/openapi-runtime-contract.test.ts`.

---

## 6. BigInt strings & decimal fields

JSON cannot safely represent i128 values. All large integers serialize as **decimal strings**:

```json
{
  "listingId": "42",
  "price": "100000000",
  "priceDecimal": "10.0000000",
  "endTime": "1710000000000"
}
```

**Rules:**

- Parse money IDs with `BigInt(value)` or decimal-string libraries — never `parseFloat` on base-unit fields.
- Display user-facing amounts from `*Decimal` siblings or compute with token decimals ([payment-tokens.md](./payment-tokens.md)).
- `price` in OpenAPI examples may show human form in some schemas; trust the live API's raw + `Decimal` pair from `/listings/:id`.

---

## 7. SSE connection & reconnection

Endpoint: `GET /events` (`text/event-stream`)

Wire format: [sse-protocol.md](../sse-protocol.md)

### Initial connect

```typescript
const es = new EventSource(`${INDEXER_URL}/events`);
es.onmessage = (e) => { /* parse e.data */ };
```

### Resume with cursor

Pass the last seen id on reconnect:

```typescript
// Browser EventSource replays Last-Event-ID automatically when set on prior connection
const es = new EventSource(`${INDEXER_URL}/events`, {
  /* Note: standard EventSource sets Last-Event-ID from last message */
});
```

Or explicitly (fetch-based clients):

```bash
curl -N -H "Last-Event-ID: 1042" "$INDEXER_URL/events"
```

### Reset events

When the ring buffer (default 200 events) cannot replay your cursor:

```
event: reset
data: {"reason":"cursor_too_old","since":"42"}
```

**Client action:** Treat as hard reset — refetch all subscribed state from REST. Do not attempt to merge partial SSE history.

Reference: `subscribeToMarketplaceEvents()` in `lib/indexer.ts` — exponential backoff reconnect, `Last-Event-ID` tracking, reset handling.

### Heartbeats

Comment frames `: heartbeat` every 30 s — ignore for UI, use as keep-alive.

---

## 8. Reorg & CRITICAL_REORG flows

When the poller detects a ledger hash mismatch, it rolls back affected rows and may emit:

```
event: CRITICAL_REORG
data: {"depth":N,"safeLedger":L}
```

**Client action:**

1. Refetch all visible listings/auctions/offers from REST.
2. Clear provisional/optimistic UI state ([useReconciliation.ts](../../frontend/elcarehub-app/src/hooks/useReconciliation.ts)).
3. Show non-blocking reorg notice ([ReorgNotifier.tsx](../../frontend/elcarehub-app/src/components/ReorgNotifier.tsx)).

Deep reorgs: see [reorganization.md](../runbooks/reorganization.md).

---

## 9. Provisional events & confirmation semantics

The indexer reflects **confirmed** ledger state only. There is no mempool stream.

**Frontend provisional pattern** (Issue #302): After a wallet submits a tx, UI enters provisional state until SSE/REST shows the matching event.

| Phase | Source | Consumer behavior |
|-------|--------|-------------------|
| Submitted | Wallet | Show pending spinner; do not treat as confirmed |
| Indexed | SSE `LISTING_CREATED`, etc. | Merge into canonical state |
| Reorged | `CRITICAL_REORG` / rollback | Revert provisional; refetch |

SSE events are ordered and deduplicated server-side (`indexer/src/__tests__/issue-443-api-sse-auth.test.ts`).

**Freshness metadata:** The frontend attaches `FreshnessMetadata` (`lastIndexedLedger`, `fetchedAt`, `indexerUpdatedAt`) and uses `isDataStale()` before sensitive actions (purchase, bid).

---

## 10. Error handling

Error JSON shape:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Listing not found",
    "class": "client",
    "requestId": "req_abc123"
  }
}
```

Log `requestId` with user reports. Classify:

- `class: client` — do not retry without fixing input
- `class: server` — retry with backoff
- `429` — honor Retry-After

---

## 11. Failure scenarios (quick reference)

| Scenario | HTTP / SSE signal | Client response |
|----------|-------------------|-----------------|
| Stale listing price | `isDataStale()` true | Refetch `/listings/:id` before checkout |
| Indexer down | Connection error | Show stale banner; block settlement |
| Rate limited | 429 + Retry-After | Backoff and retry GETs only |
| SSE cursor too old | `event: reset` | Full REST resync |
| Chain reorg | `CRITICAL_REORG` | Refetch + clear provisional state |
| Unsupported payment token | Listing has token not in `/tokens` | Disable purchase; show unsupported message |

---

## 12. Examples (no real credentials)

```bash
export INDEXER_URL=http://localhost:4000

# Health + version
curl -s "$INDEXER_URL/health" | jq '{status, lastIndexedLedger}'
curl -sI "$INDEXER_URL/listings" | grep -i x-api-version

# Paginated listings with decimal amounts
curl -s "$INDEXER_URL/listings?limit=5" | jq '.[0] | {listingId, price, priceDecimal, token}'

# Conditional GET
ETAG=$(curl -sI "$INDEXER_URL/listings/1" | grep -i etag | awk '{print $2}' | tr -d '\r')
curl -s -H "If-None-Match: $ETAG" -w "\nHTTP %{http_code}\n" "$INDEXER_URL/listings/1"

# SSE (5 s sample)
curl -N -m 5 -H "Accept: text/event-stream" "$INDEXER_URL/events"
```

Integration test fixtures: `indexer/tests/openapi-runtime-contract.test.ts`, `indexer/src/__tests__/api.test.ts`.

---

## 13. CI & compatibility

Before releasing a client:

```bash
bash scripts/validate-compatibility.sh
bash scripts/check-openapi.sh
npm run test:indexer
```

Ensure your client version appears in `COMPATIBILITY.md` valid combinations.
