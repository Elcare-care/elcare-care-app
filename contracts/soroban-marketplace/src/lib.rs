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

pub use contract::MarketplaceContract;
pub use storage::EscrowRecord;
pub use types::{
    BidRecord, CancelReason, Listing, ListingStatus, MarketplaceError, Offer, OfferStatus,
};

#[cfg(any(test, feature = "testutils"))]
pub use contract::MarketplaceContractClient;
