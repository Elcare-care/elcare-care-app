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

---

## Collection Contract Conformance Matrix

*Updated by Issue #485 — Add collection contract compatibility conformance suite.*

### Collection Variants

| Kind | Deploy Topic | Deploy Event Type | Standard | Lazy-Mint |
|------|-------------|-------------------|----------|-----------|
| `normal_721` | `dep_n721` | `DEPLOY_NORMAL_721` | ✓ | — |
| `normal_1155` | `dep_n1155` | `DEPLOY_NORMAL_1155` | ✓ | — |
| `lazy_721` | `dep_l721` | `DEPLOY_LAZY_721` | ✓ | ✓ |
| `lazy_1155` | `dep_l1155` | `DEPLOY_LAZY_1155` | ✓ | ✓ |

### Capability Matrix

| Capability | normal_721 | normal_1155 | lazy_721 | lazy_1155 | Required by |
|-----------|-----------|------------|---------|----------|-------------|
| Deploy via Launchpad | ✓ | ✓ | ✓ | ✓ | Launchpad, Indexer |
| Collection-level pause (`c_psd` / `c_unpsd`) | ✓ | ✓ | ✓ | ✓ | Marketplace, Indexer |
| Ownership transfer events | ✓ | ✓ | ✓ | ✓ | Marketplace, Frontend |
| Lazy-mint voucher revocation (`revoke`) | — | — | ✓ | ✓ | Indexer, Frontend |
| Deploy idempotency (`dep_idem`) | ✓ | ✓ | ✓ | ✓ | Launchpad, Indexer |
| Marketplace listing / sale / offer events | ✓ | ✓ | ✓ | ✓ | Marketplace, Indexer, Frontend |

**Legend:** ✓ = supported and conformance-tested; — = intentionally unsupported (documented).

### Conformance Test Location

`indexer/tests/collection-conformance.test.ts` — runs as part of the standard CI test suite. The suite verifies deploy event schema, pause capability, lazy-mint capability (lazy variants only), and marketplace integration events for every variant. Unsupported capabilities are documented with explicit `expect(variant.supportsLazyMint).toBe(false)` assertions that would fail if a standard variant started emitting lazy-mint events unexpectedly.

### How to Update After a Contract Change

1. Run `npm test -- collection-conformance` and check for failures.
2. If a new capability is added to a variant, add it to the matrix above and write a new `it(...)` block in the test file.
3. If a capability is removed, mark it `—` in the matrix and update the test to document the intentional removal.
4. Update the **Supported Combinations** table above with a new release row.
