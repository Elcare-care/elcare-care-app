# Contract Upgrade & Migration Runbook

Covers every contract in the workspace:
- `soroban-marketplace` (versions 1.0.0 → 1.1.0 already shipped; future bumps follow the same pattern)
- `launchpad`
- `collection_nft_erc721`
- `collection_nft_erc1155`
- `lazy_mint_erc721`
- `lazy_mint_erc1155`

---

## Design principles

| Principle | Implementation |
|-----------|---------------|
| Idempotent | `migrate()` records a `MigrationDone(version)` key. Calling it again returns `AlreadyMigrated`. |
| Resumable | `migrate_step(admin, max_items)` processes a bounded batch and saves a `MigrationCursor`. Call repeatedly until it returns `0`. |
| Queryable | `version()` returns the WASM version. `contract_version()` returns the last on-chain migration target. They should match after a successful upgrade. |
| Observable | Every completed migration emits `("migrated", version_string)` as a Soroban event. |
| Auth-guarded | `migrate()` requires the admin's signature on all contracts. |

---

## Pre-flight checklist

1. Confirm you have the Stellar CLI installed: `stellar --version`
2. Confirm you hold the admin key (or have its signing authority).
3. Run unit tests against the new WASM: `cargo test -p <contract-name>`.
4. Build the release WASM:
   ```bash
   cargo build --target wasm32v1-none --release -p <contract-name>
   ```
5. Verify the WASM size is reasonable (Stellar's contract size limit is 128 KB):
   ```bash
   ls -lh target/wasm32v1-none/release/<contract_name>.wasm
   ```

---

## Step-by-step upgrade procedure

### 1. Upload the new WASM

```bash
stellar contract upload \
  --wasm target/wasm32v1-none/release/<contract_name>.wasm \
  --network <network> \
  --source <admin-key-name>
```

Copy the 32-byte hex hash printed to stdout — you'll need it in step 2.

---

### 2. Install the new WASM into the existing contract address

```bash
stellar contract install \
  --wasm-hash <new-wasm-hash> \
  --contract-id <contract-address> \
  --network <network> \
  --source <admin-key-name>
```

At this point the contract address is live on the new WASM but the storage has not been migrated yet.

---

### 3. (Launchpad only) Update child-contract WASM hashes

If you also upgraded any of the four NFT WASMs, call `set_wasm_hashes` on the launchpad so future `deploy_*` calls use the new version:

```bash
stellar contract invoke \
  --id <launchpad-address> \
  --network <network> \
  --source <admin-key-name> \
  -- set_wasm_hashes \
     --wasm_normal_721  <normal-721-hash> \
     --wasm_normal_1155 <normal-1155-hash> \
     --wasm_lazy_721    <lazy-721-hash> \
     --wasm_lazy_1155   <lazy-1155-hash>
```

---

### 4. Run the migration

#### Option A — unbounded (small datasets, ≤1 000 records)

```bash
stellar contract invoke \
  --id <contract-address> \
  --network <network> \
  --source <admin-key-name> \
  -- migrate \
     --admin <admin-address>
```

#### Option B — bounded / resumable (large datasets)

```bash
# Call repeatedly until the returned value is 0
stellar contract invoke \
  --id <contract-address> \
  --network <network> \
  --source <admin-key-name> \
  -- migrate_step \
     --admin <admin-address> \
     --max_items 200
```

Tip: wrap the bounded call in a shell loop:

```bash
while true; do
  REMAINING=$(stellar contract invoke \
    --id <contract-address> --network <network> --source <admin-key-name> \
    -- migrate_step --admin <admin-address> --max_items 200 2>&1 | tail -1)
  echo "Remaining: $REMAINING"
  [ "$REMAINING" -eq 0 ] && break
  sleep 2
done
```

---

### 5. Post-upgrade verification

#### a) Confirm version strings match

```bash
stellar contract invoke --id <contract-address> --network <network> -- version
# Output: "1.1.0"   (or whatever the new version is)

stellar contract invoke --id <contract-address> --network <network> -- contract_version
# Output: "1.1.0"   — must match `version()`
```

If `contract_version()` returns `None` the migration did not complete.

#### b) Verify the `migrated` event was emitted

```bash
stellar events \
  --contract-id <contract-address> \
  --network <network> \
  --topic1 migrated
```

You should see one event per migration execution with the version string as the second topic entry.

#### c) Spot-check critical state

**Marketplace:**
```bash
# Check a known listing is still readable
stellar contract invoke --id <marketplace> --network <network> \
  -- get_listing --listing_id <known-id>

# Active listings count should be non-zero if listings existed
stellar contract invoke --id <marketplace> --network <network> \
  -- get_active_listings_count
```

**Launchpad:**
```bash
stellar contract invoke --id <launchpad> --network <network> \
  -- collection_count

stellar contract invoke --id <launchpad> --network <network> \
  -- wasm_version
```

**NFT contracts (per collection):**
```bash
# Token ownership
stellar contract invoke --id <collection> --network <network> \
  -- owner_of --token_id 0

# Royalty info
stellar contract invoke --id <collection> --network <network> \
  -- royalty_info
```

---

## Rollback limitations

Soroban contracts **cannot be downgraded** to an earlier WASM once a migration marker is written to persistent storage, because:

1. The `MigrationDone(version)` key persists across WASM upgrades.
2. A downgraded WASM would still see the completion marker and refuse to re-migrate.
3. Storage layouts changed by the migration are not automatically reversed.

**Mitigation strategy (recommended):**

- Always test migrations on a fork / testnet before mainnet.
- Keep the previous WASM hash. If the new WASM has a critical bug, you can re-install the old WASM hash. The old code will run against the new storage layout — verify compatibility first.
- For the marketplace, the `admin_pause` / `admin_unpause` functions let you halt operations while diagnosing issues without requiring a WASM revert.

---

## Supported version transitions

Each contract only supports sequential upgrades (n → n+1). Attempting to jump multiple versions in one `migrate()` call returns `UnsupportedMigration`.

| From | To | Supported? |
|------|----|-|
| (fresh install) | 1.0.0 | ✅ |
| 1.0.0 | 1.1.0 | ✅ (marketplace only, already shipped) |
| 1.0.0 | 2.0.0 | ❌ Must go 1.0.0 → 1.1.0 → 2.0.0 |

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `AlreadyMigrated` | `migrate()` called twice for the same version | Check `contract_version()` — migration already succeeded. |
| `Unauthorized` | Caller is not the admin | Use the correct admin key in `--source`. |
| `UnsupportedMigration` | Version jump skipped a release | Apply intermediate migrations first. |
| `migrate_step` returns non-zero forever | Budget too small to make progress | Increase `max_items` — minimum 1 per call. |
| `contract_version()` returns `None` after `migrate()` | Transaction failed silently | Check transaction status; re-run migration. |

---

## Quick reference — all contracts

| Contract | `migrate()` auth | Storage type migrated in v1.0.0 |
|----------|-----------------|--------------------------------|
| `soroban-marketplace` | admin address | `Vec<u64>` listing/auction/offer indices → paged index engine |
| `launchpad` | admin address | `AllCollections` / `ByCreator` Vec → paged `CollectionByIndex` keys |
| `collection_nft_erc721` | creator address | (none — initial version baseline) |
| `collection_nft_erc1155` | creator address | (none — initial version baseline) |
| `lazy_mint_erc721` | creator address | (none — initial version baseline) |
| `lazy_mint_erc1155` | creator address | (none — initial version baseline) |
