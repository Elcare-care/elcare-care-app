// test.rs — ELCARE-HUB Marketplace — complete test suite including NFT escrow
use super::*;
use crate::types::{ListingStatus, OfferStatus, Recipient};

// ── Mock NFT collection ──────────────────────────────────────
// Tracks real ownership so owner_of checks and transfer_from work correctly.
mod mock_nft {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[soroban_sdk::contracttype]
    enum NftKey { Owner(u64), RoyaltyBps, RoyaltyRecv }

    #[contract]
    pub struct MockNft;

    #[contractimpl]
    impl MockNft {
        pub fn owner_of(env: Env, token_id: u64) -> Address {
            env.storage().instance()
                .get::<NftKey, Address>(&NftKey::Owner(token_id))
                .expect("token has no owner")
        }
        /// Test helper — set initial owner (mint)
        pub fn set_owner(env: Env, token_id: u64, owner: Address) {
            env.storage().instance().set(&NftKey::Owner(token_id), &owner);
        }
        pub fn transfer_from(env: Env, _spender: Address, from: Address, to: Address, token_id: u64) {
            let cur: Address = env.storage().instance()
                .get::<NftKey, Address>(&NftKey::Owner(token_id))
                .expect("token has no owner");
            assert_eq!(cur, from, "transfer_from: wrong owner");
            env.storage().instance().set(&NftKey::Owner(token_id), &to);
        }
        pub fn royalty_info(env: Env) -> (Address, u32) {
            use soroban_sdk::testutils::Address as _;
            let bps: u32 = env.storage().instance()
                .get::<NftKey, u32>(&NftKey::RoyaltyBps).unwrap_or(0);
            let recv: Address = env.storage().instance()
                .get::<NftKey, Address>(&NftKey::RoyaltyRecv)
                .unwrap_or_else(|| Address::generate(&env));
            (recv, bps)
        }
        pub fn set_royalty(env: Env, recv: Address, bps: u32) {
            env.storage().instance().set(&NftKey::RoyaltyRecv, &recv);
            env.storage().instance().set(&NftKey::RoyaltyBps, &bps);
        }
    }
}
use mock_nft::MockNftClient;

use soroban_sdk::{
    bytes, symbol_short,
    testutils::Address as _,
    testutils::Events as _,
    testutils::Ledger,
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

/// Standard test setup. Token #1 on the mock NFT is pre-assigned to `artist`.
fn setup() -> (Env, MarketplaceContractClient<'static>, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let artist = Address::generate(&env);
    let buyer  = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &payment_token);
    sac.mint(&artist,      &100_000_000_000_i128);
    sac.mint(&buyer,       &100_000_000_000_i128);
    sac.mint(&contract_id, &100_000_000_000_i128);
    let collection_id = env.register(mock_nft::MockNft, ());
    // Give token #1 to artist
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &artist);
    (env, client, artist, buyer, payment_token, contract_id, collection_id)
}

fn valid_recipients(env: &Env, artist: &Address) -> soroban_sdk::Vec<Recipient> {
    vec![env, Recipient { address: artist.clone(), percentage: 10_000 }]
}

// Helper to create a listing for token_id=1 with the given setup
fn create_test_listing(
    env: &Env, client: &MarketplaceContractClient,
    artist: &Address, token_id: &Address,
) -> u64 {
    let collection_id = env.register(mock_nft::MockNft, ());
    MockNftClient::new(env, &collection_id).set_owner(&1u64, artist);
    client.create_listing(
        artist, &10_000_000_i128, &symbol_short!("XLM"),
        token_id, &collection_id, &1u64,
        &valid_recipients(env, artist), &None::<u64>,
    )
}

fn has_event_with_topic(events: &soroban_sdk::Vec<(soroban_sdk::Val, soroban_sdk::Val)>, topic: &str) -> bool {
    for (topics_val, _) in events.iter() {
        let s = soroban_sdk::String::from_str(
            &soroban_sdk::Env::default(), // note: only used for formatting
            topic,
        );
        let _ = s; // suppress warning
        let topics_str = format!("{:?}", topics_val);
        if topics_str.contains(topic) { return true; }
    }
    false
}

// ════════════════════════════════════════════════════════════
// SECTION 1: Treasury & Protocol Fee
// ════════════════════════════════════════════════════════════

#[test]
fn test_set_treasury_and_protocol_fee() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let treasury = Address::generate(&env);
    client.set_treasury(&artist, &treasury);
    assert_eq!(client.get_treasury(), Some(treasury.clone()));
    let price = 10_000_000_i128;
    let id = client.create_listing(
        &artist, &price, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.set_protocol_fee(&artist, &500u32);
    assert_eq!(client.get_protocol_fee(), 500u32);
    assert!(client.buy_artwork(&buyer, &id));
    let listing = client.get_listing(&id);
    assert_eq!(listing.status, ListingStatus::Sold);
    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&treasury), 500_000_i128);
    assert_eq!(token.balance(&artist), 100_000_000_000_i128 + 9_500_000_i128);
}

#[test]
fn test_buy_artwork_no_treasury_fee_set() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let price = 1_000_000_i128;
    let id = client.create_listing(
        &artist, &price, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.set_protocol_fee(&artist, &300u32);
    assert!(client.buy_artwork(&buyer, &id));
    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&artist), 100_000_000_000_i128 + price);
}

#[test]
#[should_panic]
fn test_set_protocol_fee_not_admin_panics() {
    let (_env, client, artist, buyer, _t, _c, _col) = setup();
    client.set_admin(&artist);
    client.set_protocol_fee(&buyer, &100u32);
}

#[test]
#[should_panic]
fn test_set_protocol_fee_too_high_panics() {
    let (_env, client, artist, _buyer, _t, _c, _col) = setup();
    client.set_admin(&artist);
    client.set_protocol_fee(&artist, &2000u32);
}

// ════════════════════════════════════════════════════════════
// SECTION 2: create_listing
// ════════════════════════════════════════════════════════════

#[test]
fn test_create_listing_success() {
    let (env, client, artist, _, token_id, _, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    assert_eq!(id, 1);
    let listing = client.get_listing(&1);
    assert_eq!(listing.status, ListingStatus::Active);
    // Escrow: contract should now own token #1
    let nft = MockNftClient::new(&env, &collection_id);
    // The mock tracks ownership — after create_listing the marketplace holds it
    // (we can check via get_escrow)
    let escrow = client.get_escrow(&collection_id, &1u64);
    assert!(escrow.is_some());
    let rec = escrow.unwrap();
    assert!(rec.is_listing);
    assert_eq!(rec.id, 1u64);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_create_listing_zero_price() {
    let (env, client, artist, _, token_id, _, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.create_listing(
        &artist, &0_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #36)")]
fn test_create_listing_seller_not_owner_fails() {
    let (env, client, artist, buyer, token_id, _, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    // buyer does NOT own token #1 — should revert with NotTokenOwner
    StellarAssetClient::new(&env, &token_id).mint(&buyer, &1_000_000_i128);
    client.create_listing(
        &buyer, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &buyer), &None::<u64>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #37)")]
fn test_create_listing_double_listing_fails() {
    let (env, client, artist, _, token_id, _, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    // First listing succeeds
    client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    // Token is now held by marketplace — second attempt must fail
    client.create_listing(
        &artist, &2_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
}

// ════════════════════════════════════════════════════════════
// SECTION 3: buy_artwork + escrow release to buyer
// ════════════════════════════════════════════════════════════

#[test]
fn test_buy_artwork_success_nft_goes_to_buyer() {
    let (env, client, artist, buyer, token_id, contract_id, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let price = 10_000_000_i128;
    let id = client.create_listing(
        &artist, &price, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    // NFT is in escrow now
    assert!(client.get_escrow(&collection_id, &1u64).is_some());
    assert!(client.buy_artwork(&buyer, &id));
    let listing = client.get_listing(&id);
    assert_eq!(listing.status, ListingStatus::Sold);
    assert_eq!(listing.owner, Some(buyer.clone()));
    // Escrow cleared
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    // NFT now owned by buyer
    let nft = MockNftClient::new(&env, &collection_id);
    assert_eq!(nft.owner_of(&1u64), buyer);
}

#[test]
fn test_buy_artwork_complex_split() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let colab1 = Address::generate(&env);
    let colab2 = Address::generate(&env);
    let price = 10_000_000_i128;
    let recipients = vec![
        &env,
        Recipient { address: artist.clone(),  percentage: 3_300 },
        Recipient { address: colab1.clone(),  percentage: 3_300 },
        Recipient { address: colab2.clone(),  percentage: 3_400 },
    ];
    let id = client.create_listing(
        &artist, &price, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64, &recipients, &None::<u64>,
    );
    assert!(client.buy_artwork(&buyer, &id));
    let token = TokenClient::new(&env, &token_id);
    let ag = token.balance(&artist) - 100_000_000_000_i128;
    let cg1 = token.balance(&colab1);
    let cg2 = token.balance(&colab2);
    assert_eq!(ag + cg1 + cg2, price);
}

#[test]
#[should_panic(expected = "Error(Contract, #38)")]
fn test_buy_own_listing_fails() {
    let (env, client, artist, _buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.buy_artwork(&artist, &id);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_buy_cancelled_listing_fails() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.cancel_listing(&artist, &id);
    client.buy_artwork(&buyer, &id);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_buy_already_sold_listing_fails() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.buy_artwork(&buyer, &id);
    client.buy_artwork(&buyer, &id);
}

// ════════════════════════════════════════════════════════════
// SECTION 4: cancel_listing — NFT returns to seller
// ════════════════════════════════════════════════════════════

#[test]
fn test_cancel_listing_returns_nft_to_seller() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    assert!(client.get_escrow(&collection_id, &1u64).is_some());
    assert!(client.cancel_listing(&artist, &id));
    assert_eq!(client.get_listing(&id).status, ListingStatus::Cancelled);
    // Escrow cleared
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    // NFT back to artist
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), artist);
}

#[test]
fn test_cancel_listing_rejects_pending_offers() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid = client.make_offer(&buyer, &id, &3_000_000_i128, &token_id, &None);
    client.cancel_listing(&artist, &id);
    assert_eq!(client.get_offer(&oid).status, OfferStatus::Rejected);
    // Buyer refunded
    assert_eq!(TokenClient::new(&env, &token_id).balance(&buyer), 100_000_000_000_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_cancel_listing_wrong_artist() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.cancel_listing(&buyer, &id);
}

// ════════════════════════════════════════════════════════════
// SECTION 5: expire_listing — NFT returns to seller
// ════════════════════════════════════════════════════════════

#[test]
fn test_expire_listing_returns_nft_to_seller() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let now = env.ledger().timestamp();
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &Some(now + 1000),
    );
    env.ledger().set_timestamp(now + 2000);
    client.expire_listing(&id);
    assert_eq!(client.get_listing(&id).status, ListingStatus::Cancelled);
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_expire_listing_before_expiry_fails() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let now = env.ledger().timestamp();
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &Some(now + 9999),
    );
    client.expire_listing(&id);
}

// ════════════════════════════════════════════════════════════
// SECTION 6: Auction escrow — create / cancel / finalize
// ════════════════════════════════════════════════════════════

#[test]
fn test_create_auction_escrows_nft() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    let escrow = client.get_escrow(&collection_id, &1u64);
    assert!(escrow.is_some());
    let rec = escrow.unwrap();
    assert!(!rec.is_listing);
    assert_eq!(rec.id, aid);
    // Marketplace now owns the token
    assert_eq!(
        MockNftClient::new(&env, &collection_id).owner_of(&1u64),
        env.current_contract_address(),
    );
}

#[test]
fn test_cancel_auction_returns_nft_to_creator() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    assert!(client.get_escrow(&collection_id, &1u64).is_some());
    client.cancel_auction(&artist, &aid);
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), artist);
}

#[test]
fn test_finalize_auction_with_winner_nft_goes_to_winner() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.place_bid(&buyer, &aid, &1_500_000_i128);
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.finalize_auction(&buyer, &aid);
    assert_eq!(client.get_auction(&aid).status, crate::types::AuctionStatus::Finalized);
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), buyer);
}

#[test]
fn test_finalize_auction_no_bids_returns_nft_to_creator() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.finalize_auction(&artist, &aid);
    assert_eq!(client.get_auction(&aid).status, crate::types::AuctionStatus::Cancelled);
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #36)")]
fn test_create_auction_seller_not_owner_fails() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    StellarAssetClient::new(&env, &token_id).mint(&buyer, &1_000_000_i128);
    client.create_auction(
        &buyer, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &buyer),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #37)")]
fn test_create_listing_then_auction_same_token_fails() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    // Token is in escrow — auction attempt must fail
    client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
}

// ════════════════════════════════════════════════════════════
// SECTION 7: accept_offer — NFT goes to accepted offerer
// ════════════════════════════════════════════════════════════

#[test]
fn test_accept_offer_nft_goes_to_offerer() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid = client.make_offer(&buyer, &lid, &8_000_000_i128, &token_id, &None);
    client.accept_offer(&artist, &oid);
    assert_eq!(client.get_offer(&oid).status, OfferStatus::Accepted);
    assert_eq!(client.get_listing(&lid).status, ListingStatus::Sold);
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), buyer);
}

#[test]
fn test_accept_offer_rejects_competing_offers_and_refunds() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    let buyer2 = Address::generate(&env);
    let buyer3 = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&buyer2, &100_000_000_000_i128);
    StellarAssetClient::new(&env, &token_id).mint(&buyer3, &100_000_000_000_i128);
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid1 = client.make_offer(&buyer,  &lid, &5_000_000_i128, &token_id, &None);
    let oid2 = client.make_offer(&buyer2, &lid, &7_000_000_i128, &token_id, &None);
    let oid3 = client.make_offer(&buyer3, &lid, &3_000_000_i128, &token_id, &None);
    client.accept_offer(&artist, &oid2);
    assert_eq!(client.get_offer(&oid2).status, OfferStatus::Accepted);
    assert_eq!(client.get_offer(&oid1).status, OfferStatus::Rejected);
    assert_eq!(client.get_offer(&oid3).status, OfferStatus::Rejected);
    let tok = TokenClient::new(&env, &token_id);
    assert_eq!(tok.balance(&buyer),  100_000_000_000_i128);
    assert_eq!(tok.balance(&buyer3), 100_000_000_000_i128);
}

// ════════════════════════════════════════════════════════════
// SECTION 8: cancel_artist_listings — releases both NFTs and offer escrows
// ════════════════════════════════════════════════════════════

#[test]
fn test_cancel_artist_listings_releases_nft_and_refunds_offers() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid = client.make_offer(&buyer, &lid, &3_000_000_i128, &token_id, &None);
    // Revoke artist then cancel their listings
    client.revoke_artist(&artist);
    client.cancel_artist_listings(&artist, &artist);
    assert_eq!(client.get_listing(&lid).status, ListingStatus::Cancelled);
    assert_eq!(client.get_offer(&oid).status, OfferStatus::Rejected);
    // NFT returned to artist
    assert!(client.get_escrow(&collection_id, &1u64).is_none());
    assert_eq!(MockNftClient::new(&env, &collection_id).owner_of(&1u64), artist);
    // Buyer refunded
    assert_eq!(TokenClient::new(&env, &token_id).balance(&buyer), 100_000_000_000_i128);
}

// ════════════════════════════════════════════════════════════
// SECTION 9: Reentrancy guard preserved
// ════════════════════════════════════════════════════════════

mod mock_reentrant_token {
    use soroban_sdk::{contract, contractimpl, Address, Env, IntoVal};
    #[contract]
    pub struct MockReentrantToken;
    #[contractimpl]
    impl MockReentrantToken {
        pub fn transfer(env: Env, _from: Address, _to: Address, _amount: i128) {
            let marketplace: Address = env.storage().instance()
                .get(&soroban_sdk::symbol_short!("mkt")).unwrap();
            let listing_id: u64 = env.storage().instance()
                .get(&soroban_sdk::symbol_short!("lid")).unwrap();
            let attacker: Address = env.storage().instance()
                .get(&soroban_sdk::symbol_short!("atk")).unwrap();
            env.invoke_contract::<bool>(
                &marketplace,
                &soroban_sdk::Symbol::new(&env, "buy_artwork"),
                soroban_sdk::vec![&env, attacker.into_val(&env), listing_id.into_val(&env)],
            );
        }
        pub fn set_attack_params(env: Env, marketplace: Address, listing_id: u64, attacker: Address) {
            env.storage().instance().set(&soroban_sdk::symbol_short!("mkt"), &marketplace);
            env.storage().instance().set(&soroban_sdk::symbol_short!("lid"), &listing_id);
            env.storage().instance().set(&soroban_sdk::symbol_short!("atk"), &attacker);
        }
        pub fn balance(_env: Env, _id: Address) -> i128 { 100_000_000_000_i128 }
        pub fn approve(_env: Env, _from: Address, _spender: Address, _amount: i128, _exp: u32) {}
        pub fn transfer_from(_env: Env, _sp: Address, _from: Address, _to: Address, _amount: i128) {}
    }
}
use mock_reentrant_token::MockReentrantTokenClient;

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_buy_artwork_reentrant_token_attack_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let artist = Address::generate(&env);
    let attacker = Address::generate(&env);
    let reentrant_token_id = env.register(mock_reentrant_token::MockReentrantToken, ());
    let rt_client = MockReentrantTokenClient::new(&env, &reentrant_token_id);
    let collection_id = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection_id).set_owner(&1u64, &artist);
    client.set_admin(&artist);
    client.add_token_to_whitelist(&reentrant_token_id);
    let lid = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &reentrant_token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    rt_client.set_attack_params(&contract_id, &lid, &attacker);
    client.buy_artwork(&attacker, &lid);
}

// ════════════════════════════════════════════════════════════
// SECTION 10: update_listing — no NFT movement, escrow unchanged
// ════════════════════════════════════════════════════════════

#[test]
fn test_update_listing_does_not_move_nft() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    // NFT in escrow
    let escrow_before = client.get_escrow(&collection_id, &1u64).unwrap();
    client.update_listing(&artist, &id, &9_000_000_i128, &token_id, &valid_recipients(&env, &artist));
    assert_eq!(client.get_listing(&id).price, 9_000_000_i128);
    // Escrow unchanged
    let escrow_after = client.get_escrow(&collection_id, &1u64).unwrap();
    assert_eq!(escrow_before, escrow_after);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_update_listing_fails_with_pending_offers() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &5_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.make_offer(&buyer, &id, &3_000_000_i128, &token_id, &None);
    client.update_listing(&artist, &id, &9_000_000_i128, &token_id, &valid_recipients(&env, &artist));
}

// ════════════════════════════════════════════════════════════
// SECTION 11: Offers — make / withdraw / reject
// ════════════════════════════════════════════════════════════

#[test]
fn test_make_offer_success() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token_id, &None);
    assert_eq!(oid, 1);
    let offer = client.get_offer(&oid);
    assert_eq!(offer.status, OfferStatus::Pending);
    assert_eq!(offer.offerer, buyer);
}

#[test]
fn test_withdraw_offer_refunds_buyer() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token_id, &None);
    client.withdraw_offer(&buyer, &oid);
    assert_eq!(client.get_offer(&oid).status, OfferStatus::Withdrawn);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&buyer), 100_000_000_000_i128);
}

#[test]
fn test_reject_offer_refunds_buyer() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token_id, &None);
    client.reject_offer(&artist, &oid);
    assert_eq!(client.get_offer(&oid).status, OfferStatus::Rejected);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&buyer), 100_000_000_000_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn test_make_offer_on_own_listing_fails() {
    let (env, client, artist, _buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.make_offer(&artist, &lid, &5_000_000_i128, &token_id, &None);
}

const MAX_OFFERS_PER_LISTING: u32 = 50;

#[test]
#[should_panic(expected = "Error(Contract, #35)")]
fn test_make_offer_exceeds_max_fails() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    for _ in 0..MAX_OFFERS_PER_LISTING {
        client.make_offer(&buyer, &lid, &5_000_000_i128, &token_id, &None);
    }
    client.make_offer(&buyer, &lid, &5_000_000_i128, &token_id, &None);
}

// ════════════════════════════════════════════════════════════
// SECTION 12: Artist revocation flow
// ════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_revoked_artist_cannot_create_listing() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.revoke_artist(&artist);
    client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_revoked_artist_cannot_create_auction() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.revoke_artist(&artist);
    client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
}

#[test]
fn test_revoked_artist_existing_listing_still_settleable() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.revoke_artist(&artist);
    assert!(client.buy_artwork(&buyer, &id));
    assert_eq!(client.get_listing(&id).status, ListingStatus::Sold);
}

#[test]
fn test_revoked_artist_existing_auction_still_finalizable() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.place_bid(&buyer, &aid, &1_500_000_i128);
    client.revoke_artist(&artist);
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.finalize_auction(&buyer, &aid);
    assert_eq!(client.get_auction(&aid).status, crate::types::AuctionStatus::Finalized);
}

#[test]
fn test_reinstated_artist_can_create_again() {
    let (env, client, admin, _, token_id, _cid, _col) = setup();
    client.set_admin(&admin);
    client.add_token_to_whitelist(&token_id);
    let artist2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&artist2, &100_000_000_000_i128);
    let col2 = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &col2).set_owner(&1u64, &artist2);
    client.revoke_artist(&artist2);
    client.reinstate_artist(&artist2);
    let id = client.create_listing(
        &artist2, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &col2, &1u64,
        &valid_recipients(&env, &artist2), &None::<u64>,
    );
    assert!(id > 0);
}

// ════════════════════════════════════════════════════════════
// SECTION 13: Pause enforcement
// ════════════════════════════════════════════════════════════

#[test]
fn test_is_paused_default_false() {
    let (_env, client, artist, _, _t, _c, _col) = setup();
    client.set_admin(&artist);
    assert!(!client.is_paused());
}

#[test]
fn test_admin_pause_unpause() {
    let (_env, client, artist, _, _t, _c, _col) = setup();
    client.set_admin(&artist);
    client.admin_pause(&artist);
    assert!(client.is_paused());
    client.admin_unpause(&artist);
    assert!(!client.is_paused());
}

#[test]
#[should_panic]
fn test_create_listing_blocked_when_paused() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.admin_pause(&artist);
    client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
}

#[test]
#[should_panic]
fn test_buy_artwork_blocked_when_paused() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let id = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.admin_pause(&artist);
    client.buy_artwork(&buyer, &id);
}

// ════════════════════════════════════════════════════════════
// SECTION 14: Protocol fee snapshot
// ════════════════════════════════════════════════════════════

#[test]
fn test_listing_snapshots_protocol_fee_at_creation() {
    let (env, client, artist, _b, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &10_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.set_protocol_fee(&artist, &500u32);
    assert_eq!(client.get_listing(&lid).protocol_fee_bps, 0u32);
}

#[test]
fn test_buy_uses_snapshotted_fee_not_raised_global() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let treasury = Address::generate(&env);
    client.set_treasury(&artist, &treasury);
    let price = 10_000_000_i128;
    let lid = client.create_listing(
        &artist, &price, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.set_protocol_fee(&artist, &500u32);
    assert!(client.buy_artwork(&buyer, &lid));
    // Snapshotted fee was 0, treasury gets nothing
    assert_eq!(TokenClient::new(&env, &token_id).balance(&treasury), 0_i128);
}

// ════════════════════════════════════════════════════════════
// SECTION 15: Recipient validation
// ════════════════════════════════════════════════════════════

#[test]
fn test_validate_recipients_exactly_10000_bps_succeeds() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let lid = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &vec![&env, Recipient { address: artist.clone(), percentage: 10_000 }],
        &None::<u64>,
    );
    assert_eq!(lid, 1u64);
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_validate_recipients_10001_bps_rejected() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &vec![&env,
            Recipient { address: artist.clone(),           percentage: 5_001 },
            Recipient { address: Address::generate(&env),  percentage: 5_000 },
        ],
        &None::<u64>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_create_listing_too_many_recipients() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &vec![&env,
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
            Recipient { address: Address::generate(&env), percentage: 2_000 },
        ],
        &None::<u64>,
    );
}

// ════════════════════════════════════════════════════════════
// SECTION 16: Bid / auction mechanics
// ════════════════════════════════════════════════════════════

#[test]
fn test_place_bid_success() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.place_bid(&buyer, &aid, &1_500_000_i128);
    let auction = client.get_auction(&aid);
    assert_eq!(auction.highest_bid, 1_500_000_i128);
    assert_eq!(auction.highest_bidder, Some(buyer));
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_place_bid_too_low() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.place_bid(&buyer, &aid, &500_000_i128);
}

#[test]
fn test_outbid_refund() {
    let (env, client, artist, buyer1, token_id, _cid, collection_id) = setup();
    let buyer2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&buyer2, &100_000_000_000_i128);
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.place_bid(&buyer1, &aid, &1_500_000_i128);
    client.place_bid(&buyer2, &aid, &2_000_000_i128);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&buyer1), 100_000_000_000_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #29)")]
fn test_finalize_auction_before_expiry_fails() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.finalize_auction(&buyer, &aid);
}

#[test]
#[should_panic(expected = "Error(Contract, #32)")]
fn test_self_bid_not_allowed() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let aid = client.create_auction(
        &artist, &token_id, &collection_id, &1u64,
        &1_000_000_i128, &3600u64, &valid_recipients(&env, &artist),
    );
    client.place_bid(&artist, &aid, &1_500_000_i128);
}

// ════════════════════════════════════════════════════════════
// SECTION 17: Admin whitelist / misc
// ════════════════════════════════════════════════════════════

#[test]
fn test_add_and_remove_token_whitelist() {
    let (env, client, artist, _, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    client.remove_token_from_whitelist(&token_id);
    // Empty whitelist = allow all
    let lid = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    assert_eq!(lid, 1u64);
}

#[test]
#[should_panic]
fn test_set_admin_only_once() {
    let (_env, client, artist, _, _t, _c, _col) = setup();
    client.set_admin(&artist);
    client.set_admin(&artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_buy_artwork_fails_if_token_delisted() {
    let (env, client, artist, buyer, token_id, _cid, collection_id) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    let other = Address::generate(&env);
    client.add_token_to_whitelist(&other);
    let id = client.create_listing(
        &artist, &1_000_000_i128, &symbol_short!("XLM"),
        &token_id, &collection_id, &1u64,
        &valid_recipients(&env, &artist), &None::<u64>,
    );
    client.remove_token_from_whitelist(&token_id);
    client.buy_artwork(&buyer, &id);
}

#[test]
fn test_get_artist_listings() {
    let (env, client, artist, _, token_id, _cid, _col) = setup();
    client.set_admin(&artist);
    client.add_token_to_whitelist(&token_id);
    for i in 1u64..=3u64 {
        let col = env.register(mock_nft::MockNft, ());
        MockNftClient::new(&env, &col).set_owner(&i, &artist);
        client.create_listing(
            &artist, &(i as i128 * 1_000_000_i128), &symbol_short!("XLM"),
            &token_id, &col, &i,
            &valid_recipients(&env, &artist), &None::<u64>,
        );
    }
    assert_eq!(client.get_artist_listings(&artist).len(), 3);
}

#[test]
fn test_get_listing_not_found() {
    let (_env, client, _, _, _, _, _) = setup();
    let result = client.try_get_listing(&999u64);
    assert!(result.is_err());
}
