# Threat Model: Indexer/Contract Error-Catalog Alignment and API Fixes

**Date:** 2026-09-11
**PR:** `fix/issue-636-indexer-contract-error-catalog-alignment`
**Author:** pugsley76
**Status:** Complete

---

## 1. Overview

This record covers the contract-source changes bundled in the PR that also
fixes indexer API regressions, CI setup, and the client error-catalog. The
contract changes are **additive or observational** — no settlement amounts,
no authorization guards, and no withdrawal semantics were altered. The one
functional guard added is a replay-safety marker for an existing path.

Scope of contract changes:

| Area | Change | Issue |
|---|---|---|
| Error enums | New `Error` variants appended (next available code) | #476, #484 |
| Events | New `dep_idem`, `c_psd`, `c_unpsd` emissions; removed duplicated/broken event code | #474, #477, #478 |
| Storage keys | `SaltAddress`, `CollectionPaused`, `BidRefundRecord` | #466, #477, #478 |
| Function rename | `update_collection_royalty_defaults` → `update_collection_royalties` | — |

---

## 2. Changes

### `collection_nft_erc1155`, `collection_nft_erc721`, `lazy_mint_erc1155`, `lazy_mint_erc721`
- Appended the error variants used by the creator-succession proposal path
  (`NoPendingCreator`, `NotPendingCreator`, `ProposalExpired`) so the on-chain
  error surface matches the client catalog and indexer error mapping. Codes are
  the next sequential values — no existing code was renumbered.
- `lazy_mint_erc721` additionally adds `EmptyUri`/`UriTooLong` for `redeem` /
  `check_voucher` input validation errors.

### `contracts/soroban-marketplace/src/*`
- `types.rs`: new `MarketplaceError::InvalidStateTransition = 75` for the
  lifecycle transition matrix (Issue #426). Additive.
- `storage.rs`: new `DataKey::BidRefundRecord(u64, Address)` plus
  `mark_bid_refunded` / `is_bid_refunded` helpers (Issue #466). Written
  **before** the losing-bid refund transfer so a duplicate
  `refund_losing_bid` claim cannot replay a payout. TTL follows the offer TTL.
- `events.rs`: removed a corrupt duplicated fragment in
  `AuctionCancelledEvent::publish` (stray `}LED),), self);` from a botched
  merge) and removed a duplicated `TerminalCleanedEvent` / `TERMINAL_CLEANED`
  declaration block (Issue #474) — the canonical definition remains.

### `contracts/launchpad/src/*`
- `types.rs`: new `DataKey::SaltAddress(BytesN<32>)` (Issue #477) enabling
  idempotent retries of `deploy_*` after a successful deployment, and
  `DataKey::CollectionPaused(Address)` (Issue #478) for creator/admin pause.
- `events.rs`: new `dep_idem`, `c_psd`, `c_unpsd` emissions tied to those
  paths and to pause toggling. Observational only.
- `contract.rs` / `storage.rs`: renamed
  `update_collection_royalty_defaults` → `update_collection_royalties`
  (function + call site + storage helper); formatting fix restoring a newline
  between two functions in `storage.rs`.

### Non-contract changes (same PR, listed for completeness)
- Indexer API: `/listings` cursor fix + OpenAPI envelope compliance, ratelimit
  `ipKeyGenerator` v8 call sites, restored abuse-detection metrics, expanded
  `ListingResponseV1`.
- Repo: npm workspaces now include `packages/config`; CI installs at repo root;
  `indexer/prisma/schema.prisma` drops two invalid collection indexes; client
  `contractErrors/catalog.ts` synced to the contract error surface.

---

## 3. Threat Analysis

| # | Threat | Impact | Likelihood | Mitigation |
|---|--------|--------|-----------|------------|
| 1 | New error codes collide with existing on-chain codes | Low — all new codes are the next available value; verified by error-catalog coverage gate | Low | `scripts/contract-errors/validate-error-coverage.mjs` fails on stale/renumbered mappings |
| 2 | `BidRefundRecord` marker written before the refund transfer is lost / stale | Medium — marker TTL set to the offer-TTL window; a claim after expiry falls back to storage state, not a new payout (powered by existing auction-finalized state) | Low | Marker written before transfer (no TOCTOU); TTL extended on read |
| 3 | New events leak sensitive data | None — events carry only public IDs, addresses, and hashes already visible on-chain | None | Existing event patterns reused |
| 4 | Duplicated-event removal changes indexer behaviour | Low — `TERMINAL_CLEANED` was declared twice with identical bodies; indexer already consumed the canonical symbol | None | Compile verified; event parser unchanged |
| 5 | Pause flag (`CollectionPaused`) diverges from platform admin state | Medium — feature flags need reconciliation | Low | Emission is observational; pause enforcement is part of the referenced issues' own review |
| 6 | `update_collection_royalties` rename breaks external callers | Low — same params/behaviour, only the symbol changed | None | Rename is source-compatible; upgrade path re-links to the new symbol |

---

## 4. Storage Layout Impact

- **marketplace**: one new persistent key family
  `BidRefundRecord(auction_id, bidder)` — namespaced by auction+bidder, no
  collision with existing keys. Written via `set` + TTL extend.
- **launchpad**: two new persistent key families `SaltAddress(salt)` and
  `CollectionPaused(address)` — namespaced, no collision.
- No existing listing/auction/offer storage keys were re-keyed, re-typed, or
  removed.

## 5. Authorization Changes

None. No guards added, removed, or weakened. The new storage writes happen
inside the same caller-authorization context as the actions they accompany or
guard.

## 6. Testing

- `cargo test --workspace` — 1203/1203 pass (all 6 crates).
- `cargo check --target wasm32-unknown-unknown` — passes.
- Error-catalog coverage gate (`validate-error-coverage.mjs`) — passes.
- Indexer CI vitest gates re-run green post-install (auth-policy 64,
  query-cost 57, openapi-contract 13, openapi-runtime-contract 49).
- `npx prisma generate` — clean.

## 7. Rollback

All changes are source-additive. Reverting the contract diff restores the
previous WASM; the two schema.prisma index removals are drift-only (the
indexes referenced nonexistent columns and were never created in a migration),
so no DB rollback is required.

---

## 8. Reviewer Sign-Off

> The independent reviewer confirms they have read the diff and verified that
> no high-risk settlement, authorization, or ownership logic changed.

| Role | Reviewer | Sign-off |
|------|----------|---------|
| Author | pugsley76 | — |
| Independent reviewer | *Pending — to be completed by an independent reviewer before merge* | Pending |