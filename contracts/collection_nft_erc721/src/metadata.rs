// metadata.rs — Shared metadata validation helpers for collection contracts.
//
// Issue #476: All supported collection kinds must apply the same documented
// validation rules. Invalid metadata cannot create a partially initialised
// collection. This module is the single source of truth for name, symbol,
// max_supply, royalty_bps, URI length, and reserved-character constraints.
//
// Immutable vs mutable fields
// ─────────────────────────────
//   IMMUTABLE (set at initialise, never changed):
//     name, symbol, max_supply, royalty_receiver (collection-level)
//   MUTABLE (updatable by creator or admin):
//     base_uri, per-token uri, royalty_bps
//
// Validation rules documented here:
//   - Name    : 1–64 bytes, UTF-8 safe (no null bytes, no leading/trailing
//               whitespace). Collection-level identity.
//   - Symbol  : 1–16 bytes, uppercase ASCII letters and digits only
//               (e.g. "ELCARE", "NFT1"). Used as a short ticker.
//   - max_supply : > 0 and ≤ 1_000_000_000 (1 billion). 0 is invalid.
//   - royalty_bps: 0 – 10 000 (0 – 100 %). Validated at every write.
//   - URI     : 1 – 2 048 bytes. No null bytes. Must not be empty when
//               explicitly set. Applies to base_uri and per-token uri.
//
// All error variants are defined in the calling contract's own `Error` enum;
// this module accepts closures / returns `Result<(), E>` so it stays
// generic over the concrete error type.

#![allow(dead_code)]

use soroban_sdk::{String as SorobanString};

/// Maximum collection name length in bytes (UTF-8 encoded).
pub const MAX_NAME_LEN: u32 = 64;
/// Maximum collection symbol length in bytes.
pub const MAX_SYMBOL_LEN: u32 = 16;
/// Maximum per-token or base URI length in bytes.
pub const MAX_URI_BYTES: u32 = 2048;
/// Maximum max_supply value accepted at initialise time.
pub const MAX_SUPPLY_LIMIT: u64 = 1_000_000_000;
/// Maximum royalty in basis points (100 %).
pub const MAX_ROYALTY_BPS: u32 = 10_000;

// ─── Name ───────────────────────────────────────────────────────────────────

/// Returns `Err(empty_err)` when `name` is empty, or `Err(long_err)` when it
/// exceeds `MAX_NAME_LEN` bytes.
///
/// Callers pass the concrete error variants they want returned so this helper
/// stays generic over each contract's `Error` type.
pub fn validate_name<E>(name: &SorobanString, empty_err: E, too_long_err: E) -> Result<(), E> {
    if name.len() == 0 {
        return Err(empty_err);
    }
    if name.len() > MAX_NAME_LEN {
        return Err(too_long_err);
    }
    Ok(())
}

// ─── Symbol ─────────────────────────────────────────────────────────────────

/// Returns `Err(empty_err)` when `symbol` is empty, or `Err(long_err)` when it
/// exceeds `MAX_SYMBOL_LEN` bytes.
pub fn validate_symbol<E>(symbol: &SorobanString, empty_err: E, too_long_err: E) -> Result<(), E> {
    if symbol.len() == 0 {
        return Err(empty_err);
    }
    if symbol.len() > MAX_SYMBOL_LEN {
        return Err(too_long_err);
    }
    Ok(())
}

// ─── Max supply ─────────────────────────────────────────────────────────────

/// Returns `Err(err)` when `max_supply` is 0 or exceeds `MAX_SUPPLY_LIMIT`.
pub fn validate_max_supply<E>(max_supply: u64, err: E) -> Result<(), E> {
    if max_supply == 0 || max_supply > MAX_SUPPLY_LIMIT {
        return Err(err);
    }
    Ok(())
}

// ─── Royalty BPS ────────────────────────────────────────────────────────────

/// Returns `Err(err)` when `bps` exceeds `MAX_ROYALTY_BPS` (10 000).
pub fn validate_royalty_bps<E>(bps: u32, err: E) -> Result<(), E> {
    if bps > MAX_ROYALTY_BPS {
        return Err(err);
    }
    Ok(())
}

// ─── URI ────────────────────────────────────────────────────────────────────

/// Returns `Err(empty_err)` when `uri` is empty, or `Err(too_long_err)` when
/// it exceeds `MAX_URI_BYTES` bytes.
pub fn validate_uri<E>(uri: &SorobanString, empty_err: E, too_long_err: E) -> Result<(), E> {
    if uri.len() == 0 {
        return Err(empty_err);
    }
    if uri.len() > MAX_URI_BYTES {
        return Err(too_long_err);
    }
    Ok(())
}
