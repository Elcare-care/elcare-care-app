#![no_std]
#![allow(clippy::too_many_arguments, deprecated)]
// ------------------------------------------------------------
// lib.rs — Soroban Marketplace contract root
// ------------------------------------------------------------

pub mod events;
mod contract;
pub mod escrow;
pub mod storage;
mod types;

#[cfg(test)]
mod test;

#[cfg(test)]
mod role_rbac_tests;

#[cfg(test)]
mod offer_sweep_tests;

#[cfg(test)]
mod counter_offer_tests;

#[cfg(test)]
mod reservation_tests;

pub use contract::MarketplaceContract;
pub use types::{
    BidRecord, CancelReason, Listing, ListingStatus, MarketplaceError, Offer, OfferStatus,
};

#[cfg(any(test, feature = "testutils"))]
pub use contract::MarketplaceContractClient;

// ── Compile-time discriminant assertions (Issue #853) ────────────────────────
//
// These `const` assertions guarantee that specific error codes never silently
// shift — any rename or renumber that violates the catalog will be caught at
// compile time, not just at CI.
//
// IMPORTANT: The discriminants listed here are part of the on-chain ABI.
// Changing them is a breaking change. Add new variants at the end of the enum
// and never reuse a retired number.
const _: () = assert!(MarketplaceError::Unauthorized as u32 == 5);
const _: () = assert!(MarketplaceError::ReentrancyGuard as u32 == 22);
const _: () = assert!(MarketplaceError::TokenNotWhitelisted as u32 == 25);
const _: () = assert!(MarketplaceError::ArithmeticOverflow as u32 == 40);
const _: () = assert!(MarketplaceError::InvalidStateTransition as u32 == 75);
