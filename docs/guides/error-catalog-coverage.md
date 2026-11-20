# API and Contract Error Catalog Coverage Guide

## Overview

The ElcareHub platform relies on a multi-tier error handling architecture spanning:
1. **On-Chain Soroban Smart Contracts** (`contracts/*/src/types.rs`, `contracts/*/src/lib.rs`) defining `#[contracterror]` enums.
2. **Machine-Readable Error Catalog** (`error-catalog.json`) generated from Rust contract sources for tooling and auditability.
3. **Client-Facing Error Catalog** (`frontend/elcarehub-app/src/lib/contractErrors/catalog.ts`) translating on-chain error codes into user-friendly messages and guided recovery actions.
4. **Indexer API Error Classification** (`indexer/src/api/errors.ts`) mapping database, validation, and contract errors to standardized HTTP status codes and stable machine-readable error codes.

This runbook documents how operators inspect error mappings, review coverage reports, identify unmapped entries, and safely revert changes.

---

## Contract Error Inventory

All contract error codes are sequential `u32` discriminants. Discriminants are immutable once assigned to prevent breaking ABI changes across contract versions.

| Contract | Error Enum | Source File | Total Errors | Range |
|---|---|---|---|---|
| **Marketplace** | `MarketplaceError` | `contracts/soroban-marketplace/src/types.rs` | 75 | 1 – 75 |
| **Launchpad** | `Error` | `contracts/launchpad/src/types.rs` | 22 | 1 – 22 |
| **ERC-721 Collection** | `Error` | `contracts/collection_nft_erc721/src/lib.rs` | 27 | 1 – 27 |
| **ERC-1155 Collection** | `Error` | `contracts/collection_nft_erc1155/src/lib.rs` | 28 | 1 – 28 |
| **Lazy Mint ERC-721** | `Error` | `contracts/lazy_mint_erc721/src/lib.rs` | 30 | 1 – 30 |
| **Lazy Mint ERC-1155** | `Error` | `contracts/lazy_mint_erc1155/src/lib.rs` | 31 | 1 – 31 |

**Total Contract Error Variants:** 213 (100% mapped)

---

## Client Error Actions & Operator Triage

Every mapped contract error defines an operator/client action indicating recovery behavior:

| Action | Operator / User Meaning | Example Triggers |
|---|---|---|
| `adjust_input` | User provided invalid parameter values (e.g. price out of bounds, name too long, zero amount). | `InvalidPrice`, `NameTooLong`, `ZeroAmount` |
| `refresh_and_retry` | State changed on-chain before submission (e.g. auction finalized, listing expired, offer accepted). | `ListingSold`, `AuctionExpired`, `ProposalExpired` |
| `reconnect_wallet` | Caller is not authorized or using wrong signing key for role. | `NotAdmin`, `NotCreator`, `NotOwner` |
| `retry` | Transient condition or temporary pause. Retry with backoff. | `ContractPaused`, `CollectionPaused` |
| `contact_support` | Infrastructure, setup, or uninitialized contract state requiring operator intervention. | `MarketplaceNotConfigured`, `WasmHashNotSet`, `NotInitialized` |
| `none` | Terminal state or non-recoverable rejection (e.g. already initialized, voucher revoked). | `AlreadyInitialized`, `VoucherRevoked` |

---

## Indexer API Error Taxonomy

The REST API layer (`indexer/src/api/errors.ts`) normalizes internal faults, schema validation, and database errors into a predictable response structure:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Validation failed",
    "requestId": "req_abc123",
    "class": "CLIENT_ERROR",
    "retryable": false,
    "details": {
      "fieldErrors": [
        { "field": "limit", "message": "Expected number, received string" }
      ]
    }
  }
}
```

### Prisma to API Code Mappings

| Prisma Code | Condition | API ErrorCode | HTTP Status | Retryable |
|---|---|---|---|---|
| `P2002` | Unique constraint violation | `CONFLICT` | 409 | No |
| `P2025` | Record not found in database | `NOT_FOUND` | 404 | No |
| `P2003` | Foreign key constraint violation | `BAD_REQUEST` | 400 | No |
| `P2011` | Required non-null field missing | `BAD_REQUEST` | 400 | No |
| `P2000` | Input value too long for column | `BAD_REQUEST` | 400 | No |
| `P2006` / `P2007` | Invalid type or input syntax | `BAD_REQUEST` | 400 | No |
| `P1001` / `P1002` / `P1008` / `P1017` | Database unreachable or timed out | `SERVICE_UNAVAILABLE` | 503 | Yes (30s) |

---

## Running the Coverage Verification Gate

The coverage gate ensures that `error-catalog.json`, Rust contract definitions, and `catalog.ts` remain synchronized.

```bash
# [READ-ONLY] Run contract error coverage audit
npm run validate:contract-errors

# [READ-ONLY] Run error-catalog.json parity gate
node --experimental-strip-types scripts/validate-error-catalog.ts
```

If any contract error variant is added to a contract without being mapped in `frontend/elcarehub-app/src/lib/contractErrors/catalog.ts` or `error-catalog.json`, the command fails with a non-zero exit code and outputs the missing variants.

---

## Operator Note: Review and Revert Procedure

### Review Checklist for Error Changes
1. **Never Change Discriminants:** Check that existing numeric error codes are never modified or re-assigned. Modifying a discriminant breaks ABI compatibility with deployed contracts.
2. **Sequential Assignment:** New error variants must use the next sequential integer code.
3. **Action Policy:** Financial errors (`ArithmeticOverflow`, `RoyaltyExceedsLimit`, etc.) must specify a clear action (not `none`).
4. **Validation:** Run `npm run validate:contract-errors` to verify 100% coverage.

### Reverting Error Changes
If an incorrect error mapping was added:
1. Revert the commit using git:
   ```bash
   git revert <commit-sha>
   ```
2. Verify coverage and parity:
   ```bash
   npm run validate:contract-errors
   node --experimental-strip-types scripts/validate-error-catalog.ts
   ```
3. Re-deploy the frontend and indexer services.
