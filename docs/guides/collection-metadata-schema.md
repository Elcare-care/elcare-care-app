# Collection Metadata Schema Validation

**Issue:** [#476](https://github.com/Elcare-care/elcare-care-app/issues/476)  
**Status:** Implemented  
**Applies to:** `collection_nft_erc721`, `collection_nft_erc1155`, `lazy_mint_erc721`,
`lazy_mint_erc1155`, and the `launchpad` factory contract.

---

## Overview

All four collection kinds enforce the same metadata constraints at `initialize` time.
An invalid combination cannot create a partially-initialised collection — every
validation failure returns an error before any storage is written.

The shared validation logic lives in
`contracts/<collection>/src/metadata.rs` (identical copy per contract, as
Soroban does not yet support shared crates in a workspace without publish).

---

## Immutable vs mutable fields

| Field | Kind | Mutable? |
|---|---|---|
| `name` | collection identity | ❌ Immutable |
| `symbol` | collection ticker (721-shaped only) | ❌ Immutable |
| `max_supply` | hard cap (721-shaped only) | ❌ Immutable |
| `royalty_receiver` | collection-level royalty address | ❌ Immutable |
| `royalty_bps` | royalty percentage | ✅ Mutable (creator) |
| `base_uri` | collection-level URI prefix | ✅ Mutable (creator, until frozen) |
| per-token `uri` | individual token metadata URI | ✅ Mutable (creator, until frozen) |

---

## Validation rules

### `name`
- Minimum length: **1 byte** → `EmptyName`
- Maximum length: **64 bytes** (UTF-8 encoded) → `NameTooLong`
- Applied to: all four collection kinds + launchpad preflight

### `symbol`
- Minimum length: **1 byte** → `EmptySymbol`
- Maximum length: **16 bytes** → `SymbolTooLong`
- Applied to: `collection_nft_erc721`, `lazy_mint_erc721` (1155-shaped kinds have no symbol)
- Also validated in launchpad `deploy_normal_721` / `deploy_lazy_721`

### `max_supply`
- Must be **> 0** → `InvalidMaxSupply`
- Must be **≤ 1,000,000,000** (one billion) → `MaxSupplyTooLarge` (launchpad) /
  `InvalidMaxSupply` (collection contracts)
- Applied to: `collection_nft_erc721`, `lazy_mint_erc721` (1155-shaped kinds allow
  per-token supply configured independently via `set_token_max_supply`)

### `royalty_bps`
- Range: **0 – 10,000** (0 – 100 %) → `InvalidBps`
- Applied to: all four collection kinds

### URI (base URI and per-token URI)
- Minimum length: **1 byte** → `EmptyUri`
- Maximum length: **2,048 bytes** → `UriTooLong`
- Applied at every `set_base_uri`, `mint`, `mint_new`, `redeem`, and
  related calls that accept a URI parameter

---

## Error codes by contract

### `collection_nft_erc721`

| Code | Name | Trigger |
|------|------|---------|
| 16 | `EmptyUri` | URI is empty |
| 17 | `UriTooLong` | URI > 2048 bytes |
| 18 | `EmptyBatch` | Batch call with empty list |
| 19 | `BatchTooLarge` | Batch > MAX_BATCH_SIZE (200) |
| 20 | `EmptyName` | `name` is empty at init |
| 21 | `NameTooLong` | `name` > 64 bytes at init |
| 22 | `EmptySymbol` | `symbol` is empty at init |
| 23 | `SymbolTooLong` | `symbol` > 16 bytes at init |
| 24 | `InvalidMaxSupply` | `max_supply` == 0 or > 1,000,000,000 |

### `collection_nft_erc1155`

| Code | Name | Trigger |
|------|------|---------|
| 21 | `ApprovalExpired` | Approval expiry is in the past |
| 22 | `EmptyName` | `name` is empty at init |
| 23 | `NameTooLong` | `name` > 64 bytes at init |

### `lazy_mint_erc721`

| Code | Name | Trigger |
|------|------|---------|
| 21 | `EmptyName` | `name` is empty at init |
| 22 | `NameTooLong` | `name` > 64 bytes at init |
| 23 | `EmptySymbol` | `symbol` is empty at init |
| 24 | `SymbolTooLong` | `symbol` > 16 bytes at init |
| 25 | `InvalidMaxSupply` | `max_supply` == 0 or > 1,000,000,000 |

### `lazy_mint_erc1155`

| Code | Name | Trigger |
|------|------|---------|
| 27 | `EmptyName` | `name` is empty at init |
| 28 | `NameTooLong` | `name` > 64 bytes at init |

### `launchpad`

| Code | Name | Trigger |
|------|------|---------|
| 16 | `AlreadyMigrated` | Migration already applied |
| 17 | `CollectionNotFound` | Address not in registry |
| 18 | `NameTooLong` | `name` > 64 bytes |
| 19 | `SymbolTooLong` | `symbol` > 16 bytes |
| 20 | `MaxSupplyTooLarge` | `max_supply` > 1,000,000,000 |

---

## Indexer normalisation

The indexer stores a `metadata_status` field on every `Collection` record:

| Value | Meaning |
|-------|---------|
| `"valid"` | All emitted fields passed launchpad validation |
| `"unknown"` | Collection was deployed before #476 validation rules; no validation event seen |

The `metadata_status` is set to `"valid"` when the `collection_deployed` event is
emitted by the launchpad (i.e., the deployment passed all validations). Legacy
collections that predate this change remain `"unknown"` and are not retroactively
revalidated.

---

## Frontend constraints

The launchpad creation wizard enforces the same limits client-side before
submitting a transaction:

- Name: required, max 64 characters
- Symbol (721-shaped): required, max 16 characters
- Max supply: required > 0, ≤ 1,000,000,000
- Base URI: optional at creation; if provided, max 2,048 characters

These match the on-chain rules exactly so the `preflight_deploy_*` call
can be used as a secondary validation gate before the user signs.
