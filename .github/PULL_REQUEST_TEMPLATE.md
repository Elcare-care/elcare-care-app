## Summary

<!-- What does this change do? Why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Contract change ← **see threat-model section below**
- [ ] Infrastructure / deployment

## Testing

- [ ] Unit / integration tests pass (`cargo test`, `npm test`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] Manual testing performed (describe below)

Manual test steps:

---

## ⚠️ Contract change review (required if any contract file is modified)

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

## Related issues

<!-- Closes #, Fixes # -->

## Release notes

<!-- What should appear in CHANGELOG.md for this change? -->
