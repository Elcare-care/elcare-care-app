#![no_std]
#![allow(clippy::too_many_arguments, deprecated)]
// ------------------------------------------------------------
// lib.rs — Soroban Marketplace contract root
// ------------------------------------------------------------

pub mod events;
mod contract;
pub mod escrow;
pub mod math;
pub mod storage;
mod types;

#[cfg(test)]
mod test;

#[cfg(test)]
mod invariant_tests;

pub use contract::MarketplaceContract;
pub use types::{
    BidRecord, CancelReason, Listing, ListingStatus, MarketplaceError, Offer, OfferStatus,
};

#[cfg(any(test, feature = "testutils"))]
pub use contract::MarketplaceContractClient;

// ── Reentrancy guard documentation (Issue #204) ───────────────────────────────
//
// The following entry-points are protected by a per-resource reentrancy lock
// stored in Soroban temporary storage (TTL = REENTRANCY_LOCK_TTL ledgers):
//
//   Listing locks  (DataKey::ListingLock(listing_id)):
//     • buy_artwork      — prevents token-callback re-entry during payout
//     • accept_offer     — prevents token-callback re-entry during payout
//
//   Auction locks  (DataKey::AuctionLock(auction_id)):
//     • finalize_auction — prevents re-entry during bid payout
//
// The lock is managed by the ReentrancyScope RAII struct defined in contract.rs.
// Its Drop impl clears the lock, guaranteeing release whether the function
// returns normally or panics.  On Soroban, a panicking invocation rolls back
// all storage writes atomically, so even without RAII a stuck lock would
// self-heal.  The RAII pattern adds an explicit defence-in-depth layer for any
// future execution model that may not guarantee atomic rollback.
//
// Error code for a reentrant call attempt: MarketplaceError::ReentrancyGuard = 22

// Compile-time assertion: ReentrancyGuard must be error code 22.
// If the discriminant ever drifts, this will fail to compile.
const _: () = {
    // Discriminant is repr(u32) so we can cast to check at compile time.
    assert!(
        types::MarketplaceError::ReentrancyGuard as u32 == 22,
        "ReentrancyGuard discriminant must remain 22 — update docs if intentionally changed"
    );
};
