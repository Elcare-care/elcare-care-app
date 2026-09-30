//! metadata.rs — Metadata validation for LazyMint1155 (lazy_mint_erc1155).
//!
//! Issue #851: all collection contracts must validate collection name, token URI,
//! and royalty bps at the point they are set.
//!
//! All validators return `Result<(), Error>` and are called at:
//!   - `initialize`   — name, royalty_bps
//!   - `redeem`       — voucher.uri (via validate_token_uri)
//!   - `redeem_batch` — each voucher.uri

use soroban_sdk::{Bytes, String};

use crate::Error;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum collection name length (inclusive).
pub const MAX_NAME_LEN: u32 = 64;
/// Maximum token URI length (inclusive).
pub const MAX_URI_LEN: u32 = 2_048;
/// Maximum allowed max_supply value (u64::MAX = unlimited).
pub const MAX_SUPPLY_LIMIT: u64 = 1_000_000;
/// Maximum royalty basis points (100 %).
pub const MAX_ROYALTY_BPS: u32 = 10_000;

// ── Validators ────────────────────────────────────────────────────────────────

/// Validate the collection name.
///
/// * `EmptyName`   — length is 0.
/// * `NameTooLong` — length > 64.
pub fn validate_collection_name(name: &String) -> Result<(), Error> {
    let len = name.len();
    if len == 0 {
        return Err(Error::EmptyName);
    }
    if len > MAX_NAME_LEN {
        return Err(Error::NameTooLong);
    }
    Ok(())
}

/// Validate the max supply for an edition.
///
/// * `InvalidMaxSupply` — value is 0 or > 1_000_000 (u64::MAX = unlimited, allowed).
pub fn validate_max_supply(max_supply: u64) -> Result<(), Error> {
    if max_supply == 0 {
        return Err(Error::InvalidMaxSupply);
    }
    if max_supply != u64::MAX && max_supply > MAX_SUPPLY_LIMIT {
        return Err(Error::InvalidMaxSupply);
    }
    Ok(())
}

/// Validate a token URI or base URI.
///
/// * `EmptyUri`   — length is 0.
/// * `UriTooLong` — length > 2048.
/// * `InvalidUri` — does not start with `ipfs://` or `https://`.
pub fn validate_token_uri(uri: &String) -> Result<(), Error> {
    let len = uri.len();
    if len == 0 {
        return Err(Error::EmptyUri);
    }
    if len > MAX_URI_LEN {
        return Err(Error::UriTooLong);
    }
    let bytes: Bytes = uri.clone().into();
    let starts_with_ipfs = len >= 7
        && bytes.get(0) == Some(b'i')
        && bytes.get(1) == Some(b'p')
        && bytes.get(2) == Some(b'f')
        && bytes.get(3) == Some(b's')
        && bytes.get(4) == Some(b':')
        && bytes.get(5) == Some(b'/')
        && bytes.get(6) == Some(b'/');
    let starts_with_https = len >= 8
        && bytes.get(0) == Some(b'h')
        && bytes.get(1) == Some(b't')
        && bytes.get(2) == Some(b't')
        && bytes.get(3) == Some(b'p')
        && bytes.get(4) == Some(b's')
        && bytes.get(5) == Some(b':')
        && bytes.get(6) == Some(b'/')
        && bytes.get(7) == Some(b'/');
    if !starts_with_ipfs && !starts_with_https {
        return Err(Error::InvalidUri);
    }
    Ok(())
}

/// Validate royalty basis points.
///
/// * `InvalidBps` — value > 10_000.
pub fn validate_royalty_bps(bps: u32) -> Result<(), Error> {
    if bps > MAX_ROYALTY_BPS {
        return Err(Error::InvalidBps);
    }
    Ok(())
}
