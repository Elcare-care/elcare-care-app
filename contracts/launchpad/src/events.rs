use soroban_sdk::{symbol_short, Address, BytesN, Env};

#[allow(deprecated)]
pub fn publish_deploy(env: &Env, tag: soroban_sdk::Symbol, creator: &Address, address: &Address) {
    env.events().publish(
        (symbol_short!("deploy"), tag),
        (creator.clone(), address.clone()),
    );
}

/// Emitted when a deployment fee is successfully transferred to the treasury.
///
/// Topics: ("fee_coll", creator, treasury)
/// Data:   (amount: i128, currency: Address)
#[allow(deprecated)]
pub fn publish_deployment_fee_collected(
    env: &Env,
    creator: &Address,
    treasury: &Address,
    amount: i128,
    currency: &Address,
) {
    env.events().publish(
        (symbol_short!("fee_coll"), creator.clone(), treasury.clone()),
        (amount, currency.clone()),
    );
}

/// Emitted when the admin updates the fee config.
///
/// Topics: ("cfg_fee",)
/// Data:   (receiver: Address, deploy_fee: i128)
#[allow(deprecated)]
pub fn publish_fee_config_updated(env: &Env, receiver: &Address, deploy_fee: i128) {
    env.events()
        .publish((symbol_short!("cfg_fee"),), (receiver.clone(), deploy_fee));
}

/// Emitted when the current admin proposes a successor.
///
/// Topics: ("admin", "proposed")
/// Data:   (current_admin: Address, proposed_admin: Address)
#[allow(deprecated)]
pub fn publish_admin_transfer_proposed(
    env: &Env,
    current_admin: &Address,
    proposed_admin: &Address,
) {
    env.events().publish(
        (symbol_short!("admin"), symbol_short!("proposed")),
        (current_admin.clone(), proposed_admin.clone()),
    );
}

/// Emitted when the proposed admin accepts the role.
///
/// Topics: ("admin", "accepted")
/// Data:   (old_admin: Address, new_admin: Address)
#[allow(deprecated)]
pub fn publish_admin_transfer_accepted(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (symbol_short!("admin"), symbol_short!("accepted")),
        (old_admin.clone(), new_admin.clone()),
    );
}

/// Emitted when the current admin cancels a pending transfer.
///
/// Topics: ("admin", "cancelled")
/// Data:   (admin: Address, cancelled_pending: Address)
#[allow(deprecated)]
pub fn publish_admin_transfer_cancelled(env: &Env, admin: &Address, cancelled_pending: &Address) {
    env.events().publish(
        (symbol_short!("admin"), symbol_short!("cancelled")),
        (admin.clone(), cancelled_pending.clone()),
    );
}

/// Emitted when the admin pauses or unpauses deployments.
///
/// Topics: ("paused",)
/// Data:   (admin: Address, paused: bool)
#[allow(deprecated)]
pub fn publish_paused(env: &Env, admin: &Address, paused: bool) {
    env.events()
        .publish((symbol_short!("paused"),), (admin.clone(), paused));
}

/// Emitted when the admin records a new set of collection WASM hashes.
///
/// Topics: ("wasm_set", version: u32)
/// Data:   (normal_721, normal_1155, lazy_721, lazy_1155)
#[allow(deprecated)]
pub fn publish_wasm_hashes_set(
    env: &Env,
    version: u32,
    normal_721: &BytesN<32>,
    normal_1155: &BytesN<32>,
    lazy_721: &BytesN<32>,
    lazy_1155: &BytesN<32>,
) {
    env.events().publish(
        (symbol_short!("wasm_set"), version),
        (
            normal_721.clone(),
            normal_1155.clone(),
            lazy_721.clone(),
            lazy_1155.clone(),
        ),
    );
}
