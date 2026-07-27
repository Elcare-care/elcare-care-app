# Coverage Policy

**Work item D** — Component-specific coverage thresholds, exclusions, tooling, and the ratchet process.

## Overview

A single global percentage is a misleading signal. This policy sets named coverage tools and minimum thresholds per component, focuses investment on high-risk paths, and requires all changes to be reviewed rather than silently accepted.

---

## Coverage Tools by Component

| Component | Tool | Config Location | Report Artifact |
|-----------|------|-----------------|-----------------|
| Rust contracts | `cargo llvm-cov` (see note below) | `Cargo.toml` / `mutants.toml` | `coverage/contracts/` |
| Indexer (unit) | `vitest` with `v8` coverage | `indexer/vitest.config.mts` | `indexer/coverage/` |
| Indexer (integration) | `vitest` with `v8` coverage | `indexer/vitest.integration.config.mts` | `indexer/coverage-integration/` |
| Frontend (unit/component) | `jest` with `babel-jest` + Istanbul | `frontend/elcarehub-app/jest.config.js` | `frontend/elcarehub-app/coverage/` |
| E2E workflows | Playwright (no line coverage) | `playwright.config.ts` | Playwright HTML report |

> **Rust contracts note:** `cargo-llvm-cov` is the recommended tool for Soroban contract coverage. The mutation testing configuration in `mutants.toml` supplements line coverage by measuring branch kill rates for critical arithmetic and state transitions. See `MUTATION_TESTING.md` for the current mutation score baseline.

---

## Thresholds

### Frontend (Jest)

Thresholds are defined in `frontend/elcarehub-app/jest.config.js` under `coverageThreshold`.

| Scope | Statements | Branches | Functions | Lines |
|-------|-----------|---------|----------|-------|
| Global | 60% | 50% | 55% | 60% |
| `src/components/CheckoutModal.tsx` | 90% | 75% | 85% | 90% |
| `src/components/ListingCard.tsx` | 90% | 75% | 85% | 90% |
| `src/hooks/useMarketplace.ts` | 55% | 45% | 50% | 55% |
| `src/lib/contract.ts` | 15% | 10% | 10% | 15% |
| `src/lib/disclosures.ts` | 80% | 70% | 75% | 80% |
| `src/lib/support.ts` | 80% | 70% | 75% | 80% |

> `src/lib/contract.ts` has a low threshold because most of its surface is integration-only (live Soroban RPC) and is not practical to unit-test. The integration path is covered by E2E tests. Document any new integration-only exports in the **Exclusions** section below.

### Indexer (Vitest)

Thresholds are not yet enforced by CI for the indexer unit suite but will be added once a baseline report is committed. The target is:

| Scope | Statements | Branches |
|-------|-----------|---------|
| `src/parser.ts` | 80% | 70% |
| `src/event-schemas.ts` | 85% | 80% |
| `src/keeper/**` | 70% | 60% |
| Global | 65% | 55% |

Add these to `vitest.config.mts` under `coverage.thresholds` once baseline reports confirm they are reachable.

### Rust Contracts

Mutation score targets (from `MUTATION_TESTING.md`):

| Contract | Minimum Kill Rate |
|----------|-----------------|
| `soroban-marketplace` | 70% |
| `launchpad` | 65% |
| `collection_nft_erc721` | 60% |

---

## Exclusions

The following paths are excluded from coverage enforcement. Each exclusion is documented here to prevent scope creep.

### Frontend Jest (`collectCoverageFrom`)

| Pattern | Reason |
|---------|--------|
| `src/**/*.d.ts` | Type declaration files; no executable code |
| `src/**/__tests__/**` | Test files themselves |
| `src/app/**/layout.tsx` | Next.js layout wrappers; integration-tested via E2E |
| `src/app/**/loading.tsx` | Loading skeletons; visual-only, tested via snapshot |
| `src/app/**/error.tsx` | Error boundaries; functional tests in `RootErrorBoundary.test.tsx` |
| `src/app/**/not-found.tsx` | 404 pages; integration-only |

### Indexer Vitest

| Pattern | Reason |
|---------|--------|
| `src/__tests__/integration/**` | Requires live Postgres/Redis; runs in separate CI job |
| `src/generate-openapi.ts` | Code generation utility; diff-checked in CI instead |
| `src/cli.ts` | CLI entry point; tested via shell scripts |

### Rust

| Crate path | Reason |
|------------|--------|
| `contracts/*/src/test.rs` | Test modules |
| Soroban SDK macro expansions | Generated code |

---

## Ratchet Process

1. **Establish baseline.** On every quality run, CI uploads the coverage report as an artifact (`frontend-coverage-node20`).
2. **Never lower thresholds** without opening a PR titled `[coverage] Lower threshold for <path>` and documenting the reason in this file.
3. **Increment thresholds incrementally.** After new tests are merged that meaningfully raise coverage, update `jest.config.js` thresholds in the same PR. Target increments of 5%.
4. **PR reporting.** The `Run Tests with Coverage` step in CI fails the build if coverage drops below threshold. Coverage summaries are visible in CI logs and in the uploaded HTML artifact.
5. **Changed-slice policy.** If a PR touches a file with a per-file threshold and reduces its coverage, the CI build will fail. This is intentional.

---

## High-Risk Paths (targeted even when global coverage is high)

These paths require dedicated tests regardless of global percentage:

| Path | Risk | Current Test Location |
|------|------|-----------------------|
| `soroban-marketplace` overflow checks | Financial arithmetic; overflow = fund loss | `contracts/soroban-marketplace/src/invariant_tests.rs` |
| `src/lib/disclosures.ts` | Disclosure gates block signing; bugs bypass user consent | `src/__tests__/disclosures.test.ts` (to be added) |
| `src/lib/support.ts` `containsSecret()` | Incorrectly passing a secret to support would be a severe data exposure | `src/__tests__/support.test.ts` (to be added) |
| `indexer/src/parser.ts` | Misparse = wrong financial state stored | `indexer/src/__tests__/parser.test.ts` |
| `indexer/src/event-schemas.ts` | Schema mismatch = silent data loss | `indexer/src/__tests__/event-catalog.test.ts` |
| `indexer/src/keeper/tx-pipeline.ts` | Keeper double-execution = duplicate settlement | `indexer/src/__tests__/keeper-unit.test.ts` |

---

## Contributor Guidance

- When adding a new financial action (new contract entrypoint, new UI flow), add it to the **High-Risk Paths** table and write targeted tests before the PR is merged.
- When adding a new component, add it to `collectCoverageFrom` and set an initial per-file threshold matching the current coverage level.
- Generated files (e.g. Prisma client, ABI types) must be listed in the **Exclusions** table.
- Coverage reports are not a substitute for meaningful assertions. A test that exercises a path but makes no assertion does not count as quality coverage.
