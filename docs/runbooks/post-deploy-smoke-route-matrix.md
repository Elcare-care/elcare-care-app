# Post-Deploy Frontend Smoke Route Matrix

**Issue:** [#1120](https://github.com/Elcare-care/elcare-care-app/issues/1120)  
**Category:** Reliability, Security, and Operations  
**Owner:** DevOps / Frontend Lead  
**Last updated:** 2025-07-19

---

## Purpose

A deployment must verify that key public and wallet-dependent pages are reachable and responding correctly before traffic is shifted to the new revision. This document defines the minimum route and action matrix for post-deploy smoke testing, covering both testnet and e2e mock modes.

The post-deploy workflow is `.github/workflows/post-deploy-smoke.yml`. The underlying health gate is `scripts/deploy/health-gate.sh`. The Playwright specs under `frontend/elcarehub-app/tests/e2e/` provide the deeper browser-level coverage referenced here.

---

## Route and Action Matrix

Each row specifies the route, test mode, the HTTP method or Playwright action, the expected status or outcome, and which existing spec provides coverage.

### Public Routes (no wallet required)

| Route | Test Mode | Check | Expected Result | Covered By |
|---|---|---|---|---|
| `/` | health-gate + e2e mock | `GET` via `curl` | HTTP 200; branding text visible | `smoke.spec.ts` |
| `/explore` | health-gate + e2e mock | `GET` via `curl`; page renders | HTTP 200; `[data-testid="explore-page"]` visible | `navigation.spec.ts`, `listings.spec.ts` |
| `/explore?status=Active&sort=price-low` | e2e mock | Filter URL deep link | HTTP 200; filters restored from URL | `navigation.spec.ts` |
| `/auctions` | health-gate + e2e mock | `GET` via `curl`; page renders | HTTP 200; `<h1>` contains "Auctions" | `navigation.spec.ts`, `auction-flow.spec.ts` |
| `/auctions?status=Active` | e2e mock | Tab state URL deep link | HTTP 200; Active tab selected | `navigation.spec.ts` |
| `/launchpad` | e2e mock | `GET` | HTTP 200; page renders | `navigation.spec.ts` |
| `/launchpad/collections` | e2e mock | `GET`; breadcrumb present | HTTP 200; breadcrumb links back to `/launchpad` | `navigation.spec.ts` |
| `/activity` | e2e mock | `GET` | HTTP 200; page renders | `navigation.spec.ts` |
| `/help` | e2e mock | `GET` | HTTP 200 | `navigation.spec.ts` |
| `/settings` | e2e mock | `GET` | HTTP 200 | `navigation.spec.ts` |

### Wallet-Gated Routes (disconnected user)

| Route | Test Mode | Check | Expected Result | Covered By |
|---|---|---|---|---|
| `/dashboard` | e2e mock | `GET` (no wallet) | 200 with "wallet connection required" message; connect button visible | `navigation.spec.ts` |
| `/offers` | e2e mock | `GET` (no wallet) | 200 with "wallet connection required" message | `navigation.spec.ts` |

### Wallet-Gated Actions (connected user, e2e mock mode)

| Action | Route | Test Mode | Expected Result | Covered By |
|---|---|---|---|---|
| List an NFT | `/launchpad/create` | e2e mock (Freighter mock) | Form renders; submission accepted without RPC error | `listing-flow.spec.ts` |
| Place a bid | `/auctions` | e2e mock | Bid accepted; confirmation modal shown | `auction-flow.spec.ts` |
| Make an offer | `/explore` | e2e mock | Offer submitted; pending state shown | `offers-flow.spec.ts` |
| Core purchase flow | `/explore` | e2e mock | Buy completes; success state shown | `core-purchase-flow.spec.ts` |

### Indexer Health Gates (health-gate.sh)

| Endpoint | Expected Status | Notes |
|---|---|---|
| `$INDEXER_URL/healthz` | HTTP 200 | Liveness — wait up to `GATE_TIMEOUT_SECONDS` (default 120 s) |
| `$INDEXER_URL/readyz` | HTTP 200; `{"ready": true}` | Readiness — confirms DB and Redis connections |
| `$INDEXER_URL/health/details` | HTTP 200 (auth-protected) | Detailed component status; requires `HEALTH_DETAILS_TOKEN` |
| `$INDEXER_URL/metrics` | HTTP 200 | Prometheus scrape; confirms metrics endpoint is live |

### Testnet Mode Additions

When `environment=production` or `environment=staging` is passed to the workflow dispatch, the health-gate script also validates:

| Check | Expected Result |
|---|---|
| Read-only contract query (`get_active_listings_count` via `SMOKE_CONTRACT_ID`) | Non-error RPC response |
| Indexer event log — latest `ledgerSequence` is recent (< 5 min old) | Confirms live ingestion |

---

## Running Locally

```bash
# Health gate only (requires a running indexer)
INDEXER_URL=http://localhost:4000 bash scripts/deploy/health-gate.sh

# Playwright e2e smoke suite (mock chain — no live RPC)
cd frontend/elcarehub-app
npx playwright test tests/e2e/smoke.spec.ts tests/e2e/navigation.spec.ts

# Full Playwright e2e suite (mock chain)
cd frontend/elcarehub-app
npm run test:e2e
```

---

## Triggering Post-Deploy Workflow

```bash
# After a deployment completes
gh workflow run post-deploy-smoke.yml \
  -f indexer_url=https://indexer.elcarehub.xyz \
  -f frontend_url=https://elcarehub.xyz \
  -f environment=production \
  -f smoke_contract_id=<MARKETPLACE_CONTRACT_ID>
```

The workflow uploads a `health-gate-report-<run_id>` artifact with the full gate output. Retention is 30 days (set in `post-deploy-smoke.yml`).

---

## Gap: Routes Not Yet Covered by Post-Deploy Smoke

The following routes are covered by unit or integration tests but have no explicit post-deploy smoke check. Add a Playwright test or a `curl` check in `health-gate.sh` to close each gap:

| Gap | Route / Action | Suggested Fix |
|---|---|---|
| Testnet listing page | `/explore/<listing-id>` with a known testnet listing ID | Add a fixture listing ID to `health-gate.sh` testnet path |
| Wallet-connected dashboard | `/dashboard` after Freighter auto-connect | Extend `navigation.spec.ts` signed-in suite |
| 404 handling | Any unknown route | Assert HTTP 404 (not 500) in health gate |

---

## Rollback

If any gate fails:
1. Do not shift traffic to the new revision.
2. Re-point the load balancer or CDN to the previous known-good revision.
3. Page the on-call operator. The gate report artifact is attached to the workflow run.
4. Investigate the failing gate before retrying the deployment.

Detailed rollback steps are in `scripts/deploy/health-gate.sh` (header comment).
