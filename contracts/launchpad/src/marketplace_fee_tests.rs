/// # Per-collection fee overrides, configured through the launchpad (Issue #849)
///
/// The override itself lives on the marketplace (`set_collection_fee_bps`,
/// scoped to the marketplace's `ProtocolConfig` role). The launchpad's job is to
/// be a convenience entry point for the admin of the collections it deployed, so
/// these tests assert the forwarding contract: the request reaches the
/// marketplace, the launchpad records its own audit event, and the guard rails
/// (no marketplace configured, collection we did not deploy, out-of-range bps)
/// hold.
extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, String,
};

use crate::{Error, Launchpad, LaunchpadClient};

// ── Mock marketplace ────────────────────────────────────────────────────────

mod mock_marketplace {
    use super::*;

    #[contracttype]
    pub enum Key {
        Fee(Address),
        Calls,
    }

    /// Stands in for the marketplace's `set_collection_fee_bps`, recording the
    /// last rate it was asked to set per collection plus the call count.
    #[contract]
    pub struct MockMarketplace;

    #[contractimpl]
    impl MockMarketplace {
        pub fn set_collection_fee_bps(env: Env, admin: Address, collection: Address, bps: u32) {
            // Mirrors the marketplace's role check: the caller's admin must have
            // authorized this call.
            admin.require_auth();
            env.storage().instance().set(&Key::Fee(collection), &bps);
            let calls: u32 = env.storage().instance().get(&Key::Calls).unwrap_or(0);
            env.storage().instance().set(&Key::Calls, &(calls + 1));
        }

        pub fn fee_for(env: Env, collection: Address) -> Option<u32> {
            env.storage().instance().get(&Key::Fee(collection))
        }

        pub fn calls(env: Env) -> u32 {
            env.storage().instance().get(&Key::Calls).unwrap_or(0)
        }
    }
}

use mock_marketplace::{MockMarketplace, MockMarketplaceClient};

// ── Fixture ─────────────────────────────────────────────────────────────────

fn wasm_bytes(name: &str) -> std::vec::Vec<u8> {
    let exe = std::env::current_exe().unwrap();
    let target_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .unwrap()
        .to_path_buf();
    let path = target_dir
        .join("wasm32v1-none")
        .join("release")
        .join(std::format!("{name}.wasm"));
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "missing wasm at {}. build it first with: cargo build --target wasm32v1-none --release -p collection-nft-erc1155 -p lazy-mint-erc721 -p collection-nft-erc721 -p lazy-mint-erc1155",
            path.display()
        )
    })
}

/// (launchpad client, admin, deployable creator + one deployed collection)
fn setup(env: &Env) -> (LaunchpadClient<'_>, Address, Address, Address) {
    env.mock_all_auths();

    let launchpad_id = env.register(Launchpad, ());
    let client = LaunchpadClient::new(env, &launchpad_id);

    let admin = Address::generate(env);
    let fee_receiver = Address::generate(env);
    let creator = Address::generate(env);
    client.initialize(&admin, &fee_receiver, &0i128);

    let wasm_721 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("collection_nft_erc721").as_slice());
    let wasm_1155 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("collection_nft_erc1155").as_slice());
    let lazy_721 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("lazy_mint_erc721").as_slice());
    let lazy_1155 = env
        .deployer()
        .upload_contract_wasm(wasm_bytes("lazy_mint_erc1155").as_slice());
    client.set_wasm_hashes(&wasm_721, &wasm_1155, &lazy_721, &lazy_1155);

    // One collection this launchpad deployed, i.e. one it may configure fees for.
    let collection = client.deploy_normal_721(
        &creator,
        &Address::generate(env),
        &String::from_str(env, "Fee Target"),
        &String::from_str(env, "FEE"),
        &1_000u64,
        &500u32,
        &Address::generate(env),
        &0u32,
        &BytesN::from_array(env, &[42u8; 32]),
    );

    (client, admin, creator, collection)
}

#[allow(irrefutable_let_patterns)] // ContractEventBody has a single variant in this SDK version
fn has_event_with_topic(env: &Env, symbol: &str) -> bool {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    env.events().all().events().iter().any(|event| {
        if let ContractEventBody::V0(body) = &event.body {
            body.topics.iter().any(|topic| match topic {
                ScVal::Symbol(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == symbol,
                _ => false,
            })
        } else {
            false
        }
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn set_collection_protocol_fee_forwards_to_the_marketplace() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _creator, collection) = setup(&env);

    let marketplace_id = env.register(MockMarketplace, ());
    let marketplace = MockMarketplaceClient::new(&env, &marketplace_id);
    assert_eq!(client.marketplace_address(), None);
    client.set_marketplace_address(&marketplace_id);
    assert_eq!(client.marketplace_address(), Some(marketplace_id.clone()));

    client.set_collection_protocol_fee(&collection, &700u32);
    assert!(
        has_event_with_topic(&env, "fee_cfg"),
        "the launchpad must record the request it forwarded"
    );

    // The marketplace saw exactly one call, for our collection, at our rate.
    assert_eq!(marketplace.calls(), 1u32);
    assert_eq!(marketplace.fee_for(&collection), Some(700u32));
}

#[test]
fn set_collection_protocol_fee_requires_a_configured_marketplace() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _creator, collection) = setup(&env);

    let result = client.try_set_collection_protocol_fee(&collection, &700u32);
    assert_eq!(result, Err(Ok(Error::MarketplaceNotConfigured)));
}

#[test]
fn set_collection_protocol_fee_rejects_a_collection_we_did_not_deploy() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _creator, _collection) = setup(&env);

    let marketplace_id = env.register(MockMarketplace, ());
    let marketplace = MockMarketplaceClient::new(&env, &marketplace_id);
    client.set_marketplace_address(&marketplace_id);

    let foreign = Address::generate(&env);
    let result = client.try_set_collection_protocol_fee(&foreign, &700u32);
    assert_eq!(result, Err(Ok(Error::CollectionNotOurs)));
    assert_eq!(marketplace.calls(), 0u32, "nothing should be forwarded");

    // A collection deployed by a *different* launchpad is equally foreign.
    let other_id = env.register(Launchpad, ());
    let other = LaunchpadClient::new(&env, &other_id);
    let other_admin = Address::generate(&env);
    other.initialize(&other_admin, &Address::generate(&env), &0i128);
    other.set_wasm_hashes(
        &env.deployer()
            .upload_contract_wasm(wasm_bytes("collection_nft_erc721").as_slice()),
        &env.deployer()
            .upload_contract_wasm(wasm_bytes("collection_nft_erc1155").as_slice()),
        &env.deployer()
            .upload_contract_wasm(wasm_bytes("lazy_mint_erc721").as_slice()),
        &env.deployer()
            .upload_contract_wasm(wasm_bytes("lazy_mint_erc1155").as_slice()),
    );
    let theirs = other.deploy_normal_721(
        &Address::generate(&env),
        &Address::generate(&env),
        &String::from_str(&env, "Theirs"),
        &String::from_str(&env, "THR"),
        &10u64,
        &0u32,
        &Address::generate(&env),
        &0u32,
        &BytesN::from_array(&env, &[7u8; 32]),
    );
    let result = client.try_set_collection_protocol_fee(&theirs, &700u32);
    assert_eq!(result, Err(Ok(Error::CollectionNotOurs)));
    assert_eq!(marketplace.calls(), 0u32);
}

#[test]
fn set_collection_protocol_fee_rejects_out_of_range_bps() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _creator, collection) = setup(&env);

    let marketplace_id = env.register(MockMarketplace, ());
    let marketplace = MockMarketplaceClient::new(&env, &marketplace_id);
    client.set_marketplace_address(&marketplace_id);

    // 10 000 bps (100 %) is the marketplace's own cap and is accepted.
    client.set_collection_protocol_fee(&collection, &10_000u32);
    assert_eq!(marketplace.fee_for(&collection), Some(10_000u32));

    let result = client.try_set_collection_protocol_fee(&collection, &10_001u32);
    assert_eq!(result, Err(Ok(Error::InvalidFeeBps)));
    assert_eq!(
        marketplace.calls(),
        1u32,
        "the bad rate must not be forwarded"
    );

    // A zero override is a deliberate choice, not a missing value.
    client.set_collection_protocol_fee(&collection, &0u32);
    assert_eq!(marketplace.fee_for(&collection), Some(0u32));
    assert_eq!(marketplace.calls(), 2u32);
}

#[test]
fn set_collection_protocol_fee_surfaces_marketplace_failures() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1);
    let (client, _admin, _creator, collection) = setup(&env);

    // A marketplace address that is not a contract: the launchpad must not
    // report success it did not achieve.
    let bogus = Address::generate(&env);
    client.set_marketplace_address(&bogus);

    let result = client.try_set_collection_protocol_fee(&collection, &700u32);
    assert!(result.is_err(), "a failed forward must not be swallowed");
    assert!(
        !has_event_with_topic(&env, "fee_cfg"),
        "no audit event when the override was not actually set"
    );
}
