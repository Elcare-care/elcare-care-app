# Contributing to ElcareHub

Thank you for contributing. This guide covers development workflow, testing expectations, and quality gates enforced in CI.

## Development workflow

1. Fork the repository and create a feature branch: `git checkout -b feat/your-feature`
2. Install dependencies in the area you are changing (`frontend/elcarehub-app`, `indexer`, or root for contracts)
3. Run the relevant lint, test, and build commands locally before opening a PR
4. Open a pull request with a clear summary and test plan

## Frontend test coverage (ISSUE-113)

Jest collects coverage in CI for `frontend/elcarehub-app`. Thresholds are set at the **current baseline** so CI does not break unexpectedly; raise them when you add meaningful tests.

| Scope | Policy |
|-------|--------|
| **Global** | Minimum ~60% statements/lines, ~50% branches, ~55% functions |
| **Critical paths** | Higher floors on checkout, listing cards, marketplace hooks, and contract helpers |
| **Ratchet** | When adding tests in an area, bump that area's threshold in `jest.config.js` |

### Commands

```bash
cd frontend/elcarehub-app
npm run test              # unit/component tests
npm run test:coverage     # coverage + threshold enforcement
npm run test:a11y         # jest-axe component checks
npm run test:e2e          # Playwright (starts dev server in mock-chain mode)
```

Coverage reports are written to `frontend/elcarehub-app/coverage/` and uploaded as a CI artifact on every run.

## End-to-end tests (ISSUE-114)

Playwright specs run against `npm run dev:e2e` (`NEXT_PUBLIC_E2E_MOCK_CHAIN=true`) so wallet and chain calls are deterministic via `e2e-chain-mock.ts` and `useE2eWallet`.

- Prefer stable `data-testid` selectors for flows that cross pages or modals
- Core purchase path: connect mock wallet → browse explore → checkout → success
- E2E HTML reports are published as CI artifacts when tests run in CI

## Indexer integration tests (ISSUE-117)

Unit tests mock Postgres/Redis. Integration tests hit **real** ephemeral services:

```bash
cd indexer
docker compose up -d db redis
npm run test:integration
```

CI runs migrations and `prisma db seed` before the integration suite. Keep integration tests focused on query correctness, migrations, and cache behavior.

## Accessibility (ISSUE-118)

- **Component level:** `jest-axe` in `src/__tests__/a11y/`
- **Page level:** Playwright + `@axe-core/playwright` in `tests/e2e/a11y.spec.ts`

Fix serious/critical violations (labels, roles, focus management, contrast) before merging UI changes. Modals must trap focus while open and restore focus on close (`useModalA11y`).

## Architecture & Debugging Guides

Refer to our focused architecture and debugging guides for component boundaries, diagnostic decision trees, log samples, and Safe Redaction guidance:

- 🏗️ **[Local Architecture](docs/guides/local-architecture.md)**: System overview and service boundaries
- 🦀 **[Contract Testing](docs/guides/contract-testing.md)**: Soroban WASM build and unit testing
- 🔄 **[Indexer Ingestion](docs/guides/indexer-ingestion.md)**: Polling, stall recovery, and backfill
- 🏷️ **[Event Parsing](docs/guides/event-parsing.md)**: Soroban XDR event decoding and schemas
- 💻 **[Frontend Transaction Debugging](docs/guides/frontend-transaction-debugging.md)**: Transaction signing, error codes, and E2E testing
- 🚀 **[Deployment](docs/guides/deployment.md)**: Contract, indexer container, and frontend releases
- 🗄️ **[Database Migrations](docs/guides/database-migrations.md)**: Prisma migrations and zero-downtime rules
- 🛡️ **[Security Triage](docs/guides/security-triage.md)**: Cargo audit, npm audit, Gitleaks, and secret redaction

## Documentation Review Policy

> [!IMPORTANT]
> A **Documentation Review** is a mandatory prerequisite for all release checklists and PRs involving major architecture changes.

When introducing schema updates, new event topics, smart contract entry points, environment variables, or API endpoints:
1. Update the corresponding guide in `docs/guides/` to reflect new parameters, failure modes, or diagnostic steps.
2. Verify all path links and environment variable names match the repository.
3. Ensure no example command or log output requests or prints un-redacted secrets.

## Reliability backlog

Cross-cutting reliability work (contracts, indexer, caches, UX, security, a11y, privacy, support) is
tracked in [docs/reliability/backlog.md](docs/reliability/backlog.md). Domain owners and the
[quarterly review process](docs/reliability/quarterly-review-process.md) apply when triaging
long-lived GitHub issues: close obsolete items with rationale, or link them to a backlog ID.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(frontend): add checkout coverage thresholds`.


## Contract changes and threat-model review

Any pull request that modifies files under `contracts/` — entry points, settlement logic, authorization, signatures, storage layout, events, or deployment scripts — **must** include a completed threat-model record and an independent review before it can merge.

### Process

1. **Copy the template** — `docs/threat-model-template.md`
2. **Save it** as `docs/threat-models/TM-YYYY-MM-DD-short-description.md`
3. **Complete all sections** — work through every row in section 4 (the threat checklist) and every box in section 6 (flow-specific review)
4. **Log open findings** in section 7 with severity, owner, and residual risk
5. **Get an independent review** — a second engineer who did not author the change must sign section 8
6. **Link the record** in the PR description under "Contract change review"
7. **Commit the record** to the same branch so the CI gate can find it

### CI enforcement

`.github/workflows/contract-threat-model-gate.yml` runs on every PR that touches `contracts/**/src/*.rs`. It fails if:

- No file was added or modified under `docs/threat-models/`
- The threat-model file still contains the unfilled template stub in the reviewer sign-off (section 8)

The gate is a **required status check** — add it to your branch protection rules alongside the existing contract and frontend checks.

### Severity guidance

| Severity | Description |
|---|---|
| Critical | Can drain funds or take full admin control |
| High | Significant value at risk; requires specific but realistic conditions |
| Medium | Limited impact or requires unlikely attacker preconditions |
| Low | Informational; acknowledged risk with no immediate action |

High and Critical findings must be mitigated or have a documented accepted-risk decision before merge. Medium and Low findings may be accepted with a tracking issue.

### Reference examples

See `docs/threat-models/TM-2026-07-27-marketplace-purchase-auction-offer-lazy-mint.md` for an annotated example covering the core marketplace flows.
