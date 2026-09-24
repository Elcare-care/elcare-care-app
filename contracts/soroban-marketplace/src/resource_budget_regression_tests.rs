//! # Soroban Resource-Budget Regression Test Suite (Issue #651)
//!
//! Provides deterministic release-level benchmarking and resource regression guards
//! across all major Soroban marketplace execution paths.
//!
//! Measures:
//! 1. CPU instruction footprint (`env.budget().cpu_instruction_cost()`)
//! 2. Memory byte footprint (`env.budget().memory_byte_cost()`)
//! 3. Maximum-boundary state fixtures (deep indexes, maximum recipient arrays, deep offer sweeps)
//! 4. Deterministic rejection behavior at boundary limits without state corruption

#![cfg(test)]

use crate::test::{mock_nft, MockNftClient, valid_recipients};
use crate::{MarketplaceContract, MarketplaceContractClient};
use crate::types::{
    AuctionStatus, BatchCreateListingInput, BatchUpdateListingInput, ListingStatus,
    MarketplaceError, OfferStatus, Recipient,
};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, String, Symbol, Vec,
};

/// Structure recording CPU and memory consumption with upper tolerance boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceBudgetSnapshot {
    pub cpu_instructions: u64,
    pub memory_bytes: u64,
    pub max_cpu_allowance: u64,
    pub max_memory_allowance: u64,
}

impl ResourceBudgetSnapshot {
    pub fn assert_within_budget(&self, path_name: &str) {
        assert!(
            self.cpu_instructions <= self.max_cpu_allowance,
            "RESOURCE REGRESSION [{}]: CPU cost {} exceeded allowance {}",
            path_name,
            self.cpu_instructions,
            self.max_cpu_allowance
        );
        assert!(
            self.memory_bytes <= self.max_memory_allowance,
            "RESOURCE REGRESSION [{}]: Memory cost {} exceeded allowance {}",
            path_name,
            self.memory_bytes,
            self.max_memory_allowance
        );
    }
}

/// Helper harness executing a target closure and calculating delta resource consumption.
fn measure_path_budget<F, R>(env: &Env, max_cpu: u64, max_mem: u64, op: F) -> (R, ResourceBudgetSnapshot)
where
    F: FnOnce() -> R,
{
    env.budget().reset_unlimited();
    let cpu_before = env.budget().cpu_instruction_cost();
    let mem_before = env.budget().memory_byte_cost();

    let result = op();

    let cpu_after = env.budget().cpu_instruction_cost();
    let mem_after = env.budget().memory_byte_cost();

    let delta_cpu = cpu_after.saturating_sub(cpu_before);
    let delta_mem = mem_after.saturating_sub(mem_before);

    let snapshot = ResourceBudgetSnapshot {
        cpu_instructions: delta_cpu,
        memory_bytes: delta_mem,
        max_cpu_allowance: max_cpu,
        max_memory_allowance: max_mem,
    };

    (result, snapshot)
}

/// Test harness environment helper creating initialized marketplace contract and mock actors.
struct BudgetHarness {
    env: Env,
    admin: Address,
    artist: Address,
    buyer: Address,
    treasury: Address,
    contract_id: Address,
    client: MarketplaceContractClient<'static>,
    token_id: Address,
    token_admin: Address,
}

impl BudgetHarness {
    fn setup() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let artist = Address::generate(&env);
        let buyer = Address::generate(&env);
        let treasury = Address::generate(&env);

        let contract_id = env.register_contract(None, MarketplaceContract);
        let client = MarketplaceContractClient::new(&env, &contract_id);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(token_admin.clone());
        let stellar_client = StellarAssetClient::new(&env, &token_id);
        stellar_client.mint(&artist, &1_000_000_000);
        stellar_client.mint(&buyer, &1_000_000_000);

        client.set_admin(&admin);
        client.set_treasury(&admin, &treasury);
        client.set_protocol_fee(&admin, &250); // 2.5% protocol fee
        client.add_token_to_whitelist(&admin, &token_id);

        Self {
            env,
            admin,
            artist,
            buyer,
            treasury,
            contract_id,
            client,
            token_id,
            token_admin,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 1: Batch Listing Creation & Max-Quantity Resource Budget
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_batch_listing_creation() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);

    let mut batch_inputs = Vec::new(&h.env);
    for i in 0..15 {
        mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&(i as u64), &h.artist);
        batch_inputs.push_back(BatchCreateListingInput {
            token_id: i as u64,
            price: 10_000_000,
            currency: symbol_short!("XLM"),
            token: h.token_id.clone(),
            collection: nft_contract.clone(),
            recipients: valid_recipients(&h.env, &h.artist),
            duration_secs: 86400,
            quantity: 1,
        });
    }

    // Benchmark batch listing creation at maximum boundary (15 items)
    let (_, snapshot) = measure_path_budget(&h.env, 3_500_000, 250_000, || {
        h.client.create_listings(&h.artist, &batch_inputs)
    });

    snapshot.assert_within_budget("batch_create_listings_15");
    assert_eq!(h.client.get_total_listings(), 15);
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 2: Maximum Recipient Royalty Distribution & Settlement Payouts
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_max_recipients_settlement() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);
    mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&1, &h.artist);

    // Build maximum supported recipients list (5 recipients)
    let mut max_recipients = Vec::new(&h.env);
    for _ in 0..5 {
        let recipient_addr = Address::generate(&h.env);
        max_recipients.push_back(Recipient {
            address: recipient_addr,
            percentage_bps: 1000, // 10% each
        });
    }

    let listing_id = h.client.create_listing(
        &h.artist,
        &100_000_000,
        &symbol_short!("XLM"),
        &h.token_id,
        &nft_contract,
        &1,
        &max_recipients,
        &86400,
        &1,
    );

    // Measure resource cost of purchasing artwork with full multi-recipient payout calculation
    let (_, snapshot) = measure_path_budget(&h.env, 2_200_000, 180_000, || {
        h.client.buy_artwork(&h.buyer, &listing_id);
    });

    snapshot.assert_within_budget("buy_artwork_max_recipients");
    assert_eq!(h.client.get_listing_status(&listing_id), ListingStatus::Sold);
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 3: Deep Auction Bidding & Outbid Refund Sweeps Under Load
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_auction_bidding_and_replacement() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);
    mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&42, &h.artist);

    let auction_id = h.client.create_auction(
        &h.artist,
        &h.token_id,
        &nft_contract,
        &42,
        &10_000_000,
        &86400,
        &valid_recipients(&h.env, &h.artist),
    );

    // Simulate 10 sequential competitive outbids
    let stellar_client = StellarAssetClient::new(&h.env, &h.token_id);
    for i in 1..=10 {
        let bidder = Address::generate(&h.env);
        stellar_client.mint(&bidder, &1_000_000_000);
        let bid_amount = 10_000_000 + (i as i128 * 2_000_000);

        let (_, snapshot) = measure_path_budget(&h.env, 1_800_000, 150_000, || {
            h.client.place_bid(&bidder, &auction_id, &bid_amount);
        });

        snapshot.assert_within_budget("place_bid_competitive_sequence");
    }

    let auction_data = h.client.get_auction(&auction_id);
    assert_eq!(auction_data.status, AuctionStatus::Active);
    assert_eq!(auction_data.current_bid, 30_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 4: Blocked Bidder Traversal & Filter Budget
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_blocked_bidder_checks() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);
    mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&77, &h.artist);

    let auction_id = h.client.create_auction(
        &h.artist,
        &h.token_id,
        &nft_contract,
        &77,
        &10_000_000,
        &86400,
        &valid_recipients(&h.env, &h.artist),
    );

    // Populate maximum blocked bidders list
    for _ in 0..10 {
        let malicious_bidder = Address::generate(&h.env);
        let (_, snapshot) = measure_path_budget(&h.env, 950_000, 80_000, || {
            h.client.block_bidder(&h.artist, &auction_id, &malicious_bidder);
        });
        snapshot.assert_within_budget("block_bidder_append");
    }

    assert_eq!(h.client.get_blocked_bidders(&auction_id).len(), 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 5: High-Density Offer Chains, Counters & Expiration Sweeps
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_offer_sweep_and_counter_chain() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);
    mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&99, &h.artist);

    let listing_id = h.client.create_listing(
        &h.artist,
        &50_000_000,
        &symbol_short!("XLM"),
        &h.token_id,
        &nft_contract,
        &99,
        &valid_recipients(&h.env, &h.artist),
        &86400,
        &1,
    );

    let mut offer_ids = Vec::new(&h.env);
    let stellar_client = StellarAssetClient::new(&h.env, &h.token_id);
    for _ in 0..8 {
        let offerer = Address::generate(&h.env);
        stellar_client.mint(&offerer, &500_000_000);
        let offer_id = h.client.make_offer(&offerer, &listing_id, &25_000_000, &h.token_id);
        offer_ids.push_back(offer_id);
    }

    // Fast-forward ledger past offer expiration
    h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 90000);

    // Benchmark batch sweeping expired offers
    let (_, snapshot) = measure_path_budget(&h.env, 2_800_000, 220_000, || {
        h.client.sweep_expired_offers(&offer_ids);
    });

    snapshot.assert_within_budget("sweep_expired_offers_8");
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 6: Artist Revocation Cleanup & Cascading Cancellation Batches
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_artist_revocation_cleanup() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);

    // Create multiple active listings under artist
    for i in 100..110 {
        mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&(i as u64), &h.artist);
        h.client.create_listing(
            &h.artist,
            &20_000_000,
            &symbol_short!("XLM"),
            &h.token_id,
            &nft_contract,
            &(i as u64),
            &valid_recipients(&h.env, &h.artist),
            &86400,
            &1,
        );
    }

    // Measure artist revocation footprint
    let (_, snapshot_revoke) = measure_path_budget(&h.env, 850_000, 75_000, || {
        h.client.revoke_artist(&h.admin, &h.artist);
    });
    snapshot_revoke.assert_within_budget("revoke_artist_call");

    // Measure batched cancellation sweep for revoked artist
    let (_, snapshot_sweep) = measure_path_budget(&h.env, 2_900_000, 240_000, || {
        h.client.cancel_artist_listings(&h.admin, &h.artist, &10);
    });
    snapshot_sweep.assert_within_budget("cancel_artist_listings_batch_10");
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 7: Migration Consistency & Multi-Batch Storage TTL Extensions
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_migration_batch_and_ttl_extension() {
    let h = BudgetHarness::setup();

    // Benchmark step migration execution
    let (_, snapshot_mig) = measure_path_budget(&h.env, 1_600_000, 140_000, || {
        h.client.migrate_step(&h.admin, &25);
    });
    snapshot_mig.assert_within_budget("migrate_step_batch_25");

    // Benchmark active TTL extensions across maximum items
    let (_, snapshot_ttl) = measure_path_budget(&h.env, 1_400_000, 120_000, || {
        h.client.extend_active_ttls(&h.admin, &25);
    });
    snapshot_ttl.assert_within_budget("extend_active_ttls_25");
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 8: Adversarial Input Boundary Rejection & State Invariant Stability
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn test_resource_budget_boundary_rejection_no_partial_state() {
    let h = BudgetHarness::setup();
    let nft_contract = h.env.register_contract(None, mock_nft::MockNft);
    mock_nft::MockNftClient::new(&h.env, &nft_contract).set_owner(&200, &h.artist);

    let listing_id = h.client.create_listing(
        &h.artist,
        &50_000_000,
        &symbol_short!("XLM"),
        &h.token_id,
        &nft_contract,
        &200,
        &valid_recipients(&h.env, &h.artist),
        &86400,
        &1,
    );

    // An underfunded buyer attempts purchase - ensure rejection leaves clean state
    let uncapitalized_buyer = Address::generate(&h.env);
    let initial_owner = mock_nft::MockNftClient::new(&h.env, &nft_contract).owner_of(&200);

    let (res, snapshot) = measure_path_budget(&h.env, 1_200_000, 95_000, || {
        h.client.try_buy_artwork(&uncapitalized_buyer, &listing_id)
    });

    snapshot.assert_within_budget("try_buy_artwork_rejection");
    assert!(res.is_err(), "Underfunded purchase must be rejected");

    // Invariant: NFT must remain under original owner and listing remains active
    assert_eq!(
        mock_nft::MockNftClient::new(&h.env, &nft_contract).owner_of(&200),
        initial_owner
    );
    assert_eq!(h.client.get_listing_status(&listing_id), ListingStatus::Active);
}
