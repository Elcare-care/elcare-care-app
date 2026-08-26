## Summary

<!-- What does this change do? Why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Contract change ← **see threat-model section below**
- [ ] Infrastructure / deployment

---

## 🔐 High-Risk Change Checklist

> **This PR modifies high-risk paths.** Complete all applicable sections below before requesting review.

### Authorization & Access Control
- [ ] All new entry points verify `env.invoker()` against stored authorized addresses
- [ ] Role-based checks (admin, artist, operator) are explicit and tested
- [ ] No admin-only path can be reached by non-admin callers
- [ ] Authorization failures return clear error codes and are covered by `#[should_panic]` tests

### Replay Protection & Signature Safety
- [ ] Lazy-mint vouchers include nonce or unique token ID to prevent replay
- [ ] Signed payloads are bound to contract address and network passphrase
- [ ] No signature can be replayed across different environments (testnet/mainnet)
- [ ] Frontend validates network passphrase before wallet signing (see `frontend-transaction-debugging.md`)

### Arithmetic & Financial Calculations
- [ ] All arithmetic uses checked operations (`checked_add`, `checked_mul`, `checked_div`)
- [ ] Overflow/underflow scenarios have explicit unit tests
- [ ] Settlement amounts (price, royalty splits, protocol fees) are manually verified against spec
- [ ] No rounding that could cause dust accumulation or loss of user funds

### Event Schema & Compatibility
- [ ] New events are added to `contracts/soroban-marketplace/EVENTS.md`
- [ ] Events are added to indexer event catalog (`indexer/src/event-catalog.ts`)
- [ ] Event field types match indexer Zod schemas
- [ ] `npm run test:event-catalog` passes
- [ ] Migration plan exists if event schema is incompatible with prior versions

### Reorg Behavior & Idempotency
- [ ] Contract state changes are atomic within a single transaction
- [ ] Indexer handlers are idempotent (safe to process same event twice)
- [ ] No user action (bid, purchase, listing) can be settled more than once
- [ ] Tests cover reorg scenarios where transactions are reverted

### Secrets Management
- [ ] No API keys, private keys, or credentials in code or test fixtures
- [ ] Environment variables follow redaction guidance in `frontend-transaction-debugging.md`
- [ ] Secrets are loaded from environment only, never hardcoded
- [ ] CI does not require secrets for build or test steps

### Database Migrations
- [ ] New migrations follow `CONTRIBUTING-SCHEMA-CHANGES.md` guidelines
- [ ] Migration is idempotent and safe to run multiple times
- [ ] Rollback plan documented if migration cannot be automatically reversed
- [ ] Zero-downtime constraints verified (no table locks on large tables)

### Tests & Documentation
- [ ] Unit tests cover all new authorization paths
- [ ] Integration tests cover end-to-end flow (contract → indexer → API → frontend)
- [ ] Failure modes (insufficient balance, unauthorized access, replay) have explicit tests
- [ ] Runbook or operational guide updated if deployment steps changed
- [ ] Threat model updated if new attack surface introduced

---

## ⚠️ Contract Change Review (required if any contract file is modified)

> Skip this section entirely if no file under `contracts/` was modified.
> If any contract entry point, storage schema, event, authorization check,
> settlement path, signature, or deployment script was changed, **every item
> below is mandatory**. The PR cannot merge until the independent reviewer
> signs off.

### Affected entry points

<!-- List every function that was added, removed, or modified -->

- [ ] No contract files were modified (skip the rest of this section)

### Threat-model record

- [ ] A completed `docs/threat-model-template.md` record has been committed to
      this branch at `docs/threat-models/TM-<YYYY-MM-DD>-<short-title>.md`
- [ ] The record link: <!-- paste path or permalink here -->

### Contract change checklist

#### Funds and settlement
- [ ] Settlement amounts (price, royalties, fee) were manually verified against spec
- [ ] All arithmetic uses checked operations or has overflow unit tests
- [ ] No listing, auction, or offer can be settled more than once
- [ ] Escrow refund paths (losing bids, withdrawn offers, expired offers) are covered by tests

#### Authorization
- [ ] Every new entry point has an explicit authorization check
- [ ] Admin-only paths verify `env.invoker()` against the stored admin address
- [ ] Role changes (admin transfer, artist revoke/reinstate) require the correct proposer

#### Replay and signature integrity
- [ ] Lazy-mint vouchers include a nonce or token ID preventing replay
- [ ] No signed payload can be used across different contract deployments
- [ ] Network passphrase is validated before any signature is accepted

#### Storage migration
- [ ] New storage keys are namespaced to avoid collision with existing keys
- [ ] Migration steps are idempotent (safe to run more than once)
- [ ] Existing data (listings, auctions, offers) remains readable after the upgrade
- [ ] Rollback to the previous WASM is tested or explicitly declared impossible

#### Events
- [ ] Every new event is added to the indexer event catalog (`event-catalog.ts`)
- [ ] Event fields match the schema documented in `contracts/soroban-marketplace/EVENTS.md`
- [ ] `npm run test:event-catalog` passes with the new event included

### Independent reviewer sign-off

> **A second engineer who did not author the change must check this box.**
> By checking it you confirm: you have read the diff, reviewed the threat-model
> record, verified every High/Critical finding is mitigated or accepted, and
> the contract change checklist above is complete.

- [ ] Independent review complete — reviewer: @<!-- github handle -->

---

## Testing

- [ ] Unit / integration tests pass (`cargo test`, `npm test`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] Manual testing performed (describe below)

Manual test steps:

---

## Related issues

<!-- Closes #, Fixes # -->

## Release notes

<!-- What should appear in CHANGELOG.md for this change? -->
