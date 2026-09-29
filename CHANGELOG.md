# Changelog

All notable changes to ElcareHub are documented here. Each release entry lists component versions, required migrations, rollback notes, and compatibility constraints.

## [Unreleased]

### Added

- **`FeeAttributionEvent`** (`fee_attribution` topic) — emitted at settlement
  by `buy_artwork`, `accept_offer`, and `finalize_auction` whenever a
  per-collection fee override (`set_collection_fee_bps`) is active for the
  settled collection.  Fields: `listing_id: u64`, `collection: Address`,
  `applied_fee_bps: u32`, `is_collection_override: bool`,
  `schema_version: u32`.  Lets operators distinguish collection-override-driven
  fee income from global-rate income in the indexer without a separate contract
  read.  (Issue #488)

- **`FEE_ATTRIBUTION` indexer schema** — `FEE_ATTRIBUTION_SCHEMA` and
  `FeeAttributionData` TypeScript interface added to
  `indexer/src/event-schemas.ts`; `'fee_attribution'` → `'FEE_ATTRIBUTION'`
  mapping added to `TOPIC_MAP` in `indexer/src/parser.ts`; `FEE_ATTRIBUTION: 1`
  entry added to `SUPPORTED_SCHEMA_VERSIONS`.  (Issue #488)

- **Event schema versioning audit** — confirmed all eleven schema-versioned
  event structs (`ListingCreatedEvent`, `ArtworkSoldEvent`,
  `AuctionCreatedEvent`, `AuctionFinalizedEvent`, `OfferMadeEvent`,
  `OfferAcceptedEvent`, `ProtocolFeeCollectedEvent`, `RoyaltySettlementEvent`,
  `AuctionBidRefundedEvent`, `AuctionAdminCancelledEvent`,
  `AuctionCancelledEvent`) already have `schema_version` marked
  `optional: true` in the indexer schema registry.  No fixes were required.
  (Issue #488)

- **`event-schema-lint` CI gate** — new required workflow job in
  `.github/workflows/ci.yml` that runs `scripts/lint-event-schemas.mjs`.
  Fails if any Rust event struct with a `schema_version: u32` field lacks a
  corresponding `SUPPORTED_SCHEMA_VERSIONS` entry, `SCHEMA_REGISTRY`
  registration, or `optional: true` on its `schema_version` schema field.
  Prevents schema drift from landing on `main` silently.  (Issue #488)

- **`indexer/tests/event-parsing.test.ts`** — integration test suite (15
  `describe` blocks) covering v0 (pre-upgrade, no `schema_version` field) and
  v1 (post-upgrade, `schema_version: 1`) decoding for all eleven versioned
  event types plus `FeeAttributionEvent`.  Includes backfill-boundary tests
  that confirm both event shapes decode through the same code path.
  (Issue #488)

- **Backfill boundary documentation** — new §9 "Backfill Boundary Behavior"
  added to `docs/guides/event-parsing.md` explaining: what schema version 0
  means (implicit/absent field), how the indexer populates `schema_version` in
  its database (`NULL` = pre-upgrade = version 0), why no range-splitting is
  needed, and how to verify correct behavior via Prometheus metrics.
  (Issue #488)

---

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
