# 400 and 429 Response Examples

> Issue #1059 · Every example below was **captured by running the real middleware**
> (`errors.ts`, `query-schemas.ts`, `cursor.ts`, `query-cost.ts`, `rate-limit-middleware.ts`,
> `request-id-middleware.ts`) in a throwaway Express app with `supertest`. None were written by hand.
> The capture procedure is in §6. Last reviewed against `main` @ `a5746a7` (Zod 4.4.3, express-rate-limit, draft-6 headers).

Related: [endpoint-matrix.md](./endpoint-matrix.md) · [pagination-defaults.md](./pagination-defaults.md)

`requestId` values are the fixed test value `req-example-0001`. In production they echo the inbound `X-Request-Id` or a server-generated UUID. Client keys are shown in IETF documentation ranges (`203.0.113.0/24`) or as placeholder G-addresses.

---

## 1. The standard error envelope

Every error that reaches `errorHandler` (`src/api/errors.ts`) returns this shape:

```jsonc
{
  "error": {
    "code": "BAD_REQUEST",          // stable; branch on this, not on message
    "message": "…",                 // human-readable, passed through redactString()
    "class": "CLIENT_ERROR",        // CLIENT_ERROR (4xx) | SERVER_ERROR (5xx)
    "requestId": "…",               // present when request-id middleware ran
    "retryable": false,             // always present
    "retryAfterSeconds": 60,        // only when retryable
    "details": { … }                // only for 4xx, passed through redact()
  }
}
```

The `X-Request-Id` response header carries the same `requestId`. When `retryable` is true, a `Retry-After` header is also set.

> ⚠ **Not every 429 uses this envelope.** The per-route rate limiters write their own body. See §3.

---

## 2. 400 examples

### 2.1 Query validation via `validateQuery(...)`

Used by `/listings`, `/auctions`, `/offers`, `/collections`, `/creators/:address/collections`, `/collections/:address/tokens`, `/wallets/:address/activity`, `/wallets/:address/royalty-breakdown`, `/stats`, `/artists/:address/metrics`, `/search`, `/events` and `/sync/gaps`.

The message is `"<field>: <zod message>"`. Several failures are joined with `"; "`. **No `details` object is included.** Clients have to read `message` to find the field.

`GET /listings?limit=101`
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "limit: Too big: expected number to be <=100",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

`GET /listings?status=Foo`
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "status: Invalid option: expected one of \"Active\"|\"Sold\"|\"Cancelled\"|\"Auction\"|\"expired\"",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

`GET /listings?sort=price-low&cursor_ledger=5`
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "cursor_ledger: cursor_ledger pagination is not supported with sort=price-low or sort=price-high; use offset pagination for price-sorted results",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

`GET /search` (missing `q`)
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "q: Invalid input: expected string, received undefined",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

Other messages you will see from the same schemas (verbatim):

| Input | `message` |
|---|---|
| `?limit=abc` | `limit: Invalid input: expected number, received NaN` |
| `?limit=-1` | `limit: Too small: expected number to be >=0` |
| `?minPrice=5&maxPrice=1` | `minPrice: minPrice must be ≤ maxPrice` |
| `?cursor_direction=up` | `cursor_direction: Invalid option: expected one of "asc"\|"desc"` |
| `/auctions?creator=bad` | `creator: Must be a valid 56-character Stellar G-address (base32, starts with G)` |
| `/search?q=a&types=foo` | `types.0: Invalid option: expected one of "listings"\|"auctions"\|"collections"` |
| `/events?listingId=x` | `listingId: listingId must be a non-negative integer` |

Object-level refinements such as `minPrice ≤ maxPrice` only run once every field is valid. When both are wrong, only the field error is reported.

### 2.2 Malformed path IDs and addresses

These are hand-checked in the route handler. Each returns the bare message.

`GET /listings/abc/history`
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid ID format",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

`GET /wallets/xyz/notifications` (any `:address` route that checks `isValidStellarAddress`)
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Must be a valid 56-character Stellar G-address (base32, starts with G)",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

Other path-validation messages in the code:

| Route(s) | `message` |
|---|---|
| `/listings/:id/history`, `/auctions/:id`, `/auctions/:id/blocked-bidders` | `Invalid ID format` |
| `/listings/:id/price-history` | `Invalid listing ID format` |
| `/ipfs/:cid` | `Invalid CID format` |
| `/tokens/:collection/:tokenId` | `tokenId must be a non-negative integer` |
| `/sync/gaps/:id` | `Gap ID must be an integer` |
| `/sync/jobs/:id` | `Job ID must be an integer` |
| `/admin/contracts/:id` | `Contract ID must be an integer` |
| `/moderation/appeals/:id/decision` | `Invalid appeal id` |
| `/listings/:id/history`, `/wallets/:address/notifications` | `limit must be a positive integer` / `offset must be a non-negative integer` |

### 2.3 Missing required query parameters

`GET /notifications/summary` (no `?wallet=`)
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "wallet query parameter is required",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

The same pattern: `/admin/verify-events` → `from and to query params are required`. `/stats/daily` → `from: …` / `to: …`, `from must be before or equal to to`, `Date range cannot exceed 365 days`.

### 2.4 Invalid cursor

From `decodeCursor` in `src/api/cursor.ts`. `GET /listings?cursor=not-a-token`:
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid cursor: malformed token",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false
  }
}
```

The other cursor messages are `Invalid cursor: signature verification failed`, `Invalid cursor: unsupported schema version <n>`, `Invalid cursor: missing required fields`, and `Invalid cursor: must be a non-negative integer or an opaque cursor token`. Reusing a cursor on a different endpoint is also rejected.

### 2.5 Request bodies with field details (moderation)

The moderation routes pass `parsed.error.flatten()` as `details`. This is the **only** 400 family that returns a structured per-field map. `POST /moderation/reports` with `{"cid": 1}`:
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid report payload",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false,
    "details": {
      "formErrors": [],
      "fieldErrors": {
        "cid": ["Invalid input: expected string, received number"],
        "reason": ["Invalid input: expected string, received undefined"]
      }
    }
  }
}
```

(The field names here are illustrative. The real report schema is `reportSchema` in `moderation-routes.ts`.)

A thrown `ZodError` that reaches `errorHandler` directly gets a different `details` shape, an **array**:
```json
"details": { "fieldErrors": [ { "field": "reason", "message": "Invalid input: expected string, received undefined" } ] }
```

### 2.6 Query too expensive

`queryCostGuard` returns **400** (not 429) with code `QUERY_TOO_EXPENSIVE` when the estimated cost exceeds the budget (`QUERY_COST_BUDGET_PUBLIC` = 60, `QUERY_COST_BUDGET_OPERATOR` = 200):
```json
{
  "error": {
    "code": "QUERY_TOO_EXPENSIVE",
    "message": "Query cost 85 exceeds budget 60. Reduce limit, narrow filters, or use cursor pagination.",
    "class": "CLIENT_ERROR",
    "requestId": "req-example-0001",
    "retryable": false,
    "details": {
      "estimatedCost": 85,
      "budget": 60,
      "breakdown": {
        "components": [
          { "reason": "fts_search", "cost": 25 },
          { "reason": "large_page", "cost": 20 },
          { "reason": "deep_offset", "cost": 15 },
          { "reason": "price_range", "cost": 5 },
          { "reason": "join", "cost": 15 },
          { "reason": "base", "cost": 5 }
        ],
        "total": 85
      }
    }
  }
}
```

(The component list is illustrative. The real breakdown depends on the query.)

### 2.7 Missing or invalid headers → 401, not 400

No route returns 400 for a missing header. Header problems are authentication failures:

| Missing / wrong | Status | Body |
|---|---|---|
| `X-Operator-Token` on an operator route (when a token is configured) | 401 | `{"error":{"code":"UNAUTHORIZED","message":"Invalid or missing operator token","class":"CLIENT_ERROR","requestId":"…","retryable":false}}` |
| Client IP not in `OPERATOR_ALLOWLIST` | 403 | `code: "FORBIDDEN"`, `message: "Operator access not allowed from this IP"` |
| `X-Admin-Token` on `/health/details` (when `HEALTH_DETAILS_TOKEN` is set) | 401 | `{"error":"Unauthorized"}` (**not** the envelope) |

`X-Wallet-Address` and `X-Request-Id` are optional and never cause an error.

---

## 3. 429 examples

There are **three different 429 bodies** in the codebase. Clients should rely on the status code and the `Retry-After` header, not on body shape.

### 3.1 Per-route and global token-bucket limiters (`rate-limit-middleware.ts`)

These apply to the light, medium, heavy and operational tiers and to the global limiter. **The body is not the standard envelope: `error` is a string.**

`GET /listings/1/history` after the heavy budget is used up (captured with `RATE_LIMIT_HEAVY=1`):
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
RateLimit-Policy: 1;w=60
RateLimit-Limit: 1
RateLimit-Remaining: 0
RateLimit-Reset: 60
X-Request-Id: req-example-0001
```
```json
{
  "error": "Heavy endpoint rate limit exceeded, please retry later.",
  "retryAfter": "1 minute",
  "limit": 1,
  "windowMs": 60000
}
```

With the default config, `limit` is 20 for heavy. The `error` string per tier is:

| Tier | `error` |
|---|---|
| light | `Too many requests, please slow down.` |
| medium (also the app-wide limiter) | `Too many requests to this endpoint, please try again later.` |
| heavy | `Heavy endpoint rate limit exceeded, please retry later.` |
| operational | `Operator endpoint rate limit exceeded.` |
| global | `Too many requests, please try again later.` (`limit` = `RATE_LIMIT_GLOBAL`, default 500) |

### 3.2 Abuse detection (`abuse-detection.ts`)

This covers the `sse`, `search`, `wallet-activity` and `tx-lookup` families and the operator blocklist. It uses the envelope's `code` and `class`, but **leaves out `requestId` and `retryable`**:
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
```
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many tx-lookup requests from this client. Please slow down and retry after the window resets.",
    "class": "CLIENT_ERROR",
    "details": { "retryAfterSeconds": 42 }
  }
}
```

When the client is on the blocklist, `message` is `"This client is temporarily blocked due to abusive request patterns. Please try again later."` and `retryAfterSeconds` is the remaining block TTL. (Built from `sendTooManyRequests`. The values `42` and `tx-lookup` are illustrative.)

### 3.3 SSE concurrency cap → 503, not 429

`sseConcurrencyGuard` on `/events` and `/notifications/stream` returns **503** when a key already has `SSE_CONCURRENT_PER_KEY` (default 5) open streams:
```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30
```
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "SSE connection limit reached (5 concurrent per key). Retry later.",
    "class": "CLIENT_ERROR",
    "details": { "limit": 5, "key": "ip:203.0.113.7" }
  }
}
```

`details.key` echoes the caller's own rate-limit key, which is their IP or wallet address. When the notification hub itself is full, `/notifications/stream` instead returns `503 {"error":"Notification stream at capacity — try again shortly"}`.

---

## 4. Inconsistencies found

| # | Finding | Impact | Suggested follow-up |
|---|---|---|---|
| E1 | The token-bucket 429 body (§3.1) is `{ error: string, … }`, not the `{ error: { code, … } }` envelope. | Clients that parse `error.code` get `undefined`. | Make the `baseOptions` handler emit `{ error: { code: 'RATE_LIMIT_EXCEEDED', message, class, retryable: true, retryAfterSeconds } }`. Keep the top-level `limit` and `windowMs` for one release. |
| E2 | The abuse 429 and SSE 503 leave out `retryable` and `requestId`. `error-envelope.test.ts` says `retryable` is "always present". | Contract drift. | Route them through `errorHandler`, or add the missing fields. |
| E3 | `validateQuery` drops Zod's structured issues. Moderation returns `flatten()`. A thrown `ZodError` returns a `fieldErrors[]` array. | Three different `details` shapes for validation errors. | Pick the `fieldErrors[]` array from `errors.ts` and use it in `validateQuery`. |
| E4 | `components.schemas.ErrorResponse` in `openapi.json` only declares `error.code` and `error.message`. | The spec under-describes real responses. | Add `class`, `retryable`, `retryAfterSeconds`, `requestId` and `details`. Add the §5 components. |
| E5 | Only 3 operations in `openapi.json` declare a `400`, and **none** declare a `429`. | Consumers cannot see rate-limit behaviour in `/docs`. | Reference `#/components/responses/BadRequest` and `TooManyRequests` on every public operation. |
| E6 | The SSE 503 reuses `RATE_LIMIT_EXCEEDED` with HTTP 503. | Code and status disagree. | Use 429, or the code `SERVICE_UNAVAILABLE`. |
| E7 | `/health/details` returns `{"error":"Unauthorized"}`, and its `authMiddleware` errors skip `errorHandler` (see endpoint-matrix D7). | Different shape from every other 401. | Move `app.use(errorHandler)` to the end of `src/index.ts`. |

---

## 5. OpenAPI components, ready to adopt

The served spec is generated from `src/api/openapi.ts`. **These are not applied yet.** To adopt them, register them in the registry, run `npm run generate-openapi` and commit `openapi.json`. The examples are the captured bodies above.

```yaml
components:
  schemas:
    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, class, retryable]
          properties:
            code:              { type: string, enum: [BAD_REQUEST, NOT_FOUND, UNAUTHORIZED, FORBIDDEN, RATE_LIMIT_EXCEEDED, QUERY_TOO_EXPENSIVE, CONFLICT, GONE, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR] }
            message:           { type: string }
            class:             { type: string, enum: [CLIENT_ERROR, SERVER_ERROR] }
            requestId:         { type: string }
            retryable:         { type: boolean }
            retryAfterSeconds: { type: integer }
            details:           {}
    RateLimitBody:
      type: object
      required: [error, retryAfter, limit, windowMs]
      properties:
        error:      { type: string }
        retryAfter: { type: string, example: "1 minute" }
        limit:      { type: integer }
        windowMs:   { type: integer }
  responses:
    BadRequest:
      description: Invalid query, path or body input.
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
          examples:
            invalidLimit:
              value: { error: { code: BAD_REQUEST, message: "limit: Too big: expected number to be <=100", class: CLIENT_ERROR, requestId: req-example-0001, retryable: false } }
            malformedId:
              value: { error: { code: BAD_REQUEST, message: "Invalid ID format", class: CLIENT_ERROR, requestId: req-example-0001, retryable: false } }
            invalidAddress:
              value: { error: { code: BAD_REQUEST, message: "Must be a valid 56-character Stellar G-address (base32, starts with G)", class: CLIENT_ERROR, requestId: req-example-0001, retryable: false } }
            invalidCursor:
              value: { error: { code: BAD_REQUEST, message: "Invalid cursor: malformed token", class: CLIENT_ERROR, requestId: req-example-0001, retryable: false } }
            queryTooExpensive:
              value: { error: { code: QUERY_TOO_EXPENSIVE, message: "Query cost 85 exceeds budget 60. Reduce limit, narrow filters, or use cursor pagination.", class: CLIENT_ERROR, requestId: req-example-0001, retryable: false, details: { estimatedCost: 85, budget: 60 } } }
    TooManyRequests:
      description: Rate limit exceeded. Honour the Retry-After header.
      headers:
        Retry-After:     { schema: { type: integer }, description: Seconds to wait. }
        RateLimit-Limit: { schema: { type: integer } }
        RateLimit-Remaining: { schema: { type: integer } }
        RateLimit-Reset: { schema: { type: integer } }
      content:
        application/json:
          schema:
            oneOf:
              - $ref: '#/components/schemas/RateLimitBody'
              - $ref: '#/components/schemas/ErrorEnvelope'
          examples:
            tokenBucket:
              value: { error: "Too many requests, please slow down.", retryAfter: "1 minute", limit: 200, windowMs: 60000 }
            abuseQuota:
              value: { error: { code: RATE_LIMIT_EXCEEDED, message: "Too many search requests from this client. Please slow down and retry after the window resets.", class: CLIENT_ERROR, details: { retryAfterSeconds: 42 } } }
```

---

## 6. Reproducing and reviewing

**Existing tests that pin this behaviour** (no network, no DB):

```bash
cd indexer
npx vitest run src/__tests__/error-envelope.test.ts src/__tests__/error-handler.test.ts \
               src/__tests__/rate-limit.test.ts tests/rate-limit-middleware.test.ts
```

**Re-capturing the examples.** This is read-only: it mounts the real middleware in memory and writes nothing to the repo or DB. Save the following as a `.mts` file **outside the repo** and run it with `npx tsx <file>` from `indexer/`:

```ts
import { createRequire } from 'node:module';
const req = createRequire(process.cwd() + '/package.json');
process.env.RATE_LIMIT_HEAVY = '1';
const express = req('express'), request = req('supertest');
const src = process.cwd() + '/src/api';
const { errorHandler, badRequest } = await import(`${src}/errors.ts`);
const { validateQuery, listingsQuerySchema } = await import(`${src}/query-schemas.ts`);
const { heavyRateLimiter } = await import(`${src}/rate-limit-middleware.ts`);
const { requestIdMiddleware } = await import(`${src}/request-id-middleware.ts`);

const app = express();
app.use(requestIdMiddleware);
app.get('/listings', validateQuery(listingsQuerySchema), (_q, r) => r.json([]));
app.get('/bad-id', (_q, _r, next) => next(badRequest('Invalid ID format')));
app.get('/heavy', heavyRateLimiter, (_q, r) => r.json({ ok: true }));
app.use(errorHandler);

for (const p of ['/listings?limit=101', '/bad-id', '/heavy', '/heavy']) {
  const res = await request(app).get(p).set('X-Request-Id', 'req-example-0001');
  console.log(p, res.status, res.headers['retry-after'] ?? '', JSON.stringify(res.body));
}
process.exit(0);
```

When `errors.ts`, `query-schemas.ts`, `rate-limit-middleware.ts` or `abuse-detection.ts` changes a message or shape, re-run the capture and update the matching example in the same PR.

**Revert.** This is a documentation-only change. To revert it, delete this file or `git revert` the commit. No runtime code, config or the generated spec changes.
