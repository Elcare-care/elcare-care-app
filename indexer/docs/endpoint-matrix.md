# Indexer REST Endpoint Matrix

> Issue #1057 · Built from the Express route registrations in `src/index.ts`, `src/api/routes.ts`,
> `src/api/notification-routes.ts`, `src/api/moderation-routes.ts`, `src/api/audit-routes.ts` and
> `src/api/docs-router.ts`, then reconciled with `openapi.json`, `openapi.yaml` and `README.md`.
> Last reviewed against `main` @ `a5746a7`.

Related: [pagination-defaults.md](./pagination-defaults.md) · [error-response-examples.md](./error-response-examples.md)

---

## 1. How to read the matrix

**Auth**
- `public`: no credentials.
- `operator`: `authMiddleware('operator')`. Requires `X-Operator-Token` (or `?operator_token=`) to equal `OPERATOR_TOKEN`, falling back to `HEALTH_DETAILS_TOKEN`. If `OPERATOR_ALLOWLIST` is set, the client IP must also be on it. **If neither token is set, operator routes are open** and only an `auth.unconfigured` warning is logged.
- `auth*`: `authMiddleware('authenticated')`. Today this **is a no-op** that accepts every request.

**Rate limit.** Every request passes through two app-wide limiters before its own: `globalRateLimiter` (500/min) and `rateLimiter` (= medium, 100/min). They are registered in `src/index.ts`. Per-route tiers (all per 60 s, keyed by `X-Wallet-Address` → `?wallet=` → IP):

| Tier | Default max | Env override |
|---|---|---|
| light | 200 | `RATE_LIMIT_LIGHT` |
| medium | 100 | `RATE_LIMIT_MEDIUM` |
| heavy (`strictRateLimiter`) | 20 | `RATE_LIMIT_HEAVY` |
| operational | 10 | `RATE_LIMIT_OPERATIONAL` |
| global | 500 | `RATE_LIMIT_GLOBAL` |

> ⚠ Because the app-wide medium limiter runs first, a `light` route is **effectively capped at 100/min**, not 200.
> `/health` and `/readyz` skip every limiter. `/metrics` skips the app-wide medium limiter but **not** the global one.

**Guards.** `cost` = `queryCostGuard` (public budget 60, operator 200; see `.env.example`). `abuse:<family>` = Redis quota in `abuse-detection.ts`; it fails open if Redis is down. `sse` = `sseConcurrencyGuard` (5 concurrent per key, `SSE_CONCURRENT_PER_KEY`).

**Cache.** Redis response-cache TTL in seconds from `cacheMiddleware(...)` (values from `TTL` in `src/cache-warmer.ts`). `—` = not cached.

**Spec.** `J` = in the generated `openapi.json`, which is what `/openapi.json` and `/docs` serve. `Y` = only in the hand-written `openapi.yaml`. `R` = listed in `README.md` › API Reference. `—` = undocumented.

**Data sensitivity**
- `P0 public`: projection of public on-chain data.
- `P1 wallet`: keyed by a wallet address. Pseudonymous, but it links activity to one address.
- `P2 internal`: operational state, config, contract registry or infrastructure details.
- `P3 sensitive`: user-submitted reports, audit actor data, request IDs, or the ability to change state.

---

## 2. Health, meta and debug

| Method | Path | Auth | Rate limit | Guards | Cache | Spec | Sensitivity | Notes |
|---|---|---|---|---|---|---|---|---|
| GET | `/health` | public | none (skipped) | — | — | J R | P0 | Liveness. 503 if any probe is `down`. |
| GET | `/readyz` | public | none (skipped) | — | — | J R | P0 | Readiness. 503 `stalled` / `not_ready`. |
| GET | `/version` | public | global + medium | — | — | — | P0 | Build SHA, schema and migration versions. |
| GET | `/metrics` | **public** | global | — | — | J R | P2 | Prometheus output. Not auth-gated, so restrict it at the ingress. |
| GET | `/health/details` | operator (+ `X-Admin-Token` when `HEALTH_DETAILS_TOKEN` is set) | global + medium | — | — | — | P2 | Memory, uptime, Node version, SSE count. |
| GET | `/cors-test` | public | global + medium | — | — | — | P2 | **Debug. Only registered when `NODE_ENV !== 'production'`.** Echoes the CORS whitelist. |
| GET | `/openapi.json` | public | global + medium | — | — | — | P0 | Generated spec. |
| GET | `/docs` | public | global + medium | — | — | — | P0 | Swagger UI. |

## 3. Public marketplace reads

| Method | Path | Auth | Rate limit | Guards | Cache | Spec | Sensitivity |
|---|---|---|---|---|---|---|---|
| GET | `/events` | public | global + medium | abuse:sse, sse | — | J | P0 |
| GET | `/listings` | public | light | cost | 10 | J R | P0 |
| GET | `/listings/:id` | public | light | cost (join) | 60 | J R | P0 |
| GET | `/listings/:id/history` | public | heavy | abuse:tx-lookup | — | J R | P0 |
| GET | `/listings/:id/price-history` | public | light | — | 60 | — | P0 |
| GET | `/ipfs/:cid` | public | medium | — | 300 | — | P0 |
| GET | `/auctions` | public | light | cost | 10 | J R | P0 |
| GET | `/auctions/:id` | public | light | cost (join) | 5 | J R | P0 |
| GET | `/auctions/:id/blocked-bidders` | public | light | — | — | — | P1 |
| GET | `/offers` | public | light | cost | — | J R | P1 |
| GET | `/activity/recent` | public | global + medium only | — | 30 | J | P0 |
| GET | `/collections` | public | light | cost | 60 | J R | P0 |
| GET | `/collections/:address` | public | light | cost (agg) | 60 | Y | P0 |
| GET | `/collections/:address/tokens` | public | light | cost | — | Y | P0 |
| GET | `/collections/:address/fee` | public | light | — | — | — | P0 |
| GET | `/collections/:address/royalty-defaults` | public | light | — | 60 | — | P0 |
| GET | `/collections/:address/succession` | public | light | — | — | — | P0 |
| GET | `/collections/:address/vouchers` | public | global + medium only | — | — | — | P1 |
| GET | `/creators/:address/collections` | public | light | — | — | J R | P1 |
| GET | `/artists/:address/metrics` | public | light | cost (agg) | 60 | J | P1 |
| GET | `/tokens` | public | light | — | — | — | P0 |
| GET | `/tokens/:address/history` | public | light | abuse:tx-lookup | — | — | P0 |
| GET | `/tokens/:collection/:tokenId` | public | light | cost (join) | 60 | Y | P0 |
| GET | `/stats` | public | light | cost (agg) | — | J | P0 |
| GET | `/stats/overview` | public | light | — | — | — | P0 |
| GET | `/stats/daily` | public | light | — | — | — | P0 |
| GET | `/stats/top-collections` | public | light | — | — | — | P0 |
| GET | `/stats/top-artists` | public | light | — | — | — | P1 |
| GET | `/search` | public | medium | cost | — | — | P0 |
| GET | `/config/auction` | public | global + medium only | — | 60 | — | P0 |

## 4. Wallet-scoped reads

| Method | Path | Auth | Rate limit | Guards | Cache | Spec | Sensitivity |
|---|---|---|---|---|---|---|---|
| GET | `/wallets/:address/activity` | public | heavy | cost | `Cache-Control` header only | J R | P1 |
| GET | `/wallets/:address/royalty-stats` | public | heavy | abuse:wallet-activity | — | J R | P1 |
| GET | `/wallets/:address/royalty-breakdown` | public | light | cost | 60 | — | P1 |
| GET | `/wallets/:address/notifications` | public | heavy | — | — | — | P1 |
| GET | `/notifications/stream` | public | global + medium | sse (+ 503 at hub capacity) | — | — | P1 |
| GET | `/notifications/summary?wallet=` | public | light | — | — | — | P1 |

## 5. Moderation

| Method | Path | Auth | Rate limit | Spec | Sensitivity |
|---|---|---|---|---|---|
| POST | `/moderation/reports` | public | heavy | — | P3 |
| GET | `/moderation/cases/:cid` | public | light | — | P0 (public state only) |
| POST | `/moderation/cases/:cid/appeals` | auth* | light | — | P3 |
| GET | `/moderation/cases` | operator | operational | — | P3 |
| GET | `/moderation/cases/:cid/full` | operator | operational | — | P3 |
| POST | `/moderation/cases/:cid/decision` | operator | operational | — | P3 |
| POST | `/moderation/appeals/:id/decision` | operator | operational | — | P3 |

## 6. Operator: sync, recovery and diagnostics

All rows: auth `operator`, rate limit `operational`, not cached. Spec is `—` unless marked.

| Method | Path | Mutates? | Spec | Sensitivity |
|---|---|---|---|---|
| GET | `/reconciliation/status` | no | — | P2 |
| GET | `/backfill/status` | no | — | P2 |
| GET | `/keeper/status` | no | — | P2 |
| GET | `/sync/gaps` | no | Y | P2 |
| GET | `/sync/gaps/:id` | no | Y | P2 |
| GET | `/sync/jobs` | no | Y | P2 |
| GET | `/sync/jobs/:id` | no | Y | P2 |
| GET | `/admin/verify-events` | no (documented as read-only) | — | P2 |
| GET | `/admin/rpc-pool-status` | no | — | P2 |
| GET | `/admin/query-cost` | no | — | P2 |
| GET | `/admin/contracts` | no | — | P2 |
| POST | `/admin/contracts` | **yes** | — | P3 |
| DELETE | `/admin/contracts/:id` | **yes** | — | P3 |
| GET | `/admin/abuse/blocklist` | no | — | P3 (contains client keys) |
| GET | `/admin/abuse/block/:key` | no | — | P3 |
| POST | `/admin/abuse/block` | **yes** | — | P3 |
| DELETE | `/admin/abuse/block/:key` | **yes** | — | P3 |
| GET | `/admin/deployment-fees` | no | — | P2 |
| GET | `/admin/dead-letters` | no | — | P2 |
| GET | `/admin/dead-letters/:id` | no | — | P2 |
| POST | `/admin/dead-letters/:id/remediate` | **yes** | — | P3 |
| POST | `/admin/dead-letters/:id/replay` | **yes** | — | P3 |
| POST | `/admin/dead-letters/replay/batch` | **yes** | — | P3 |
| GET | `/admin/snapshots` | no | — | P2 |
| GET | `/admin/snapshots/:id` | no | — | P2 |
| POST | `/admin/snapshots/:id/verify` | **yes** (updates the snapshot's verification fields) | — | P2 |
| GET | `/admin/token-metadata` | no | — | P2 |
| POST | `/admin/token-metadata/:address/invalidate` | **yes** (cache) | — | P2 |
| GET | `/admin/orphaned-offers` | no | — | P2 |
| GET | `/admin/pending-offers` | no | — | P2 |

## 7. Operator: audit log (`audit-routes.ts`)

Auth `operator`. **No per-route limiter**, only global + medium.

| Method | Path | Spec | Sensitivity | Notes |
|---|---|---|---|---|
| GET | `/admin/audit` | — | P3 | `?export=csv` returns `text/csv`. |
| GET | `/admin/audit/:requestId` | — | P3 | |
| GET | `/admin/audit/stats` | — | P3 | **Unreachable.** See §8. |

---

## 8. Drift, dead and deprecated routes

| # | Finding | Evidence | Suggested follow-up |
|---|---|---|---|
| D1 | `openapi.json` (generated, served) documents **17** operations. `openapi.yaml` documents **24**. The 7 extra YAML paths (`/collections/{address}`, `/collections/{address}/tokens`, `/tokens/{collection}/{tokenId}`, `/sync/gaps`, `/sync/gaps/{id}`, `/sync/jobs`, `/sync/jobs/{id}`) are **not served** by `/openapi.json`. | Path diff of the two files. | Register them in `src/api/openapi.ts`, then run `npm run generate-openapi`. Treat `openapi.yaml` as deprecated, or regenerate it from the JSON. |
| D2 | 67 of the 84 operations in this matrix are missing from `openapi.json`. 60 of them are in neither spec (marked `—`). | Matrix above. | Add public routes first (§3–4), then operator routes under an `operator` tag. |
| D3 | `GET /admin/deployment-fees` is registered **three times** (`routes.ts` ≈ L1207, L1243, L1275). Only the first handler runs. | Express matches first registration. | Delete the two unreachable copies. |
| D4 | `GET /collections/:address/royalty-defaults` and `/succession` are each registered **twice** (≈ L1155/L1297 and L1182/L1311). The second copies are unreachable. | Same. | Delete the duplicates. |
| D5 | `GET /admin/audit/stats` is registered **after** `/admin/audit/:requestId`, so `stats` is matched as a `requestId`. | `audit-routes.ts` L92 vs L111. | Register `/stats` before `/:requestId`. |
| D6 | `privacy-routes.ts` (`POST /privacy/requests`, `GET /privacy/requests`, `GET /privacy/requests/:id`) is **never mounted**. | No import of the module outside the module itself. | Mount it or remove it. Until then, mark it **not live**. |
| D7 | `/health`, `/readyz`, `/version` and `/health/details` are registered **after** `app.use(errorHandler)`. A `next(err)` from `authMiddleware` on `/health/details` therefore goes to Express's default handler, not the JSON error envelope. | `src/index.ts` L99 vs L102–150. | Move `app.use(errorHandler)` to the end of `index.ts`. |
| D8 | The README says `/metrics` "bypasses rate limiting". It is subject to `globalRateLimiter`. | `src/index.ts` L65 vs L81. | Correct the README wording. |
| D9 | The README cache table (`/listings` 30 s, `/auctions` 30 s, `/wallets/:address/activity` 15 s) does not match the code (10 s, 10 s, and no Redis cache, only a `Cache-Control` header). | `src/cache-warmer.ts` `TTL`. | Update the README table from `TTL`. |
| D10 | `.env.example` documents `QUERY_COST_*` but not `RATE_LIMIT_{LIGHT,MEDIUM,HEAVY,OPERATIONAL,GLOBAL}`, `SSE_CONCURRENT_PER_KEY` or `ABUSE_QUOTA_*`. | `rate-limit-middleware.ts`, `abuse-detection.ts`. | Add commented defaults. |
| D11 | The operator token is accepted from `?operator_token=`. Query strings can end up in access logs and proxies. | `auth-middleware.ts` L140. | Prefer the header. Consider dropping the query form. |
| D12 | The rate-limit key trusts the client-supplied `X-Wallet-Address` header. A caller can rotate it to get a fresh budget. | `getRateLimitKey`. | Abuse detection and the global limiter partly cover this. Document it as known. |

The README already says the interactive docs (`/docs`) are canonical. Rows marked `J` are the only ones guaranteed to be in them.

---

## 9. Reviewing and reverting

**Review.** Every row can be checked against code with read-only commands:

```bash
# READ-ONLY: list every registered route (method + path) in the API sources
cd indexer
grep -rnE "(app|router)\.(get|post|put|patch|delete)\(" src/index.ts src/api/*.ts
grep -nA1 -E "^router\.(get|post)\($" src/api/routes.ts src/api/notification-routes.ts

# READ-ONLY: operations documented in each spec
node -e 'const j=require("./openapi.json");for(const[p,v]of Object.entries(j.paths))for(const m of Object.keys(v))console.log(m.toUpperCase(),p)'

# Spec contract tests (no network, no DB writes)
npx vitest run src/__tests__/openapi.test.ts
```

When adding or removing a route, update its row in the same PR.

**Revert.** This is a documentation-only change. To revert it, delete this file or `git revert` the commit. No config, schema or runtime behaviour depends on it.
