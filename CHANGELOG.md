# Changelog

All notable changes to ElcareHub are documented here. Each release entry lists component versions, required migrations, rollback notes, and compatibility constraints.

## [Unreleased]

### Added

- **`set_collection_protocol_fee` on the launchpad (Issue #849).** The launchpad admin can now configure the marketplace's per-collection protocol fee override for any collection the launchpad deployed: `set_marketplace_address` points the launchpad at its marketplace, and the new entry point forwards to the marketplace's `set_collection_fee_bps` (which is what enforces the `ProtocolConfig` role on the marketplace side) and emits a launchpad-side `fee_cfg` audit event. Guard rails: `MarketplaceNotConfigured` when no marketplace is set, `CollectionNotOurs` for addresses this launchpad did not deploy, `InvalidFeeBps` above 10 000 bps. The marketplace's storage helpers and its own `collection_fee_set` / `collection_fee_cleared` events are unchanged.

## [Release 1] - 2026-07-26

### Components

| Component | Version |
|-----------|---------|
| Marketplace Contract | 0.1.0 (storage: 1.1.0) |
| Launchpad Contract | 0.1.0 |
| Indexer | 1.0.0 |
| Frontend | 0.1.0 |
| Event Schema | 1 |
| OpenAPI Spec | 1.0.0 |
| Database Migration | 20260724000000 |

### Migrations Required

- **Database**: Run `npx prisma migrate deploy` to apply all migrations through `20260724000000` (offer expiry column).
- **Contract (marketplace)**: If upgrading from a pre-1.1.0 version, invoke `migrate(admin)` to transform legacy monolithic `Vec<u64>` indices into paged storage. Use `migrate_step(admin, max_items)` for large state.
- **Contract (launchpad)**: No storage migration needed. Call `set_wasm_hashes(...)` if deploying new collection WASM.

### Rollback Notes

- **Frontend**: Can roll back to any version that supports indexer API ≥ 1.0.0. No database or contract dependencies.
- **Indexer**: Database migrations are additive-only. To roll back, stop the indexer, revert to the previous Docker image, and manually roll back the migration with `npx prisma migrate resolve --rolled-back <migration_name>`.
- **Contracts**: Contracts are immutable once deployed. Rollback requires redeploying the previous WASM version and re-initializing. On-chain state is preserved if storage layout is backward-compatible.

### Compatibility

- Marketplace contract requires indexer ≥ 1.0.0 (event schema v1).
- Launchpad contract requires indexer ≥ 1.0.0.
- Frontend requires indexer API ≥ 1.0.0.
- Event schema v1 is the baseline; no prior versions exist.

### Breaking Changes

- None (initial release).

### Known Limitations

- Contract WASM hashes are not yet tracked in `deployed_versions.json` (added in deploy script update).
- Launchpad contract does not expose a `version()` string view (uses `wasm_version()` integer counter).
