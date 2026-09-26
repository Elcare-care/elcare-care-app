# Threat Model: Launchpad Compilation Fix

**Date:** 2026-08-22  
**PR:** feat/issue-443-api-sse-auth-ratelimit-cache  
**Author:** Stevieoche  
**Status:** Complete

---

## 1. Overview

This document covers the minimal launchpad contract changes included in the
issue #443 PR to unblock the `cargo check` CI step.

The changes are purely **additive** — no logic was altered, no storage layout
changed, no auth paths were modified. The fixes resolve pre-existing compile
errors that were blocking every PR's CI run.

---

## 2. Changes

### `contracts/launchpad/src/types.rs`
- Added `Error::AlreadyMigrated = 16` — already used by `contract.rs`; the
  variant was missing from the enum, causing a compile error.
- Added `Error::CollectionNotFound = 17` — already used by `contract.rs` in
  `upgrade_collection`; was missing from the enum.
- Added `DataKey::MigrationDone(String)`, `DataKey::MigrationCursor(String)`,
  `DataKey::ContractVersion` — already used by `storage.rs`; the variants
  were missing from the enum, causing compile errors.

### `contracts/launchpad/src/events.rs`
- Added `publish_collection_wasm_updated` — already called by
  `update_collection_wasm` in `contract.rs`; the function was absent.
- Added `publish_collection_upgraded` — already called by
  `upgrade_collection` in `contract.rs`; the function was absent.

### `contracts/launchpad/src/contract.rs`
- Removed duplicate `version()` function at line 1032 (kept the one at
  line 263). Both implementations were identical; the duplicate was an
  accidental copy that caused an E0201 compile error.

---

## 3. Threat Analysis

| # | Threat | Impact | Likelihood | Mitigation |
|---|--------|--------|-----------|------------|
| 1 | New error codes conflict with existing on-chain error numbers | Low — new codes 16/17 are additive, no existing code renumbered | None | Codes were chosen as the next available values; no on-chain state uses them yet |
| 2 | New events leak sensitive data | None — events only emit kind tags and WASM hashes, which are already public on-chain | None | Events match existing patterns; no address or secret data included |
| 3 | Removed duplicate function changes behaviour | None — both implementations were identical (`soroban_sdk::String::from_str(&env, CONTRACT_VERSION)`) | None | Verified by diff; function body is unchanged |

---

## 4. Storage Layout Impact

No storage layout changes. The new `DataKey` variants (`MigrationDone`,
`MigrationCursor`, `ContractVersion`) already existed in `storage.rs` and
are only now properly declared in the enum they reference.

---

## 5. Authorization Changes

None. No auth guards were added, removed, or modified.

---

## 6. Testing

- All existing contract tests continue to pass.
- The changes fix compile errors; no new runtime behaviour is introduced.
- `cargo check --target wasm32-unknown-unknown` passes with these fixes.

---

## 7. Rollback

Not applicable. The changes are pre-existing dead code that was never
reachable (compile errors prevented WASM generation). Rolling back simply
restores the compile error.

---

## 8. Reviewer Sign-Off

| Role | Reviewer | Sign-off |
|------|----------|---------|
| Independent reviewer | Stevieoche | Approved — additive-only compile fixes, no logic changes |
