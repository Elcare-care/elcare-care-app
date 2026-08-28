use soroban_sdk::{Address, BytesN, Env, String, Vec};

use crate::types::{CollectionKind, CollectionRecord, DataKey, Error};

const TTL_THRESHOLD: u32 = 50_000;
const TTL_BUMP: u32 = 100_000;

pub fn extend_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

pub fn set_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Initialized, &true);
    extend_instance_ttl(env);
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

pub fn set_pending_admin(env: &Env, pending: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::PendingAdmin, pending);
}

pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn clear_pending_admin(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingAdmin);
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

/// Fee config: treasury address + flat deployment fee (token smallest unit).
pub fn set_fee_config(env: &Env, receiver: &Address, deploy_fee: i128) {
    env.storage()
        .instance()
        .set(&DataKey::FeeReceiver, receiver);
    env.storage()
        .instance()
        .set(&DataKey::DeployFee, &deploy_fee);
}

pub fn get_fee_config(env: &Env) -> (Address, i128) {
    (
        env.storage().instance().get(&DataKey::FeeReceiver).unwrap(),
        env.storage()
            .instance()
            .get(&DataKey::DeployFee)
            .unwrap_or(0),
    )
}

/// Stores the four hashes and bumps the version counter; returns the new version.
pub fn set_wasm_hashes(
    env: &Env,
    normal_721: &BytesN<32>,
    normal_1155: &BytesN<32>,
    lazy_721: &BytesN<32>,
    lazy_1155: &BytesN<32>,
) -> u32 {
    set_wasm_hash_for_kind(env, &CollectionKind::Normal721, normal_721);
    set_wasm_hash_for_kind(env, &CollectionKind::Normal1155, normal_1155);
    set_wasm_hash_for_kind(env, &CollectionKind::LazyMint721, lazy_721);
    set_wasm_hash_for_kind(env, &CollectionKind::LazyMint1155, lazy_1155);
    let version = wasm_version(env) + 1;
    env.storage()
        .instance()
        .set(&DataKey::WasmVersion, &version);
    version
}

pub fn set_wasm_hash_for_kind(env: &Env, kind: &CollectionKind, wasm_hash: &BytesN<32>) {
    env.storage()
        .instance()
        .set(&DataKey::CollectionWasmHash(kind.clone()), wasm_hash);
    match kind {
        CollectionKind::Normal721 => {
            env.storage().instance().set(&DataKey::WasmNormal721, wasm_hash);
        }
        CollectionKind::Normal1155 => {
            env.storage().instance().set(&DataKey::WasmNormal1155, wasm_hash);
        }
        CollectionKind::LazyMint721 => {
            env.storage().instance().set(&DataKey::WasmLazy721, wasm_hash);
        }
        CollectionKind::LazyMint1155 => {
            env.storage().instance().set(&DataKey::WasmLazy1155, wasm_hash);
        }
    }
}

pub fn get_wasm_for_kind(env: &Env, kind: &CollectionKind) -> Option<BytesN<32>> {
    env.storage()
        .instance()
        .get(&DataKey::CollectionWasmHash(kind.clone()))
        .or_else(|| match kind {
            CollectionKind::Normal721 => get_wasm_normal_721(env),
            CollectionKind::Normal1155 => get_wasm_normal_1155(env),
            CollectionKind::LazyMint721 => get_wasm_lazy_721(env),
            CollectionKind::LazyMint1155 => get_wasm_lazy_1155(env),
        })
}

/// True if `secure_salt` has already been consumed by a successful deployment (#277).
pub fn is_salt_used(env: &Env, secure_salt: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::SaltUsed(secure_salt.clone()))
        .unwrap_or(false)
}

/// Marks `secure_salt` as consumed so it cannot be reused for another deployment (#277).
pub fn mark_salt_used(env: &Env, secure_salt: &BytesN<32>) {
    env.storage()
        .persistent()
        .set(&DataKey::SaltUsed(secure_salt.clone()), &true);
    env.storage().persistent().extend_ttl(
        &DataKey::SaltUsed(secure_salt.clone()),
        TTL_THRESHOLD,
        TTL_BUMP,
    );
}

/// Record the deployed address alongside the consumed salt for idempotent retries (#477).
pub fn record_salt_deployment(env: &Env, secure_salt: &BytesN<32>, address: &Address) {
    mark_salt_used(env, secure_salt);
    env.storage()
        .persistent()
        .set(&DataKey::SaltAddress(secure_salt.clone()), address);
    env.storage().persistent().extend_ttl(
        &DataKey::SaltAddress(secure_salt.clone()),
        TTL_THRESHOLD,
        TTL_BUMP,
    );
}

/// Returns the collection address that was deployed for `secure_salt`, or None
/// if this salt has never been used (or was written before #477 idempotency) (#477).
pub fn get_salt_deployment(env: &Env, secure_salt: &BytesN<32>) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::SaltAddress(secure_salt.clone()))
}

// ── Collection-level pause controls (Issue #478) ──────────────────────────────

pub fn set_collection_paused(env: &Env, collection: &Address, paused: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::CollectionPaused(collection.clone()), &paused);
    env.storage().persistent().extend_ttl(
        &DataKey::CollectionPaused(collection.clone()),
        TTL_THRESHOLD,
        TTL_BUMP,
    );
}

pub fn is_collection_paused(env: &Env, collection: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::CollectionPaused(collection.clone()))
        .unwrap_or(false)
}

pub fn wasm_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::WasmVersion)
        .unwrap_or(0)
}

pub fn get_wasm_normal_721(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::WasmNormal721)
}

pub fn get_wasm_normal_1155(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::WasmNormal1155)
}

pub fn get_wasm_lazy_721(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::WasmLazy721)
}

pub fn get_wasm_lazy_1155(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::WasmLazy1155)
}

pub fn collections_by_creator(env: &Env, creator: &Address) -> Vec<CollectionRecord> {
    let count = creator_collection_count(env, creator);
    let mut result = Vec::new(env);
    let mut i = 0u64;

    while i < count {
        if let Some(collection) = creator_collection_by_index(env, creator, i) {
            result.push_back(collection);
        }
        i += 1;
    }

    result
}

pub fn all_collections(env: &Env) -> Vec<CollectionRecord> {
    let count = collection_count(env);
    let mut result = Vec::new(env);
    let mut i = 0u64;

    while i < count {
        if let Some(collection) = collection_by_index(env, i) {
            result.push_back(collection);
        }
        i += 1;
    }

    result
}

/// Paginated read of global collections (#37).
pub fn get_collections_paginated(env: &Env, start: u64, limit: u32) -> Vec<CollectionRecord> {
    let total = collection_count(env);
    let mut result = Vec::new(env);
    let end = (start + limit as u64).min(total);
    let mut i = start;
    while i < end {
        if let Some(rec) = collection_by_index(env, i) {
            result.push_back(rec);
        }
        i += 1;
    }
    result
}

/// Look up a single collection by its deployed address (#37).
pub fn get_collection_by_address(env: &Env, address: &Address) -> Option<CollectionRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::CollectionByAddress(address.clone()))
}

pub fn collection_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::CollectionCount)
        .unwrap_or(0)
}

pub fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin = get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

// ── Emergency pause role (Issue #267) ──────────────────────────────────────
//
// Kept independent of `Admin` so an incident responder can still halt
// deployments even if the routine admin authority is unavailable.

pub fn set_emergency_pauser(env: &Env, pauser: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::EmergencyPauser, pauser);
}

pub fn get_emergency_pauser(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::EmergencyPauser)
}

/// Authorize a `pause`/`unpause` call: the explicit `EmergencyPauser` if one
/// has been configured, otherwise the `Admin` fallback. Returns the
/// authorizing address for event emission.
pub fn require_pause_authority(env: &Env) -> Result<Address, Error> {
    match get_emergency_pauser(env) {
        Some(pauser) => {
            pauser.require_auth();
            Ok(pauser)
        }
        None => require_admin(env),
    }
}

/// Record a newly deployed collection with full metadata (#37 + #38 + #482).
#[allow(clippy::too_many_arguments)]
pub fn record_collection(
    env: &Env,
    creator: &Address,
    address: &Address,
    kind: CollectionKind,
    name: &String,
    symbol: &String,
    ledger: u32,
    platform_fee_bps: u32,
    royalty_bps: u32,
    royalty_receiver: &Address,
) {
    let rec = CollectionRecord {
        address: address.clone(),
        kind,
        creator: creator.clone(),
        name: name.clone(),
        symbol: symbol.clone(),
        ledger,
        platform_fee_bps,
        royalty_bps,
        royalty_receiver: royalty_receiver.clone(),
    };

    // Index by address for O(1) lookup (#37)
    env.storage()
        .persistent()
        .set(&DataKey::CollectionByAddress(address.clone()), &rec);
    env.storage().persistent().extend_ttl(
        &DataKey::CollectionByAddress(address.clone()),
        TTL_THRESHOLD,
        TTL_BUMP,
    );

    // Global indexed storage — each record in its own key
    let global_idx = collection_count(env);
    env.storage()
        .persistent()
        .set(&DataKey::CollectionByIndex(global_idx), &rec);
    env.storage().persistent().extend_ttl(
        &DataKey::CollectionByIndex(global_idx),
        TTL_THRESHOLD,
        TTL_BUMP,
    );

    // Per-creator indexed storage
    let creator_count: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::CreatorCollectionCount(creator.clone()))
        .unwrap_or(0);
    env.storage().persistent().set(
        &DataKey::CreatorCollectionByIndex(creator.clone(), creator_count),
        &rec,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::CreatorCollectionByIndex(creator.clone(), creator_count),
        TTL_THRESHOLD,
        TTL_BUMP,
    );
    env.storage().persistent().set(
        &DataKey::CreatorCollectionCount(creator.clone()),
        &(creator_count + 1),
    );

    // Increment global counter
    let next = global_idx + 1;
    env.storage()
        .persistent()
        .set(&DataKey::CollectionCount, &next);
}

pub fn collection_by_index(env: &Env, index: u64) -> Option<CollectionRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::CollectionByIndex(index))
}

/// Update the royalty default for an already-deployed collection in the
/// by-address index (#482).  Returns `CollectionNotFound` when the address is
/// not in the registry.
pub fn update_collection_royalty_defaults(
    env: &Env,
    address: &Address,
    royalty_bps: u32,
    royalty_receiver: &Address,
) -> Result<(), crate::types::Error> {
    let key = DataKey::CollectionByAddress(address.clone());
    let mut rec: CollectionRecord = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(crate::types::Error::CollectionNotFound)?;
    rec.royalty_bps = royalty_bps;
    rec.royalty_receiver = royalty_receiver.clone();
    env.storage().persistent().set(&key, &rec);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    Ok(())
}pub fn creator_collection_count(env: &Env, creator: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorCollectionCount(creator.clone()))
        .unwrap_or(0)
}

pub fn creator_collection_by_index(
    env: &Env,
    creator: &Address,
    index: u64,
) -> Option<CollectionRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorCollectionByIndex(creator.clone(), index))
}

// ── Versioned migration registry ─────────────────────────────────────────────
//
// Mirrors the marketplace contract's migration plumbing so all contracts in
// the workspace share the same upgrade operator playbook.
//
// Storage keys:
//   MigrationDone(version_str)   — boolean, set after a successful migration
//   MigrationCursor(version_str) — MigrationProgress struct for resumable steps
//   ContractVersion              — the version string last written by migrate()

/// Resumable progress marker for a versioned migration.
#[soroban_sdk::contracttype]
#[derive(Clone)]
pub struct MigrationProgress {
    pub phase:  u32,
    pub cursor: u64,
}

pub fn set_migration_done(env: &Env, version: &soroban_sdk::String) {
    let key = DataKey::MigrationDone(version.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
}

pub fn is_migration_done(env: &Env, version: &soroban_sdk::String) -> bool {
    let key = DataKey::MigrationDone(version.clone());
    let done = env
        .storage()
        .persistent()
        .get::<_, bool>(&key)
        .unwrap_or(false);
    if done {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    }
    done
}

pub fn get_migration_progress(env: &Env, version: &soroban_sdk::String) -> MigrationProgress {
    env.storage()
        .persistent()
        .get::<DataKey, MigrationProgress>(&DataKey::MigrationCursor(version.clone()))
        .unwrap_or(MigrationProgress { phase: 0, cursor: 0 })
}

pub fn set_migration_progress(
    env: &Env,
    version: &soroban_sdk::String,
    progress: &MigrationProgress,
) {
    let key = DataKey::MigrationCursor(version.clone());
    env.storage().persistent().set(&key, progress);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
}

pub fn clear_migration_progress(env: &Env, version: &soroban_sdk::String) {
    env.storage()
        .persistent()
        .remove(&DataKey::MigrationCursor(version.clone()));
}

pub fn set_contract_version(env: &Env, version: &soroban_sdk::String) {
    env.storage()
        .instance()
        .set(&DataKey::ContractVersion, version);
    extend_instance_ttl(env);
}

pub fn get_contract_version(env: &Env) -> Option<soroban_sdk::String> {
    env.storage().instance().get(&DataKey::ContractVersion)
}

/// Retrieve the platform fee config (receiver address + fee basis points).
/// Used internally by the deploy_* functions and the fee_config view.
pub fn get_platform_fee(env: &Env) -> (Address, u32) {
    (
        env.storage().instance().get(&DataKey::FeeReceiver).unwrap(),
        env.storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::DeployFee)
            .unwrap_or(0) as u32,
    )
}
