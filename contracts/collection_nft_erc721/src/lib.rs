//! NormalNFT721 — ERC-721-equivalent on Soroban.
//!
//! Deployed by the Launchpad factory. The `creator` (collection owner) calls
//! `mint` to issue tokens. Standard transfer / approve / burn logic follows
//! ERC-721 semantics.  Royalty info (bps + receiver) is stored on-chain so
//! marketplaces (Litemint, etc.) can query it.
//!
//! ## Approval model (updated)
//! - Per-token `approve(spender, approved, token_id, expires_at)` stores an
//!   optional expiry (ledger sequence).  Expired approvals are treated as absent.
//! - `set_approval_for_all(operator, approved, expires_at)` stores an optional
//!   expiry per (owner, operator) pair.
//! - `is_approved_for_all` checks the flag **and** that the current ledger
//!   sequence is before the stored expiry (when present).
//! - `revoke_all_approvals(token_id)` lets the token owner clear the per-token
//!   approval immediately and emits `ApprovalRevoked`.
#![no_std]
#![allow(clippy::too_many_arguments, deprecated)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, Env, String,
    Vec,
};

const TTL_THRESHOLD: u32 = 50_000;
const TTL_BUMP: u32 = 100_000;
const MAX_BPS: u32 = 10_000; // 100% in basis points
/// Maximum number of items accepted by any single batch call (#274).
const MAX_BATCH_SIZE: u32 = 200;

// ─── Errors ──────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotOwner = 3,
    NotApproved = 4,
    TokenNotFound = 5,
    MaxSupplyReached = 6,
    NotCreator = 7,
    InsufficientBalance = 8,
    MetadataFrozen = 9,
    AlreadyFrozen = 10,
    InvalidBps = 11,
    CollectionPaused = 12,
    ApprovalExpired = 13,
    /// migrate() called for a version already marked done in persistent storage.
    AlreadyMigrated = 14,
    /// Unsupported version jump — only sequential upgrades are permitted.
    UnsupportedMigration = 15,
}

// ─── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // Instance storage — cheap, shared TTL with contract instance
    Initialized,
    Creator,
    Name,
    Symbol,
    MaxSupply,
    NextTokenId,
    TotalSupply,
    RoyaltyBps,
    RoyaltyReceiver,
    // Persistent storage — per-token / per-owner, independent TTL
    Owner(u64),
    TokenUri(u64),
    Approved(u64),
    /// Optional expiry (ledger sequence) for a per-token approval.
    /// Absent means the approval never expires.
    ApprovedExpiry(u64),
    BalanceOf(Address),
    ApprovedForAll(Address, Address),
    /// Optional expiry (ledger sequence) for an operator-level approval.
    /// Absent means the approval never expires.
    ApprovedForAllExpiry(Address, Address),
    BaseUri,        // String — collection-level base URI (optional)
    MetadataFrozen, // bool   — permanently frozen when true
    // Per-token royalty overrides (persistent, optional)
    TokenRoyaltyReceiver(u64), // Address
    TokenRoyaltyBps(u64),      // u32
    Paused,                    // bool   — minting paused when true
    // ── Versioned migration registry ─────────────────────────────────────
    /// Completion marker: present when migration to `version` is done.
    MigrationDone(String),
    /// Resumable progress cursor during an in-flight migration.
    MigrationCursor(String),
    /// Version string last written to on-chain storage by `migrate()`.
    ContractVersion,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Convert a u64 to its decimal ASCII representation as a Soroban `String`.
/// Used to build `base_uri + token_id` paths in `token_uri()`.
fn u64_to_string(env: &Env, mut n: u64) -> String {
    let mut buf = [0u8; 20]; // u64::MAX has 20 decimal digits
    let mut len = 0usize;
    if n == 0 {
        buf[0] = b'0';
        len = 1;
    } else {
        while n > 0 {
            buf[len] = b'0' + (n % 10) as u8;
            n /= 10;
            len += 1;
        }
        buf[..len].reverse();
    }
    String::from_bytes(env, &buf[..len])
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct NormalNFT721;

#[contractimpl]
#[allow(clippy::too_many_arguments)]
impl NormalNFT721 {
    // ── Initializer (called by Launchpad factory) ──────────────────────────

    pub fn initialize(
        env: Env,
        creator: Address,
        name: String,
        symbol: String,
        max_supply: u64,  // pass u64::MAX for unlimited
        royalty_bps: u32, // e.g. 500 = 5%
        royalty_receiver: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Creator, &creator);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage()
            .instance()
            .set(&DataKey::MaxSupply, &max_supply);
        env.storage().instance().set(&DataKey::NextTokenId, &0u64);
        env.storage().instance().set(&DataKey::TotalSupply, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::RoyaltyBps, &royalty_bps);
        env.storage()
            .instance()
            .set(&DataKey::RoyaltyReceiver, &royalty_receiver);
        env.storage().instance().extend_ttl(50_000, 100_000);
        Ok(())
    }

    pub fn next_token_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextTokenId)
            .unwrap_or(0)
    }

    // ── Minting ───────────────────────────────────────────────────────────

    /// Creator mints a single token to `to` with the given metadata URI.
    /// Returns the new token_id.
    pub fn mint(env: Env, to: Address, uri: String) -> Result<u64, Error> {
        Self::extend_instance_ttl(&env);
        let creator = Self::only_creator(&env)?;

        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(Error::CollectionPaused);
        }

        let token_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTokenId)
            .unwrap_or(0);
        let max: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MaxSupply)
            .unwrap_or(u64::MAX);

        if token_id >= max {
            return Err(Error::MaxSupplyReached);
        }

        Self::_do_mint(&env, &to, token_id, &uri);

        env.events().publish(
            (symbol_short!("mint"), creator.clone(), to.clone()),
            (token_id, 1u128),
        );
        Ok(token_id)
    }

    /// Batch mint multiple tokens to the same recipient.
    /// Optimized to minimize storage I/O - reads storage once, mints in memory, writes back once.
    pub fn batch_mint(env: Env, to: Address, uris: Vec<String>) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let creator = Self::only_creator(&env)?;

        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(Error::CollectionPaused);
        }

        let uris_len = uris.len();
        if uris_len == 0 {
            return Err(Error::EmptyBatch);
        }
        if uris_len > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        // Read storage ONCE before the loop
        let mut next_token_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTokenId)
            .unwrap_or(0);
        let max_supply: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MaxSupply)
            .unwrap_or(u64::MAX);
        let mut total_supply: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);

        // Check if we have enough supply for all tokens
        if next_token_id + (uris_len as u64) > max_supply {
            return Err(Error::MaxSupplyReached);
        }

        // Get current balance once (will be incremented for each mint)
        let mut current_balance: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BalanceOf(to.clone()))
            .unwrap_or(0);

        // Collect token IDs to emit events
        let mut minted_ids = Vec::new(&env);

        // Mint all tokens in memory first
        for uri in uris.iter() {
            let token_id = next_token_id;

            // Store token data
            env.storage()
                .persistent()
                .set(&DataKey::Owner(token_id), &to);
            env.storage()
                .persistent()
                .set(&DataKey::TokenUri(token_id), &uri);
            env.storage().persistent().extend_ttl(
                &DataKey::Owner(token_id),
                TTL_THRESHOLD,
                TTL_BUMP,
            );
            env.storage().persistent().extend_ttl(
                &DataKey::TokenUri(token_id),
                TTL_THRESHOLD,
                TTL_BUMP,
            );

            minted_ids.push_back(token_id);

            // Increment in memory
            next_token_id += 1;
            total_supply += 1;
            current_balance += 1;
        }

        // Write back to storage ONCE after the loop
        env.storage()
            .instance()
            .set(&DataKey::NextTokenId, &next_token_id);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &total_supply);
        env.storage()
            .persistent()
            .set(&DataKey::BalanceOf(to.clone()), &current_balance);
        env.storage().persistent().extend_ttl(
            &DataKey::BalanceOf(to.clone()),
            TTL_THRESHOLD,
            TTL_BUMP,
        );

        for token_id in minted_ids.iter() {
            env.events().publish(
                (symbol_short!("mint"), creator.clone(), to.clone()),
                (token_id, 1u128),
            );
        }

        Ok(())
    }

    // ── Transfers ─────────────────────────────────────────────────────────

    /// Owner transfers their token.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u64) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        from.require_auth();
        Self::_transfer(&env, &from, &to, token_id)
    }

    /// Approved spender (or operator) transfers on behalf of owner.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        token_id: u64,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        spender.require_auth();
        Self::_check_approved(&env, &spender, &from, token_id)?;
        // clear single-token approval + its expiry on transfer
        env.storage()
            .persistent()
            .remove(&DataKey::Approved(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::ApprovedExpiry(token_id));
        Self::_transfer(&env, &from, &to, token_id)
    }

    // ── Approvals ─────────────────────────────────────────────────────────

    /// Grant `approved` permission to transfer `token_id`.
    ///
    /// `expires_at` — optional ledger sequence number after which this
    /// approval is treated as absent.  Passing a sequence that has already
    /// passed is rejected with `ApprovalExpired`.
    pub fn approve(
        env: Env,
        spender: Address, // caller — must be owner or authorized operator
        approved: Address,
        token_id: u64,
        expires_at: Option<u32>,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        spender.require_auth();
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner(token_id))
            .ok_or(Error::TokenNotFound)?;

        // [SECURITY] Allow owner or authorized operator to approve (#48)
        if spender != owner
            && !Self::is_approved_for_all(env.clone(), owner.clone(), spender.clone())
        {
            return Err(Error::NotApproved);
        }

        // Reject an expiry that is already in the past.
        if let Some(exp) = expires_at {
            if env.ledger().sequence() >= exp {
                return Err(Error::ApprovalExpired);
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::Approved(token_id), &approved);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Approved(token_id), TTL_THRESHOLD, TTL_BUMP);

        // Store or clear expiry
        match expires_at {
            Some(exp) => {
                env.storage()
                    .persistent()
                    .set(&DataKey::ApprovedExpiry(token_id), &exp);
                env.storage()
                    .persistent()
                    .extend_ttl(&DataKey::ApprovedExpiry(token_id), TTL_THRESHOLD, TTL_BUMP);
            }
            None => {
                env.storage()
                    .persistent()
                    .remove(&DataKey::ApprovedExpiry(token_id));
            }
        }

        // Emit ApprovalSet (primary) + legacy approve topic
        env.events().publish(
            (symbol_short!("appr_set"), owner.clone()),
            (approved.clone(), token_id, expires_at),
        );
        env.events()
            .publish((symbol_short!("approve"), owner), (approved, token_id));
        Ok(())
    }

    /// Grant or revoke operator-level approval over all tokens owned by
    /// the caller.
    ///
    /// `expires_at` — optional ledger sequence number after which this
    /// approval is treated as absent.  Ignored when `approved` is `false`.
    pub fn set_approval_for_all(
        env: Env,
        owner: Address,
        operator: Address,
        approved: bool,
        expires_at: Option<u32>,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        owner.require_auth();

        // Reject an expiry already in the past (only relevant when granting).
        if approved {
            if let Some(exp) = expires_at {
                if env.ledger().sequence() >= exp {
                    return Err(Error::ApprovalExpired);
                }
            }
        }

        let key = DataKey::ApprovedForAll(owner.clone(), operator.clone());
        let expiry_key = DataKey::ApprovedForAllExpiry(owner.clone(), operator.clone());

        env.storage().persistent().set(&key, &approved);
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);

        // Store or clear expiry
        match (approved, expires_at) {
            (true, Some(exp)) => {
                env.storage().persistent().set(&expiry_key, &exp);
                env.storage()
                    .persistent()
                    .extend_ttl(&expiry_key, TTL_THRESHOLD, TTL_BUMP);
            }
            _ => {
                env.storage().persistent().remove(&expiry_key);
            }
        }

        // Emit ApprovalForAllSet (primary) + legacy appr_all topic
        env.events().publish(
            (symbol_short!("apfa_set"), owner.clone()),
            (operator.clone(), approved, expires_at),
        );
        env.events()
            .publish((symbol_short!("appr_all"), owner), (operator, approved));
        Ok(())
    }

    /// Remove the per-token approval for `token_id` immediately.
    ///
    /// Only the token owner can call this.  Emits `ApprovalRevoked`.
    pub fn revoke_all_approvals(env: Env, token_id: u64) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner(token_id))
            .ok_or(Error::TokenNotFound)?;
        owner.require_auth();

        let had_approval = env
            .storage()
            .persistent()
            .has(&DataKey::Approved(token_id));

        env.storage()
            .persistent()
            .remove(&DataKey::Approved(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::ApprovedExpiry(token_id));

        if had_approval {
            // Emit ApprovalRevoked event
            env.events().publish(
                (symbol_short!("appr_rev"), owner),
                token_id,
            );
        }
        Ok(())
    }

    // ── Burn ──────────────────────────────────────────────────────────────

    pub fn burn(env: Env, spender: Address, token_id: u64) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        spender.require_auth();
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner(token_id))
            .ok_or(Error::TokenNotFound)?;

        // [SECURITY] Allow owner, approved spender, or operator to burn (#48)
        Self::_check_approved(&env, &spender, &owner, token_id)?;

        let bal: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BalanceOf(owner.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::BalanceOf(owner.clone()), &(bal.saturating_sub(1)));
        env.storage().persistent().extend_ttl(
            &DataKey::BalanceOf(owner.clone()),
            TTL_THRESHOLD,
            TTL_BUMP,
        );

        env.storage().persistent().remove(&DataKey::Owner(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::TokenUri(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::Approved(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::ApprovedExpiry(token_id));

        let supply: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply.saturating_sub(1)));

        env.events()
            .publish((symbol_short!("burn"), owner), token_id);
        Ok(())
    }

    // ── View functions ────────────────────────────────────────────────────

    pub fn owner_of(env: Env, token_id: u64) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Owner(token_id))
            .ok_or(Error::TokenNotFound)
    }

    pub fn token_uri(env: Env, token_id: u64) -> Result<String, Error> {
        // Verify the token exists first.
        if !env.storage().persistent().has(&DataKey::Owner(token_id)) {
            return Err(Error::TokenNotFound);
        }
        // If a base URI is set, return base_uri + token_id.
        if let Some(base) = env
            .storage()
            .instance()
            .get::<DataKey, String>(&DataKey::BaseUri)
        {
            let id_str = u64_to_string(&env, token_id);
            let mut combined: Bytes = base.into();
            let id_bytes: Bytes = id_str.into();
            combined.append(&id_bytes);
            return Ok(String::from(&combined));
        }
        // Fall back to per-token URI stored at mint time.
        env.storage()
            .persistent()
            .get(&DataKey::TokenUri(token_id))
            .ok_or(Error::TokenNotFound)
    }

    pub fn balance_of(env: Env, owner: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::BalanceOf(owner))
            .unwrap_or(0)
    }

    pub fn total_supply(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn max_supply(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MaxSupply)
            .unwrap_or(u64::MAX)
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }

    pub fn creator(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Creator).unwrap()
    }

    /// Returns (royalty_receiver, royalty_bps) for the collection default.
    /// Preserved for backward compatibility with existing marketplace integrations.
    pub fn royalty_info(env: Env) -> (Address, u32) {
        (
            env.storage()
                .instance()
                .get(&DataKey::RoyaltyReceiver)
                .unwrap(),
            env.storage()
                .instance()
                .get(&DataKey::RoyaltyBps)
                .unwrap_or(0),
        )
    }

    /// EIP-2981-style royalty query: returns (recipient, royalty_amount) for a
    /// given token and sale price.  Per-token overrides take priority over the
    /// collection default.  Royalty amount = sale_price * bps / 10_000 using
    /// checked arithmetic (returns 0 amount when sale_price is 0).
    pub fn royalty_info_for(
        env: Env,
        token_id: u64,
        sale_price: i128,
    ) -> Result<(Address, i128), Error> {
        // Resolve recipient and bps — per-token override wins if present.
        let (receiver, bps) = if env
            .storage()
            .persistent()
            .has(&DataKey::TokenRoyaltyBps(token_id))
        {
            let r: Address = env
                .storage()
                .persistent()
                .get(&DataKey::TokenRoyaltyReceiver(token_id))
                .ok_or(Error::NotInitialized)?;
            let b: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::TokenRoyaltyBps(token_id))
                .unwrap_or(0);
            (r, b)
        } else {
            (
                env.storage()
                    .instance()
                    .get(&DataKey::RoyaltyReceiver)
                    .ok_or(Error::NotInitialized)?,
                env.storage()
                    .instance()
                    .get(&DataKey::RoyaltyBps)
                    .unwrap_or(0),
            )
        };

        // Checked arithmetic: sale_price * bps / MAX_BPS
        let amount = sale_price
            .checked_mul(bps as i128)
            .unwrap_or(0)
            .checked_div(MAX_BPS as i128)
            .unwrap_or(0);

        Ok((receiver, amount))
    }

    pub fn get_approved(env: Env, token_id: u64) -> Option<Address> {
        // Return None if the approval has expired
        if let Some(exp) = env
            .storage()
            .persistent()
            .get::<DataKey, u32>(&DataKey::ApprovedExpiry(token_id))
        {
            if env.ledger().sequence() >= exp {
                return None;
            }
        }
        env.storage().persistent().get(&DataKey::Approved(token_id))
    }

    /// Returns `true` when `operator` has a valid (non-expired)
    /// approval-for-all over `owner`'s tokens.
    pub fn is_approved_for_all(env: Env, owner: Address, operator: Address) -> bool {
        let flag: bool = env
            .storage()
            .persistent()
            .get(&DataKey::ApprovedForAll(owner.clone(), operator.clone()))
            .unwrap_or(false);

        if !flag {
            return false;
        }

        // Check expiry when present
        if let Some(exp) = env
            .storage()
            .persistent()
            .get::<DataKey, u32>(&DataKey::ApprovedForAllExpiry(owner, operator))
        {
            if env.ledger().sequence() >= exp {
                return false;
            }
        }

        true
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    pub fn transfer_ownership(env: Env, new_creator: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Creator, &new_creator);
        Ok(())
    }

    pub fn update_royalty(env: Env, receiver: Address, bps: u32) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::RoyaltyReceiver, &receiver);
        env.storage().instance().set(&DataKey::RoyaltyBps, &bps);
        Ok(())
    }

    /// Set the collection-level default royalty with bps validation.
    /// Replaces any previously stored default.  Callable only by creator.
    pub fn set_default_royalty(env: Env, receiver: Address, bps: u32) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        if bps > MAX_BPS {
            return Err(Error::InvalidBps);
        }
        env.storage()
            .instance()
            .set(&DataKey::RoyaltyReceiver, &receiver);
        env.storage().instance().set(&DataKey::RoyaltyBps, &bps);
        Ok(())
    }

    /// Set a per-token royalty override with bps validation.
    /// When set, `royalty_info_for(token_id, ..)` uses this instead of the default.
    /// Callable only by creator.
    pub fn set_token_royalty(
        env: Env,
        token_id: u64,
        receiver: Address,
        bps: u32,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        if bps > MAX_BPS {
            return Err(Error::InvalidBps);
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenRoyaltyReceiver(token_id), &receiver);
        env.storage()
            .persistent()
            .set(&DataKey::TokenRoyaltyBps(token_id), &bps);
        env.storage().persistent().extend_ttl(
            &DataKey::TokenRoyaltyReceiver(token_id),
            TTL_THRESHOLD,
            TTL_BUMP,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::TokenRoyaltyBps(token_id),
            TTL_THRESHOLD,
            TTL_BUMP,
        );
        Ok(())
    }

    /// Pause minting.  Callable only by creator.
    pub fn pause(env: Env) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    /// Resume minting.  Callable only by creator.
    pub fn unpause(env: Env) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Returns `true` if minting is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Update the collection-level base URI.  Reverts if metadata is frozen.
    /// Callable only by creator.
    pub fn set_base_uri(env: Env, base_uri: String) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::MetadataFrozen)
            .unwrap_or(false)
        {
            return Err(Error::MetadataFrozen);
        }
        env.storage().instance().set(&DataKey::BaseUri, &base_uri);
        Ok(())
    }

    /// Permanently freeze metadata.  Can only be called once; subsequent calls
    /// revert with `AlreadyFrozen`.  Callable only by creator.
    pub fn freeze_metadata(env: Env) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;
        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::MetadataFrozen)
            .unwrap_or(false)
        {
            return Err(Error::AlreadyFrozen);
        }
        env.storage()
            .instance()
            .set(&DataKey::MetadataFrozen, &true);
        Ok(())
    }

    /// Returns `true` if metadata has been permanently frozen.
    pub fn is_metadata_frozen(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::MetadataFrozen)
            .unwrap_or(false)
    }

    /// Returns the stored base URI, or `None` if unset.
    pub fn base_uri(env: Env) -> Option<String> {
        env.storage().instance().get(&DataKey::BaseUri)
    }

    // ── Versioning & Migration ─────────────────────────────────────────────

    /// Semantic version compiled into this WASM.
    pub fn version(_env: Env) -> &'static str {
        "1.0.0"
    }

    /// On-chain version string last written by `migrate()`, or `None` before
    /// the first migration.
    pub fn contract_version(env: Env) -> Option<String> {
        env.storage().instance().get(&DataKey::ContractVersion)
    }

    /// Creator-guarded, idempotent storage migration entry point.
    ///
    /// Reverts with `AlreadyMigrated` when the "1.0.0" marker is already set.
    ///
    /// **v1.0.0 migration**: this is the initial version; the migration body
    /// is intentionally empty — calling it simply records the completion marker
    /// and the on-chain version string so operators can verify the upgrade
    /// script applied correctly.  Future versions will add data-backfill steps
    /// here following the same idempotent-by-marker pattern.
    pub fn migrate(env: Env) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        Self::only_creator(&env)?;

        let target = String::from_str(&env, "1.0.0");
        let done_key = DataKey::MigrationDone(target.clone());

        if env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&done_key)
            .unwrap_or(false)
        {
            return Err(Error::AlreadyMigrated);
        }

        // ── v1.0.0 migration body ─────────────────────────────────────────
        // Nothing to migrate for the initial version.  Future versions insert
        // data-backfill logic here before recording the marker.
        // ─────────────────────────────────────────────────────────────────

        // Record completion marker (persistent so it survives instance bumps).
        env.storage().persistent().set(&done_key, &true);
        env.storage().persistent().extend_ttl(
            &done_key,
            TTL_THRESHOLD,
            TTL_BUMP,
        );

        // Write the version to instance storage for operator verification.
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &target);

        env.events().publish(
            (soroban_sdk::symbol_short!("migrated"), target),
            (),
        );
        Ok(())
    }

    // ── Private helpers ───────────────────────────────────────────────────

    fn extend_instance_ttl(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
    }

    fn only_creator(env: &Env) -> Result<Address, Error> {
        let creator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Creator)
            .ok_or(Error::NotInitialized)?;
        creator.require_auth();
        Ok(creator)
    }

    fn _do_mint(env: &Env, to: &Address, token_id: u64, uri: &String) {
        env.storage()
            .persistent()
            .set(&DataKey::Owner(token_id), to);
        env.storage()
            .persistent()
            .set(&DataKey::TokenUri(token_id), uri);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Owner(token_id), 50_000, 100_000);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::TokenUri(token_id), 50_000, 100_000);

        let bal: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BalanceOf(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::BalanceOf(to.clone()), &(bal + 1));
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::BalanceOf(to.clone()), 50_000, 100_000);

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTokenId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextTokenId, &(next + 1));

        let supply: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply + 1));
    }

    fn _transfer(env: &Env, from: &Address, to: &Address, token_id: u64) -> Result<(), Error> {
        // [SECURITY] Clear single-token approval + expiry on every transfer (#50)
        env.storage()
            .persistent()
            .remove(&DataKey::Approved(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::ApprovedExpiry(token_id));

        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner(token_id))
            .ok_or(Error::TokenNotFound)?;
        if owner != *from {
            return Err(Error::NotOwner);
        }

        let from_bal: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BalanceOf(from.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::BalanceOf(from.clone()),
            &(from_bal.saturating_sub(1)),
        );
        env.storage().persistent().extend_ttl(
            &DataKey::BalanceOf(from.clone()),
            TTL_THRESHOLD,
            TTL_BUMP,
        );

        let to_bal: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BalanceOf(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::BalanceOf(to.clone()), &(to_bal + 1));
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::BalanceOf(to.clone()), 50_000, 100_000);

        env.storage()
            .persistent()
            .set(&DataKey::Owner(token_id), to);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Owner(token_id), TTL_THRESHOLD, TTL_BUMP);
        env.events().publish(
            (symbol_short!("transfer"), from.clone(), to.clone()),
            (token_id, 1u128),
        );
        Ok(())
    }

    fn _check_approved(
        env: &Env,
        spender: &Address,
        from: &Address,
        token_id: u64,
    ) -> Result<(), Error> {
        // Check single-token approval (respecting expiry)
        if let Some(approved) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::Approved(token_id))
        {
            if approved == *spender {
                // Verify the approval has not expired
                let expired = env
                    .storage()
                    .persistent()
                    .get::<DataKey, u32>(&DataKey::ApprovedExpiry(token_id))
                    .map(|exp| env.ledger().sequence() >= exp)
                    .unwrap_or(false);

                if !expired {
                    return Ok(());
                }
            }
        }
        // Check operator approval (with expiry handled inside is_approved_for_all)
        if Self::is_approved_for_all(env.clone(), from.clone(), spender.clone()) {
            return Ok(());
        }
        Err(Error::NotApproved)
    }
}

#[cfg(test)]
mod test;
