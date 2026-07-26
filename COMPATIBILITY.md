# Compatibility Matrix

This document records which component versions have been tested and validated together. Deploy only combinations listed in the **Supported Combinations** table below.

## Current Release: v1 (Release ID: 1)

### Component Versions

| Component | Version | Notes |
|-----------|---------|-------|
| Marketplace Contract | 0.1.0 (storage: 1.1.0) | `CONTRACT_VERSION` in contract.rs |
| Launchpad Contract | 0.1.0 | `wasm_version()` tracks factory WASM iterations |
| Indexer | 1.0.0 | REST API + Prisma ORM |
| Frontend | 0.1.0 | Next.js on Vercel |
| Event Schema | 1 | Contract ↔ indexer event interface |
| OpenAPI Spec | 1.0.0 | Matches indexer version |
| Database Migration | 20260724000000 | Latest Prisma migration |

### Supported Combinations

| Release | Marketplace | Launchpad | Indexer | Frontend | Event Schema | DB Migration | Status |
|---------|-------------|-----------|---------|----------|--------------|--------------|--------|
| 1 | 0.1.0 | 0.1.0 | 1.0.0 | 0.1.0 | 1 | 20260724000000 | Active |

### Minimum Required Versions

| Component | Requires |
|-----------|----------|
| Marketplace Contract | Indexer ≥ 1.0.0 |
| Launchpad Contract | Indexer ≥ 1.0.0 |
| Indexer | Event Schema ≥ 1, Frontend ≥ 0.1.0 |
| Frontend | Indexer API ≥ 1.0.0 |

## Breaking Change Policy

| Change Type | Impact | Required Version Bump |
|-------------|--------|-----------------------|
| Contract event fields added/removed | Indexer parser breaks | Event Schema version |
| Contract event type renamed | Indexer + frontend break | Event Schema version |
| REST API endpoint removed/restructured | Frontend breaks | Indexer API version (minor/major) |
| REST API field added (non-breaking) | No break | Patch version |
| Database migration (additive) | Indexer restart required | DB Migration version |
| Database migration (destructive) | Potential data loss on rollback | Indexer major version |
| Contract storage layout change | Migration required on-chain | Contract version |

## Rollback Compatibility

| Component | Rollback Condition |
|-----------|-------------------|
| **Frontend** | Safe to roll back to any version with `min_indexer_api ≤ current API version` |
| **Indexer** | DB migrations are additive-only; roll back requires manual `prisma migrate resolve --rolled-back` |
| **Contracts** | Immutable on-chain; "rollback" = redeploy previous WASM hash and re-initialize |
| **Event Schema** | Indexer must be compatible with the event schema version emitted by deployed contracts |

## How to Read This Matrix

1. Find your deployed contract version in the **Supported Combinations** table.
2. Check the **Indexer** column — your indexer must be at least that version.
3. Check the **Frontend** column — your frontend must be at least that version.
4. Verify the **DB Migration** matches your Prisma migration state (`npx prisma migrate status`).

## Updating This File

When releasing a new version:
1. Add a new row to **Supported Combinations** with the new `release_id`.
2. Update **Component Versions** to reflect the new state.
3. Update **Minimum Required Versions** if compatibility requirements changed.
4. Document any new **Breaking Change Policy** additions.
5. Document **Rollback Compatibility** for the new version.
