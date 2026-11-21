# CORS Configuration Validation

> Issue #1069. **Audience:** operators who deploy the indexer, and frontend or
> integrator developers.
> **Owners:** `@org/backend-lead-indexer` (middleware), `@org/devops`
> (per-environment `CORS_ORIGIN` values).

This guide shows the `Origin` and preflight (`OPTIONS`) responses you should
expect from the indexer API in each environment. It also gives `curl` checks
to confirm a deployment. Everything here comes from:

- `indexer/src/cors.ts`: `parseCorsOrigins`, `buildCorsOptions`
- `indexer/src/index.ts`: the `cors()` mount, `app.options(/.*/)`, and the
  dev-only `GET /cors-test`
- `indexer/src/__tests__/cors.test.ts`: the executable specification
- `indexer/.env.example` and `indexer/README.md#cors-configuration`

---

## 1. How the middleware decides

The decision depends **only** on whether `CORS_ORIGIN` is empty. `NODE_ENV`
does **not** affect it.

| `CORS_ORIGIN` | Mode | Behaviour |
|---|---|---|
| unset / empty | "development (all origins)" | Every `Origin` is reflected back. |
| comma-separated list | "production (whitelist)" | Only exact string matches are reflected. Every other origin gets **no** CORS headers. |

`NODE_ENV` only controls whether the `GET /cors-test` debug endpoint exists.
It is registered when `NODE_ENV !== 'production'`.

> ⚠️ **Never deploy staging or production with an empty `CORS_ORIGIN`.** The
> middleware would then reflect *any* origin **and** send
> `Access-Control-Allow-Credentials: true`. Setting `NODE_ENV=production`
> does not prevent this.

Matching rules (`parseCorsOrigins` + `origin()` callback):

- Entries are split on `,`, trimmed, de-duplicated, and empty entries are
  dropped.
- The comparison is an **exact string match**. There are no wildcards, no
  subdomain matching, and no regexes. Scheme, host and port must all match.
- Browsers send `Origin` **without** a trailing slash. A value such as
  `https://app.elcarehub.xyz/` in `CORS_ORIGIN` therefore never matches.
- A request with no `Origin` header (curl, server-to-server, same-origin
  navigation) is always allowed and gets no `Access-Control-Allow-Origin`.
- CORS is a browser rule, not access control. A denied origin's request is
  still **processed** by the server. The browser just refuses to let the page
  read the response. Use auth (`X-API-Key`, roles) for access control.

Fixed values on every allowed response:

| Header | Value | Where |
|---|---|---|
| `Access-Control-Allow-Origin` | the request's `Origin`, echoed back (never `*`) | all allowed |
| `Access-Control-Allow-Credentials` | `true` | all allowed |
| `Vary` | `Origin` | all allowed |
| `Access-Control-Expose-Headers` | `X-Request-Id` | all allowed |
| `Access-Control-Allow-Methods` | `GET,HEAD,PUT,PATCH,POST,DELETE` (`cors` package default) | preflight |
| `Access-Control-Allow-Headers` | `Content-Type,Authorization,X-API-Key,Last-Event-ID` | preflight |
| `Access-Control-Max-Age` | `86400` (24 h) | preflight |
| Preflight status | `204 No Content` | preflight |

Request headers that are **not** in the allow-list (for example
`If-None-Match`, `X-API-Version`, custom tracing headers) make a preflight
fail when a browser sends them cross-origin. Add them to `allowedHeaders` in
`cors.ts` (with a test) before frontend code starts relying on them.

---

## 2. Expected behaviour matrix

Example environment values. They match `indexer/README.md` and are not real
secrets:

| Environment | `NODE_ENV` | `CORS_ORIGIN` |
|---|---|---|
| Local | `development` | *(empty)* |
| Staging | `production` | `https://staging.elcarehub.xyz` |
| Production | `production` | `https://app.elcarehub.xyz,https://partner.example.com` |

| # | Request | Local | Staging | Production |
|---|---|---|---|---|
| 1 | `GET` with no `Origin` | 200, no ACAO | 200, no ACAO | 200, no ACAO |
| 2 | `GET`, `Origin: http://localhost:3000` | 200, ACAO=`http://localhost:3000`, ACAC=`true` | 200, **no ACAO** | 200, **no ACAO** |
| 3 | `GET`, `Origin: https://staging.elcarehub.xyz` | 200, ACAO echoed | 200, ACAO=`https://staging.elcarehub.xyz`, ACAC=`true` | 200, **no ACAO** |
| 4 | `GET`, `Origin: https://app.elcarehub.xyz` | 200, ACAO echoed | 200, **no ACAO** | 200, ACAO=`https://app.elcarehub.xyz`, ACAC=`true` |
| 5 | `GET`, `Origin: https://evil.example` | 200, ACAO echoed (dev only!) | 200, **no ACAO** | 200, **no ACAO** |
| 6 | `GET`, `Origin: https://sub.app.elcarehub.xyz` (subdomain) | ACAO echoed | no ACAO | **no ACAO** (no subdomain matching) |
| 7 | `GET`, `Origin: http://app.elcarehub.xyz` (wrong scheme) | ACAO echoed | no ACAO | **no ACAO** |
| 8 | `GET`, `Origin: null` (sandboxed iframe / `file://`) | ACAO=`null` echoed | no ACAO | no ACAO |
| 9 | `OPTIONS` preflight from an allowed origin | 204 + full preflight headers | 204 + full preflight headers | 204 + full preflight headers |
| 10 | `OPTIONS` preflight from a denied origin | n/a (all allowed) | **no CORS headers**; the status code is not part of the contract | **no CORS headers** |
| 11 | Preflight asking for `X-API-Key` | `X-API-Key` listed in ACAH | listed (if origin allowed) | listed (if origin allowed) |
| 12 | `GET /cors-test` | 200 JSON | **404** (not registered when `NODE_ENV=production`) | **404** |

ACAO = `Access-Control-Allow-Origin`, ACAC = `Access-Control-Allow-Credentials`,
ACAH = `Access-Control-Allow-Headers`. "200" assumes the route itself
succeeds. CORS never changes the status code of a non-preflight request.

Rows 2–6, 9–11 and 12 are covered by `indexer/src/__tests__/cors.test.ts`.
Rows 7 and 8 follow from the exact-match rule and have no dedicated test yet.

---

## 3. `curl` validation examples

All commands below are **READ-ONLY**. They send only `GET`/`OPTIONS`, with no
request body, no cookies, no `Authorization` and no `X-API-Key`. Point
`INDEXER_URL` at the environment under test:

```bash
INDEXER_URL=http://localhost:4000            # local
# INDEXER_URL=https://<staging-indexer-host>  # staging
# INDEXER_URL=https://<prod-indexer-host>     # production
```

### 3.1 Allowed origin, simple request (READ-ONLY)

```bash
curl -s -o /dev/null -D - \
  -H 'Origin: https://app.elcarehub.xyz' \
  "$INDEXER_URL/health" | grep -i '^access-control-\|^vary'
```

Expected when the origin is allowed:

```
Vary: Origin
Access-Control-Allow-Origin: https://app.elcarehub.xyz
Access-Control-Allow-Credentials: true
Access-Control-Expose-Headers: X-Request-Id
```

### 3.2 Denied origin (READ-ONLY)

```bash
curl -s -o /dev/null -D - \
  -H 'Origin: https://evil.example' \
  "$INDEXER_URL/health" | grep -i '^access-control-allow-origin' \
  || echo 'OK: no Access-Control-Allow-Origin (origin denied)'
```

In staging and production, expect the `OK:` line. Locally the origin is
echoed back, which is expected in development mode.

### 3.3 Preflight from an allowed origin (READ-ONLY)

```bash
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://app.elcarehub.xyz' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: X-API-Key,Content-Type' \
  "$INDEXER_URL/listings"
```

Expected:

```
HTTP/1.1 204 No Content
Vary: Origin
Access-Control-Allow-Origin: https://app.elcarehub.xyz
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
Access-Control-Allow-Headers: Content-Type,Authorization,X-API-Key,Last-Event-ID
Access-Control-Max-Age: 86400
Access-Control-Expose-Headers: X-Request-Id
```

`-X OPTIONS` together with `Access-Control-Request-*` headers only asks for
CORS policy. The route handler is not run.

### 3.4 Preflight from a denied origin (READ-ONLY)

```bash
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: GET' \
  "$INDEXER_URL/listings" | grep -i '^access-control-' \
  || echo 'OK: no CORS headers on denied preflight'
```

### 3.5 SSE stream from a browser origin (READ-ONLY)

```bash
curl -sN -D - --max-time 5 \
  -H 'Origin: https://app.elcarehub.xyz' \
  "$INDEXER_URL/events" | head -n 15
```

Expect the CORS headers from 3.1 plus `Content-Type: text/event-stream` and
`X-Accel-Buffering: no`. See [`../sse-protocol.md`](../sse-protocol.md).

### 3.6 Debug endpoint (READ-ONLY, non-production only)

```bash
curl -s -H 'Origin: http://localhost:3000' "$INDEXER_URL/cors-test"
```

```json
{
  "origin": "http://localhost:3000",
  "allowed": true,
  "whitelist": [],
  "mode": "development (all origins)",
  "headers": {
    "access-control-allow-origin": "http://localhost:3000",
    "access-control-allow-credentials": "true"
  }
}
```

The `whitelist` field echoes `CORS_ORIGIN`. Origins are public URLs, not
secrets. Against staging or production this endpoint must return **404**. A
200 there means `NODE_ENV` is misconfigured.

---

## 4. Pre-deploy checklist (staging / production)

- [ ] `CORS_ORIGIN` is **non-empty** and lists every frontend and integrator
      origin as exact scheme + host (+ port). No trailing slash, no path.
- [ ] `NODE_ENV=production` is set, so `GET /cors-test` returns 404.
- [ ] Checks 3.1–3.4 pass for one allowed origin and one denied origin.
- [ ] Any new custom request header used by the frontend is in
      `allowedHeaders` (`indexer/src/cors.ts`).
- [ ] If preflights fail through a CDN or reverse proxy, confirm it passes
      `OPTIONS` through and does not cache responses without `Vary: Origin`.

---

## 5. Review and revert

**Reviewing.** Check the matrix against `buildCorsOptions` in
`indexer/src/cors.ts` and the cases in `indexer/src/__tests__/cors.test.ts`.
This PR also fixes the `CORS_ORIGIN` comment in `indexer/.env.example`, which
wrongly said that `NODE_ENV` controls the allow-all behaviour, and adds the
`headers` field to the `/cors-test` example in `indexer/README.md`.

**Reverting.** Documentation and comments only. Revert with
`git revert <commit>`. No runtime behaviour, configuration value or
deployment changes. To roll back a bad `CORS_ORIGIN` value in an
environment, restore the previous value in that environment's secret or config
store and restart the indexer. The value is read once at startup
(`index.ts`).
