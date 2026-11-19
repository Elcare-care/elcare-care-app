# GET Pagination Defaults

> Issue #1058 · Built from the Zod schemas in `src/api/query-schemas.ts`, the inline parsing in
> `src/api/routes.ts`, `notification-routes.ts`, `moderation-routes.ts` and `audit-routes.ts`,
> and the cursor helpers in `src/api/cursor.ts`. Last reviewed against `main` @ `a5746a7`.

Related: [endpoint-matrix.md](./endpoint-matrix.md) · [error-response-examples.md](./error-response-examples.md)

---

## 1. Project conventions

These are the existing defaults. A new list endpoint should copy them rather than invent its own.

| Setting | Public list | Wallet or operator list | Source |
|---|---|---|---|
| Default `limit` | **20** | **50** | `take = limit ?? 20` (public) / `?? 50` (wallet, operator) |
| Maximum `limit` | **100** | **200** | `positiveInt(100)` / `Math.min(…, 200)` |
| Maximum `offset` | **10 000** | 10 000 where validated | `positiveInt(10_000)` |
| Default order | newest first (`… desc`) | newest first | `cursor_direction` defaults to `desc` |
| Total count | `X-Total-Count` header | `X-Total-Count` header | |
| Next page | `X-Next-Cursor` header (`""` when exhausted) | same, where supported | `nextCursorFromRows` |

**How an out-of-range `limit` is handled depends on the endpoint:**
- **Zod-validated routes** (`validateQuery(...)`) **reject** it with `400 BAD_REQUEST`, for example `limit: Too big: expected number to be <=100` (Zod 4 message text).
- **Hand-parsed routes** (`Math.min(...)`) **clamp it silently** to the maximum.

### Cursor behaviour

Endpoints that spread `cursorFields` accept three parameters:

| Param | Meaning |
|---|---|
| `cursor` | **Preferred.** Opaque base64url token from `X-Next-Cursor`. Encodes the ledger plus a row-id tiebreaker and is HMAC-signed (`CURSOR_SECRET`). A token that has been tampered with, has the wrong version or belongs to another endpoint gets a `400`. |
| `cursor_ledger` | Legacy plain integer. Exclusive ledger boundary. |
| `cursor_direction` | `desc` (default) or `asc`. |

- `cursor` takes precedence over `cursor_ledger`.
- When a cursor is present, `offset` is **ignored** (`skip = 0`).
- `X-Next-Cursor` is `""` when the page returned fewer rows than `limit`.
- `X-Total-Count` is the count of the **whole filtered set**, ignoring the cursor bound.
- `/listings` only: `cursor_ledger` together with `sort=price-low` or `sort=price-high` is rejected with `400`. Paginate price sorts with `offset`.

---

## 2. Per-endpoint table

**Cursor column:** ✓ = `cursor` / `cursor_ledger` / `cursor_direction` accepted. ✗ = offset only. — = not paginated.
**Bound column:** `400` = rejects values over the maximum. `clamp` = silently caps them. `fixed` = the server picks the page size and ignores `limit`.

### Public

| Endpoint | Default | Max | Offset max | Bound | Cursor | Order | Response shape |
|---|---|---|---|---|---|---|---|
| `GET /listings` | 20 | 100 | 10 000 | 400 | ✓ | `sort`: `newest` (default) / `recently-sold` → `updatedAtLedger` desc · `oldest` → asc · `price-low` / `price-high` → `price` | `{ listings, total }` |
| `GET /auctions` | 20 | 100 | 10 000 | 400 | ✓ | `updatedAtLedger` desc | array |
| `GET /offers` | 20 | 100 | 10 000 | 400 | ✓ | `updatedAtLedger` desc | array |
| `GET /collections` | 20 | 100 | 10 000 | 400 | ✓ | `deployedAtLedger` desc | array |
| `GET /creators/:address/collections` | 20 | 100 | 10 000 | 400 | ✓ | `deployedAtLedger` desc | array |
| `GET /collections/:address/tokens` | 20 | 100 | 10 000 | 400 | ✗ | `nftTokenId`, then Active > Auction > other, then `updatedAtLedger` desc | `{ tokens, total }` |
| `GET /listings/:id/history` | 100 | 500 | 10 000 | clamp (non-integer → 400) | ✗ | `ledgerSequence` asc, `eventIndex` asc (nulls last) | `{ events, total, hasMore }` |
| `GET /tokens/:address/history` | 100 | 500 | 10 000 | clamp | ✗ | `ledgerSequence` asc, `id` asc | `{ events, total }` |
| `GET /search` | 10 **per type** | 50 | — | 400 | ✗ | `ts_rank` (q ≥ 3 chars) or `updatedAtLedger` / `deployedAtLedger` desc | `{ listings?, auctions?, collections? }` each `{ items, total }` |
| `GET /stats/top-collections` | 10 | 100 | — | 400 | — | by volume | array |
| `GET /stats/top-artists` | 10 | **none** | — | — | — | by earnings | array |
| `GET /activity/recent` | 20 | — | — | fixed | — | `ledgerSequence` desc | array |
| `GET /collections/:address/vouchers` | 50 | 200 | none | clamp | ✗ | `createdAtLedger` desc | object + `X-Total-Count` |
| `GET /stats/daily` | — | range ≤ 365 days | — | 400 | — | by day | array |

### Wallet-scoped

| Endpoint | Default | Max | Offset max | Bound | Cursor | Order |
|---|---|---|---|---|---|---|
| `GET /wallets/:address/activity` | 50 | 200 | 10 000 | 400 | ✓ | `ledgerSequence` (`cursor_direction`, default desc) |
| `GET /wallets/:address/royalty-breakdown` | 50 | 1000 | 10 000 | 400 | ✗ | `ledgerSequence` desc. `from` / `to` ledger bounds are optional. |
| `GET /wallets/:address/notifications` | 50 | 100 | **none** | clamp (non-integer → 400) | ✗ | `ledgerSequence` desc |
| `GET /notifications/summary` | 5 | — | — | fixed | — | `ledgerSequence` desc |

### Operator

| Endpoint | Default | Max | Offset max | Bound | Order |
|---|---|---|---|---|---|
| `GET /sync/gaps` | 50 | 500 | 10 000 | 400 | `createdAt` asc |
| `GET /sync/jobs` | 100 | — | — | fixed | `createdAt` desc |
| `GET /moderation/cases` | 25 | 100 | none | 400 | `state` asc, `updatedAt` desc |
| `GET /admin/audit` | 100 | 1000 | none | 400 (generic message) | service-defined. Body includes `hasMore`. |
| `GET /admin/deployment-fees` | 50 | 200 | none | clamp | `ledgerSequence` desc |
| `GET /admin/dead-letters` | 50 | 200 | none | clamp | `createdAt` asc |
| `POST /admin/dead-letters/replay/batch` (body `limit`) | 10 | 50 | — | clamp | — |
| `GET /admin/snapshots` | 20 | 100 | none | clamp | `ledgerSequence` desc |
| `GET /admin/orphaned-offers` | 50 | 200 | none | clamp | `createdAtLedger` asc |
| `GET /admin/pending-offers` | 50 | 200 | none | clamp | `createdAtLedger` asc |
| `GET /admin/verify-events` | window 500 ledgers | range ≤ `VERIFY_MAX_RANGE` (50 000) | — | 400 | ledger asc. `cursor` = ledger to resume from. |

---

## 3. Unbounded reads

These GET endpoints return every matching row with no `take`. Each is low risk today because the underlying set is small or scoped to a single parent row. Revisit them if the data grows.

| Endpoint | Bounded by | Risk |
|---|---|---|
| `GET /listings/:id/price-history` | one listing | Low. A listing has few price changes. |
| `GET /auctions/:id/blocked-bidders` | one auction | Low. Returns the full block/unblock `history`. |
| `GET /tokens` | whitelisted payment tokens | Low. Operator-curated list. |
| `GET /admin/contracts` | tracked contracts | Low. Operator only. |
| `GET /admin/token-metadata` | whitelisted tokens | Low. Operator only. |
| `GET /admin/abuse/blocklist` | active blocks in Redis | Medium during an attack. Operator only. |
| `GET /moderation/cases/:cid/full` | one case (`reports`, `decisions`, `appeals` nested) | Medium if a CID is report-spammed. Operator only. |
| `GET /stats/top-artists` | `limit` has a minimum but **no maximum** | **Medium. Public.** `?limit=100000` is accepted. |

---

## 4. Gaps found, with suggested defaults

The fixes below use the existing project defaults from §1. **None are applied in this change.** They are recorded so each one can land as a small, separately reviewed PR.

| # | Gap | Suggested fix |
|---|---|---|
| P1 | `/stats/top-artists` has no maximum `limit`. | `.max(100)`, the same as `/stats/top-collections`. |
| P2 | Hand-parsed routes pass `NaN` through when `limit=abc`: `Math.min(NaN, 200)` is `NaN`. This affects `/admin/deployment-fees`, `/admin/dead-letters`, `/admin/snapshots`, `/admin/orphaned-offers`, `/admin/pending-offers`, `/collections/:address/vouchers` and `/tokens/:address/history`. The result is a Prisma error and a `500` instead of a `400`. | Move them to `validateQuery(z.object({ limit: positiveInt(200).optional(), offset: positiveInt(10_000).optional() }))`. |
| P3 | Offset is not capped on notifications, vouchers, moderation cases, audit and the operator lists. | `positiveInt(10_000)`. |
| P4 | The single-column `orderBy` (`updatedAtLedger`, `deployedAtLedger`) has no `id` tiebreaker, so **offset** paging can repeat or skip rows that share a ledger. The opaque cursor's WHERE clause includes the id, but the ORDER BY does not. | Add `{ id: direction }` as a secondary key. |
| P5 | `GET /listings?status=expired` returns `[]` when there are no expired listings, but `{ listings, total }` otherwise. | Return `{ listings: [], total: 0 }`. |
| P6 | `positiveInt` is `nonnegative()`, so `limit=0` passes validation and asks Prisma for zero rows. | Use `.min(1)` for `limit`. Keep `offset` non-negative. |
| P7 | `/wallets/:address/activity` caps at 200 in both Zod and `Math.min`. That is redundant but harmless. | Leave it. |

---

## 5. Examples

Read-only requests against a local indexer (`npm run dev` on port 4000):

```bash
# First page, defaults (limit=20, newest first)
curl -si 'http://localhost:4000/listings' | grep -iE '^(x-next-cursor|x-total-count)'

# Next page using the opaque cursor from the previous response
curl -si "http://localhost:4000/listings?cursor=$NEXT" | grep -i x-next-cursor

# Oldest-first
curl -s 'http://localhost:4000/auctions?cursor_direction=asc&limit=5'

# Over the maximum → 400 (Zod-validated route)
curl -s 'http://localhost:4000/listings?limit=101'
# {"error":{"code":"BAD_REQUEST","message":"limit: Too big: expected number to be <=100","class":"CLIENT_ERROR","retryable":false}}

# Over the maximum → silently clamped to 500 (hand-parsed route)
curl -s 'http://localhost:4000/listings/1/history?limit=9999'
```

---

## 6. Reviewing and reverting

**Review.** Re-derive the table with read-only commands:

```bash
cd indexer
# READ-ONLY: Zod limits per schema
grep -nE "positiveInt\(|limit:|offset:" src/api/query-schemas.ts
# READ-ONLY: inline defaults and caps in handlers
grep -nE "limit \?\?|Math\.min\(|take:|orderBy" src/api/routes.ts src/api/*-routes.ts
# Existing tests that pin cursor and limit behaviour
npx vitest run src/__tests__/cursor-pagination.test.ts src/__tests__/cursor-hardening.test.ts
```

Any PR that changes a default, maximum or ordering should update its row here.

**Revert.** This is a documentation-only change. To revert it, delete this file or `git revert` the commit.
