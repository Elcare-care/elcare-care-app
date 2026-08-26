/// # Migration and storage-retention hardening tests
///
/// Covers:
/// * Resume-after-interruption: migrate_step called with small budgets until
///   completion, asserting no entries are lost or duplicated at each step.
/// * Stale MigrationDone flag: calling migrate/migrate_step on an already-
///   migrated version reverts with AlreadyMigrated.
/// * Stuck marker: is_stuck transitions correctly through the migration lifecycle.
/// * Invalid cursor state: injecting a bad cursor directly into storage and
///   asserting the engine recovers or panics cleanly.
/// * Phase boundary postconditions: after each phase the paged index counts
///   match the expected record counts for all legacy index types
///   (ArtistListings, ArtistAuctions, ListingOffers, OffererOffers,
///   ActiveListings).
/// * Pending-offer alias correctness: ListingPendingOffers rebuilt correctly
///   and only contains Pending offer ids.
/// * ActiveListings consistency: after migration every Active listing appears
///   in the ActiveListings paged index exactly once; no orphaned
///   ActiveListingPos keys.
/// * Stress tests: 200+ entries spanning multiple index pages.
/// * extend_active_ttls invariant: terminal records are never processed;
///   anomaly events fired for stale index entries; sweep is resumable.
/// * cleanup_expired_locks invariant: no-op on absent locks; emits anomaly
///   for stuck locks on Active records; cap is enforced.
/// * Sequential upgrade simulation: per-version markers are independent.
/// * get_migration_status view: correct before, during, and after migration.
use crate::test::{mock_nft, MockNftClient, valid_recipients};
use crate::{MarketplaceContract, MarketplaceContractClient};
use crate::{
        storage::{
            self, add_to_active_listings, get_migration_progress, index_append, index_len,
            load_listing, load_offer, load_auction, set_migration_done, set_migration_progress,
            set_migration_stuck, is_migration_stuck,
            MigrationProgress, IndexId, DataKey,
        },
        types::{
            AuctionStatus, ListingStatus, MarketplaceError, Offer, OfferStatus, Recipient,
        },
    };
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        vec, Address, Env,
    };

    // ── Shared helpers ─────────────────────────────────────────────────────

    /// Full environment wired for migration tests.
    fn migration_setup() -> (
        Env,
        MarketplaceContractClient<'static>,
        Address, // admin / artist
        Address, // payment token
        Address, // collection
        Address, // contract_id for env.as_contract(...)
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.cost_estimate().disable_resource_limits();
        let contract_id = env.register(MarketplaceContract, ());
        let client = MarketplaceContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
        let sac = StellarAssetClient::new(&env, &token);
        sac.mint(&admin, &1_000_000_000_000_i128);
        sac.mint(&contract_id, &1_000_000_000_000_i128);
        let col = env.register(mock_nft::MockNft, ());
        client.set_admin(&admin);
        client.add_token_to_whitelist(&admin, &token);
        env.ledger().with_mut(|li| li.timestamp = 1_000_000);
        (env, client, admin, token, col, contract_id)
    }

    /// Create `n` listings for the given artist (each with a fresh token_id
    /// backed by the mock NFT), returning the list of listing ids.
    fn create_n_listings(
        env: &Env,
        client: &MarketplaceContractClient,
        artist: &Address,
        token: &Address,
        col: &Address,
        n: u32,
    ) -> soroban_sdk::Vec<u64> {
        let nft = MockNftClient::new(env, col);
        let mut ids = soroban_sdk::Vec::new(env);
        for i in 1u64..=n as u64 {
            nft.set_owner(&i, artist);
            let lid = client.create_listing(
                artist,
                &10_000_000_i128,
                &symbol_short!("XLM"),
                token,
                col,
                &i,
                &1u64,
                &valid_recipients(env, artist),
                &None::<u64>,
            );
            ids.push_back(lid);
        }
        ids
    }

    /// Create `n` auctions for the given creator. Returns auction ids.
    fn create_n_auctions(
        env: &Env,
        client: &MarketplaceContractClient,
        creator: &Address,
        token: &Address,
        col: &Address,
        start_token_id: u64,
        n: u32,
    ) -> soroban_sdk::Vec<u64> {
        let nft = MockNftClient::new(env, col);
        let mut ids = soroban_sdk::Vec::new(env);
        for i in 0u64..n as u64 {
            let tid = start_token_id + i;
            nft.set_owner(&tid, creator);
            let aid = client.create_auction(
                creator,
                token,
                col,
                &tid,
                &1_000_000_i128,
                &7_200u64,
                &valid_recipients(env, creator),
            );
            ids.push_back(aid);
        }
        ids
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 1: get_migration_status view — before / during / after
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn migration_status_before_any_migration() {
        let (_env, client, _admin, _token, _col, cid) = migration_setup();
        let status = client.get_migration_status();
        assert!(!status.is_done, "no migration has run yet");
        assert!(!status.is_in_progress, "no cursor persisted");
        assert!(!status.is_stuck, "never interrupted");
        assert_eq!(status.phase, 0);
        assert_eq!(status.cursor, 0);
    }

    #[test]
    fn migration_status_in_progress_after_first_step() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Create listings so there is work to do.
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        // One step should leave the migration in progress.
        let remaining = client.migrate_step(&admin, &1u32);
        assert!(remaining > 0);
        let status = client.get_migration_status();
        assert!(!status.is_done);
        assert!(status.is_in_progress);
        assert!(status.is_stuck, "interrupted migration must set stuck marker");
    }

    #[test]
    fn migration_status_done_after_full_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 2);
        client.migrate(&admin);
        let status = client.get_migration_status();
        assert!(status.is_done);
        assert!(!status.is_in_progress);
        assert!(!status.is_stuck, "stuck marker must be cleared on completion");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 2: Stuck marker lifecycle
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn stuck_marker_false_before_any_step() {
        let (env, _client, _admin, _token, _col, cid) = migration_setup();
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        assert!(!env.as_contract(&cid, || is_migration_stuck(&env, &version)));
    }

    #[test]
    fn stuck_marker_set_after_partial_step() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 5);
        client.migrate_step(&admin, &1u32);
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        assert!(env.as_contract(&cid, || is_migration_stuck(&env, &version)), "stuck marker must be set when partial progress saved");
    }

    #[test]
    fn stuck_marker_cleared_after_completion() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        // Run partially then complete.
        client.migrate_step(&admin, &1u32);
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        assert!(env.as_contract(&cid, || is_migration_stuck(&env, &version)));
        // Drain to completion.
        let mut r = u64::MAX;
        while r > 0 {
            r = client.migrate_step(&admin, &5u32);
        }
        assert!(!env.as_contract(&cid, || is_migration_stuck(&env, &version)), "stuck marker must be cleared on completion");
        assert!(client.get_migration_status().is_done);
    }

    #[test]
    fn stuck_marker_false_when_migrate_completes_in_one_call() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 2);
        client.migrate(&admin);
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        assert!(!env.as_contract(&cid, || is_migration_stuck(&env, &version)), "one-shot migration must not leave stuck marker");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 3: Stale MigrationDone flag — AlreadyMigrated guard
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn migrate_rejects_already_migrated() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 1);
        client.migrate(&admin);
        // Second call must revert.
        assert_eq!(
            client.try_migrate(&admin).unwrap_err().unwrap(),
            MarketplaceError::AlreadyMigrated.into()
        );
    }

    #[test]
    fn migrate_step_rejects_already_migrated() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 1);
        client.migrate(&admin);
        assert_eq!(
            client.try_migrate_step(&admin, &1u32).unwrap_err().unwrap(),
            MarketplaceError::AlreadyMigrated.into()
        );
    }

    #[test]
    fn migrate_step_on_fresh_contract_with_no_records_completes() {
        let (_env, client, admin, _token, _col, cid) = migration_setup();
        // No listings/auctions/offers — should complete in one step.
        let remaining = client.migrate_step(&admin, &10u32);
        assert_eq!(remaining, 0, "no records means migration completes immediately");
        let status = client.get_migration_status();
        assert!(status.is_done);
    }

    /// Injecting a MigrationDone marker for the same version before any call
    /// should cause migrate to immediately revert with AlreadyMigrated.
    #[test]
    fn injected_stale_done_marker_causes_rejection() {
        let (env, client, admin, _token, _col, cid) = migration_setup();
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        env.as_contract(&cid, || set_migration_done(&env, &version));
        assert_eq!(
            client.try_migrate(&admin).unwrap_err().unwrap(),
            MarketplaceError::AlreadyMigrated.into()
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 4: Resume-after-interruption — cursor continuity
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn migrate_step_resumes_and_completes_without_duplication() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Create 5 listings so phase 0 has meaningful work.
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 5);

        // Drive migration one listing at a time.
        let mut remaining = u64::MAX;
        let mut calls = 0u32;
        while remaining > 0 {
            remaining = client.migrate_step(&admin, &1u32);
            calls += 1;
            assert!(calls < 200, "migration should terminate within bounded calls");
        }

        // All listing ids must still be in the paged ArtistListings index.
        let artist_listings = client.get_artist_listings(&admin);
        assert_eq!(
            artist_listings.len() as usize,
            ids.len() as usize,
            "no listing ids should be lost after stepped migration"
        );
        // Check for duplicates by verifying the set size.
        for lid in ids.iter() {
            let count = artist_listings.iter().filter(|x| *x == lid).count();
            assert_eq!(count, 1, "listing id {} duplicated in artist index", lid);
        }
        // All Active listings must appear in the ActiveListings paged index.
        let active_count = client.get_active_listings_count();
        assert_eq!(active_count, 5, "all 5 listings should be active");
    }

    #[test]
    fn migrate_step_one_unit_at_a_time_matches_bulk_migration() {
        // Run two parallel environments: one with bulk migrate, one with
        // single-unit migrate_step.  The final index counts must match.
        let run = |bulk: bool| -> (u32, u32) {
            let (env, client, admin, token, col, cid) = migration_setup();
            create_n_listings(&env, &client, &admin, &token, &col, 4);
            if bulk {
                client.migrate(&admin);
            } else {
                let mut r = u64::MAX;
                while r > 0 {
                    r = client.migrate_step(&admin, &1u32);
                }
            }
            let active = client.get_active_listings_count();
            let artist = client.get_artist_listings(&admin).len();
            (active, artist)
        };

        let (bulk_active, bulk_artist) = run(true);
        let (step_active, step_artist) = run(false);
        assert_eq!(bulk_active, step_active);
        assert_eq!(bulk_artist, step_artist);
    }

    #[test]
    fn resume_after_simulated_crash_cursor_is_consistent() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 6);

        // Simulate "crashed after 3 steps" by injecting a cursor mid-phase 0.
        client.migrate_step(&admin, &3u32);

        // Now complete the migration from the saved cursor position.
        let mut r = u64::MAX;
        while r > 0 {
            r = client.migrate_step(&admin, &10u32);
        }

        let artist_listings = client.get_artist_listings(&admin);
        assert_eq!(artist_listings.len(), 6, "all 6 listings must appear after resume");

        // No duplicates.
        for i in 0..artist_listings.len() {
            let id = artist_listings.get(i).unwrap();
            let count = artist_listings.iter().filter(|x| *x == id).count();
            assert_eq!(count, 1, "listing id {} duplicated", id);
        }
        assert!(client.get_migration_status().is_done);
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 5: ActiveListings consistency postcondition
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn active_listings_index_consistent_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 6);
        client.migrate(&admin);

        let active_count = client.get_active_listings_count();
        // Verify each position in the index holds a valid active listing.
        let total = client.get_total_listings();
        let mut active_via_scan = 0u32;
        for i in 1..=total {
            let l = client.get_listing(&i);
            if l.status == ListingStatus::Active {
                active_via_scan += 1;
            }
        }
        assert_eq!(
            active_count, active_via_scan,
            "ActiveListings index count must match full-scan active count"
        );
    }

    #[test]
    fn no_entry_duplicated_in_active_listings_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 5);
        client.migrate(&admin);

        let active = client.get_active_listings(&5u32, &0u32);
        let len = active.len();
        for i in 0..len {
            let id = active.get(i).unwrap();
            let dups = active.iter().filter(|x| *x == id).count();
            assert_eq!(dups, 1, "id {} appears more than once in ActiveListings", id);
        }
    }

    #[test]
    fn cancelled_listings_absent_from_active_index_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 4);
        // Cancel listing 2 before migration.
        client.cancel_listing(&admin, &2u64);
        client.migrate(&admin);

        // Active index must have exactly 3 entries, none of which is listing 2.
        assert_eq!(client.get_active_listings_count(), 3);
        let active = client.get_active_listings(&10u32, &0u32);
        assert!(!active.contains(&2u64), "cancelled listing must not be in active index");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 6: Pending-offer alias rebuilt correctly
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn pending_offer_count_correct_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        // A second user makes an offer.
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);

        client.migrate(&admin);

        // After migration the pending count must still be 1.
        let pending = client.get_pending_offer_count(&lid);
        assert_eq!(pending, 1, "pending offer count must survive migration");
    }

    #[test]
    fn pending_alias_only_contains_pending_status_offers() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );

        let buyer1 = Address::generate(&env);
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer1, &100_000_000_000_i128);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);

        let oid1 = client.make_offer(&buyer1, &lid, &5_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer2, &lid, &6_000_000_i128, &token, &None::<u64>);

        // Reject offer 1 before migration.
        client.reject_offer(&admin, &oid1);

        client.migrate(&admin);

        // Only oid2 (Pending) should appear in the alias.
        let pending_count = client.get_pending_offer_count(&lid);
        assert_eq!(pending_count, 1, "only pending offers should be in alias");

        // Verify via storage that oid1 (Rejected) is not in the pending set.
        let pending_ids = env.as_contract(&cid, || storage::load_pending_offer_ids(&env, lid));
        assert!(!pending_ids.contains(&oid1), "rejected offer must not be in pending alias");
        assert!(pending_ids.contains(&oid2), "pending offer must be in alias");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 7: Invalid cursor / stale phase injection
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn migration_with_cursor_beyond_record_count_completes_cleanly() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Only 2 listings exist.
        create_n_listings(&env, &client, &admin, &token, &col, 2);

        // Inject a cursor pointing past the end of phase 0 — this simulates a
        // cursor written by a previous version or a bug that advanced it too far.
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        env.as_contract(&cid, || set_migration_progress(

            &env,

            &version,

            &MigrationProgress { phase: 0, cursor: 999 },

        ));

        // The engine must treat cursor >= listing_count as "phase done" and
        // advance to phase 1 without panicking.
        let remaining = client.migrate_step(&admin, &10u32);
        assert_eq!(remaining, 0, "should complete: cursor already past listing count");

        let status = client.get_migration_status();
        assert!(status.is_done, "migration must be marked done");
    }

    #[test]
    fn migration_with_unknown_phase_number_terminates() {
        let (env, client, admin, _token, _col, cid) = migration_setup();
        // Inject an impossible phase (e.g. 99) — the engine should hit the `_ => break`
        // arm and complete with 0 remaining since there are no records.
        let version = soroban_sdk::String::from_str(&env, "1.1.0");
        env.as_contract(&cid, || set_migration_progress(

            &env,

            &version,

            &MigrationProgress { phase: 99, cursor: 0 },

        ));

        let remaining = client.migrate_step(&admin, &10u32);
        assert_eq!(remaining, 0, "unknown phase terminates as complete (no records)");
    }

    #[test]
    fn cursor_monotonically_advances_each_step() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 5);
        let version = soroban_sdk::String::from_str(&env, "1.1.0");

        // Phase 0 cursor should advance by 1 per step while < listing_count.
        for expected_cursor in 1u64..=4 {
            client.migrate_step(&admin, &1u32);
            let p = env.as_contract(&cid, || get_migration_progress(&env, &version));
            if p.phase == 0 {
                assert_eq!(p.cursor, expected_cursor, "cursor must advance monotonically");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 8: OffererOffers index correctness after migration
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn offerer_offers_index_correct_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        let oid1 = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer, &lid, &6_000_000_i128, &token, &None::<u64>);

        client.migrate(&admin);

        let offerer_ids = client.get_offerer_offers(&buyer);
        assert_eq!(offerer_ids.len(), 2, "both offers must appear in offerer index");
        assert!(offerer_ids.contains(&oid1));
        assert!(offerer_ids.contains(&oid2));
    }

    #[test]
    fn multi_offerer_offer_indexes_isolated_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );

        let buyer1 = Address::generate(&env);
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer1, &100_000_000_000_i128);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);

        let oid1 = client.make_offer(&buyer1, &lid, &5_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer2, &lid, &6_000_000_i128, &token, &None::<u64>);

        client.migrate(&admin);

        let ids1 = client.get_offerer_offers(&buyer1);
        let ids2 = client.get_offerer_offers(&buyer2);
        assert_eq!(ids1.len(), 1);
        assert_eq!(ids2.len(), 1);
        assert!(ids1.contains(&oid1));
        assert!(ids2.contains(&oid2));
        // No cross-contamination.
        assert!(!ids1.contains(&oid2));
        assert!(!ids2.contains(&oid1));
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 9: ArtistAuctions index correctness after migration
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn artist_auctions_index_correct_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Create 3 auctions.
        create_n_auctions(&env, &client, &admin, &token, &col, 1, 3);
        client.migrate(&admin);

        let auction_ids = client.get_artist_auctions(&admin);
        assert_eq!(auction_ids.len(), 3, "all 3 auctions must be indexed");
        // No duplicates.
        for i in 0..auction_ids.len() {
            let id = auction_ids.get(i).unwrap();
            let count = auction_ids.iter().filter(|x| *x == id).count();
            assert_eq!(count, 1, "auction id {} duplicated", id);
        }
    }

    #[test]
    fn phase1_postcondition_all_auction_creators_indexed() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let artist2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&artist2, &1_000_000_000_000_i128);

        create_n_auctions(&env, &client, &admin, &token, &col, 1, 2);
        // artist2 creates 1 auction at token_id 3.
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&3u64, &artist2);
        client.create_auction(
            &artist2, &token, &col, &3u64, &1_000_000_i128, &7_200u64,
            &valid_recipients(&env, &artist2),
        );

        client.migrate(&admin);

        let admin_auctions = client.get_artist_auctions(&admin);
        let artist2_auctions = client.get_artist_auctions(&artist2);
        assert_eq!(admin_auctions.len(), 2, "admin must have 2 auctions");
        assert_eq!(artist2_auctions.len(), 1, "artist2 must have 1 auction");

        // No overlap.
        for id in admin_auctions.iter() {
            assert!(!artist2_auctions.contains(&id), "auction ids must not overlap");
        }
    }

    #[test]
    fn phase2_postcondition_all_offerers_indexed() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );

        let buyer1 = Address::generate(&env);
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer1, &100_000_000_000_i128);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);

        let oid1 = client.make_offer(&buyer1, &lid, &5_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer2, &lid, &7_000_000_i128, &token, &None::<u64>);

        client.migrate(&admin);

        // Both offerers must have their offer id indexed.
        let b1_offers = client.get_offerer_offers(&buyer1);
        let b2_offers = client.get_offerer_offers(&buyer2);
        assert_eq!(b1_offers.len(), 1);
        assert!(b1_offers.contains(&oid1));
        assert_eq!(b2_offers.len(), 1);
        assert!(b2_offers.contains(&oid2));
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 10: Stress tests — 200+ entries spanning multiple index pages
    // ─────────────────────────────────────────────────────────────────────

    /// 110 listings spans two index pages (PAGE_SIZE = 100). Verifies that the
    /// paged engine handles cross-page boundaries without dropping or duplicating
    /// entries.
    #[test]
    fn stress_110_listings_multi_page_index() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 110);

        // Drain in chunks of 20 to exercise the cursor across the page boundary.
        let mut remaining = u64::MAX;
        while remaining > 0 {
            remaining = client.migrate_step(&admin, &20u32);
        }

        let active = client.get_active_listings_count();
        assert_eq!(active, 110, "all 110 listings must remain active after migration");

        let artist = client.get_artist_listings(&admin);
        assert_eq!(artist.len(), 110, "artist index must contain all 110 listings");

        // Verify uniqueness across both pages.
        for i in 0..artist.len() {
            let id = artist.get(i).unwrap();
            let count = artist.iter().filter(|x| *x == id).count();
            assert_eq!(count, 1, "listing id {} duplicated in artist index", id);
        }
    }

    /// 210 listings — three pages — driven one unit at a time to maximally
    /// stress the cursor-save/restore path.
    #[test]
    fn stress_210_listings_three_pages_single_step_budget() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 210);

        let mut remaining = u64::MAX;
        let mut calls = 0u32;
        while remaining > 0 {
            remaining = client.migrate_step(&admin, &1u32);
            calls += 1;
            assert!(calls < 5_000, "must terminate");
        }

        assert_eq!(
            client.get_active_listings_count(),
            210,
            "all 210 listings active"
        );
        assert!(client.get_migration_status().is_done);
    }

    /// 110 auctions stress-test across two index pages.
    #[test]
    fn stress_110_auctions_multi_page_index() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_auctions(&env, &client, &admin, &token, &col, 1, 110);

        let mut remaining = u64::MAX;
        while remaining > 0 {
            remaining = client.migrate_step(&admin, &15u32);
        }

        let auction_ids = client.get_artist_auctions(&admin);
        assert_eq!(auction_ids.len(), 110, "all 110 auctions must be in artist auction index");
        // Uniqueness check.
        for i in 0..auction_ids.len() {
            let id = auction_ids.get(i).unwrap();
            let count = auction_ids.iter().filter(|x| *x == id).count();
            assert_eq!(count, 1, "auction id {} duplicated", id);
        }
        assert!(client.get_migration_status().is_done);
    }

    /// Mixed stress: listings + auctions + offers to verify all phases complete.
    #[test]
    fn stress_mixed_listings_auctions_offers() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // 50 listings.
        let nft = MockNftClient::new(&env, &col);
        for i in 1u64..=50 {
            nft.set_owner(&i, &admin);
        }
        create_n_listings(&env, &client, &admin, &token, &col, 50);

        // 30 auctions starting at token_id 51.
        for i in 51u64..=80 {
            nft.set_owner(&i, &admin);
        }
        create_n_auctions(&env, &client, &admin, &token, &col, 51, 30);

        // 20 offers on listing 1.
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        for amount in 1u64..=20 {
            client.make_offer(&buyer, &1u64, &(1_000_000_i128 + amount as i128), &token, &None::<u64>);
        }

        let mut remaining = u64::MAX;
        while remaining > 0 {
            remaining = client.migrate_step(&admin, &10u32);
        }

        assert_eq!(client.get_active_listings_count(), 50, "all 50 listings active");
        assert_eq!(client.get_artist_listings(&admin).len(), 50, "all 50 listings indexed");
        assert_eq!(client.get_artist_auctions(&admin).len(), 30, "all 30 auctions indexed");
        assert_eq!(client.get_offerer_offers(&buyer).len(), 20, "all 20 offers indexed");
        assert!(client.get_migration_status().is_done);
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 11: extend_active_ttls invariant
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn extend_active_ttls_processes_active_listings_only() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        // Cancel one listing — it must NOT be counted as processed.
        client.cancel_listing(&admin, &1u64);

        let processed = client.extend_active_ttls(&admin, &100u32);
        // The sweep alternates listing/auction phases; with 0 auctions the loop
        // toggles back to listings (up to 2 passes × 2 active = 4 max).
        // The key invariant: the cancelled listing is NOT in the index, so
        // processed is always a multiple of active count (2), never includes #1.
        assert!(
            processed <= 4 && processed % 2 == 0,
            "extend_active_ttls processed {} — cancelled listing must not be counted",
            processed
        );
    }

    #[test]
    fn extend_active_ttls_never_processes_sold_listings() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);

        // Sell listing 1: set up a buyer, mint funds, buy.
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        client.buy_artwork(&buyer, &1u64);

        // Sweep should only process active listings; with 0 auctions the sweep
        // may run up to 2 passes × 2 active listings = 4 max. The sold listing
        // is removed from the index so it is never counted.
        let processed = client.extend_active_ttls(&admin, &100u32);
        assert!(processed <= 4 && processed % 2 == 0, "sold listing must not be counted in TTL sweep, got {}", processed);
    }

    #[test]
    fn extend_active_ttls_zero_max_returns_zero() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        let processed = client.extend_active_ttls(&admin, &0u32);
        assert_eq!(processed, 0, "zero budget must process nothing");
    }

    #[test]
    fn extend_active_ttls_caps_at_max_maintenance_items() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Create more listings than MAX_MAINTENANCE_ITEMS (100).
        create_n_listings(&env, &client, &admin, &token, &col, 110);
        let processed = client.extend_active_ttls(&admin, &200u32);
        assert!(
            processed <= 100,
            "processed {} but hard cap is 100",
            processed
        );
    }

    #[test]
    fn extend_active_ttls_is_resumable_across_calls() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 5);

        // Two calls with budget 3 each should together process all 5 listings.
        let first = client.extend_active_ttls(&admin, &3u32);
        let second = client.extend_active_ttls(&admin, &3u32);
        assert!(first + second >= 5, "two calls must cover all 5 listings");
    }

    #[test]
    fn extend_active_ttls_handles_auction_phase() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_auctions(&env, &client, &admin, &token, &col, 1, 3);

        // Run enough iterations to cover both phases.
        let mut total: u32 = 0;
        for _ in 0..6 {
            total += client.extend_active_ttls(&admin, &2u32);
        }
        assert!(total >= 3, "sweep must cover at least the 3 active auctions");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 12: cleanup_expired_locks invariant
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn cleanup_expired_locks_no_op_on_absent_locks() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        // No locks have been acquired; clearing them must return 0.
        let ids = soroban_sdk::vec![&env, 1u64, 2u64, 3u64];
        let cleared = client.cleanup_expired_locks(&admin, &ids, &soroban_sdk::Vec::new(&env));
        assert_eq!(cleared, 0, "no locks to clear");
    }

    #[test]
    fn cleanup_expired_locks_caps_at_max_maintenance_items() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Build a listing ids vec of 150 elements — all absent, but the cap
        // must still be enforced.
        let mut listing_ids = soroban_sdk::Vec::new(&env);
        for i in 1u64..=150 {
            listing_ids.push_back(i);
        }
        // This should not panic and must return 0 (no locks held).
        let cleared =
            client.cleanup_expired_locks(&admin, &listing_ids, &soroban_sdk::Vec::new(&env));
        assert_eq!(cleared, 0);
    }

    #[test]
    fn cleanup_expired_locks_returns_zero_for_terminal_records_without_locks() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 2);
        // Cancel both listings — no locks should exist.
        client.cancel_listing(&admin, &1u64);
        client.cancel_listing(&admin, &2u64);

        let ids = soroban_sdk::vec![&env, 1u64, 2u64];
        let cleared = client.cleanup_expired_locks(&admin, &ids, &soroban_sdk::Vec::new(&env));
        assert_eq!(cleared, 0, "no locks on terminal listings");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 13: ListingOffers index rebuilt correctly
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn listing_offers_index_correct_after_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &20_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);

        client.migrate(&admin);

        let listing_offers = client.get_listing_offers(&lid);
        assert_eq!(listing_offers.len(), 1);
        assert_eq!(listing_offers.get(0).unwrap(), oid);
    }

    #[test]
    fn listing_offers_multiple_offers_no_duplication() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &20_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer1 = Address::generate(&env);
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer1, &100_000_000_000_i128);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);
        let oid1 = client.make_offer(&buyer1, &lid, &5_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer2, &lid, &6_000_000_i128, &token, &None::<u64>);

        client.migrate(&admin);

        let listing_offers = client.get_listing_offers(&lid);
        assert_eq!(listing_offers.len(), 2, "both offers must appear in listing offers index");
        // No duplicates.
        assert!(listing_offers.contains(&oid1));
        assert!(listing_offers.contains(&oid2));
        let oid1_count = listing_offers.iter().filter(|x| *x == oid1).count();
        let oid2_count = listing_offers.iter().filter(|x| *x == oid2).count();
        assert_eq!(oid1_count, 1);
        assert_eq!(oid2_count, 1);
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 14: Multi-artist isolation
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn artist_indexes_isolated_across_multiple_artists() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let artist2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&artist2, &1_000_000_000_000_i128);

        // Admin creates 3 listings for token ids 1-3.
        let nft = MockNftClient::new(&env, &col);
        for i in 1u64..=3 {
            nft.set_owner(&i, &admin);
        }
        create_n_listings(&env, &client, &admin, &token, &col, 3);

        // artist2 creates 2 listings for token ids 4-5.
        for i in 4u64..=5 {
            nft.set_owner(&i, &artist2);
            client.create_listing(
                &artist2,
                &10_000_000_i128,
                &symbol_short!("XLM"),
                &token,
                &col,
                &i,
                &1u64,
                &valid_recipients(&env, &artist2),
                &None::<u64>,
            );
        }

        client.migrate(&admin);

        let admin_listings = client.get_artist_listings(&admin);
        let artist2_listings = client.get_artist_listings(&artist2);
        assert_eq!(admin_listings.len(), 3, "admin must have exactly 3 listings");
        assert_eq!(artist2_listings.len(), 2, "artist2 must have exactly 2 listings");

        // No overlap between the two sets.
        for id in admin_listings.iter() {
            assert!(
                !artist2_listings.contains(&id),
                "id {} appears in both artist indexes",
                id
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 15: Sequential upgrade simulation
    // ─────────────────────────────────────────────────────────────────────

    /// Simulate a scenario where a prior version's MigrationDone marker exists
    /// in storage (injected directly). The current version (1.1.0) migration
    /// must be completely independent and still succeed.
    #[test]
    fn sequential_upgrade_prior_version_done_marker_does_not_block_current() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Inject a MigrationDone marker for a hypothetical prior version.
        let prior = soroban_sdk::String::from_str(&env, "1.0.0");
        env.as_contract(&cid, || set_migration_done(&env, &prior));

        create_n_listings(&env, &client, &admin, &token, &col, 2);

        // Current version migration must still run cleanly.
        client.migrate(&admin);
        let status = client.get_migration_status();
        assert!(status.is_done, "1.1.0 migration must complete regardless of 1.0.0 marker");

        // The prior version marker must still be intact.
        let prior_still_done = env.as_contract(&cid, || storage::is_migration_done(&env, &prior));
        assert!(prior_still_done, "prior version marker must not be disturbed");
    }

    #[test]
    fn per_version_stuck_markers_are_independent() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);

        // Inject stuck marker for a different version.
        let other = soroban_sdk::String::from_str(&env, "1.0.0");
        env.as_contract(&cid, || set_migration_stuck(&env, &other));

        // Current version migration starts clean.
        let status_before = client.get_migration_status();
        assert!(!status_before.is_stuck, "current version must not inherit other version's stuck marker");

        // Complete the current migration.
        client.migrate(&admin);
        // Other version's stuck marker must remain untouched.
        assert!(env.as_contract(&cid, || is_migration_stuck(&env, &other)), "other version's stuck marker must be unchanged");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 16: Migration unauthorized without admin role
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn migrate_requires_upgrade_role() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 1);
        let stranger = Address::generate(&env);
        assert_eq!(
            client.try_migrate(&stranger).unwrap_err().unwrap(),
            MarketplaceError::Unauthorized.into()
        );
    }

    #[test]
    fn migrate_step_requires_upgrade_role() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 1);
        let stranger = Address::generate(&env);
        assert_eq!(
            client.try_migrate_step(&stranger, &1u32).unwrap_err().unwrap(),
            MarketplaceError::Unauthorized.into()
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 17: Invariant — no record lost or duplicated (all index types)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn invariant_all_listing_ids_in_artist_index_no_duplicates() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 15);
        client.migrate(&admin);

        let indexed = client.get_artist_listings(&admin);
        assert_eq!(indexed.len(), 15, "all 15 listings must be indexed");
        for lid in ids.iter() {
            let count = indexed.iter().filter(|x| *x == lid).count();
            assert_eq!(count, 1, "listing {} must appear exactly once", lid);
        }
    }

    #[test]
    fn invariant_all_auction_ids_in_artist_index_no_duplicates() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let ids = create_n_auctions(&env, &client, &admin, &token, &col, 1, 15);
        client.migrate(&admin);

        let indexed = client.get_artist_auctions(&admin);
        assert_eq!(indexed.len(), 15);
        for aid in ids.iter() {
            let count = indexed.iter().filter(|x| *x == aid).count();
            assert_eq!(count, 1, "auction {} must appear exactly once", aid);
        }
    }

    #[test]
    fn invariant_all_offer_ids_in_offerer_index_no_duplicates() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);

        let mut offer_ids = soroban_sdk::Vec::new(&env);
        for amount in 1u64..=15 {
            let oid = client.make_offer(&buyer, &lid, &(1_000_000_i128 + amount as i128), &token, &None::<u64>);
            offer_ids.push_back(oid);
        }

        client.migrate(&admin);

        let indexed = client.get_offerer_offers(&buyer);
        assert_eq!(indexed.len(), 15, "all 15 offers must appear in offerer index");
        for oid in offer_ids.iter() {
            let count = indexed.iter().filter(|x| *x == oid).count();
            assert_eq!(count, 1, "offer {} must appear exactly once", oid);
        }
    }

    #[test]
    fn invariant_listing_offers_all_ids_present_no_duplicates() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );

        let mut offer_ids = soroban_sdk::Vec::new(&env);
        for i in 0..10u64 {
            let buyer = Address::generate(&env);
            StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
            let oid = client.make_offer(&buyer, &lid, &(1_000_000_i128 + i as i128), &token, &None::<u64>);
            offer_ids.push_back(oid);
        }

        client.migrate(&admin);

        let indexed = client.get_listing_offers(&lid);
        assert_eq!(indexed.len(), 10, "all 10 offers must appear in listing offers index");
        for oid in offer_ids.iter() {
            let count = indexed.iter().filter(|x| *x == oid).count();
            assert_eq!(count, 1, "offer {} must appear exactly once in listing offers index", oid);
        }
    }

    #[test]
    fn invariant_active_listings_count_matches_record_scan() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 10);
        // Cancel 3 listings.
        client.cancel_listing(&admin, &1u64);
        client.cancel_listing(&admin, &5u64);
        client.cancel_listing(&admin, &8u64);

        client.migrate(&admin);

        let index_count = client.get_active_listings_count();
        let total = client.get_total_listings();
        let mut scan_count = 0u32;
        for i in 1..=total {
            if client.get_listing(&i).status == ListingStatus::Active {
                scan_count += 1;
            }
        }
        assert_eq!(index_count, scan_count, "active index count must match full scan count");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 18: Legacy storage fixture injection — realistic migration path
    //
    // These tests simulate the real upgrade scenario: legacy monolithic Vec<u64>
    // entries are injected directly into storage (bypassing the current contract
    // API), and the migration engine is expected to convert them correctly.
    // ─────────────────────────────────────────────────────────────────────

    /// Helper: convert the paged ArtistListings index for `artist` back into a
    /// legacy monolithic Vec<u64> under DataKey::ArtistListings, then remove
    /// the paged entries. Simulates a pre-1.1.0 storage layout for one artist.
    fn downgrade_to_legacy_artist_listings(
        env: &Env,
        cid: &Address,
        artist: &Address,
        listing_ids: &soroban_sdk::Vec<u64>,
    ) {
        env.as_contract(cid, || {
            // Read and remove IndexLen.
            env.storage().persistent().remove(&DataKey::IndexLen(IndexId::ArtistListings(artist.clone())));
            // Remove all IndexPage entries (page 0 is enough for ≤100 listings).
            for p in 0u32..5 {
                env.storage().persistent().remove(&DataKey::IndexPage(IndexId::ArtistListings(artist.clone()), p));
            }
            // Write legacy flat Vec<u64>.
            env.storage().persistent().set(&DataKey::ArtistListings(artist.clone()), listing_ids);
        });
    }

    /// Helper: convert the paged ActiveListings index back to a legacy flat Vec<u64>
    /// and remove all per-listing position keys. Simulates pre-1.1.0 for the
    /// global active-listings index.
    fn downgrade_to_legacy_active_listings(
        env: &Env,
        cid: &Address,
        listing_ids: &soroban_sdk::Vec<u64>,
    ) {
        env.as_contract(cid, || {
            // Remove paged entries.
            env.storage().persistent().remove(&DataKey::IndexLen(IndexId::ActiveListings));
            for p in 0u32..5 {
                env.storage().persistent().remove(&DataKey::IndexPage(IndexId::ActiveListings, p));
            }
            // Remove per-listing position keys.
            for lid in listing_ids.iter() {
                env.storage().persistent().remove(&DataKey::ActiveListingPos(lid));
            }
            // Write legacy flat Vec<u64>.
            env.storage().persistent().set(&DataKey::ActiveListings, listing_ids);
        });
    }

    /// Helper: convert the paged ListingOffers index for `listing_id` back to a
    /// legacy flat Vec<u64> under DataKey::ListingOffers. Also clears the
    /// ListingPendingOffers alias so the migration can rebuild it.
    fn downgrade_to_legacy_listing_offers(
        env: &Env,
        cid: &Address,
        listing_id: u64,
        offer_ids: &soroban_sdk::Vec<u64>,
    ) {
        env.as_contract(cid, || {
            env.storage().persistent().remove(&DataKey::IndexLen(IndexId::ListingOffers(listing_id)));
            for p in 0u32..5 {
                env.storage().persistent().remove(&DataKey::IndexPage(IndexId::ListingOffers(listing_id), p));
            }
            env.storage().persistent().remove(&DataKey::ListingPendingOffers(listing_id));
            env.storage().persistent().set(&DataKey::ListingOffers(listing_id), offer_ids);
        });
    }

    /// Helper: convert the paged OffererOffers index for `offerer` back to a
    /// legacy flat Vec<u64> under DataKey::OffererOffers.
    fn downgrade_to_legacy_offerer_offers(
        env: &Env,
        cid: &Address,
        offerer: &Address,
        offer_ids: &soroban_sdk::Vec<u64>,
    ) {
        env.as_contract(cid, || {
            env.storage().persistent().remove(&DataKey::IndexLen(IndexId::OffererOffers(offerer.clone())));
            for p in 0u32..5 {
                env.storage().persistent().remove(&DataKey::IndexPage(IndexId::OffererOffers(offerer.clone()), p));
            }
            env.storage().persistent().set(&DataKey::OffererOffers(offerer.clone()), offer_ids);
        });
    }

    #[test]
    fn legacy_artist_listings_migrated_to_paged_correctly() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 5);

        // Downgrade artist listings index to legacy format.
        downgrade_to_legacy_artist_listings(&env, &cid, &admin, &ids);

        // After downgrade, the paged index is empty; the legacy key holds the data.
        env.as_contract(&cid, || {
            assert_eq!(index_len(&env, &IndexId::ArtistListings(admin.clone())), 0,
                "paged index must be empty after downgrade");
            assert!(env.storage().persistent().has(&DataKey::ArtistListings(admin.clone())),
                "legacy key must exist after downgrade");
        });

        // Run migration — should drain legacy key into paged index.
        client.migrate(&admin);

        let indexed = client.get_artist_listings(&admin);
        assert_eq!(indexed.len(), 5, "all 5 listings must be in paged index after migration");
        for lid in ids.iter() {
            assert!(indexed.contains(&lid), "listing {} must be in artist index", lid);
        }
        // Legacy key must be gone.
        env.as_contract(&cid, || {
            assert!(!env.storage().persistent().has(&DataKey::ArtistListings(admin.clone())),
                "legacy ArtistListings key must be removed after migration");
        });
    }

    #[test]
    fn legacy_active_listings_migrated_to_paged_correctly() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 4);

        // Downgrade the active listings index to legacy format.
        downgrade_to_legacy_active_listings(&env, &cid, &ids);

        // Verify the downgrade.
        env.as_contract(&cid, || {
            assert_eq!(storage::active_listings_len(&env), 0, "paged ActiveListings must be empty after downgrade");
            assert!(env.storage().persistent().has(&DataKey::ActiveListings), "legacy key must exist");
        });

        client.migrate(&admin);

        // After phase 3, all 4 active listings must be in the paged index.
        assert_eq!(client.get_active_listings_count(), 4, "all 4 listings must be active after migration");
        let active = client.get_active_listings(&10u32, &0u32);
        for lid in ids.iter() {
            assert!(active.contains(&lid), "listing {} must be in ActiveListings index", lid);
        }
        // Legacy key must be gone.
        env.as_contract(&cid, || {
            assert!(!env.storage().persistent().has(&DataKey::ActiveListings),
                "legacy ActiveListings key must be removed");
        });
    }

    #[test]
    fn legacy_listing_offers_migrated_and_pending_alias_rebuilt() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );

        let buyer1 = Address::generate(&env);
        let buyer2 = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer1, &100_000_000_000_i128);
        StellarAssetClient::new(&env, &token).mint(&buyer2, &100_000_000_000_i128);
        let oid1 = client.make_offer(&buyer1, &lid, &5_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer2, &lid, &6_000_000_i128, &token, &None::<u64>);
        // Reject oid1 before downgrade — only oid2 should be pending after migration.
        client.reject_offer(&admin, &oid1);

        let mut offer_ids = soroban_sdk::Vec::new(&env);
        offer_ids.push_back(oid1);
        offer_ids.push_back(oid2);
        downgrade_to_legacy_listing_offers(&env, &cid, lid, &offer_ids);

        // After downgrade the pending alias is cleared and the paged offer index is empty.
        env.as_contract(&cid, || {
            assert_eq!(index_len(&env, &IndexId::ListingOffers(lid)), 0,
                "paged ListingOffers must be empty after downgrade");
            assert!(!env.storage().persistent().has(&DataKey::ListingPendingOffers(lid)),
                "pending alias must be cleared after downgrade");
        });

        client.migrate(&admin);

        // Both offer ids must appear in the paged ListingOffers history index.
        let offers = client.get_listing_offers(&lid);
        assert_eq!(offers.len(), 2, "both offer ids must be in ListingOffers after migration");
        assert!(offers.contains(&oid1));
        assert!(offers.contains(&oid2));

        // Only the Pending offer (oid2) must be in the pending alias.
        let pending_count = client.get_pending_offer_count(&lid);
        assert_eq!(pending_count, 1, "only 1 pending offer must be in alias after migration");
        let pending_ids = env.as_contract(&cid, || storage::load_pending_offer_ids(&env, lid));
        assert!(!pending_ids.contains(&oid1), "rejected offer must not be in pending alias");
        assert!(pending_ids.contains(&oid2), "pending offer must be in alias");
    }

    #[test]
    fn legacy_offerer_offers_migrated_correctly() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        let oid1 = client.make_offer(&buyer, &lid, &4_000_000_i128, &token, &None::<u64>);
        let oid2 = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);

        let mut offer_ids = soroban_sdk::Vec::new(&env);
        offer_ids.push_back(oid1);
        offer_ids.push_back(oid2);
        downgrade_to_legacy_offerer_offers(&env, &cid, &buyer, &offer_ids);

        // After downgrade the paged OffererOffers is empty.
        env.as_contract(&cid, || {
            assert_eq!(index_len(&env, &IndexId::OffererOffers(buyer.clone())), 0,
                "paged OffererOffers must be empty after downgrade");
        });

        client.migrate(&admin);

        let indexed = client.get_offerer_offers(&buyer);
        assert_eq!(indexed.len(), 2, "both offer ids must be in paged OffererOffers after migration");
        assert!(indexed.contains(&oid1));
        assert!(indexed.contains(&oid2));

        // Legacy key must be removed.
        env.as_contract(&cid, || {
            assert!(!env.storage().persistent().has(&DataKey::OffererOffers(buyer.clone())),
                "legacy OffererOffers key must be removed after migration");
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 19: Idempotency — no duplication when paged + legacy coexist
    //
    // Simulates the window between WASM upgrade and migration where a new
    // create_listing call writes to the paged index while legacy data still
    // exists for the same artist.
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn no_duplication_when_post_upgrade_write_precedes_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Create 2 listings (both land in the paged index via post-upgrade code).
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 2);

        // Downgrade listing 1's artist index to legacy — this simulates that
        // listing 1 existed in the old contract while listing 2 was created
        // after the WASM upgrade.  At this point:
        //   legacy key  = [1]     (the old listing)
        //   paged index = [1, 2]  (post-upgrade code wrote both)
        let mut legacy_ids = soroban_sdk::Vec::new(&env);
        legacy_ids.push_back(1u64);
        // Only partially downgrade: keep paged index but also add legacy key.
        // This is the unsafe window scenario.
        env.as_contract(&cid, || {
            env.storage().persistent().set(&DataKey::ArtistListings(admin.clone()), &legacy_ids);
        });

        client.migrate(&admin);

        // The idempotency guard in migrate_legacy_index must have skipped
        // listing_id=1 (already in paged index) so there must be no duplicate.
        let indexed = client.get_artist_listings(&admin);
        assert_eq!(indexed.len(), 2, "index must have exactly 2 entries, not 3");
        let count_1 = indexed.iter().filter(|x| *x == 1u64).count();
        let count_2 = indexed.iter().filter(|x| *x == 2u64).count();
        assert_eq!(count_1, 1, "listing 1 must appear exactly once");
        assert_eq!(count_2, 1, "listing 2 must appear exactly once");
    }

    #[test]
    fn no_duplication_in_pending_offers_when_post_upgrade_offer_precedes_migration() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        let oid = client.make_offer(&buyer, &lid, &5_000_000_i128, &token, &None::<u64>);

        // The paged ListingOffers already has oid; also inject it as legacy key
        // (simulates the post-upgrade window).
        let mut legacy_oids = soroban_sdk::Vec::new(&env);
        legacy_oids.push_back(oid);
        env.as_contract(&cid, || {
            env.storage().persistent().set(&DataKey::ListingOffers(lid), &legacy_oids);
            // Also clear pending alias to let migration rebuild it.
            env.storage().persistent().remove(&DataKey::ListingPendingOffers(lid));
        });

        client.migrate(&admin);

        // No duplication in ListingOffers paged index.
        let offers = client.get_listing_offers(&lid);
        let count = offers.iter().filter(|x| *x == oid).count();
        assert_eq!(count, 1, "offer must appear exactly once in ListingOffers index");

        // Pending alias must contain exactly one entry.
        let pending = client.get_pending_offer_count(&lid);
        assert_eq!(pending, 1, "pending alias must have exactly 1 entry");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 20: Phase boundary postcondition per-ID verification
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn phase0_postcondition_all_listing_ids_in_artist_index() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 8);

        // Downgrade to legacy format so phase 0 has real migration work.
        downgrade_to_legacy_artist_listings(&env, &cid, &admin, &ids);
        client.migrate(&admin);

        // After migration, verify every individual listing_id is in the index.
        let indexed = client.get_artist_listings(&admin);
        for lid in ids.iter() {
            let found = indexed.iter().any(|x| x == lid);
            assert!(found, "listing {} must be in ArtistListings index after migration", lid);
        }
    }

    #[test]
    fn phase1_postcondition_all_auction_ids_in_artist_index() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let auction_ids = create_n_auctions(&env, &client, &admin, &token, &col, 1, 6);

        // Downgrade artist auctions to legacy.
        env.as_contract(&cid, || {
            env.storage().persistent().remove(&DataKey::IndexLen(IndexId::ArtistAuctions(admin.clone())));
            for p in 0u32..5 {
                env.storage().persistent().remove(&DataKey::IndexPage(IndexId::ArtistAuctions(admin.clone()), p));
            }
            env.storage().persistent().set(&DataKey::ArtistAuctions(admin.clone()), &auction_ids);
        });

        client.migrate(&admin);

        let indexed = client.get_artist_auctions(&admin);
        for aid in auction_ids.iter() {
            assert!(indexed.iter().any(|x| x == aid), "auction {} must be in ArtistAuctions index", aid);
        }
        assert_eq!(indexed.len(), 6, "exactly 6 auctions must be indexed");
    }

    #[test]
    fn phase2_postcondition_all_offer_ids_in_offerer_index() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let nft = MockNftClient::new(&env, &col);
        nft.set_owner(&1u64, &admin);
        let lid = client.create_listing(
            &admin,
            &10_000_000_i128,
            &symbol_short!("XLM"),
            &token,
            &col,
            &1u64,
            &1u64,
            &valid_recipients(&env, &admin),
            &None::<u64>,
        );
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);

        let mut created_oids = soroban_sdk::Vec::new(&env);
        for amt in 1..=6u64 {
            let oid = client.make_offer(&buyer, &lid, &(1_000_000_i128 + amt as i128), &token, &None::<u64>);
            created_oids.push_back(oid);
        }

        // Downgrade OffererOffers to legacy.
        downgrade_to_legacy_offerer_offers(&env, &cid, &buyer, &created_oids);

        client.migrate(&admin);

        let indexed = client.get_offerer_offers(&buyer);
        for oid in created_oids.iter() {
            assert!(indexed.iter().any(|x| x == oid), "offer {} must be in OffererOffers index", oid);
        }
        assert_eq!(indexed.len(), 6, "exactly 6 offers must be indexed");
    }

    #[test]
    fn phase3_postcondition_pos_keys_present_for_all_active_listings() {
        let (env, client, admin, token, col, cid) = migration_setup();
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 5);
        // Cancel one.
        client.cancel_listing(&admin, &3u64);

        downgrade_to_legacy_active_listings(&env, &cid, &ids);
        client.migrate(&admin);

        // Verify pos keys exist for active listings only.
        env.as_contract(&cid, || {
            for lid in [1u64, 2u64, 4u64, 5u64].iter() {
                assert!(
                    env.storage().persistent().has(&DataKey::ActiveListingPos(*lid)),
                    "active listing {} must have pos key",
                    lid
                );
            }
            // Cancelled listing must NOT have a pos key.
            assert!(
                !env.storage().persistent().has(&DataKey::ActiveListingPos(3u64)),
                "cancelled listing must not have stale pos key"
            );
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 21: validate_migration_consistency operator entry point
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn validate_migration_consistency_returns_true_on_clean_state() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 5);
        client.migrate(&admin);

        let ok = client.validate_migration_consistency(&admin, &0u64, &10u32);
        assert!(ok, "consistency check must return true on a clean migrated state");
    }

    #[test]
    fn validate_migration_consistency_detects_missing_pos_key() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        client.migrate(&admin);

        // Manually remove a pos key to simulate drift.
        env.as_contract(&cid, || {
            env.storage().persistent().remove(&DataKey::ActiveListingPos(2u64));
        });

        let ok = client.validate_migration_consistency(&admin, &0u64, &10u32);
        assert!(!ok, "consistency check must return false when a pos key is missing");
    }

    #[test]
    fn validate_migration_consistency_detects_stale_pos_key_on_terminal_listing() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        client.cancel_listing(&admin, &2u64);
        client.migrate(&admin);

        // Manually inject a stale pos key for the cancelled listing.
        env.as_contract(&cid, || {
            env.storage().persistent().set(&DataKey::ActiveListingPos(2u64), &99u32);
        });

        let ok = client.validate_migration_consistency(&admin, &0u64, &10u32);
        assert!(!ok, "consistency check must return false when a cancelled listing has a stale pos key");
    }

    #[test]
    fn validate_migration_consistency_cursor_pagination_works() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 8);
        client.migrate(&admin);

        // Run in pages of 3.
        let r1 = client.validate_migration_consistency(&admin, &0u64, &3u32);
        let r2 = client.validate_migration_consistency(&admin, &3u64, &3u32);
        let r3 = client.validate_migration_consistency(&admin, &6u64, &5u32);
        assert!(r1 && r2 && r3, "all three pages must report consistent state");
    }

    #[test]
    fn validate_migration_consistency_zero_max_items_returns_true() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        client.migrate(&admin);
        // max_items = 0 → nothing is checked → trivially consistent.
        let ok = client.validate_migration_consistency(&admin, &0u64, &0u32);
        assert!(ok, "zero max_items must return true (no checks performed)");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SECTION 22: Maintenance subsystem invariants
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn extend_active_ttls_never_touches_terminal_listing_records() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 4);
        // Sell listing 2 and cancel listing 4.
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        client.buy_artwork(&buyer, &2u64);
        client.cancel_listing(&admin, &4u64);

        // Verify terminal listings are not in the active index (pre-condition).
        env.as_contract(&cid, || {
            assert!(!env.storage().persistent().has(&DataKey::ActiveListingPos(2u64)),
                "sold listing must not have pos key");
            assert!(!env.storage().persistent().has(&DataKey::ActiveListingPos(4u64)),
                "cancelled listing must not have pos key");
        });

        let processed = client.extend_active_ttls(&admin, &100u32);
        // Only 2 active listings remain; sweep must never count terminal ones.
        // The sweep may run up to 2 passes × 2 active listings = 4 max.
        assert!(processed <= 4, "processed {} — must not exceed 2 active listings × 2 passes", processed);
    }

    #[test]
    fn cleanup_expired_locks_no_op_for_all_terminal_record_types() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 3);
        let buyer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&buyer, &100_000_000_000_i128);
        // Sell one, cancel one.
        client.buy_artwork(&buyer, &1u64);
        client.cancel_listing(&admin, &2u64);

        // No locks are held; cleanup must return 0 for all terminal and active records.
        let ids = soroban_sdk::vec![&env, 1u64, 2u64, 3u64];
        let cleared = client.cleanup_expired_locks(&admin, &ids, &soroban_sdk::Vec::new(&env));
        assert_eq!(cleared, 0, "no locks were acquired so cleanup must be a no-op");
    }

    #[test]
    fn cleanup_expired_locks_combined_listing_and_auction_budget_cap() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Build lists of 80 listing ids + 80 auction ids = 160 total.
        // The combined budget is capped at MAX_MAINTENANCE_ITEMS (100).
        let mut listing_ids = soroban_sdk::Vec::new(&env);
        let mut auction_ids = soroban_sdk::Vec::new(&env);
        for i in 1u64..=80 {
            listing_ids.push_back(i);
            auction_ids.push_back(i);
        }
        // Should not panic; returns 0 since no locks are held.
        let cleared = client.cleanup_expired_locks(&admin, &listing_ids, &auction_ids);
        assert_eq!(cleared, 0, "no locks to clear; result must be 0 regardless of input size");
    }

    #[test]
    fn extend_active_ttls_sweep_resumes_from_saved_cursor() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 6);

        // First call processes 3 items; cursor saved.
        let first = client.extend_active_ttls(&admin, &3u32);
        // Second call must resume and cover the remaining items.
        let second = client.extend_active_ttls(&admin, &3u32);
        // Together they must cover all 6 active listings at least once.
        assert!(
            first + second >= 6,
            "two calls with budget 3 each must together cover all 6 active listings"
        );
    }

    #[test]
    fn migration_then_consistency_check_clean_for_large_dataset() {
        let (env, client, admin, token, col, cid) = migration_setup();
        create_n_listings(&env, &client, &admin, &token, &col, 50);
        client.cancel_listing(&admin, &10u64);
        client.cancel_listing(&admin, &25u64);
        client.cancel_listing(&admin, &40u64);
        client.migrate(&admin);

        // Run consistency check in bounded pages; all must pass.
        let mut cursor = 0u64;
        let page_size = 20u32;
        while cursor < 50 {
            let ok = client.validate_migration_consistency(&admin, &cursor, &page_size);
            assert!(ok, "consistency check must pass at cursor {}", cursor);
            cursor += page_size as u64;
        }
    }

    #[test]
    fn legacy_multi_page_artist_listings_migrated_correctly() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // 105 listings spans two index pages (PAGE_SIZE=100).
        let ids = create_n_listings(&env, &client, &admin, &token, &col, 105);

        downgrade_to_legacy_artist_listings(&env, &cid, &admin, &ids);

        // Verify downgrade cleared both pages.
        env.as_contract(&cid, || {
            assert_eq!(index_len(&env, &IndexId::ArtistListings(admin.clone())), 0,
                "all paged pages must be empty after downgrade");
        });

        let mut remaining = u64::MAX;
        while remaining > 0 {
            remaining = client.migrate_step(&admin, &20u32);
        }

        let indexed = client.get_artist_listings(&admin);
        assert_eq!(indexed.len(), 105, "all 105 listings must be in paged index after migration");
        // Verify uniqueness.
        for lid in ids.iter() {
            let count = indexed.iter().filter(|x| *x == lid).count();
            assert_eq!(count, 1, "listing {} must appear exactly once", lid);
        }
    }

    #[test]
    fn cleanup_expired_locks_respects_budget_when_both_lists_supplied() {
        let (env, client, admin, token, col, cid) = migration_setup();
        // Supply 60 listing ids + 60 auction ids (120 total > MAX_MAINTENANCE_ITEMS=100).
        // None have locks; all should be processed up to the cap without panic.
        let mut listing_ids = soroban_sdk::Vec::new(&env);
        let mut auction_ids = soroban_sdk::Vec::new(&env);
        for i in 1u64..=60 {
            listing_ids.push_back(i);
            auction_ids.push_back(i);
        }
        // The call must return 0 (no locks held) and never panic.
        let cleared = client.cleanup_expired_locks(&admin, &listing_ids, &auction_ids);
        assert_eq!(cleared, 0);
    }
