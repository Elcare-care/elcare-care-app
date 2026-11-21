# Launchpad Contract — Upgrade & Migration Checklist

> **Scope**: This checklist covers every operator action required when upgrading
> the launchpad WASM or any of the four collection WASMs it manages.  Work
> through the Pre-upgrade section before you submit the upgrade transaction, and
> the Post-upgrade section immediately after.  Record evidence (tx hash, output
> snippet, ledger sequence) in the deployment incident or PR that tracks this
> upgrade.

---

## Version reference

| Constant | Location | Current value |
|----------|----------|---------------|
| `CONTRACT_VERSION` | `contracts/launchpad/src/types.rs` | `"1.0.0"` |
| On-chain version key | `DataKey::ContractVersion` (instance storage) | set by `migrate()` |
| WASM version counter | `DataKey::WasmVersion` (instance storage) | incremented by `set_wasm_hashes()` |

The two-version design is intentional:

* `version()` — returns the **binary** version compiled into the uploaded WASM.
* `contract_version()` — returns the **storage** version last written by
  `migrate()`.  Returns `None` until the first migration runs.

After uploading a new WASM, `version() ≠ contract_version()` until the operator
calls `migrate()` or `migrate_step()`.  This gap is the signal that migration is
required.

---

## Pre-upgrade checklist

### 1 — Verify binary version
```bash
# Inspect the WASM to be uploaded — the version string must match what you
# expect before you commit to the network.
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn version
# Expected: "1.0.0"  (or the new target version for the upgrade)
```
- [ ] `version()` returns the expected string.

### 2 — Record the current on-chain version
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn contract_version
# Expected before first migration: (none)
# Expected after any prior migration: the version string from that migration
```
- [ ] `contract_version()` output recorded.  `None` is acceptable only on a
  first-ever deploy; any other gap between `version()` and `contract_version()`
  means a previous upgrade cycle was not completed — resolve that first.

### 3 — Check the migration-done marker
If `contract_version()` already matches the binary `version()`, the migration
for this version is already marked complete.  Calling `migrate()` again will
return `Error::AlreadyMigrated` (code 16) — this is correct and not an error.

- [ ] Confirm whether a migration is needed for this version:
  - `contract_version() == version()` → migration already done, skip Step 5.
  - `contract_version() == None` or older string → migration required.

### 4 — Confirm collection registry is consistent
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn collection_count
# Note the number.
```
- [ ] `collection_count()` recorded (must not change after migration).

### 5 — Check the pause state
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn is_paused
```
- [ ] If `true`, decide whether to unpause before or after the upgrade.
  Deployments are blocked while paused — this is intentional for upgrades.

### 6 — Snapshot the WASM hashes currently in storage
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn wasm_hashes
# Records: { normal_721, normal_1155, lazy_721, lazy_1155, version }
```
- [ ] WASM hash set and version counter recorded.

---

## Upgrade execution

### Upload new WASM(s) and record hashes
```bash
HASH_N721=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/collection_nft_erc721.wasm $NETWORK)
# Repeat for other WASMs as needed.
```
- [ ] Each new hash recorded before proceeding.

### (Optional) Upgrade the launchpad WASM itself
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn upgrade -- --new_wasm_hash $NEW_LAUNCHPAD_HASH
```
An `upgraded` event `(old_hash, new_hash)` is emitted.  After this point
`version()` will return the new binary version and `contract_version()` will
still report the old one until `migrate()` runs.

- [ ] `upgraded` event tx hash recorded.

### Register new collection WASM hashes (if any collection WASMs changed)
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn set_wasm_hashes -- \
  --wasm_normal_721  $HASH_N721  \
  --wasm_normal_1155 $HASH_N1155 \
  --wasm_lazy_721    $HASH_L721  \
  --wasm_lazy_1155   $HASH_L1155
# Returns: new wasm_version counter (monotonically increasing u32).
```
A `wasm_set` event `(version, normal_721, normal_1155, lazy_721, lazy_1155)` is
emitted.

- [ ] `set_wasm_hashes` tx hash recorded.
- [ ] `wasm_version()` incremented by 1 from the pre-upgrade value.

---

## Migration execution

> Skip this section if `contract_version() == version()` from Step 3 above.

### Option A — Single call (small state)
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn migrate -- --admin $ADMIN_ADDRESS
# Returns: ()  on success.
# Returns: Error code 16 (AlreadyMigrated) if already done.
```

### Option B — Resumable (large state)
Call `migrate_step` repeatedly until it returns `0`:
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn migrate_step -- --admin $ADMIN_ADDRESS --max_items 500
# Returns: remaining item count (u64).  Call again while > 0.
```

Both options:
- Emit a `("migrated", version)` event when complete.
- Write `DataKey::ContractVersion` with the new version string.
- Set `DataKey::MigrationDone(version)` to prevent re-runs.
- Clear any `DataKey::MigrationCursor(version)` resumable cursor.

- [ ] `migrate` / `migrate_step` tx hash(es) recorded.

---

## Post-upgrade checklist

### 1 — Verify the binary version
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn version
```
- [ ] Returns the new expected version string.

### 2 — Verify the on-chain version matches
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn contract_version
```
- [ ] Returns the same string as `version()`.  Any mismatch means migration
  did not complete — rerun `migrate_step` until it returns 0.

### 3 — Confirm collection registry is unchanged
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn collection_count
```
- [ ] Count equals the value recorded in Pre-upgrade Step 4.

### 4 — Confirm WASM version counter incremented
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK --fn wasm_version
```
- [ ] Counter is Pre-upgrade value + number of `set_wasm_hashes` calls made.

### 5 — Check the migrated event
Confirm the `migrated` event was emitted with the correct version topic:
```bash
# Via Stellar Horizon or the indexer:
# topics[0] = Symbol("migrated")
# topics[1] = String(<new version>)
# data      = ()
```
- [ ] Event present with correct version topic.

### 6 — Spot-check an existing collection record
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn get_collection -- --address $KNOWN_COLLECTION_ADDRESS
```
- [ ] Record is intact and matches pre-upgrade snapshot.

### 7 — Spot-check a new deploy end-to-end
Deploy one collection via the upgraded launchpad to confirm the new WASM
hashes work:
```bash
stellar contract invoke --id $LAUNCHPAD $NETWORK \
  --fn deploy_normal_721 -- \
  --creator $CREATOR_ADDRESS \
  --currency $CURRENCY_ADDRESS \
  --name "Smoke Test" \
  --symbol "SMKT" \
  --max_supply 10 \
  --royalty_bps 0 \
  --royalty_receiver $CREATOR_ADDRESS \
  --platform_fee_bps 0 \
  --salt $(openssl rand -hex 32)
# Returns: deployed collection address.
```
- [ ] Returns a valid contract address.
- [ ] `collection_count()` incremented by 1.

---

## Error codes reference

| Code | Name | Meaning |
|------|------|---------|
| 1 | `AlreadyInitialized` | `initialize` called more than once |
| 2 | `NotInitialized` | Action before `initialize` |
| 3 | `NotAdmin` | Caller does not match stored admin |
| 4 | `WasmHashNotSet` | `set_wasm_hashes` not yet called |
| 5 | `InvalidFeeBps` | Platform fee bps > `MAX_FEE_BPS` (2000) |
| 6 | `ContractPaused` | Deployments halted by pause |
| 7 | `InvalidDeployFee` | Negative `deploy_fee` rejected |
| 10 | `DuplicateSalt` | `(creator, salt)` pair already used |
| 11 | `InvalidRoyaltyBps` | Royalty bps > 10 000 |
| 15 | `InsufficientFee` | Creator balance < `deploy_fee` |
| 16 | `AlreadyMigrated` | `migrate()` called for a version whose marker is already set |
| 17 | `CollectionNotFound` | Address lookup returned no record |
| 21 | `MarketplaceNotConfigured` | `set_collection_protocol_fee` before marketplace address is set |
| 22 | `CollectionNotOurs` | Collection not deployed by this launchpad |

---

## Rollback

Contracts are immutable once deployed on Stellar.  "Rollback" means uploading
the previous WASM hash via `upgrade()` and rerunning `set_wasm_hashes` to
restore the old collection WASMs.  The on-chain migration-done marker for the
new version **remains set** after a rollback — do not attempt to call
`migrate()` for the rolled-back version after restoring; the idempotency
marker will return `AlreadyMigrated`.

If the migration corrupted storage (should not happen given the idempotent
phase design), restore from the last Horizon ledger snapshot and re-derive
state.  Contact the team before taking any destructive action.

---

## Linked tests

The invariants in this checklist are covered by unit tests in
`contracts/launchpad/src/migration_tests.rs` (Issue #1100):

| Invariant | Test |
|-----------|------|
| `version()` returns compile-time constant | `version_returns_compile_time_constant` |
| `contract_version()` is None before migration | `contract_version_is_none_before_first_migration` |
| `migrate()` admin-gated | `migrate_rejects_non_admin` |
| `migrate()` succeeds once | `migrate_succeeds_once_and_records_marker` |
| `contract_version()` == `version()` after migration | `contract_version_matches_version_after_migration` |
| `migrate()` idempotent | `migrate_is_idempotent_returns_already_migrated_on_second_call` |
| `migrate_step()` succeeds | `migrate_step_first_call_succeeds` |
| `migrate_step()` returns 0 on completion | `migrate_step_returns_zero_remaining_on_completion` |
| `migrate_step()` sets contract_version | `migrate_step_sets_contract_version_after_last_step` |
| `migrated` event emitted | `migrate_emits_migrated_event_with_version_topic` |
| `version()` != `contract_version()` until migration | `version_differs_from_contract_version_until_migration_runs` |
| Registry not corrupted by migrate | `migrate_does_not_corrupt_collection_registry` |
| `migrate_step()` refuses after `migrate()` | `migrate_step_returns_already_migrated_after_migrate_completes` |
| `CONTRACT_VERSION` constant pinned | `contract_version_constant_is_1_0_0` |
