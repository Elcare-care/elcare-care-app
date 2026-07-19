//! Launchpad — Factory contract that deploys the 4 NFT collection types.
//!
//! # Deployment flow
//!
//! 1. Admin deploys this contract and calls `initialize`.
//! 2. Admin uploads each of the 4 collection WASMs with:
//!    `stellar contract upload --wasm <file>.wasm --network testnet`
//!    and then calls `set_wasm_hashes` with the 4 resulting 32-byte hashes.
//! 3. Any user can now call one of the four `deploy_*` functions to launch
//!    their own collection.  The factory calls `initialize` on the freshly
//!    deployed contract in the same transaction — no second call needed.
//!
//! # Fee model
//!
//! Two distinct fees, deliberately typed apart:
//! * `deploy_fee: i128` — a flat, token-denominated amount transferred from
//!   the creator to `fee_receiver` on every `deploy_*` call.
//! * `platform_fee_bps: u32` — a per-collection basis-point fee chosen by the
//!   creator (≤ `MAX_FEE_BPS`), recorded in the registry and forwarded to the
//!   lazy-mint contracts so they can split redemption proceeds.
//!
//! # Deterministic addresses (clone-equivalent)
//! `env.deployer().with_current_contract(salt)` gives a deterministic address
//! from `sha256(factory_address ‖ salt)`.  Clients can pre-compute the address
//! before the transaction confirms.  Pass a different `salt` for each collection.
//!
//! # Why this is Soroban's answer to EIP-1167 clones
//! The collection WASM is stored once on the network (identified by hash).
//! Every `deploy()` call shares that same WASM — no bytecode duplication.
//! Each instance gets completely isolated storage.

use soroban_sdk::{
    contract, contractimpl, symbol_short, token, xdr::ToXdr, Address, Bytes, BytesN, Env, String,
    Vec,
};

use crate::{
    events, storage,
    types::{CollectionKind, CollectionRecord, Error, WasmHashes},
};

/// Maximum allowed platform fee (20 %) — issue #38.
const MAX_FEE_BPS: u32 = 2000;

// ─── Cross-contract clients ───────────────────────────────────────────────────

mod iface {
    use soroban_sdk::{contractclient, Address, BytesN, Env, String};

    #[contractclient(name = "Normal721Client")]
    pub trait INormal721 {
        fn initialize(
            env: Env,
            creator: Address,
            name: String,
            symbol: String,
            max_supply: u64,
            royalty_bps: u32,
            royalty_receiver: Address,
        );
    }

    #[contractclient(name = "Normal1155Client")]
    pub trait INormal1155 {
        fn initialize(
            env: Env,
            creator: Address,
            name: String,
            royalty_bps: u32,
            royalty_receiver: Address,
        );
    }

    /// Issue #38: lazy mint contracts accept per-collection platform fee at init.
    #[contractclient(name = "Lazy721Client")]
    #[allow(clippy::too_many_arguments)]
    pub trait ILazy721 {
        fn initialize(
            env: Env,
            creator: Address,
            creator_pubkey: BytesN<32>,
            name: String,
            symbol: String,
            max_supply: u64,
            royalty_bps: u32,
            royalty_receiver: Address,
            platform_fee_receiver: Address,
            platform_fee_bps: u32,
        );
    }

    #[contractclient(name = "Lazy1155Client")]
    #[allow(clippy::too_many_arguments)]
    pub trait ILazy1155 {
        fn initialize(
            env: Env,
            creator: Address,
            creator_pubkey: BytesN<32>,
            name: String,
            royalty_bps: u32,
            royalty_receiver: Address,
            platform_fee_receiver: Address,
            platform_fee_bps: u32,
        );
    }
}

use iface::{Lazy1155Client, Lazy721Client, Normal1155Client, Normal721Client};

// ─── Salt hardening ───────────────────────────────────────────────────────────
fn make_secure_salt(env: &Env, creator: &Address, raw_salt: &BytesN<32>) -> BytesN<32> {
    let mut raw = Bytes::new(env);
    raw.append(&creator.to_xdr(env));
    raw.extend_from_array(&raw_salt.to_array());
    env.crypto().sha256(&raw).into()
}

// ─── Shared deploy guards ─────────────────────────────────────────────────────

fn require_not_paused(env: &Env) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

/// Transfers the flat deploy fee (if any) from `creator` to the treasury and
/// emits `fee_coll`.  Returns the configured fee receiver so lazy deploys can
/// forward it to the child contract as `platform_fee_receiver`.
fn collect_deploy_fee(env: &Env, creator: &Address, currency: &Address) -> Address {
    let (receiver, deploy_fee) = storage::get_fee_config(env);
    if deploy_fee > 0 {
        token::TokenClient::new(env, currency).transfer(creator, &receiver, &deploy_fee);
        events::publish_deployment_fee_collected(env, creator, &receiver, deploy_fee, currency);
    }
    receiver
}

#[contract]
pub struct Launchpad;

#[contractimpl]
#[allow(clippy::too_many_arguments)]
impl Launchpad {
    pub fn initialize(
        env: Env,
        admin: Address,
        fee_receiver: Address,
        deploy_fee: i128,
    ) -> Result<(), Error> {
        if storage::is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        if deploy_fee < 0 {
            return Err(Error::InvalidDeployFee);
        }
        admin.require_auth();
        storage::set_initialized(&env);
        storage::set_admin(&env, &admin);
        storage::set_fee_config(&env, &fee_receiver, deploy_fee);
        Ok(())
    }

    /// Records the four collection WASM hashes, bumps the version counter and
    /// emits `wasm_set` so indexers can track factory upgrades.
    pub fn set_wasm_hashes(
        env: Env,
        wasm_normal_721: BytesN<32>,
        wasm_normal_1155: BytesN<32>,
        wasm_lazy_721: BytesN<32>,
        wasm_lazy_1155: BytesN<32>,
    ) -> Result<u32, Error> {
        storage::extend_instance_ttl(&env);
        storage::require_admin(&env)?;
        let version = storage::set_wasm_hashes(
            &env,
            &wasm_normal_721,
            &wasm_normal_1155,
            &wasm_lazy_721,
            &wasm_lazy_1155,
        );
        events::publish_wasm_hashes_set(
            &env,
            version,
            &wasm_normal_721,
            &wasm_normal_1155,
            &wasm_lazy_721,
            &wasm_lazy_1155,
        );
        Ok(version)
    }

    // ── Deploy: Normal ERC-721 ────────────────────────────────────────────

    /// Issue #38: `platform_fee_bps` is validated (≤ MAX_FEE_BPS) and stored in the registry.
    pub fn deploy_normal_721(
        env: Env,
        creator: Address,
        currency: Address,
        name: String,
        symbol: String,
        max_supply: u64,
        royalty_bps: u32,
        royalty_receiver: Address,
        platform_fee_bps: u32,
        salt: BytesN<32>,
    ) -> Result<Address, Error> {
        storage::extend_instance_ttl(&env);
        creator.require_auth();
        require_not_paused(&env)?;

        if platform_fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFeeBps);
        }

        let (receiver, fee) = storage::get_platform_fee(&env);
        if fee > 0 {
            soroban_sdk::token::TokenClient::new(&env, &currency).transfer(
                &creator,
                &receiver,
                &(fee as i128),
            );
            events::publish_deployment_fee_collected(
                &env,
                &creator,
                &receiver,
                fee as i128,
                &currency,
            );
        }

        let wasm = storage::get_wasm_normal_721(&env).ok_or(Error::WasmHashNotSet)?;
        collect_deploy_fee(&env, &creator, &currency);

        let secure_salt = make_secure_salt(&env, &creator, &salt);
        let addr = env
            .deployer()
            .with_current_contract(secure_salt)
            .deploy_v2(wasm, ());

        Normal721Client::new(&env, &addr).initialize(
            &creator,
            &name,
            &symbol,
            &max_supply,
            &royalty_bps,
            &royalty_receiver,
        );

        storage::record_collection(
            &env,
            &creator,
            &addr,
            CollectionKind::Normal721,
            &name,
            &symbol,
            env.ledger().sequence(),
            platform_fee_bps,
        );
        events::publish_deploy(&env, symbol_short!("n721"), &creator, &addr);
        Ok(addr)
    }

    // ── Deploy: Normal ERC-1155 ──────────────────────────────────────────
    pub fn deploy_normal_1155(
        env: Env,
        creator: Address,
        currency: Address,
        name: String,
        royalty_bps: u32,
        royalty_receiver: Address,
        platform_fee_bps: u32,
        salt: BytesN<32>,
    ) -> Result<Address, Error> {
        storage::extend_instance_ttl(&env);
        creator.require_auth();
        require_not_paused(&env)?;

        if platform_fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFeeBps);
        }

        let (receiver, fee) = storage::get_platform_fee(&env);
        if fee > 0 {
            soroban_sdk::token::TokenClient::new(&env, &currency).transfer(
                &creator,
                &receiver,
                &(fee as i128),
            );
            events::publish_deployment_fee_collected(
                &env,
                &creator,
                &receiver,
                fee as i128,
                &currency,
            );
        }

        let wasm = storage::get_wasm_normal_1155(&env).ok_or(Error::WasmHashNotSet)?;
        collect_deploy_fee(&env, &creator, &currency);

        let secure_salt = make_secure_salt(&env, &creator, &salt);
        let addr = env
            .deployer()
            .with_current_contract(secure_salt)
            .deploy_v2(wasm, ());

        Normal1155Client::new(&env, &addr).initialize(
            &creator,
            &name,
            &royalty_bps,
            &royalty_receiver,
        );

        let empty_symbol = String::from_str(&env, "");
        storage::record_collection(
            &env,
            &creator,
            &addr,
            CollectionKind::Normal1155,
            &name,
            &empty_symbol,
            env.ledger().sequence(),
            platform_fee_bps,
        );
        events::publish_deploy(&env, symbol_short!("n1155"), &creator, &addr);
        Ok(addr)
    }

    // ── Deploy: LazyMint ERC-721 ──────────────────────────────────────────

    /// Issue #38: passes per-collection fee to the lazy mint contract so that
    /// fee splits are applied at voucher redemption time.
    pub fn deploy_lazy_721(
        env: Env,
        creator: Address,
        currency: Address,
        creator_pubkey: BytesN<32>,
        name: String,
        symbol: String,
        max_supply: u64,
        royalty_bps: u32,
        royalty_receiver: Address,
        platform_fee_bps: u32,
        salt: BytesN<32>,
    ) -> Result<Address, Error> {
        storage::extend_instance_ttl(&env);
        creator.require_auth();
        require_not_paused(&env)?;

        if platform_fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFeeBps);
        }

        let (platform_fee_receiver, fee) = storage::get_platform_fee(&env);
        if fee > 0 {
            soroban_sdk::token::TokenClient::new(&env, &currency).transfer(
                &creator,
                &platform_fee_receiver,
                &(fee as i128),
            );
            events::publish_deployment_fee_collected(
                &env,
                &creator,
                &receiver,
                fee as i128,
                &currency,
            );
        }

        let wasm = storage::get_wasm_lazy_721(&env).ok_or(Error::WasmHashNotSet)?;
        let platform_fee_receiver = collect_deploy_fee(&env, &creator, &currency);

        let secure_salt = make_secure_salt(&env, &creator, &salt);
        let addr = env
            .deployer()
            .with_current_contract(secure_salt)
            .deploy_v2(wasm, ());

        Lazy721Client::new(&env, &addr).initialize(
            &creator,
            &creator_pubkey,
            &name,
            &symbol,
            &max_supply,
            &royalty_bps,
            &royalty_receiver,
            &platform_fee_receiver,
            &platform_fee_bps,
        );

        storage::record_collection(
            &env,
            &creator,
            &addr,
            CollectionKind::LazyMint721,
            &name,
            &symbol,
            env.ledger().sequence(),
            platform_fee_bps,
        );
        events::publish_deploy(&env, symbol_short!("l721"), &creator, &addr);
        Ok(addr)
    }

    // ── Deploy: LazyMint ERC-1155 ─────────────────────────────────────────
    pub fn deploy_lazy_1155(
        env: Env,
        creator: Address,
        currency: Address,
        creator_pubkey: BytesN<32>,
        name: String,
        royalty_bps: u32,
        royalty_receiver: Address,
        platform_fee_bps: u32,
        salt: BytesN<32>,
    ) -> Result<Address, Error> {
        storage::extend_instance_ttl(&env);
        creator.require_auth();
        require_not_paused(&env)?;

        if platform_fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFeeBps);
        }

        let (platform_fee_receiver, fee) = storage::get_platform_fee(&env);
        if fee > 0 {
            soroban_sdk::token::TokenClient::new(&env, &currency).transfer(
                &creator,
                &platform_fee_receiver,
                &(fee as i128),
            );
            events::publish_deployment_fee_collected(
                &env,
                &creator,
                &receiver,
                fee as i128,
                &currency,
            );
        }

        let wasm = storage::get_wasm_lazy_1155(&env).ok_or(Error::WasmHashNotSet)?;
        let platform_fee_receiver = collect_deploy_fee(&env, &creator, &currency);

        let secure_salt = make_secure_salt(&env, &creator, &salt);
        let addr = env
            .deployer()
            .with_current_contract(secure_salt)
            .deploy_v2(wasm, ());

        Lazy1155Client::new(&env, &addr).initialize(
            &creator,
            &creator_pubkey,
            &name,
            &royalty_bps,
            &royalty_receiver,
            &platform_fee_receiver,
            &platform_fee_bps,
        );

        let empty_symbol = String::from_str(&env, "");
        storage::record_collection(
            &env,
            &creator,
            &addr,
            CollectionKind::LazyMint1155,
            &name,
            &empty_symbol,
            env.ledger().sequence(),
            platform_fee_bps,
        );
        events::publish_deploy(&env, symbol_short!("l1155"), &creator, &addr);
        Ok(addr)
    }

    // ── Admin management (two-step transfer) ──────────────────────────────

    /// Step 1: the current admin proposes a successor.  Overwrites any
    /// previously pending proposal.  The successor must call `accept_admin`.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        storage::extend_instance_ttl(&env);
        let admin = storage::require_admin(&env)?;
        storage::set_pending_admin(&env, &new_admin);
        events::publish_admin_transfer_proposed(&env, &admin, &new_admin);
        Ok(())
    }

    /// Step 2: the proposed successor accepts the role.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        storage::extend_instance_ttl(&env);
        new_admin.require_auth();
        let pending = storage::get_pending_admin(&env).ok_or(Error::NoPendingAdmin)?;
        if new_admin != pending {
            return Err(Error::NotPendingAdmin);
        }
        let old_admin = storage::get_admin(&env).ok_or(Error::NotInitialized)?;
        storage::set_admin(&env, &new_admin);
        storage::clear_pending_admin(&env);
        events::publish_admin_transfer_accepted(&env, &old_admin, &new_admin);
        Ok(())
    }

    /// Cancels a pending admin proposal.  Only the current admin may cancel.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        storage::extend_instance_ttl(&env);
        let admin = storage::require_admin(&env)?;
        let pending = storage::get_pending_admin(&env).ok_or(Error::NoPendingAdmin)?;
        storage::clear_pending_admin(&env);
        events::publish_admin_transfer_cancelled(&env, &admin, &pending);
        Ok(())
    }

    // ── Pause ─────────────────────────────────────────────────────────────

    /// Halts all four `deploy_*` functions.
    pub fn pause(env: Env) -> Result<(), Error> {
        storage::extend_instance_ttl(&env);
        let admin = storage::require_admin(&env)?;
        storage::set_paused(&env, true);
        events::publish_paused(&env, &admin, true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        storage::extend_instance_ttl(&env);
        let admin = storage::require_admin(&env)?;
        storage::set_paused(&env, false);
        events::publish_paused(&env, &admin, false);
        Ok(())
    }

    // ── Fee config ────────────────────────────────────────────────────────

    /// Sets both the treasury address and the flat deploy fee (token smallest
    /// unit).  Replaces the former `set_deploy_fee` / `set_treasury` /
    /// `update_platform_fee` trio.
    pub fn set_fee_config(env: Env, receiver: Address, deploy_fee: i128) -> Result<(), Error> {
        storage::extend_instance_ttl(&env);
        storage::require_admin(&env)?;
        if deploy_fee < 0 {
            return Err(Error::InvalidDeployFee);
        }
        storage::set_fee_config(&env, &receiver, deploy_fee);
        events::publish_fee_config_updated(&env, &receiver, deploy_fee);
        Ok(())
    }

    // ── View functions ────────────────────────────────────────────────────

    pub fn collections_by_creator(env: Env, creator: Address) -> Vec<CollectionRecord> {
        storage::collections_by_creator(&env, &creator)
    }

    pub fn all_collections(env: Env) -> Vec<CollectionRecord> {
        storage::all_collections(&env)
    }

    pub fn collection_count(env: Env) -> u64 {
        storage::collection_count(&env)
    }

    /// Direct O(1) lookup of a collection by its deployed address (#37).
    pub fn get_collection(env: Env, address: Address) -> Option<CollectionRecord> {
        storage::get_collection_by_address(&env, &address)
    }

    /// Paginated read of the global registry (#37).
    pub fn get_collections(env: Env, start: u64, limit: u32) -> Vec<CollectionRecord> {
        storage::get_collections_paginated(&env, start, limit)
    }

    pub fn admin(env: Env) -> Address {
        storage::get_admin(&env).unwrap()
    }

    pub fn pending_admin(env: Env) -> Option<Address> {
        storage::get_pending_admin(&env)
    }

    pub fn paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// (fee_receiver, deploy_fee) — the treasury and flat deployment fee.
    pub fn fee_config(env: Env) -> (Address, i128) {
        storage::get_fee_config(&env)
    }

    /// Current collection WASM hashes plus the version counter, or `None` if
    /// `set_wasm_hashes` was never called.
    pub fn wasm_hashes(env: Env) -> Option<WasmHashes> {
        Some(WasmHashes {
            normal_721: storage::get_wasm_normal_721(&env)?,
            normal_1155: storage::get_wasm_normal_1155(&env)?,
            lazy_721: storage::get_wasm_lazy_721(&env)?,
            lazy_1155: storage::get_wasm_lazy_1155(&env)?,
            version: storage::wasm_version(&env),
        })
    }

    pub fn wasm_version(env: Env) -> u32 {
        storage::wasm_version(&env)
    }
}
