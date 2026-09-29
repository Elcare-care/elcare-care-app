# Changelog

All notable changes to ElcareHub are documented here. Each release entry lists component versions, required migrations, rollback notes, and compatibility constraints.

## [Unreleased]

### Added

- **`FeeAttributionEvent` (contract + indexer, Issue #846).** Settlement emits `fee_attribution` with the fee rate the payout split actually applied and whether that rate came from the collection's fee override rather than the rate snapshotted on the listing/auction, so operators can separate override-driven fee income from snapshot-rate income. Registered in `SCHEMA_REGISTRY` + `SUPPORTED_SCHEMA_VERSIONS` (versioned from the start) and covered by `indexer/tests/event-parsing.test.ts` and `contracts/soroban-marketplace/src/fee_attribution_tests.rs`.
- **CI gate `event-schema-lint`** (`scripts/check-event-schemas.mjs`): fails when a contract struct carrying `schema_version: u32` has no indexer schema entry, or has one that does not mark the field `optional: true`.

### Changed

- **Per-collection fee overrides now apply at settlement.** `CollectionFeeBps` was settable and readable but never consulted when splitting a payout; the split now uses the collection override when one is configured and falls back to the rate snapshotted on the listing/auction otherwise. `fee_attribution` records which of the two was used.
- **`TOPIC_MAP` accepts the topics the contract publishes.** The long-form topics (`listing_created`, `auction_resolved`, `fee_attribution`, …) were missing, so those events were dropped before any schema ran; the legacy short forms (`lst_crtd`, …) remain as aliases for historical backfills.

### Fixed

- `AUCTION_CANCELLED_SCHEMA` declared no `schema_version` field, so the version gate never applied to that event.
- `AUCTION_BID_REFUNDED` and `AUCTION_ADMIN_CANCELLED` schemas existed but were never registered, leaving those two event types without any decoding.
- `ledger_sequence` was declared `bigint` in eight schemas although the contract field is `u32`, which JavaScript decodes to a number — real events failed validation with `Field 'ledger_sequence' must be bigint, got number`.

### Notes

- Event schema version remains **1**: every field added here is optional and additive, so no database migration and no forced re-index is required. A range previously ingested by a decoder that lacked the topic aliases should be backfilled once after deploy, since those events were dropped rather than mis-decoded.

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
