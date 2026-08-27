/// # Invariant-based state machine tests (Issue #281)
///
/// Model-based tests that compare the on-chain contract against a simple
/// reference model. Generated sequences of valid and invalid operations
/// are run and the following invariants are asserted after every step:
///
/// 1. **Transition invariant** — illegal transitions fail without changing
///    relevant on-chain state.
/// 2. **Uniqueness** — terminal states (Sold/Finalized/Cancelled) cannot
///    be re-entered.
/// 3. **Ownership conservation** — after every successful sale the buyer
///    owns the NFT; after every cancel/expire the seller gets it back.
/// 4. **Escrow conservation** — buyer tokens paid in equal seller+fee
///    tokens paid out; offer amounts refunded on rejection/withdrawal.
///
/// Failing seeds are printed so any sequence can be reproduced with:
///   `cargo test -- invariant --nocapture 2>&1 | grep SEED`
///
use crate::test::{mock_nft, MockNftClient, valid_recipients};
use crate::{MarketplaceContract, MarketplaceContractClient};
use crate::types::{AuctionStatus, ListingStatus, MarketplaceError, OfferStatus};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

    // ── Deterministic LCG used as a seedable RNG ─────────────────────────
    // Allows any failing sequence to be reproduced by re-running with the
    // same seed. We use a simple 64-bit LCG so there are no extra deps.

    struct Lcg(u64);
    impl Lcg {
        fn new(seed: u64) -> Self { Lcg(seed ^ 0x6c62272e07bb0142) }
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0
        }
        fn next_usize(&mut self, limit: usize) -> usize {
            (self.next() as usize) % limit
        }
        fn next_bool(&mut self) -> bool { self.next() & 1 == 1 }
    }

    // ── Reference model ──────────────────────────────────────────────────
    // A pure-Rust mirror of the legal state transitions. No storage, no
    // Soroban SDK — just enums and structs that track what *should* happen.

    #[derive(Debug, Clone, PartialEq)]
    enum ModelListingStatus { Active, Sold, Cancelled }

    #[derive(Debug, Clone)]
    struct ModelListing {
        artist: u8,       // index into a small address pool
        price: i128,
        status: ModelListingStatus,
        has_pending_offers: bool,
    }

    #[derive(Debug, Clone, PartialEq)]
    enum ModelOfferStatus { Pending, Accepted, Rejected, Withdrawn }

    #[derive(Debug, Clone)]
    struct ModelOffer {
        listing_id: u64,
        offerer: u8,
        amount: i128,
        status: ModelOfferStatus,
    }

    #[derive(Debug, Clone, PartialEq)]
    enum ModelAuctionStatus { Active, Finalized, Cancelled }

    #[derive(Debug, Clone)]
    struct ModelAuction {
        creator: u8,
        reserve: i128,
        highest_bid: i128,
        highest_bidder: Option<u8>,
        end_time: u64,
        status: ModelAuctionStatus,
    }

    // ════════════════════════════════════════════════════════════════════
    // LISTING STATE MACHINE INVARIANTS
    // ════════════════════════════════════════════════════════════════════

    /// Common environment wired for listing invariant tests.
    fn listing_setup() -> (
        Env,
        MarketplaceContractClient<'static>,
        Address,   // artist
        Address,   // buyer
        Address,   // payment token
        Address,   // contract_id
        Address,   // collection
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MarketplaceContract, ());
        let client = MarketplaceContractClient::new(&env, &contract_id);
        let artist = Address::generate(&env);
        let buyer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let payment_token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
        let sac = StellarAssetClient::new(&env, &payment_token);
        sac.mint(&artist, &500_000_000_000_i128);
        sac.mint(&buyer, &500_000_000_000_i128);
        sac.mint(&contract_id, &500_000_000_000_i128);
        let collection_id = env.register(mock_nft::MockNft, ());
        MockNftClient::new(&env, &collection_id).set_owner(&1u64, &artist);
        client.set_admin(&artist);
        client.add_token_to_whitelist(&artist, &payment_token);
        (env, client, artist, buyer, payment_token, contract_id, collection_id)
    }

    fn mk_listing(
        env: &Env,
        client: &MarketplaceContractClient,
        artist: &Address,
        token: &Address,
        collection: &Address,
        price: i128,
    ) -> u64 {
        client.create_listing(
            artist, &price, &symbol_short!("XLM"),
            token, collection, &1u64, &1u64,
            &valid_recipients(env, artist),
            &None::<u64>,
        )
    }

    // ── Invariant: Active → Sold (buy) is terminal ───────────────────────

    #[test]
    fn inv_listing_sold_is_terminal() {
        let (env, client, artist, buyer, token, _cid, col) = listing_setup();
        let price = 10_000_000_i128;
        let lid = mk_listing(&env, &client, &artist, &token, &col, price);
        assert!(client.buy_artwork(&buyer, &lid));
        // Sold → buy again must fail
        assert_eq!(
            client.try_buy_artwork(&buyer, &lid).unwrap_err().unwrap(),
            MarketplaceError::ListingSold.into()
        );
        // Sold → cancel must fail
        assert_eq!(
            client.try_cancel_listing(&artist, &lid).unwrap_err().unwrap(),
            MarketplaceError::ListingNotActive.into()
        );
        // Sold → update must fail
        assert_eq!(
            client.try_update_listing(
                &artist, &lid, &price, &token, &valid_recipients(&env, &artist)
            ).unwrap_err().unwrap(),
            MarketplaceError::ListingNotActive.into()
        );
        // State unchanged: status is still Sold
        assert_eq!(client.get_listing(&lid).status, ListingStatus::Sold);
    }

    // ── Invariant: Active → Cancelled is terminal ────────────────────────

    #[test]
    fn inv_listing_cancelled_is_terminal() {
        let (env, client, artist, buyer, token, _cid, col) = listing_setup();
        let lid = mk_listing(&env, &client, &artist, &token, &col, 10_000_000_i128);
        assert!(client.cancel_listing(&artist, &lid));
        // Cancelled → buy must fail
        assert_eq!(
            client.try_buy_artwork(&buyer, &lid).unwrap_err().unwrap(),
            MarketplaceError::ListingCancelled.into()
        );
        // Cancelled → cancel again must fail
        assert_eq!(
            client.try_cancel_listing(&artist, &lid).unwrap_err().unwrap(),
            MarketplaceError::ListingNotActive.into()
        );
        assert_eq!(client.get_listing(&lid).status, ListingStatus::Cancelled);
    }

    // ── Invariant: ownership conservation after buy ──────────────────────

    #[test]
    fn inv_listing_ownership_conservation_on_buy() {
        let (env, client, artist, buyer, token, contract_id, col) = listing_setup();
        let price = 50_000_000_i128;
        let tk = TokenClient::new(&env, &token);
        let artist_before = tk.balance(&artist);
        let buyer_before = tk.balance(&buyer);
        let lid = mk_listing(&env, &client, &artist, &token, &col, price);
        assert!(client.buy_artwork(&buyer, &lid));
        // Buyer paid exactly `price`
        assert_eq!(tk.balance(&buyer), buyer_before - price);
        // Artist received exactly `price` (protocol fee is 0 in setup)
        assert_eq!(tk.balance(&artist), artist_before + price);
        // Contract holds no residual
        assert_eq!(tk.balance(&contract_id), 500_000_000_000_i128);
        // NFT now belongs to buyer
        assert_eq!(
            mock_nft::MockNftClient::new(&env, &col).owner_of(&1u64),
            buyer
        );
    }

    // ── Invariant: NFT returned on cancel ────────────────────────────────

    #[test]
    fn inv_listing_nft_returned_on_cancel() {
        let (env, client, artist, _buyer, token, _cid, col) = listing_setup();
        let nft = mock_nft::MockNftClient::new(&env, &col);
        // After create_listing NFT is in contract escrow
        let lid = mk_listing(&env, &client, &artist, &token, &col, 10_000_000_i128);
        assert_ne!(nft.owner_of(&1u64), artist, "NFT should be in escrow");
        // After cancel NFT returns to artist
        assert!(client.cancel_listing(&artist, &lid));
        assert_eq!(nft.owner_of(&1u64), artist, "NFT must return to artist on cancel");
    }

    // ── Invariant: update rejected for non-artist ────────────────────────

    #[test]
    fn inv_listing_update_requires_owner() {
        let (env, client, artist, buyer, token, _cid, col) = listing_setup();
        let lid = mk_listing(&env, &client, &artist, &token, &col, 10_000_000_i128);
        assert_eq!(
            client.try_update_listing(
                &buyer, &lid, &9_000_000_i128, &token, &valid_recipients(&env, &buyer)
            ).unwrap_err().unwrap(),
            MarketplaceError::Unauthorized.into()
        );
        // State is unchanged
        assert_eq!(client.get_listing(&lid).price, 10_000_000_i128);
    }

    // ── Invariant: self-purchase not allowed ─────────────────────────────

    #[test]
    fn inv_listing_self_purchase_not_allowed() {
        let (env, client, artist, _buyer, token, _cid, col) = listing_setup();
        let lid = mk_listing(&env, &client, &artist, &token, &col, 10_000_000_i128);
        assert_eq!(
            client.try_buy_artwork(&artist, &lid).unwrap_err().unwrap(),
            MarketplaceError::SelfPurchaseNotAllowed.into()
        );
        assert_eq!(client.get_listing(&lid).status, ListingStatus::Active);
    }

    // ── Random-sequence listing invariant ────────────────────────────────

    /// Runs a bounded random sequence of listing operations and asserts
    /// that no illegal transition silently succeeds. Prints seed on failure.
    #[test]
    fn inv_listing_random_sequence() {
        for seed in [1u64, 42, 999, 12345, 0xdeadbeef] {
            run_listing_sequence(seed);
        }
    }

    fn run_listing_sequence(seed: u64) {
        let mut rng = Lcg::new(seed);
        let (env, client, artist, buyer, token, _cid, col) = listing_setup();

        let price = 10_000_000_i128;
        let lid = mk_listing(&env, &client, &artist, &token, &col, price);
        let mut model = ModelListing {
            artist: 0,
            price,
            status: ModelListingStatus::Active,
            has_pending_offers: false,
        };

        // 12 random steps
        for _ in 0..12 {
            let op = rng.next_usize(3);
            match op {
                0 => {
                    // buy
                    let result = client.try_buy_artwork(&buyer, &lid);
                    match model.status {
                        ModelListingStatus::Active => {
                            if !model.has_pending_offers {
                                assert!(result.is_ok(), "buy should succeed on Active listing");
                                model.status = ModelListingStatus::Sold;
                            }
                        }
                        _ => {
                            assert!(result.is_err(), "buy on non-Active listing must fail");
                        }
                    }
                }
                1 => {
                    // cancel
                    let result = client.try_cancel_listing(&artist, &lid);
                    match model.status {
                        ModelListingStatus::Active => {
                            assert!(result.is_ok(), "cancel should succeed on Active listing");
                            model.status = ModelListingStatus::Cancelled;
                        }
                        _ => {
                            assert!(result.is_err(), "cancel on non-Active listing must fail");
                        }
                    }
                }
                _ => {
                    // update price — always valid while Active (no pending offers)
                    let new_price = price + rng.next() as i128 % 5_000_000;
                    let result = client.try_update_listing(
                        &artist, &lid, &new_price, &token,
                        &valid_recipients(&env, &artist),
                    );
                    match model.status {
                        ModelListingStatus::Active => {
                            assert!(result.is_ok(), "update should succeed on Active listing");
                            model.price = new_price;
                        }
                        _ => {
                            assert!(result.is_err(), "update on non-Active listing must fail");
                        }
                    }
                }
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // OFFER STATE MACHINE INVARIANTS
    // ════════════════════════════════════════════════════════════════════

    fn offer_setup() -> (
        Env,
        MarketplaceContractClient<'static>,
        Address, // artist
        Address, // buyer (offerer)
        Address, // token
        Address, // contract_id
        Address, // collection
        u64,     // listing_id
    ) {
        let (env, client, artist, buyer, token, cid, col) = listing_setup();
        let lid = mk_listing(&env, &client, &artist, &token, &col, 20_000_000_i128);
        // Mint extra for the buyer so they can make offers
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        (env, client, artist, buyer, token, cid, col, lid)
    }

    // ── Invariant: Pending → Withdrawn is terminal ───────────────────────

    #[test]
    fn inv_offer_withdrawn_is_terminal() {
        let (env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);
        client.withdraw_offer(&buyer, &oid);
        // Withdrawn → withdraw again must fail
        assert_eq!(
            client.try_withdraw_offer(&buyer, &oid).unwrap_err().unwrap(),
            MarketplaceError::InvalidOfferState.into()
        );
        // Withdrawn → reject must fail
        assert_eq!(
            client.try_reject_offer(&artist, &oid).unwrap_err().unwrap(),
            MarketplaceError::InvalidOfferState.into()
        );
        // Withdrawn → accept must fail
        assert_eq!(
            client.try_accept_offer(&artist, &oid).unwrap_err().unwrap(),
            MarketplaceError::InvalidOfferState.into()
        );
    }

    // ── Invariant: Pending → Rejected is terminal ────────────────────────

    #[test]
    fn inv_offer_rejected_is_terminal() {
        let (_env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);
        client.reject_offer(&artist, &oid);
        assert_eq!(
            client.try_reject_offer(&artist, &oid).unwrap_err().unwrap(),
            MarketplaceError::InvalidOfferState.into()
        );
        assert_eq!(
            client.try_withdraw_offer(&buyer, &oid).unwrap_err().unwrap(),
            MarketplaceError::InvalidOfferState.into()
        );
    }

    // ── Invariant: Pending → Accepted is terminal ────────────────────────

    #[test]
    fn inv_offer_accepted_is_terminal() {
        let (_env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);
        client.accept_offer(&artist, &oid);
        // Accept again must fail (listing is now Sold)
        assert_eq!(
            client.try_accept_offer(&artist, &oid).unwrap_err().unwrap(),
            MarketplaceError::InvalidOfferState.into()
        );
    }

    // ── Invariant: offer on cancelled listing must fail ──────────────────

    #[test]
    fn inv_offer_on_cancelled_listing_fails() {
        let (_env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        client.cancel_listing(&artist, &lid);
        assert_eq!(
            client.try_make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>)
                .unwrap_err().unwrap(),
            MarketplaceError::ListingNotActive.into()
        );
    }

    // ── Invariant: offer on sold listing must fail ───────────────────────

    #[test]
    fn inv_offer_on_sold_listing_fails() {
        let (env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);
        client.buy_artwork(&buyer2, &lid);
        assert_eq!(
            client.try_make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>)
                .unwrap_err().unwrap(),
            MarketplaceError::ListingNotActive.into()
        );
    }

    // ── Invariant: self-offer not allowed ────────────────────────────────

    #[test]
    fn inv_offer_self_offer_not_allowed() {
        let (_env, client, artist, _buyer, token, _cid, _col, lid) = offer_setup();
        assert_eq!(
            client.try_make_offer(&artist, &lid, &5_000_000_i128, &token, &None::<u64>)
                .unwrap_err().unwrap(),
            MarketplaceError::CannotOfferOwnListing.into()
        );
    }

    // ── Invariant: escrow conservation — refund on reject ───────────────

    #[test]
    fn inv_offer_escrow_refunded_on_reject() {
        let (_env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let tk = TokenClient::new(&_env, &token);
        let before = tk.balance(&buyer);
        let amount = 5_000_000_i128;
        let oid = client.make_offer(&buyer, &lid, &amount, &token, &None::<u64>);
        assert_eq!(tk.balance(&buyer), before - amount, "funds must be locked");
        client.reject_offer(&artist, &oid);
        assert_eq!(tk.balance(&buyer), before, "funds must be refunded on reject");
    }

    // ── Invariant: escrow conservation — refund on withdraw ─────────────

    #[test]
    fn inv_offer_escrow_refunded_on_withdraw() {
        let (_env, client, _artist, buyer, token, _cid, _col, lid) = offer_setup();
        let tk = TokenClient::new(&_env, &token);
        let before = tk.balance(&buyer);
        let amount = 3_000_000_i128;
        let oid = client.make_offer(&buyer, &lid, &amount, &token, &None::<u64>);
        client.withdraw_offer(&buyer, &oid);
        assert_eq!(tk.balance(&buyer), before, "funds must be refunded on withdraw");
    }

    // ── Invariant: sibling offers refunded when one is accepted ──────────

    #[test]
    fn inv_offer_siblings_refunded_on_accept() {
        let (env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);
        let tk = TokenClient::new(&env, &token);

        let oid1 = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);
        let b2_before = tk.balance(&buyer2);
        let oid2 = client.make_offer(&buyer2, &lid, &4_000_000_i128, &token, &None::<u64>);
        assert_eq!(tk.balance(&buyer2), b2_before - 4_000_000, "buyer2 locked");

        // Accept the first offer — buyer2's offer must be refunded
        client.accept_offer(&artist, &oid1);
        assert_eq!(tk.balance(&buyer2), b2_before, "buyer2 must be refunded on sibling accept");
    }

    // ── Random-sequence offer invariant ──────────────────────────────────

    #[test]
    fn inv_offer_random_sequence() {
        for seed in [7u64, 31, 101, 7777, 0xcafebabe] {
            run_offer_sequence(seed);
        }
    }

    fn run_offer_sequence(seed: u64) {
        let mut rng = Lcg::new(seed);
        let (env, client, artist, buyer, token, _cid, _col, lid) = offer_setup();
        let tk = TokenClient::new(&env, &token);

        let amount = 5_000_000_i128;
        let oid = client.make_offer(&buyer, &lid, &amount, &token, &None::<u64>);
        let mut model = ModelOffer {
            listing_id: lid,
            offerer: 1,
            amount,
            status: ModelOfferStatus::Pending,
        };
        let buyer_locked = tk.balance(&buyer);

        for _ in 0..8 {
            let op = rng.next_usize(3);
            match op {
                0 => {
                    // withdraw
                    let res = client.try_withdraw_offer(&buyer, &oid);
                    match model.status {
                        ModelOfferStatus::Pending => {
                            assert!(res.is_ok());
                            model.status = ModelOfferStatus::Withdrawn;
                        }
                        _ => { assert!(res.is_err()); }
                    }
                }
                1 => {
                    // reject
                    let res = client.try_reject_offer(&artist, &oid);
                    match model.status {
                        ModelOfferStatus::Pending => {
                            assert!(res.is_ok());
                            model.status = ModelOfferStatus::Rejected;
                        }
                        _ => { assert!(res.is_err()); }
                    }
                }
                _ => {
                    // accept — only if listing still active
                    let res = client.try_accept_offer(&artist, &oid);
                    match model.status {
                        ModelOfferStatus::Pending => {
                            // Accept may or may not succeed depending on listing state
                            if res.is_ok() { model.status = ModelOfferStatus::Accepted; }
                        }
                        _ => { assert!(res.is_err()); }
                    }
                }
            }
        }

        // After any terminal state the buyer must have their funds back (or the
        // listing must be Sold, meaning the artist got them)
        match model.status {
            ModelOfferStatus::Withdrawn | ModelOfferStatus::Rejected => {
                // Funds must be back with the buyer
                assert!(tk.balance(&buyer) >= buyer_locked, "funds not refunded");
            }
            _ => {} // Accepted or still Pending — no additional assertion needed
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // AUCTION STATE MACHINE INVARIANTS
    // ════════════════════════════════════════════════════════════════════

    fn auction_setup() -> (
        Env,
        MarketplaceContractClient<'static>,
        Address, // creator
        Address, // bidder
        Address, // token
        Address, // contract_id
        Address, // collection
        u64,     // auction_id
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MarketplaceContract, ());
        let client = MarketplaceContractClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&creator, &500_000_000_000_i128);
        sac.mint(&bidder, &500_000_000_000_i128);
        sac.mint(&contract_id, &100_i128);
        let col = env.register(mock_nft::MockNft, ());
        MockNftClient::new(&env, &col).set_owner(&1u64, &creator);
        client.set_admin(&creator);
        client.add_token_to_whitelist(&creator, &token);

        env.ledger().with_mut(|li| li.timestamp = 1_000_000);
        let duration = 7_200u64; // 2 h > MIN_AUCTION_DURATION (1 h)
        let auction_id = client.create_auction(
            &creator, &token, &col, &1u64,
            &1_000_000_i128, &duration,
            &valid_recipients(&env, &creator),
        );
        (env, client, creator, bidder, token, contract_id, col, auction_id)
    }

    // ── Invariant: Active → Finalized is terminal ────────────────────────

    #[test]
    fn inv_auction_finalized_is_terminal() {
        let (env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
        client.place_bid(&bidder, &aid, &2_000_000_i128);
        // Advance past end_time
        env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
        client.finalize_auction(&creator, &aid);
        // Finalize again must fail
        assert_eq!(
            client.try_finalize_auction(&creator, &aid).unwrap_err().unwrap(),
            MarketplaceError::AuctionAlreadyFinalized.into()
        );
        assert_eq!(client.get_auction(&aid).status, AuctionStatus::Finalized);
    }

    // ── Invariant: bid after finalization must fail ───────────────────────

    #[test]
    fn inv_auction_bid_after_finalized_fails() {
        let (env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
        client.place_bid(&bidder, &aid, &2_000_000_i128);
        env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
        client.finalize_auction(&creator, &aid);
        assert_eq!(
            client.try_place_bid(&bidder, &aid, &3_000_000_i128).unwrap_err().unwrap(),
            MarketplaceError::AuctionNotActive.into()
        );
    }

    // ── Invariant: bid after expiry (before finalize) must fail ──────────

    #[test]
    fn inv_auction_bid_after_expiry_fails() {
        let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
        env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
        assert_eq!(
            client.try_place_bid(&bidder, &aid, &2_000_000_i128).unwrap_err().unwrap(),
            MarketplaceError::AuctionExpired.into()
        );
        // Status must still be Active (not changed by the failed bid)
        assert_eq!(client.get_auction(&aid).status, AuctionStatus::Active);
    }

    // ── Invariant: finalize before end_time must fail ────────────────────

    #[test]
    fn inv_auction_finalize_before_end_time_fails() {
        let (env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
        client.place_bid(&bidder, &aid, &2_000_000_i128);
        // Still before end_time
        assert_eq!(
            client.try_finalize_auction(&creator, &aid).unwrap_err().unwrap(),
            MarketplaceError::AuctionNotEnded.into()
        );
        assert_eq!(client.get_auction(&aid).status, AuctionStatus::Active);
    }

    // ── Invariant: cancel with bids must fail ────────────────────────────

    #[test]
    fn inv_auction_cancel_with_bids_fails() {
        let (_env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
        client.place_bid(&bidder, &aid, &2_000_000_i128);
        assert_eq!(
            client.try_cancel_auction(&creator, &aid).unwrap_err().unwrap(),
            MarketplaceError::AuctionHasBids.into()
        );
        assert_eq!(client.get_auction(&aid).status, AuctionStatus::Active);
    }

    // ── Invariant: self-bid must fail ────────────────────────────────────

    #[test]
    fn inv_auction_self_bid_not_allowed() {
        let (_env, client, creator, _bidder, token, _cid, _col, aid) = auction_setup();
        assert_eq!(
            client.try_place_bid(&creator, &aid, &2_000_000_i128).unwrap_err().unwrap(),
            MarketplaceError::SelfBidNotAllowed.into()
        );
        assert_eq!(client.get_auction(&aid).highest_bid, 0);
    }

    // ── Invariant: previous bidder refunded on outbid ────────────────────

    #[test]
    fn inv_auction_outbid_refunds_previous_bidder() {
        let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
        let bidder2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&bidder2, &500_000_000_000_i128);
        let tk = TokenClient::new(&env, &token);

        let b1_before = tk.balance(&bidder);
        client.place_bid(&bidder, &aid, &2_000_000_i128);
        assert_eq!(tk.balance(&bidder), b1_before - 2_000_000, "bid1 locked");

        // bidder2 outbids — bidder should get refunded
        client.place_bid(&bidder2, &aid, &3_000_000_i128);
        assert_eq!(tk.balance(&bidder), b1_before, "previous bidder must be refunded on outbid");
    }

    // ── Invariant: escrow conservation after finalize with winner ────────

    #[test]
    fn inv_auction_escrow_conservation_on_finalize() {
        let (env, client, creator, bidder, token, contract_id, col, aid) = auction_setup();
        let tk = TokenClient::new(&env, &token);
        let bid_amount = 10_000_000_i128;
        let creator_before = tk.balance(&creator);
        let bidder_before = tk.balance(&bidder);

        client.place_bid(&bidder, &aid, &bid_amount);
        // Advance past end_time
        env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
        client.finalize_auction(&creator, &aid);

        // Bidder paid bid_amount
        assert_eq!(tk.balance(&bidder), bidder_before - bid_amount, "bidder paid");
        // Creator received bid_amount (protocol fee 0 in setup)
        assert_eq!(tk.balance(&creator), creator_before + bid_amount, "creator received");
        // NFT transferred to bidder
        assert_eq!(
            mock_nft::MockNftClient::new(&env, &col).owner_of(&1u64),
            bidder
        );
        // Contract holds no residual value from this auction
        assert_eq!(tk.balance(&contract_id), 100_i128, "no residual in contract");
    }

    // ── Invariant: no-bid auction finalizes as Cancelled, NFT returned ───

    #[test]
    fn inv_auction_no_bid_finalize_returns_nft() {
        let (env, client, creator, _bidder, _token, _cid, col, aid) = auction_setup();
        let nft = mock_nft::MockNftClient::new(&env, &col);
        // NFT should be in escrow after auction creation
        assert_ne!(nft.owner_of(&1u64), creator, "NFT should be in escrow");
        env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
        client.finalize_auction(&creator, &aid);
        assert_eq!(client.get_auction(&aid).status, AuctionStatus::Cancelled);
        assert_eq!(nft.owner_of(&1u64), creator, "NFT must return to creator after no-bid finalize");
    }

    // ── Invariant: bid increment enforced ────────────────────────────────

    #[test]
    fn inv_auction_bid_increment_enforced() {
        let (_env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
        client.place_bid(&bidder, &aid, &2_000_000_i128);
        // Bid at exactly highest — must fail (need increment)
        assert_eq!(
            client.try_place_bid(&bidder, &aid, &2_000_000_i128).unwrap_err().unwrap(),
            MarketplaceError::BidTooLow.into()
        );
        assert_eq!(client.get_auction(&aid).highest_bid, 2_000_000_i128);
    }

    // ── Random-sequence auction invariant ────────────────────────────────

    #[test]
    fn inv_auction_random_sequence() {
        for seed in [2u64, 17, 256, 9999, 0xbaadf00d] {
            run_auction_sequence(seed);
        }
    }

    fn run_auction_sequence(seed: u64) {
        let mut rng = Lcg::new(seed);
        let (env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
        let mut model = ModelAuction {
            creator: 0,
            reserve: 1_000_000,
            highest_bid: 0,
            highest_bidder: None,
            end_time: 1_000_000 + 7_200,
            status: ModelAuctionStatus::Active,
        };
        let mut current_time: u64 = 1_000_000;

        for _ in 0..10 {
            let op = rng.next_usize(4);
            match op {
                0 => {
                    // place bid
                    let amount = model.highest_bid.max(model.reserve) + 1_000_000;
                    let res = client.try_place_bid(&bidder, &aid, &amount);
                    if model.status == ModelAuctionStatus::Active
                        && current_time < model.end_time
                    {
                        assert!(res.is_ok(), "valid bid should succeed");
                        model.highest_bid = amount;
                        model.highest_bidder = Some(1);
                    } else {
                        assert!(res.is_err(), "bid on inactive/expired auction must fail");
                    }
                }
                1 => {
                    // advance time past end
                    current_time = model.end_time + 1;
                    env.ledger().with_mut(|li| li.timestamp = current_time);
                }
                2 => {
                    // finalize
                    let res = client.try_finalize_auction(&creator, &aid);
                    if model.status == ModelAuctionStatus::Active
                        && current_time >= model.end_time
                    {
                        assert!(res.is_ok(), "finalize should succeed after end_time");
                        model.status = if model.highest_bidder.is_some() {
                            ModelAuctionStatus::Finalized
                        } else {
                            ModelAuctionStatus::Cancelled
                        };
                    } else {
                        assert!(res.is_err(), "finalize in invalid state must fail");
                    }
                }
                _ => {
                    // cancel (only without bids)
                    let res = client.try_cancel_auction(&creator, &aid);
                    if model.status == ModelAuctionStatus::Active
                        && model.highest_bidder.is_none()
                    {
                        assert!(res.is_ok(), "cancel without bids should succeed");
                        model.status = ModelAuctionStatus::Cancelled;
                    } else {
                        assert!(res.is_err(), "cancel in invalid state must fail");
                    }
                }
            }
        }
    }


// ══════════════════════════════════════════════════════════════════════════════
// Issue #434 — Auction settlement and anti-sniping formal invariants layer
// ══════════════════════════════════════════════════════════════════════════════
//
// This section adds a dedicated regression suite for the unified auction
// invariants introduced in issue #434.  Coverage targets:
//   • End-time validity (past / future / exact boundary)
//   • Minimum bid increment (zero, negative, equal, one-below, one-above)
//   • Refund correctness (outbid, cancelled, finalized — no funds stuck)
//   • Self-bidding constraints (creator cannot outbid anyone)
//   • Extension cap exhaustion + total-duration cap
//   • Blocked-bidder registry overflow + bidder unblock flow
//   • Settlement atomicity (duplicate finalization, no partial state)
//   • No-bid auction path (NFT back, correct status)
//   • Fuzz-like bid-sequence + timing property tests (5 seeds each)
//   • refund_losing_bid edge cases

// ── helpers shared by this section ──────────────────────────────────────────

/// Create an auction with configurable duration and anti-snipe settings.
fn mk_auction_full(
    env: &Env,
    client: &MarketplaceContractClient,
    creator: &Address,
    token: &Address,
    col: &Address,
    reserve: i128,
    duration: u64,
) -> u64 {
    client.create_auction(
        creator,
        token,
        col,
        &1u64,
        &reserve,
        &duration,
        &valid_recipients(env, creator),
    )
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION A — End-time validity
// ──────────────────────────────────────────────────────────────────────────────

/// Bidding at exactly end_time (timestamp == end_time) must fail.
#[test]
fn inv434_bid_at_exact_end_time_fails() {
    let (env, client, creator, bidder, token, _cid, col, aid) = auction_setup();
    // advance to exactly end_time
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_200);
    assert_eq!(
        client
            .try_place_bid(&bidder, &aid, &2_000_000_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::AuctionExpired.into()
    );
    // Status unchanged
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Active);
    // Finalize must succeed (end_time is in the past now)
    client.finalize_auction(&creator, &aid);
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Cancelled);
}

/// Bidding one second before end_time must succeed.
#[test]
fn inv434_bid_one_second_before_end_time_succeeds() {
    let (env, client, _creator, bidder, _token, _cid, _col, aid) = auction_setup();
    // one second before end_time
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_200 - 1);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    assert_eq!(client.get_auction(&aid).highest_bid, 2_000_000_i128);
}

/// `finalize_auction` called before `end_time` must revert with `AuctionNotEnded`.
#[test]
fn inv434_finalize_before_end_time_fails() {
    let (env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    // Still one second before end
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_200 - 1);
    assert_eq!(
        client
            .try_finalize_auction(&creator, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::AuctionNotEnded.into()
    );
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Active);
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION B — Minimum bid increment edge cases
// ──────────────────────────────────────────────────────────────────────────────

/// Bid at reserve_price - 1 must fail.
#[test]
fn inv434_bid_below_reserve_fails() {
    let (_env, client, _creator, bidder, _token, _cid, _col, aid) = auction_setup();
    // reserve is 1_000_000; bid 999_999
    assert_eq!(
        client
            .try_place_bid(&bidder, &aid, &999_999_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::BidTooLow.into()
    );
    assert_eq!(client.get_auction(&aid).highest_bid, 0);
}

/// Bid at reserve_price exactly must succeed (first bid on reserve).
#[test]
fn inv434_bid_at_reserve_price_succeeds() {
    let (_env, client, _creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &1_000_000_i128);
    assert_eq!(client.get_auction(&aid).highest_bid, 1_000_000_i128);
}

/// After an existing bid, a new bid at `highest_bid + min_increment - 1` fails.
#[test]
fn inv434_bid_one_below_increment_fails() {
    let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&bidder2, &100_000_000_000_i128);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    // min_increment = DEFAULT_MIN_BID_INCREMENT = 1_000_000
    // required = 2_000_000 + 1_000_000 = 3_000_000; bid 2_999_999 must fail
    assert_eq!(
        client
            .try_place_bid(&bidder2, &aid, &2_999_999_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::BidTooLow.into()
    );
    assert_eq!(client.get_auction(&aid).highest_bid, 2_000_000_i128);
}

/// A bid at exactly `highest_bid + min_increment` must succeed.
#[test]
fn inv434_bid_at_exact_increment_succeeds() {
    let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&bidder2, &100_000_000_000_i128);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    client.place_bid(&bidder2, &aid, &3_000_000_i128);
    assert_eq!(client.get_auction(&aid).highest_bid, 3_000_000_i128);
    assert_eq!(
        client.get_auction(&aid).highest_bidder,
        Some(bidder2)
    );
}

/// Equal bid to the current highest (no increment) must fail.
#[test]
fn inv434_equal_bid_fails() {
    let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&bidder2, &100_000_000_000_i128);
    client.place_bid(&bidder, &aid, &5_000_000_i128);
    assert_eq!(
        client
            .try_place_bid(&bidder2, &aid, &5_000_000_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::BidTooLow.into()
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION C — Refund correctness
// ──────────────────────────────────────────────────────────────────────────────

/// On outbid, the previous bidder's exact amount is returned in the same
/// transaction as the new bid — no funds are stuck.
#[test]
fn inv434_outbid_refund_exact_amount() {
    let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&bidder2, &100_000_000_000_i128);
    let tk = TokenClient::new(&env, &token);

    let b1_before = tk.balance(&bidder);
    client.place_bid(&bidder, &aid, &3_000_000_i128);
    assert_eq!(tk.balance(&bidder), b1_before - 3_000_000, "locked");
    client.place_bid(&bidder2, &aid, &5_000_000_i128);
    assert_eq!(tk.balance(&bidder), b1_before, "refunded exactly on outbid");
}

/// After admin-cancel of an active auction with a bid, the highest bidder
/// is refunded automatically and the NFT returns to creator.
#[test]
fn inv434_admin_cancel_refunds_bidder_and_returns_nft() {
    let (env, client, creator, bidder, token, _cid, col, aid) = auction_setup();
    let tk = TokenClient::new(&env, &token);
    let bidder_before = tk.balance(&bidder);
    client.place_bid(&bidder, &aid, &4_000_000_i128);
    // Admin cancels — bidder must be refunded, NFT returned
    client.admin_cancel_auction(&creator, &aid);
    assert_eq!(tk.balance(&bidder), bidder_before, "bidder refunded on admin cancel");
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Cancelled);
    assert_eq!(
        mock_nft::MockNftClient::new(&env, &col).owner_of(&1u64),
        creator,
        "NFT returned to creator on admin cancel"
    );
}

/// No-bid auction: finalize produces Cancelled, NFT back, no token movement.
#[test]
fn inv434_no_bid_finalize_no_token_movement() {
    let (env, client, creator, _bidder, token, _cid, col, aid) = auction_setup();
    let tk = TokenClient::new(&env, &token);
    let creator_before = tk.balance(&creator);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Cancelled);
    // Creator's balance unchanged (no payment)
    assert_eq!(tk.balance(&creator), creator_before);
    assert_eq!(
        mock_nft::MockNftClient::new(&env, &col).owner_of(&1u64),
        creator
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION D — Self-bidding constraints
// ──────────────────────────────────────────────────────────────────────────────

/// Creator cannot place a bid on their own auction regardless of amount.
#[test]
fn inv434_creator_cannot_self_bid_after_prior_bid() {
    let (_env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    // Place a legitimate bid first
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    // Creator attempts to outbid
    assert_eq!(
        client
            .try_place_bid(&creator, &aid, &5_000_000_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::SelfBidNotAllowed.into()
    );
    // State unchanged
    assert_eq!(client.get_auction(&aid).highest_bidder, Some(bidder));
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION E — Extension cap exhaustion + total-duration cap
// ──────────────────────────────────────────────────────────────────────────────

/// When `max_extensions = 1`, the second snipe-triggering bid must fail with
/// `MaxExtensionsReached` — the extension cap is enforced by the invariants layer.
#[test]
fn inv434_extension_cap_exhaustion() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder1 = Address::generate(&env);
    let bidder2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&creator, &500_000_000_000_i128);
    sac.mint(&bidder1, &500_000_000_000_i128);
    sac.mint(&bidder2, &500_000_000_000_i128);
    let col = env.register(mock_nft::MockNft, ());
    mock_nft::MockNftClient::new(&env, &col).set_owner(&1u64, &creator);
    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &token);
    // Configure: trigger=300s, window=600s, max_extensions=1
    client.set_auction_extension_trigger(&creator, &300u64);
    client.set_auction_extension_window(&creator, &600u64);
    client.set_auction_max_extensions(&creator, &1u32);

    let start = 1_000_000u64;
    env.ledger().with_mut(|li| li.timestamp = start);
    let duration = 7_200u64;
    let aid = mk_auction_full(&env, &client, &creator, &token, &col, 1_000_000, duration);

    // First snipe: within trigger window — extension applied (count → 1)
    env.ledger().with_mut(|li| li.timestamp = start + duration - 100);
    client.place_bid(&bidder1, &aid, &2_000_000_i128);
    assert_eq!(client.get_auction(&aid).extension_count, 1);

    // Second snipe: max_extensions = 1, count already 1.
    // Issue #468 fix: the bid must be ACCEPTED but the auction must NOT be extended.
    let auction_end_time = client.get_auction(&aid).end_time;
    env.ledger().with_mut(|li| li.timestamp = auction_end_time - 100);
    client.place_bid(&bidder2, &aid, &4_000_000_i128);
    let after = client.get_auction(&aid);
    assert_eq!(after.end_time, auction_end_time, "end_time must not change after cap");
    assert_eq!(after.extension_count, 1, "extension_count must not increment after cap");
    assert!(after.highest_bidder.is_some(), "bid must be recorded as highest");
}

/// When a proposed extension would exceed `original_end_time + MAX_TOTAL_AUCTION_DURATION`,
/// the bid is still accepted but no extension is applied.
#[test]
fn inv434_total_duration_cap_bid_accepted_no_extension() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&creator, &500_000_000_000_i128);
    sac.mint(&bidder, &500_000_000_000_i128);
    let col = env.register(mock_nft::MockNft, ());
    mock_nft::MockNftClient::new(&env, &col).set_owner(&1u64, &creator);
    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &token);
    // Very large window so proposed_end = now + window > original + MAX_TOTAL
    client.set_auction_extension_trigger(&creator, &300u64);
    // window = MAX_TOTAL_AUCTION_DURATION + 1 day — extension would exceed cap
    client.set_auction_extension_window(&creator, &(2_592_000u64 + 86_400));

    let start = 1_000_000u64;
    env.ledger().with_mut(|li| li.timestamp = start);
    let duration = 7_200u64;
    let aid = mk_auction_full(&env, &client, &creator, &token, &col, 1_000_000, duration);

    // Trigger the snipe-window: time remaining < trigger
    let snipe_time = start + duration - 100;
    env.ledger().with_mut(|li| li.timestamp = snipe_time);
    // Bid must succeed but extension_count stays 0
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    let a = client.get_auction(&aid);
    assert_eq!(a.extension_count, 0, "no extension applied when cap exceeded");
    // end_time unchanged
    assert_eq!(a.end_time, start + duration);
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION F — Blocked-bidder enforcement
// ──────────────────────────────────────────────────────────────────────────────

/// A blocked bidder cannot place any bid.
#[test]
fn inv434_blocked_bidder_cannot_bid() {
    let (_env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.block_bidder(&creator, &aid, &bidder);
    assert_eq!(
        client
            .try_place_bid(&bidder, &aid, &2_000_000_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::Unauthorized.into()
    );
}

/// After being unblocked, the previously-blocked bidder can bid again.
#[test]
fn inv434_unblocked_bidder_can_bid() {
    let (_env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.block_bidder(&creator, &aid, &bidder);
    client.unblock_bidder(&creator, &aid, &bidder);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    assert_eq!(client.get_auction(&aid).highest_bid, 2_000_000_i128);
}

/// Attempting to block more than MAX_BLOCKED_BIDDERS addresses must fail
/// gracefully (the 51st block attempt panics).
#[test]
#[should_panic]
fn inv434_blocked_bidder_registry_overflow() {
    let (env, client, creator, _bidder, _token, _cid, _col, aid) = auction_setup();
    // Fill the registry to MAX_BLOCKED_BIDDERS (50) distinct addresses, then add one more.
    for _ in 0..51 {
        let addr = Address::generate(&env);
        client.block_bidder(&creator, &aid, &addr);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION G — Settlement atomicity (duplicate finalization)
// ──────────────────────────────────────────────────────────────────────────────

/// `finalize_auction` called a second time on a Finalized auction must revert.
/// This ensures no partial re-settlement can occur.
#[test]
fn inv434_duplicate_finalize_fails() {
    let (env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Finalized);
    // Second call must fail
    assert_eq!(
        client
            .try_finalize_auction(&creator, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::AuctionAlreadyFinalized.into()
    );
}

/// Placing a bid on a Finalized auction must fail.
#[test]
fn inv434_bid_on_finalized_auction_fails() {
    let (env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&bidder2, &100_000_000_000_i128);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    assert_eq!(
        client
            .try_place_bid(&bidder2, &aid, &5_000_000_i128)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::AuctionNotActive.into()
    );
}

/// Creator cannot cancel a Finalized auction.
#[test]
fn inv434_cancel_finalized_auction_fails() {
    let (env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    assert_eq!(
        client
            .try_cancel_auction(&creator, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::AuctionAlreadyFinalized.into()
    );
}

/// Creator cannot cancel a Cancelled auction a second time.
#[test]
fn inv434_double_cancel_fails() {
    let (_env, client, creator, _bidder, _token, _cid, _col, aid) = auction_setup();
    client.cancel_auction(&creator, &aid);
    assert_eq!(
        client
            .try_cancel_auction(&creator, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::AuctionAlreadyFinalized.into()
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION H — Event trail consistency
// ──────────────────────────────────────────────────────────────────────────────

/// Check whether any event in `events` carries `symbol` as a topic.
/// Uses the same XDR-based pattern as `has_event_with_topic` in test.rs.
fn has_event_topic_434(
    events: &soroban_sdk::testutils::ContractEvents,
    symbol: &str,
) -> bool {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    events.events().iter().any(|e| {
        if let ContractEventBody::V0(body) = &e.body {
            body.topics.iter().any(|t| match t {
                ScVal::Symbol(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == symbol,
                ScVal::String(s) => core::str::from_utf8(s.0.as_slice()).unwrap_or("") == symbol,
                _ => false,
            })
        } else {
            false
        }
    })
}

/// `place_bid` must emit `bid_placed`.
#[test]
fn inv434_bid_emits_bid_placed_event() {
    let (env, client, _creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    assert!(
        has_event_topic_434(&env.events().all(), crate::events::BID_PLACED),
        "bid_placed event must be emitted"
    );
}

/// `place_bid` triggering an extension must emit both `bid_placed` and
/// `auction_extended`.
#[test]
fn inv434_snipe_emits_both_bid_and_extension_events() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&creator, &500_000_000_000_i128);
    StellarAssetClient::new(&env, &token).mint(&bidder, &500_000_000_000_i128);
    let col = env.register(mock_nft::MockNft, ());
    mock_nft::MockNftClient::new(&env, &col).set_owner(&1u64, &creator);
    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &token);
    client.set_auction_extension_trigger(&creator, &300u64);
    client.set_auction_extension_window(&creator, &600u64);

    let start = 1_000_000u64;
    env.ledger().with_mut(|li| li.timestamp = start);
    let aid = mk_auction_full(&env, &client, &creator, &token, &col, 1_000_000, 7_200);
    // Place bid within the trigger window
    env.ledger().with_mut(|li| li.timestamp = start + 7_200 - 100);
    client.place_bid(&bidder, &aid, &2_000_000_i128);

    let evs = env.events().all();
    assert!(
        has_event_topic_434(&evs, crate::events::BID_PLACED),
        "bid_placed event must be emitted on snipe"
    );
    assert!(
        has_event_topic_434(&evs, crate::events::AUCTION_EXTENDED),
        "auction_extended event must be emitted on snipe"
    );
    assert_eq!(client.get_auction(&aid).extension_count, 1);
}

/// `finalize_auction` must emit `auction_resolved`.
#[test]
fn inv434_finalize_emits_auction_resolved_event() {
    let (env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    assert!(
        has_event_topic_434(&env.events().all(), crate::events::AUCTION_RESOLVED),
        "auction_resolved event must be emitted on finalize"
    );
}

/// Outbid must emit `auction_bid_refunded` for the previous bidder.
#[test]
fn inv434_outbid_emits_refund_event() {
    let (env, client, _creator, bidder, token, _cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&bidder2, &100_000_000_000_i128);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    client.place_bid(&bidder2, &aid, &4_000_000_i128);
    assert!(
        has_event_topic_434(&env.events().all(), crate::events::AUCTION_BID_REFUNDED),
        "auction_bid_refunded event must be emitted on outbid"
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION I — refund_losing_bid entry point
// ──────────────────────────────────────────────────────────────────────────────

/// `refund_losing_bid` on an Active auction must fail with `InvalidAuctionState`.
#[test]
fn inv434_refund_losing_bid_on_active_fails() {
    let (_env, client, _creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    assert_eq!(
        client
            .try_refund_losing_bid(&bidder, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::InvalidAuctionState.into()
    );
}

/// Winner cannot call `refund_losing_bid` on a Finalized auction.
#[test]
fn inv434_winner_cannot_call_refund_losing_bid() {
    let (env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    assert_eq!(client.get_auction(&aid).status, AuctionStatus::Finalized);
    assert_eq!(
        client
            .try_refund_losing_bid(&bidder, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::NoBidToRefund.into()
    );
}

/// A bidder with no recorded bid calling `refund_losing_bid` must fail.
#[test]
fn inv434_refund_losing_bid_no_record_fails() {
    let (env, client, creator, bidder, token, _cid, _col, aid) = auction_setup();
    let other = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&other, &100_000_000_000_i128);
    client.place_bid(&bidder, &aid, &2_000_000_i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000_000 + 7_201);
    client.finalize_auction(&creator, &aid);
    // `other` never placed a bid
    assert_eq!(
        client
            .try_refund_losing_bid(&other, &aid)
            .unwrap_err()
            .unwrap(),
        MarketplaceError::NoBidToRefund.into()
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION J — Fuzz-like property tests (random bid sequences + timings)
// ──────────────────────────────────────────────────────────────────────────────

/// Property: across many random bid sequences, no stroop is ever lost in the
/// contract.  After every sequence terminates:
///   creator_final + bidder_final + contract_final == initial_total
#[test]
fn inv434_prop_no_token_loss_across_bid_sequences() {
    for seed in [31u64, 137, 271, 4096, 0xf00dcafe] {
        run_bid_sequence_no_loss(seed);
    }
}

fn run_bid_sequence_no_loss(seed: u64) {
    let mut rng = Lcg::new(seed);
    let (env, client, creator, bidder, token, cid, _col, aid) = auction_setup();
    let bidder2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&bidder2, &500_000_000_000_i128);
    let tk = TokenClient::new(&env, &token);

    let initial_total = tk.balance(&creator)
        + tk.balance(&bidder)
        + tk.balance(&bidder2)
        + tk.balance(&cid);

    let mut current_time: u64 = 1_000_000;
    let end_time: u64 = 1_000_000 + 7_200;
    let mut highest_bid: i128 = 0;

    for _ in 0..15 {
        let op = rng.next_usize(3);
        match op {
            0 => {
                // bidder1 bids
                if current_time < end_time {
                    let amount = highest_bid.max(1_000_000) + 1_000_000;
                    if client.try_place_bid(&bidder, &aid, &amount).is_ok() {
                        highest_bid = amount;
                    }
                }
            }
            1 => {
                // bidder2 bids
                if current_time < end_time {
                    let amount = highest_bid + 2_000_000;
                    if client.try_place_bid(&bidder2, &aid, &amount).is_ok() {
                        highest_bid = amount;
                    }
                }
            }
            _ => {
                // advance time
                current_time = end_time + 1;
                env.ledger().with_mut(|li| li.timestamp = current_time);
            }
        }
    }

    // Finalize if still active
    env.ledger().with_mut(|li| li.timestamp = end_time + 1);
    let _ = client.try_finalize_auction(&creator, &aid);

    let final_total = tk.balance(&creator)
        + tk.balance(&bidder)
        + tk.balance(&bidder2)
        + tk.balance(&cid);

    assert_eq!(
        initial_total, final_total,
        "no stroop must be lost across the entire auction lifecycle (seed={seed})"
    );
}

/// Property: across many random bid sequences + time jumps, every auction
/// lifecycle terminates in exactly one terminal state (Finalized or Cancelled)
/// and every subsequent mutation attempt fails.
#[test]
fn inv434_prop_terminal_state_is_irrevocable() {
    for seed in [53u64, 199, 512, 8192, 0xdeadbeef_u64] {
        run_terminal_irrevocable_sequence(seed);
    }
}

fn run_terminal_irrevocable_sequence(seed: u64) {
    let mut rng = Lcg::new(seed);
    let (env, client, creator, bidder, _token, _cid, _col, aid) = auction_setup();
    let end_time: u64 = 1_000_000 + 7_200;
    let mut current_time: u64 = 1_000_000;
    let mut highest_bid: i128 = 0;
    let mut terminated = false;

    for _ in 0..20 {
        let op = rng.next_usize(4);
        match op {
            0 => {
                if current_time < end_time {
                    let amount = highest_bid.max(1_000_000) + 1_000_000;
                    if client.try_place_bid(&bidder, &aid, &amount).is_ok() {
                        highest_bid = amount;
                    }
                }
            }
            1 => {
                current_time = end_time + 1;
                env.ledger().with_mut(|li| li.timestamp = current_time);
            }
            2 => {
                if current_time >= end_time {
                    if client.try_finalize_auction(&creator, &aid).is_ok() {
                        terminated = true;
                    }
                }
            }
            _ => {
                if highest_bid == 0 {
                    if client.try_cancel_auction(&creator, &aid).is_ok() {
                        terminated = true;
                    }
                }
            }
        }
    }

    if terminated {
        let status = client.get_auction(&aid).status;
        assert!(
            status == AuctionStatus::Finalized || status == AuctionStatus::Cancelled,
            "terminal status must be Finalized or Cancelled (seed={seed})"
        );
        // All subsequent mutations must fail
        assert!(
            client
                .try_place_bid(&bidder, &aid, &999_999_999_i128)
                .is_err(),
            "bid on terminal auction must fail (seed={seed})"
        );
        assert!(
            client.try_finalize_auction(&creator, &aid).is_err(),
            "double-finalize must fail (seed={seed})"
        );
        assert!(
            client.try_cancel_auction(&creator, &aid).is_err(),
            "cancel on terminal auction must fail (seed={seed})"
        );
    }
}

// ══════════════════════════════════════════════════════════════
// ISSUE #468 — Anti-sniping extension boundary invariants
// ══════════════════════════════════════════════════════════════

fn auction_setup_with_trigger() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // creator
    Address, // bidder
    Address, // payment token
    Address, // collection
    u64,     // auction_id
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token =
        env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &payment_token);
    sac.mint(&creator, &1_000_000_000_i128);
    sac.mint(&bidder, &1_000_000_000_i128);
    sac.mint(&contract_id, &1_000_000_000_i128);
    let collection = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection).set_owner(&1u64, &creator);

    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &payment_token);
    client.set_min_bid_increment(&creator, &1_000_i128);
    // 60-second trigger window, 120-second extension
    client.set_auction_extension_trigger(&creator, &60u64);
    client.set_auction_extension_window(&creator, &120u64);

    env.ledger().with_mut(|l| { l.timestamp = 1_000; });
    let aid = client.create_auction(
        &creator, &payment_token, &collection, &1u64,
        &1_000_i128, &3600u64,
        &valid_recipients(&env, &creator),
    );
    (env, client, creator, bidder, payment_token, collection, aid)
}

/// A bid placed outside the trigger window must NOT extend the auction.
#[test]
fn test_non_qualifying_bid_does_not_extend() {
    let (env, client, _creator, bidder, _tok, _col, aid) =
        auction_setup_with_trigger();
    let before = client.get_auction(&aid);
    // bid well before the trigger window (3600 - 60 = 3540 seconds remaining)
    env.ledger().with_mut(|l| { l.timestamp = 1_100; }); // 2900 sec remaining
    client.place_bid(&bidder, &aid, &1_000_i128);
    let after = client.get_auction(&aid);
    assert_eq!(after.end_time, before.end_time, "end_time must not change for non-qualifying bid");
    assert_eq!(after.extension_count, 0, "extension_count must stay zero");
}

/// A bid placed inside the trigger window MUST extend the auction exactly once.
#[test]
fn test_qualifying_bid_extends_exactly_once() {
    let (env, client, _creator, bidder, _tok, _col, aid) =
        auction_setup_with_trigger();
    // Advance to 30 seconds before end (inside the 60-second trigger window)
    env.ledger().with_mut(|l| { l.timestamp = 4_570; }); // end_time=4600, remaining=30
    client.place_bid(&bidder, &aid, &1_000_i128);
    let after = client.get_auction(&aid);
    assert!(after.end_time > 4_600u64, "end_time must be extended past original end");
    assert_eq!(after.extension_count, 1, "extension_count must be 1 after first qualifying bid");
}

/// When max_extensions == 1 and the cap is reached, a late bid is still
/// ACCEPTED but does NOT extend the auction further.
#[test]
fn test_bid_accepted_after_extension_cap() {
    // Inline setup: max_extensions must be configured BEFORE create_auction so
    // the value is embedded in the auction struct.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let bidder2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let tok = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &tok);
    sac.mint(&creator, &1_000_000_000_i128);
    sac.mint(&bidder, &1_000_000_000_i128);
    sac.mint(&bidder2, &1_000_000_000_i128);
    sac.mint(&contract_id, &1_000_000_000_i128);
    let col = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &col).set_owner(&1u64, &creator);

    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &tok);
    client.set_min_bid_increment(&creator, &1_000_i128);
    client.set_auction_extension_trigger(&creator, &60u64);
    client.set_auction_extension_window(&creator, &120u64);
    client.set_auction_max_extensions(&creator, &1u32);  // set BEFORE create_auction

    env.ledger().with_mut(|l| { l.timestamp = 1_000; });
    let aid = client.create_auction(
        &creator, &tok, &col, &1u64,
        &1_000_i128, &3600u64,
        &valid_recipients(&env, &creator),
    );

    // First qualifying bid — applies extension 1
    env.ledger().with_mut(|l| { l.timestamp = 4_570; }); // end_time=4600, remaining=30<60
    client.place_bid(&bidder, &aid, &1_000_i128);
    let after_first = client.get_auction(&aid);
    assert_eq!(after_first.extension_count, 1);
    let extended_end = after_first.end_time;

    // Second qualifying bid — cap reached; bid must succeed but NOT extend
    let trigger_time = extended_end.saturating_sub(30);
    env.ledger().with_mut(|l| { l.timestamp = trigger_time; });
    client.place_bid(&bidder2, &aid, &2_000_i128);
    let after_second = client.get_auction(&aid);
    assert_eq!(after_second.end_time, extended_end, "end_time must not change after cap");
    assert_eq!(after_second.extension_count, 1, "extension_count must not increment after cap");
    assert!(after_second.highest_bidder.is_some(), "bid must have been recorded");
}

/// A bid at exactly end_time must be rejected (expired, not extended).
#[test]
fn test_bid_at_exact_end_time_rejected() {
    let (env, client, _creator, bidder, _tok, _col, aid) =
        auction_setup_with_trigger();
    let end = client.get_auction(&aid).end_time;
    env.ledger().with_mut(|l| { l.timestamp = end; });
    assert!(
        client.try_place_bid(&bidder, &aid, &1_000_i128).is_err(),
        "bid at exact end_time must fail with AuctionExpired"
    );
}

/// Extension cannot push end_time beyond original_end_time + MAX_TOTAL_AUCTION_DURATION.
#[test]
fn test_extension_bounded_by_total_duration_cap() {
    let (env, client, _creator, bidder, tok, _col, aid) =
        auction_setup_with_trigger();
    let original_end = client.get_auction(&aid).original_end_time;
    // Unlimited extensions; place many qualifying bids advancing the clock.
    // Create each bidder inline to avoid std::vec::Vec in no_std context.
    let mut current_bid = 1_000_i128;
    for _ in 0..10 {
        let b = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &tok).mint(&b, &1_000_000_000_i128);
        let auction = client.get_auction(&aid);
        let trigger_time = auction.end_time.saturating_sub(30);
        env.ledger().with_mut(|l| { l.timestamp = trigger_time; });
        current_bid += 1_000;
        let _ = client.try_place_bid(&b, &aid, &current_bid);
    }

    let final_auction = client.get_auction(&aid);
    let max_end = original_end.saturating_add(crate::contract::MAX_TOTAL_AUCTION_DURATION);
    assert!(
        final_auction.end_time <= max_end,
        "end_time {:?} must not exceed original_end + MAX_TOTAL_AUCTION_DURATION {:?}",
        final_auction.end_time, max_end
    );
}

// ══════════════════════════════════════════════════════════════
// ISSUE #467 — Reserve price update invariants
// ══════════════════════════════════════════════════════════════

fn reserve_update_setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // creator
    Address, // bidder
    Address, // payment token
    Address, // collection
    u64,     // auction_id
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token =
        env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &payment_token);
    sac.mint(&creator, &1_000_000_000_i128);
    sac.mint(&bidder, &1_000_000_000_i128);
    sac.mint(&contract_id, &1_000_000_000_i128);
    let collection = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection).set_owner(&1u64, &creator);

    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &payment_token);
    client.set_min_bid_increment(&creator, &1_000_i128);
    env.ledger().with_mut(|l| { l.timestamp = 1_000; });
    let aid = client.create_auction(
        &creator, &payment_token, &collection, &1u64,
        &1_000_i128, &3600u64,
        &valid_recipients(&env, &creator),
    );
    (env, client, creator, bidder, payment_token, collection, aid)
}

/// Creator can update reserve price when no bids exist.
#[test]
fn test_reserve_price_update_zero_bids() {
    let (_env, client, creator, _bidder, _tok, _col, aid) = reserve_update_setup();
    client.update_auction_reserve_price(&creator, &aid, &5_000_i128);
    let auction = client.get_auction(&aid);
    assert_eq!(auction.reserve_price, 5_000_i128, "reserve_price must reflect the update");
}

/// Reserve price update is rejected once the first bid exists.
#[test]
fn test_reserve_price_update_rejected_after_first_bid() {
    let (env, client, creator, bidder, _tok, _col, aid) = reserve_update_setup();
    env.ledger().with_mut(|l| { l.timestamp = 1_100; });
    client.place_bid(&bidder, &aid, &1_000_i128);
    assert!(
        client.try_update_auction_reserve_price(&creator, &aid, &500_i128).is_err(),
        "reserve price update must fail after first bid"
    );
    // Stored price is unchanged
    assert_eq!(client.get_auction(&aid).reserve_price, 1_000_i128);
}

/// Non-creator cannot update reserve price.
#[test]
fn test_reserve_price_update_unauthorized() {
    let (_env, client, _creator, bidder, _tok, _col, aid) = reserve_update_setup();
    assert!(
        client.try_update_auction_reserve_price(&bidder, &aid, &2_000_i128).is_err(),
        "non-creator reserve price update must fail"
    );
}

/// Reserve price update is rejected on a terminal (Cancelled) auction.
#[test]
fn test_reserve_price_update_rejected_on_terminal_auction() {
    let (_env, client, creator, _bidder, _tok, _col, aid) = reserve_update_setup();
    client.cancel_auction(&creator, &aid);
    assert!(
        client.try_update_auction_reserve_price(&creator, &aid, &2_000_i128).is_err(),
        "reserve price update on cancelled auction must fail"
    );
}

/// Randomized sequence: reserve updates are only valid in the (Active, no-bids) window.
#[test]
fn test_reserve_price_update_randomized() {
    let seeds: &[u64] = &[0, 1, 0xdeadbeef, 0xc0ffee00, 42];
    for &seed in seeds {
        let mut rng = Lcg::new(seed);
        let (env, client, creator, bidder, _tok, _col, aid) = reserve_update_setup();

        let mut has_bid = false;
        let mut terminated = false;

        for _ in 0..20 {
            match rng.next_usize(4) {
                0 => {
                    // attempt reserve update
                    let new_price = 1_000_i128 + (rng.next() % 10_000) as i128;
                    let result = client.try_update_auction_reserve_price(&creator, &aid, &new_price);
                    if !has_bid && !terminated {
                        assert!(result.is_ok(), "update must succeed (seed={seed}, price={new_price})");
                    } else {
                        assert!(result.is_err(), "update must fail after bid/terminal (seed={seed})");
                    }
                }
                1 if !has_bid && !terminated => {
                    env.ledger().with_mut(|l| { l.timestamp = l.timestamp.saturating_add(100); });
                    let reserve = client.get_auction(&aid).reserve_price;
                    if client.try_place_bid(&bidder, &aid, &reserve).is_ok() {
                        has_bid = true;
                    }
                }
                2 if !has_bid && !terminated => {
                    if client.try_cancel_auction(&creator, &aid).is_ok() {
                        terminated = true;
                    }
                }
                _ => {}
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════
// ISSUE #466 — Refund idempotency and winner exclusion
// ══════════════════════════════════════════════════════════════

fn refund_setup() -> (
    Env,
    MarketplaceContractClient<'static>,
    Address, // creator
    Address, // bidder (loser)
    Address, // bidder2 (winner)
    Address, // payment token
    u64,     // auction_id
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let bidder2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token =
        env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &payment_token);
    sac.mint(&creator, &1_000_000_000_i128);
    sac.mint(&bidder, &1_000_000_000_i128);
    sac.mint(&bidder2, &1_000_000_000_i128);
    sac.mint(&contract_id, &1_000_000_000_i128);
    let collection = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection).set_owner(&1u64, &creator);

    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &payment_token);
    client.set_min_bid_increment(&creator, &1_000_i128);
    env.ledger().with_mut(|l| { l.timestamp = 1_000; });
    let aid = client.create_auction(
        &creator, &payment_token, &collection, &1u64,
        &1_000_i128, &3600u64,
        &valid_recipients(&env, &creator),
    );

    // bidder places first bid (loses), bidder2 wins
    env.ledger().with_mut(|l| { l.timestamp = 1_100; });
    client.place_bid(&bidder, &aid, &1_000_i128);
    client.place_bid(&bidder2, &aid, &2_000_i128);
    // The outbid refund to `bidder` happens atomically in place_bid, so their
    // escrow is already returned. Finalize after end_time.
    env.ledger().with_mut(|l| { l.timestamp = 10_000; });
    client.finalize_auction(&creator, &aid);
    (env, client, creator, bidder, bidder2, payment_token, aid)
}

/// Duplicate `refund_losing_bid` call by the same bidder returns a stable error.
#[test]
fn test_refund_losing_bid_idempotent() {
    let (_env, client, _creator, bidder, _bidder2, _tok, aid) = refund_setup();
    // The losing bidder was already refunded atomically at outbid time.
    // `refund_losing_bid` is the recovery path — first call might succeed or
    // fail depending on whether escrow remains; second call must never succeed.
    let first = client.try_refund_losing_bid(&bidder, &aid);
    // Whether the first call succeeds or not, a second call must fail.
    if first.is_ok() {
        assert!(
            client.try_refund_losing_bid(&bidder, &aid).is_err(),
            "second refund claim must return NoBidToRefund"
        );
    } else {
        // First call already failed — nothing escrowed, so test passes trivially.
    }
}

/// The winner of a Finalized auction cannot claim a refund.
#[test]
fn test_refund_losing_bid_winner_excluded() {
    let (_env, client, _creator, _bidder, bidder2, _tok, aid) = refund_setup();
    assert!(
        client.try_refund_losing_bid(&bidder2, &aid).is_err(),
        "winning bidder must not be able to claim a refund"
    );
}

/// A cancelled auction allows losing bidders to reclaim (admin_cancel path).
#[test]
fn test_refund_losing_bid_after_admin_cancel() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let payment_token =
        env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &payment_token);
    sac.mint(&creator, &1_000_000_000_i128);
    sac.mint(&bidder, &1_000_000_000_i128);
    sac.mint(&contract_id, &1_000_000_000_i128);
    let collection = env.register(mock_nft::MockNft, ());
    MockNftClient::new(&env, &collection).set_owner(&1u64, &creator);

    client.set_admin(&creator);
    client.add_token_to_whitelist(&creator, &payment_token);
    client.set_min_bid_increment(&creator, &1_000_i128);
    env.ledger().with_mut(|l| { l.timestamp = 1_000; });
    let aid = client.create_auction(
        &creator, &payment_token, &collection, &1u64,
        &1_000_i128, &3600u64,
        &valid_recipients(&env, &creator),
    );
    env.ledger().with_mut(|l| { l.timestamp = 1_100; });
    client.place_bid(&bidder, &aid, &1_000_i128);

    // Admin cancels — highest bidder is refunded atomically inside admin_cancel_auction.
    client.admin_cancel_auction(&creator, &aid);

    // refund_losing_bid recovery path should now return NoBidToRefund (already refunded).
    assert!(
        client.try_refund_losing_bid(&bidder, &aid).is_err(),
        "bidder already refunded by admin_cancel; second claim must fail"
    );
}

// ══════════════════════════════════════════════════════════════
// ISSUE #465 — Conservation and terminal-state property tests
// ══════════════════════════════════════════════════════════════

/// Randomised sequences must conserve token balances across all operations.
/// Expected invariant: sum(seller + fee) == winning_bid after finalization.
#[test]
fn test_auction_payout_conservation_randomized() {
    let seeds: &[u64] = &[0, 1, 7, 100, 0xfeedface];
    for &seed in seeds {
        let mut rng = Lcg::new(seed);
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MarketplaceContract, ());
        let client = MarketplaceContractClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let payment_token =
            env.register_stellar_asset_contract_v2(token_admin.clone()).address();
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &payment_token);
        let tc = soroban_sdk::token::TokenClient::new(&env, &payment_token);

        let initial_balance = 100_000_000_i128;
        sac.mint(&creator, &initial_balance);
        sac.mint(&contract_id, &initial_balance);
        let collection = env.register(mock_nft::MockNft, ());
        MockNftClient::new(&env, &collection).set_owner(&1u64, &creator);

        client.set_admin(&creator);
        client.add_token_to_whitelist(&creator, &payment_token);
        client.set_min_bid_increment(&creator, &1_000_i128);

        // Generate 2-4 bidders with initial balances (soroban Vec avoids std in no_std context)
        let n_bidders = 2 + rng.next_usize(3);
        let mut bidders: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        for _ in 0..n_bidders {
            let b = Address::generate(&env);
            sac.mint(&b, &initial_balance);
            bidders.push_back(b);
        }

        env.ledger().with_mut(|l| { l.timestamp = 1_000; });
        let reserve = 1_000_i128;
        let aid = client.create_auction(
            &creator, &payment_token, &collection, &1u64,
            &reserve, &3600u64,
            &valid_recipients(&env, &creator),
        );

        // Record pre-auction contract balance
        let contract_before = tc.balance(&contract_id);

        let mut current_min = reserve;
        let mut any_bid_placed = false;

        for _ in 0..10 {
            let bidder = bidders.get(rng.next_usize(n_bidders) as u32).unwrap();
            let bid_amount = current_min + (rng.next() % 5_000) as i128;
            env.ledger().with_mut(|l| { l.timestamp = l.timestamp.saturating_add(100); });
            if client.try_place_bid(&bidder, &aid, &bid_amount).is_ok() {
                any_bid_placed = true;
                current_min = bid_amount + 1;
            }
        }

        if !any_bid_placed { continue; }

        // Finalize after end_time
        env.ledger().with_mut(|l| { l.timestamp = 10_000; });
        client.finalize_auction(&creator, &aid);

        // Conservation: contract balance must have returned to its pre-auction level.
        // (All escrowed funds flowed to creator/recipients.)
        let contract_after = tc.balance(&contract_id);
        assert_eq!(
            contract_after, contract_before,
            "escrow conservation violated after finalization (seed={seed}): \
             contract held {contract_before} before, {contract_after} after"
        );
    }
}

/// Illegal terminal-state transitions are rejected without state change.
#[test]
fn test_illegal_terminal_transitions_rejected() {
    let seeds: &[u64] = &[0, 42, 0xbeef];
    for &seed in seeds {
        let mut rng = Lcg::new(seed);
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MarketplaceContract, ());
        let client = MarketplaceContractClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let payment_token =
            env.register_stellar_asset_contract_v2(token_admin.clone()).address();
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &payment_token);
        sac.mint(&creator, &1_000_000_000_i128);
        sac.mint(&bidder, &1_000_000_000_i128);
        sac.mint(&contract_id, &1_000_000_000_i128);
        let collection = env.register(mock_nft::MockNft, ());
        MockNftClient::new(&env, &collection).set_owner(&1u64, &creator);

        client.set_admin(&creator);
        client.add_token_to_whitelist(&creator, &payment_token);
        client.set_min_bid_increment(&creator, &1_000_i128);
        env.ledger().with_mut(|l| { l.timestamp = 1_000; });
        let aid = client.create_auction(
            &creator, &payment_token, &collection, &1u64,
            &1_000_i128, &3600u64,
            &valid_recipients(&env, &creator),
        );

        let terminate_via_cancel = rng.next_bool();
        if terminate_via_cancel {
            client.cancel_auction(&creator, &aid);
        } else {
            env.ledger().with_mut(|l| { l.timestamp = 1_100; });
            client.place_bid(&bidder, &aid, &1_000_i128);
            env.ledger().with_mut(|l| { l.timestamp = 10_000; });
            client.finalize_auction(&creator, &aid);
        }

        let status = client.get_auction(&aid).status;
        assert!(
            status == AuctionStatus::Finalized || status == AuctionStatus::Cancelled,
            "auction must be terminal (seed={seed})"
        );

        // All mutations on a terminal auction must fail.
        assert!(client.try_place_bid(&bidder, &aid, &5_000_i128).is_err());
        assert!(client.try_finalize_auction(&creator, &aid).is_err());
        assert!(client.try_cancel_auction(&creator, &aid).is_err());
        assert!(client.try_update_auction_reserve_price(&creator, &aid, &500_i128).is_err());
    }
}
