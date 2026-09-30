# Changelog

All notable changes to ElcareHub are documented here. Each release entry lists component versions, required migrations, rollback notes, and compatibility constraints.

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
