//! metadata.rs — Metadata validation for LazyMint721 (lazy_mint_erc721).
//!
//! Issue #851: all collection contracts must validate collection name, symbol,
//! max supply, token URI, and royalty bps at the point they are set.
//!
//! All validators return `Result<(), Error>` and are called at:
//!   - `initialize`  — name, symbol, max_supply, royalty_bps
//!   - `redeem`      — voucher.uri (via validate_token_uri)
//!   - `redeem_batch`— each voucher.uri

use soroban_sdk::{Bytes, Env, String};

use crate::Error;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum collection name length (inclusive).
pub const MAX_NAME_LEN: u32 = 64;
/// Maximum collection symbol length (inclusive).
pub const MAX_SYMBOL_LEN: u32 = 16;
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

/// Validate the collection symbol.
///
/// * `EmptySymbol`       — length is 0.
/// * `SymbolTooLong`     — length > 16.
/// * `InvalidSymbolChar` — contains a non-ASCII-alphanumeric character.
pub fn validate_collection_symbol(_env: &Env, symbol: &String) -> Result<(), Error> {
    let len = symbol.len();
    if len == 0 {
        return Err(Error::EmptySymbol);
    }
    if len > MAX_SYMBOL_LEN {
        return Err(Error::SymbolTooLong);
    }
    let bytes: Bytes = symbol.clone().into();
    for i in 0..bytes.len() {
        let b = bytes.get(i).unwrap_or(0);
        let is_alpha_num = (b >= b'A' && b <= b'Z')
            || (b >= b'a' && b <= b'z')
            || (b >= b'0' && b <= b'9');
        if !is_alpha_num {
            return Err(Error::InvalidSymbolChar);
        }
    }
    Ok(())
}

/// Validate the max supply.
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
