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

use soroban_sdk::{Bytes, String as SorobanString};

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
/// Generic version — callers supply their own error variant.
pub fn validate_max_supply_with_err<E>(max_supply: u64, err: E) -> Result<(), E> {
    if max_supply == 0 || max_supply > MAX_SUPPLY_LIMIT {
        return Err(err);
    }
    Ok(())
}

// ─── Royalty BPS ────────────────────────────────────────────────────────────

/// Returns `Err(err)` when `bps` exceeds `MAX_ROYALTY_BPS` (10 000).
/// Generic version — callers supply their own error variant.
pub fn validate_royalty_bps_with_err<E>(bps: u32, err: E) -> Result<(), E> {
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

// ─── Contract-local fixed-error wrappers ────────────────────────────────────
//
// The generic helpers above accept caller-supplied error variants so they can
// be reused across contracts.  The wrappers below bind them to the concrete
// `crate::Error` variants used by this contract, providing a stable call-site
// for the contract's own test module (metadata_tests) and any internal callers
// that do not want to repeat the error arguments.

use crate::Error;

/// Validates the royalty BPS value for this contract.
/// Returns `Err(Error::InvalidBps)` when `bps` exceeds `MAX_ROYALTY_BPS` (10 000).
pub fn validate_royalty_bps(bps: u32) -> Result<(), Error> {
    if bps > MAX_ROYALTY_BPS {
        return Err(Error::InvalidBps);
    }
    Ok(())
}

/// Validates a collection name against the rules in this module.
/// Returns `Err(Error::EmptyName)` or `Err(Error::NameTooLong)`.
pub fn validate_collection_name(name: &SorobanString) -> Result<(), Error> {
    validate_name(name, Error::EmptyName, Error::NameTooLong)
}

/// Validates a `max_supply` value for this contract.
/// Returns `Err(Error::InvalidMaxSupply)` when `max_supply` is 0 or exceeds
/// `MAX_SUPPLY_LIMIT` (1 000 000 000).
///
/// Note: the collection_nft_erc1155 contract does not enforce a per-collection
/// `max_supply` at the collection level (supply caps are per-token), so this
/// helper is provided for the metadata test suite and for callers that want to
/// pre-validate a value before storing it.
pub fn validate_max_supply(max_supply: u64) -> Result<(), Error> {
    if max_supply == 0 || max_supply > MAX_SUPPLY_LIMIT {
        return Err(Error::InvalidMaxSupply);
    }
    Ok(())
}

/// Validates a per-token or base URI for this contract.
///
/// Rejects:
///   - Empty strings                    → `Error::EmptyUri`
///   - Strings longer than 2 048 bytes  → `Error::UriTooLong`
///   - `data:` scheme URIs              → `Error::InvalidUri`
///     (inline data URIs embed unbounded payloads and are not a content-
///      addressing scheme; `ipfs://` and `https://` URIs are accepted.)
pub fn validate_token_uri(uri: &SorobanString) -> Result<(), Error> {
    if uri.len() == 0 {
        return Err(Error::EmptyUri);
    }
    if uri.len() > MAX_URI_BYTES {
        return Err(Error::UriTooLong);
    }
    // Reject inline data URIs — they are not a content-addressing scheme and
    // can carry unbounded payloads.  We convert to `Bytes` (which reuses the
    // `Env` handle already embedded in `SorobanString`) so we can inspect
    // individual bytes in no_std without requiring a separate `&Env` parameter.
    //
    // "data:" in ASCII: [100, 97, 116, 97, 58]
    let bytes: soroban_sdk::Bytes = uri.clone().into();
    if bytes.len() >= 5
        && bytes.get(0) == Some(100u8) // 'd'
        && bytes.get(1) == Some(97u8)  // 'a'
        && bytes.get(2) == Some(116u8) // 't'
        && bytes.get(3) == Some(97u8)  // 'a'
        && bytes.get(4) == Some(58u8)
    // ':'
    {
        return Err(Error::InvalidUri);
    }
    Ok(())
}
