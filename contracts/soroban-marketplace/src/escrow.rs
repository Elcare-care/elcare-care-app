// escrow.rs — NFT custody helpers for the ELCARE-HUB Marketplace
//
// # Design
// Two public functions own the full NFT lifecycle:
//
//   escrow_nft  — verify ownership + no double-listing, pull NFT into contract
//                  custody, write escrow index.
//   release_nft — transfer NFT from contract custody to recipient, clear index.
//
// # CEI ordering
// Both functions are called from the Interactions phase of their callers in
// contract.rs — after all storage Effects are committed.  A panic in either
// function rolls back the entire transaction atomically, including the Effects.
//
// # Reentrancy
// Neither function manages reentrancy locks.  Those are held by the outer
// buy_artwork / accept_offer / finalize_auction wrappers for the duration of
// the settlement, which fully covers the release_nft call.

use soroban_sdk::{panic_with_error, Address, Env, IntoVal};

use crate::{
    storage::{clear_escrow_record, get_escrow_record, set_escrow_record, EscrowRecord},
    types::MarketplaceError,
};

// ── Internals ────────────────────────────────────────────────

/// Call `owner_of(token_id)` on `collection` and return the owner address.
fn owner_of(env: &Env, collection: &Address, token_id: u64) -> Address {
    env.invoke_contract::<Address>(
        collection,
        &soroban_sdk::Symbol::new(env, "owner_of"),
        soroban_sdk::vec![env, token_id.into_val(env)],
    )
}

/// Call `transfer_from(spender, from, to, token_id)` on `collection`.
pub(crate) fn transfer_nft(
    env: &Env,
    collection: &Address,
    spender: &Address,
    from: &Address,
    to: &Address,
    token_id: u64,
) {
    env.invoke_contract::<()>(
        collection,
        &soroban_sdk::Symbol::new(env, "transfer_from"),
        soroban_sdk::vec![
            env,
            spender.into_val(env),
            from.into_val(env),
            to.into_val(env),
            token_id.into_val(env),
        ],
    );
}

// ── Public API ───────────────────────────────────────────────

/// Pull `(collection, token_id)` into contract custody for a new listing/auction.
///
/// Checks:
///   1. `owner_of(token_id) == seller` — caller owns the token.
///   2. No existing `EscrowedToken` record — no double-listing.
///
/// On success:
///   • EscrowRecord written to persistent storage.
///   • NFT transferred: seller → marketplace.
///
/// Any panic rolls back everything atomically (including caller's Effects).
pub fn escrow_nft(
    env: &Env,
    seller: &Address,
    collection: &Address,
    token_id: u64,
    is_listing: bool,
    id: u64,
) {
    // Check 1 — ownership verification (external read, fail fast)
    let current_owner = owner_of(env, collection, token_id);
    if current_owner != *seller {
        panic_with_error!(env, MarketplaceError::NotTokenOwner);
    }

    // Check 2 — double-listing guard
    if get_escrow_record(env, collection, token_id).is_some() {
        panic_with_error!(env, MarketplaceError::TokenAlreadyEscrowed);
    }

    // Effect — write escrow index before transfer so rollback cleans both
    set_escrow_record(env, collection, token_id, &EscrowRecord { is_listing, id });

    // Interaction — pull NFT into contract custody
    transfer_nft(
        env,
        collection,
        &env.current_contract_address(),
        seller,
        &env.current_contract_address(),
        token_id,
    );
}

/// Release an escrowed NFT to `recipient` and clear the escrow index.
///
/// Transfers marketplace → recipient, then removes the EscrowedToken record.
/// Emits NftReleasedEvent after a successful transfer.
pub fn release_nft(
    env: &Env,
    collection: &Address,
    token_id: u64,
    recipient: &Address,
    ledger_sequence: u32,
    listing_or_auction_id: u64,
) {
    // Interaction — transfer NFT out of custody
    transfer_nft(
        env,
        collection,
        &env.current_contract_address(),
        &env.current_contract_address(),
        recipient,
        token_id,
    );

    // Effect — clear escrow index (after successful transfer)
    clear_escrow_record(env, collection, token_id);

    // Emit NftReleased
    crate::events::NftReleasedEvent {
        id: listing_or_auction_id,
        collection: collection.clone(),
        token_id,
        recipient: recipient.clone(),
        ledger_sequence,
    }
    .publish(env);
}

/// Emit NftEscrowed — called by contract.rs after escrow_nft succeeds.
pub fn emit_nft_escrowed(
    env: &Env,
    id: u64,
    collection: &Address,
    token_id: u64,
    seller: &Address,
    ledger_sequence: u32,
) {
    crate::events::NftEscrowedEvent {
        id,
        collection: collection.clone(),
        token_id,
        seller: seller.clone(),
        ledger_sequence,
    }
    .publish(env);
}
