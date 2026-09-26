# Contributing to ELCARE-HUB

Thank you for contributing to ELCARE-HUB! This document explains how to work with the test suite, what quality gates the CI enforces, and how to add new tests.

---

## Table of Contents

- [Repository layout](#repository-layout)
- [Test matrix](#test-matrix)
- [Running tests locally](#running-tests-locally)
  - [Smart contracts](#smart-contracts)
  - [Indexer](#indexer)
  - [Frontend](#frontend)
  - [End-to-end](#end-to-end)
- [Coverage policy](#coverage-policy)
- [CI quality gates](#ci-quality-gates)
- [Adding new tests](#adding-new-tests)
  - [Indexer unit tests](#indexer-unit-tests)
  - [Frontend component tests](#frontend-component-tests)
  - [Contract tests](#contract-tests)
  - [E2E tests](#e2e-tests)
- [Test fixtures and helpers](#test-fixtures-and-helpers)
- [Debugging failures](#debugging-failures)

---

## Repository layout

```
elcare-care-app/
├── contracts/                  Rust / Soroban smart contracts
│   └── soroban-marketplace/
│       └── src/test.rs         Contract unit + property-based tests
├── indexer/                    Node.js event indexer (Express + Prisma)
│   ├── src/__tests__/          Vitest unit tests
│   │   ├── helpers/            Shared mock utilities (fake-redis, fixtures)
│   │   └── integration/        Vitest integration tests (need Postgres + Redis)
│   └── vitest.config.mts       Unit test config with coverage thresholds
├── frontend/
│   └── elcarehub-app/
│       ├── src/__tests__/      Jest component + hook tests
│       │   └── helpers/        Shared fixture factories
│       ├── tests/e2e/          Playwright end-to-end tests
│       ├── jest.config.js      Coverage thresholds and transform config
│       └── playwright.config.ts
└── .github/workflows/ci.yml    Full CI pipeline
```

---

## Test matrix

| Layer | Tool | Scope | Speed |
|---|---|---|---|
| Smart contracts | `cargo test` | Unit tests for every public entry-point | Fast (~30 s) |
| Smart contracts | `cargo test proptests` (proptest) | Property-based fuzz (1 000 cases) | Medium (~2 min) |
| Indexer unit | Vitest | Pure-function tests, mocked DB + Redis | Fast (~15 s) |
| Indexer integration | Vitest + testcontainers | Real Postgres + Redis, full request pipeline | Slow (~3 min) |
| Frontend unit | Jest + React Testing Library | Component rendering, hooks, utilities | Fast (~30 s) |
| Frontend accessibility | jest-axe | WCAG rule regressions on components | Fast (~20 s) |
| Frontend E2E | Playwright (Chromium) | Full browser, mock-chain build | Medium (~3 min) |

**Critical user journeys covered by E2E tests:**
- Browse listings page — renders cards, prices, artwork
- Listing artwork loading — loading skeleton → image → fallback states
- Navigate from listing card to detail page
- Activity feed page — renders events, filter tabs, refresh
- Notification bell — open/close panel

---

## Running tests locally

### Prerequisites

```bash
# Rust toolchain
rustup target add wasm32v1-none
# Node.js 20 or 22
node --version
```

### Smart contracts

```bash
# Format check
cargo fmt --check

# Lint
cargo clippy

# Unit tests (includes Issue #9 security tests)
cargo test

# Property-based fuzz tests (1 000 cases per property)
cargo test --package soroban-marketplace proptests
```

### Indexer

```bash
cd indexer

# Install dependencies
npm ci

# Type-check (no emit)
npx tsc --noEmit

# Lint
npm run lint

# Unit tests (fast, no infrastructure required)
npm test

# Unit tests with coverage report
npx vitest run --coverage

# Integration tests (requires Docker — starts Postgres + Redis containers)
npm run test:integration
```

### Frontend

```bash
cd frontend/elcarehub-app

# Install dependencies
npm ci

# Type-check
npx tsc --noEmit

# Lint (ESLint + Prettier check)
npm run lint

# Unit + component tests
npm test

# Unit tests with coverage
npm run test:coverage

# Accessibility tests
npm run test:a11y

# Watch mode (development)
npm run test -- --watch
```

### End-to-end

```bash
cd frontend/elcarehub-app

# Install Playwright browsers (first time only)
npx playwright install --with-deps chromium

# Run E2E tests against the mock-chain build
npm run test:e2e

# Run with headed browser for debugging
npx playwright test --headed

# Run a specific spec
npx playwright test tests/e2e/listings.spec.ts

# View the HTML report after a run
npx playwright show-report
```

The E2E suite runs against `npm run dev:e2e`, which builds the frontend with `NEXT_PUBLIC_E2E_MOCK_CHAIN=true` so all on-chain calls return fixture data without a running Soroban node.

---

## Coverage policy

Coverage is enforced as a **ratchet**: thresholds only ever increase. Lowering a threshold requires an explicit PR comment explaining why and review from a maintainer.

### Current thresholds

**Frontend (jest.config.js)**

| Scope | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| Global | 65 % | 55 % | 60 % | 65 % |
| `CheckoutModal.tsx` | 90 % | 75 % | 85 % | 90 % |
| `ListingCard.tsx` | 90 % | 75 % | 85 % | 90 % |
| `lib/ipfs.ts` | 80 % | 65 % | 80 % | 80 % |

**Indexer (vitest.config.mts)**

| Scope | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| Global | 60 % | 50 % | 55 % | 60 % |

When you add a new source file, add a per-file threshold in `jest.config.js` or note it in your PR if the current global threshold is enough.

---

## CI quality gates

The `.github/workflows/ci.yml` pipeline runs the following checks on every PR and `main` push. **All must pass before merge.**

| Check | Job | What it enforces |
|---|---|---|
| Secret scan | `secret-scan` | No hardcoded secrets (Gitleaks) |
| Dependency audit | `dependency-scan` | No high/critical CVEs in npm or Cargo deps |
| Contract formatting | `contracts` | `cargo fmt --check` |
| Contract linting | `contracts` | `cargo clippy` (zero warnings) |
| Contract tests | `contracts` | All unit + proptest cases pass |
| Frontend type-check | `frontend` | `tsc --noEmit` — zero TypeScript errors |
| Frontend lint | `frontend` | `npm run lint` — zero ESLint errors |
| Frontend build | `frontend` | `next build` succeeds |
| Frontend tests | `frontend` | All Jest tests pass |
| Frontend coverage | `coverage-gate` | Global thresholds not regressed |
| Frontend a11y | `frontend` | Zero axe rule violations |
| Frontend E2E | `frontend-e2e` | All Playwright tests pass |
| Indexer type-check | `indexer` | `tsc --noEmit` — zero errors |
| Indexer lint | `indexer` | Zero ESLint errors |
| Indexer build | `indexer` | TypeScript compilation succeeds |
| Indexer unit tests | `indexer` | All Vitest tests pass |
| Indexer coverage | `coverage-gate` | Global thresholds not regressed |
| Indexer integration | `indexer-integration` | API + DB integration tests pass |
| OpenAPI spec | `check-openapi` | Generated spec matches committed spec |
| Version consistency | `release-validate` | Package versions are aligned |
| Container scan | `container-scan` | No high/critical CVEs in Docker image |

---

## Adding new tests

### Indexer unit tests

Create `indexer/src/__tests__/<feature>.test.ts`. Use Vitest globals (`describe`, `it`, `expect`, `vi`) — no imports needed. Mock Prisma and Redis using `vi.hoisted` + `vi.mock` patterns (see `ipfs-cache.test.ts` for a complete example).

Use the shared fixtures from `./helpers/fixtures.ts` to build minimal test data:

```typescript
import { makeMarketplaceEvent, makeListingRow, resetFixtureSequences } from './helpers/fixtures.js';

beforeEach(() => resetFixtureSequences());

it('processes a sold event', async () => {
  const event = makeArtworkSoldEvent({ actor: 'GBUYER...' });
  // ...
});
```

### Frontend component tests

Create `frontend/elcarehub-app/src/__tests__/<Component>.test.tsx`. Import from `@/` (mapped to `src/`). Use React Testing Library (`render`, `screen`, `fireEvent`, `waitFor`).

Use the shared fixtures from `src/__tests__/helpers/fixtures.ts`:

```typescript
import { makeListing, makeArtworkMetadata } from '@/__tests__/helpers/fixtures';

it('renders listing price', async () => {
  const listing = makeListing({ price: 10_000_000n });
  render(<ListingCard listing={listing} />);
  await waitFor(() => expect(screen.getByText(/1 XLM/)).toBeInTheDocument());
});
```

Mock external dependencies at the top of the file using `jest.mock(...)`. See `ListingCard.test.tsx` for a full example with Next.js `Image`, `Link`, and wallet context mocks.

### Contract tests

Append new `#[test]` functions to `contracts/soroban-marketplace/src/test.rs`. Use the `setup()` helper for a fully initialised environment or `setup_with_roles()` for tests that exercise RBAC:

```rust
#[test]
fn test_my_new_behaviour() {
    let (env, client, admin, _, token_id, collection_id) = setup_with_roles();
    client.add_token_to_whitelist(&admin, &token_id);
    // ... assertions ...
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_my_new_behaviour_unauthorized() {
    let (_, client, _, non_admin, _, _) = setup_with_roles();
    client.set_protocol_fee(&non_admin, &100u32); // must panic
}
```

Property-based tests go in `contracts/soroban-marketplace/src/invariant_tests.rs` using the `proptest!` macro.

### E2E tests

Add `.spec.ts` files under `frontend/elcarehub-app/tests/e2e/`. Use `data-testid` attributes to locate elements (they are stable across class-name refactors). Keep tests resilient: prefer `waitForSelector` over fixed `waitForTimeout`. Mock-chain fixtures are controlled via `NEXT_PUBLIC_E2E_MOCK_CHAIN=true`.

```typescript
import { test, expect } from '@playwright/test';

test('my new journey', async ({ page }) => {
  await page.goto('/my-page');
  await expect(page.getByTestId('my-element')).toBeVisible({ timeout: 10_000 });
});
```

---

## Test fixtures and helpers

### Indexer

`indexer/src/__tests__/helpers/fixtures.ts` — typed factory functions for:
- `makeMarketplaceEvent(overrides)` — any event row
- `makeArtworkSoldEvent(overrides)` — ARTWORK_SOLD event
- `makeBidPlacedEvent(auctionId, overrides)` — BID_PLACED event
- `makeOfferMadeEvent(listingId, overrides)` — OFFER_MADE event
- `makeIpfsQueueRow(overrides)` — IpfsQueue row
- `makeIpfsMetadataRow(overrides)` — IpfsMetadata row
- `makeListingRow(overrides)` — Listing DB row
- `resetFixtureSequences()` — reset auto-increment IDs in `beforeEach`

`indexer/src/__tests__/helpers/fake-redis.ts` — in-memory Redis substitute (`FakeRedisBus`, `FakeRedisClient`) for testing the `RealtimeHub` without infrastructure.

### Frontend

`frontend/elcarehub-app/src/__tests__/helpers/fixtures.ts` — typed factory functions for:
- `makeListing(overrides)` — a `Listing` contract object
- `makeArtworkMetadata(overrides)` — an `ArtworkMetadata` IPFS payload
- `makeNotification(overrides)` — an `AppNotification`
- `makeHighPriorityNotification(overrides)` — HIGH-priority notification
- `makeLowPriorityNotification(overrides)` — LOW-priority notification
- `makeActivityEvent(overrides)` — an activity feed event
- `resetFixtureSequences()` — reset auto-increment IDs in `beforeEach`

---

## Debugging failures

### "Coverage threshold not met"
Run `npm run test:coverage` locally and check the summary table. Find the file below threshold and add tests until it passes. Do **not** lower the threshold.

### "TypeScript error in CI but not locally"
Your editor may use a different `tsconfig`. Run `npx tsc --noEmit` in the workspace root to replicate the CI check exactly.

### "Playwright test flaky"
Add `await page.waitForLoadState('networkidle')` before assertions. Increase `timeout` on the specific `expect`. If the test is inherently timing-dependent, use `test.slow()` to triple the timeout for that test only.

### "Cargo clippy warnings"
Run `cargo clippy -- -D warnings` locally to see the exact lint. Most warnings have a suggested fix in the output. Do not `#[allow(...)]` without a comment explaining why.

### "Integration test fails with DB connection error"
The integration suite requires Docker. Run `docker info` to confirm the daemon is running, then `npm run test:integration` again. The `globalSetup.ts` in `src/__tests__/integration/` starts and tears down containers automatically.

---

---

## Pull request templates

This repository provides two PR templates based on the risk level of your change:

### Standard Template (Default)

Use for most changes: bug fixes, refactors, documentation, frontend UI updates, tests, and infrastructure config changes that don't touch high-risk paths.

### High-Risk Change Template

Use when your PR modifies contracts, financial calculations, wallet signing, parser logic, migrations, or operational controls. The high-risk template includes comprehensive checklists for:

- Contract entry points, storage, or events
- Authorization or role-based access control
- Arithmetic (settlement amounts, royalties, fees)
- Signature validation or replay protection
- Database migrations
- Event schema changes

The high-risk template includes checklists for:
- Authorization & access control
- Replay protection & signature safety
- Arithmetic & financial calculations
- Event schema & compatibility
- Reorg behavior & idempotency
- Secrets management
- Database migrations
- Tests & documentation

**When to use the high-risk template:**
- Your PR touches `contracts/`, `indexer/src/event-parser.ts`, or `prisma/schema.prisma`
- Your PR modifies wallet signing, transaction simulation, or contract deployment
- Your PR changes authorization, role-based access, or admin controls
- Your PR modifies financial settlement logic, arithmetic, or escrow refunds
- You are unsure if your change is high-risk (use the template and skip irrelevant sections)

**How to select the template:**

When opening a PR on GitHub, add `?template=high_risk_change.md` to the URL:
```
https://github.com/ORG/REPO/compare/main...your-branch?template=high_risk_change.md
```

Or, after opening a standard PR, replace the description with the high-risk template content from [`.github/PULL_REQUEST_TEMPLATE/high_risk_change.md`](../.github/PULL_REQUEST_TEMPLATE/high_risk_change.md).

See [`.github/PULL_REQUEST_TEMPLATE/high_risk_change.md`](../.github/PULL_REQUEST_TEMPLATE/high_risk_change.md) for the full checklist.

---

## Support request template

Users experiencing transaction failures, wallet issues, indexer lag, or other problems can open a support request using the **[Support Request Issue Template](../.github/ISSUE_TEMPLATE/support_request.md)**.

The template guides users to provide:
- Transaction hash, network, wallet type, and timestamp
- Error codes and messages (safe to share)
- Reproduction steps and diagnostic context

**Security notice:** The template explicitly warns users NOT to share private keys, seed phrases, or credential-bearing URLs. Support engineers can investigate using public transaction hashes and error codes alone.

For support response guidance, safe diagnostic collection, severity classification, and escalation paths, see **[Support Triage Guide](../docs/guides/support-triage.md)**.
