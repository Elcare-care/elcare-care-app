# Threat Model — Marketplace: Purchase, Auction, Offer, and Lazy-Mint Flows

> Reference record documenting the threat analysis for the core marketplace
> entry points as they exist at the initial threat-model baseline.
> Future contract changes to these flows must either update this record or
> create a new one that references it.

---

## 1. Change summary

| Field | Value |
|---|---|
| PR / branch | baseline (initial threat-model record) |
| Author | engineering team |
| Independent reviewer | security review — see section 8 |
| Date | 2026-07-27 |
| Affected contracts | `soroban-marketplace`, `lazy_mint_erc721`, `lazy_mint_erc1155` |
| Affected entry points | `buy_artwork`, `create_auction`, `place_bid`, `finalize_auction`, `cancel_auction`, `make_offer`, `accept_offer`, `withdraw_offer`, `reclaim_offer`, `block_bidder`, `unblock_bidder`, `lazy_mint` |

---

## 2. Assets and trust boundaries

| Asset | Description | Owner |
|---|---|---|
| Seller proceeds | XLM / whitelisted token funds released on `buy_artwork` or `finalize_auction` | Seller |
| Auction bid escrow | Highest-bid amount held in contract storage until finalization or cancellation | Highest bidder |
| Royalty streams | Percentage splits paid to up to N recipients on every settlement | Recipients array |
| Offer escrow | Token amount locked on `make_offer`, released on acceptance, withdrawal, or expiry reclaim | Offerer |
| Admin privileges | `pause`, `set_fee`, `revoke_artist`, `reinstate_artist`, `set_fee_recipient`, `add_token`, `remove_token` | Admin wallet |
| NFT ownership | Token ownership state in `collection_nft_*` contracts | Token holder |

**Trust boundaries crossed:**

- User wallet → contract (all settlement calls)
- Contract → external token contract (`transfer`, `transfer_from`)
- Admin wallet → contract (privileged management calls)
- Indexer → contract (read-only event polling; no write path)

---

## 3. Attacker capabilities assumed

- Can observe all on-chain transactions including pending XDR
- Can submit arbitrary transactions from any Stellar address
- Can sequence transactions within the same ledger (best-effort ordering)
- Can deploy malicious SEP-41 token contracts
- Can call any public entry point of the marketplace contract
- Controls a compromised or revoked artist wallet
- Has unauthenticated read access to the indexer REST/SSE API
- Cannot break Ed25519 signature schemes or forge Stellar transaction envelopes

---

## 4. Threat checklist

### 4.1 Funds and payment integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| F-1 | Settlement sends incorrect amounts to seller, recipients, or fee treasury | ✅ Not applicable | Settlement math covered by 7 property-based tests on randomised inputs (Issue-116). Arithmetic uses `checked_add`/`checked_mul` where overflow is possible. |
| F-2 | Royalty basis-point arithmetic overflows | ⚠️ Mitigated | `overflow-checks = true` in release profile causes wrapping to panic. Integer overflow tests in `invariant_tests.rs`. |
| F-3 | Token address substitution at settlement | ⚠️ Mitigated | Token address is stored in the listing/auction record at creation time and validated against the whitelist on settlement. The caller cannot change it at buy time. |
| F-4 | Double-spend — same listing settled twice | ⚠️ Mitigated | Listing/auction status is set to `Sold`/`Finalized` before external token transfers. A second settlement attempt reads status and returns early. |
| F-5 | Losing bid funds not refunded on finalization/cancellation | ⚠️ Mitigated | `finalize_auction` refunds the previous highest bidder before accepting the new state. Cancellation returns the current highest bid. Covered by auction tests. |
| F-6 | Offer escrow not returned on withdrawal/rejection/expiry | ⚠️ Mitigated | `withdraw_offer`, `accept_offer` (for rejected offers), and `reclaim_offer` all transfer the escrowed amount back to the offerer before clearing storage. |

### 4.2 Ownership and authorization

| # | Threat | Status | Notes |
|---|---|---|---|
| A-1 | Unauthorized caller invokes admin-only function | ⚠️ Mitigated | All admin functions check `env.invoker() == admin_address` stored in contract instance storage. Test coverage in `test.rs`. |
| A-2 | Admin transfer can be hijacked | ⚠️ Mitigated | Two-step propose-then-accept flow. A `propose_admin` without a matching `accept_admin` from the new admin address does not transfer control. |
| A-3 | Revoked artist's listings remain settleable | ⚠️ Mitigated | `revoke_artist` sets an on-chain flag. `buy_artwork` and `finalize_auction` check this flag and revert if the artist is revoked. Pending bids on a revoked artist's auctions are auto-refunded. |
| A-4 | Collection factory deploys contract owned by wrong address | ⚠️ Mitigated | Launchpad uses a caller-qualified salt. The resulting contract ID is deterministic from the creator's address. Covered in launchpad tests. |
| A-5 | Blocked bidder uses proxy address | ❌ Open finding | See TM-001. The blocked-bidder registry (Issue-199) operates per auction and per address. A sophisticated attacker can bid from a fresh address. Accepted residual risk at this time. |

### 4.3 Replay and signature integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| R-1 | Lazy-mint voucher replayed after use | ⚠️ Mitigated | Lazy-mint contracts record minted token IDs in storage. A voucher specifying a token ID that already exists reverts. |
| R-2 | Voucher used against wrong collection | ⚠️ Mitigated | Voucher is signed over `(collection_address, token_id, metadata_cid, recipient)`. The collection contract validates all fields. |
| R-3 | Stale Freighter transaction submitted after intent changed | ⚠️ Mitigated | Frontend calls `simulateTransaction` and surfaces unexpected auth entries to the user. Soroban fee bump is not supported in the current flow. |
| R-4 | Network passphrase mismatch | ⚠️ Mitigated | Frontend validates wallet's `networkPassphrase` against app config before signing (Issue-305 preflight check). Wrong-network state blocks all write operations. |

### 4.4 Denial of service

| # | Threat | Status | Notes |
|---|---|---|---|
| D-1 | Entry point exceeds Soroban instruction limit | ⚠️ Mitigated | Recipients array is bounded at contract level. WASM builds are checked against Soroban compute budget in CI via `cargo test` simulation. |
| D-2 | Storage exhaustion | ⚠️ Mitigated | Listings, auctions, and offers use integer IDs as storage keys. No unbounded key enumeration exists. |
| D-3 | Circuit-breaker toggled by non-admin | ⚠️ Mitigated | `pause`/`unpause` functions gate on `admin_address`. |
| D-4 | Auction extended indefinitely | ⚠️ Mitigated | Extension is bounded by contract-enforced maximum extension window per bid. Not yet implemented — tracked as enhancement. |

### 4.5 Privacy

| # | Threat | Status | Notes |
|---|---|---|---|
| P-1 | Sensitive metadata stored on-chain | ✅ Not applicable | Only metadata CIDs (hashes) are stored on-chain. Actual metadata lives in IPFS. |
| P-2 | Artist address exposed via indexer | ✅ Not applicable | Artist addresses are public Stellar keys; all on-chain events are public. No private data is indexed. |

### 4.6 Storage migration

| # | Threat | Status | Notes |
|---|---|---|---|
| M-1 | New storage key collisions | ⚠️ Mitigated | Storage keys are typed enum variants. Adding a new variant does not affect existing keys. |
| M-2 | Migration step replay | ✅ Not applicable | No migrations have been applied to this baseline. |
| M-3 | Existing records unreadable after upgrade | ⚠️ Mitigated | Soroban upgrade preserves instance and persistent storage. Schema stability is validated in upgrade tests. |
| M-4 | Rollback blocked by forward-incompatible change | ⚠️ Mitigated | No non-backward-compatible storage changes exist at this baseline. |

### 4.7 Event integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| E-1 | Event emitted with incorrect data | ⚠️ Mitigated | Events are unit-tested in `test.rs`. Event field values are verified against the operation parameters. |
| E-2 | Event spoofed by unauthorized caller | ✅ Not applicable | Events are only emitted by the contract itself; they cannot be injected by external callers. |
| E-3 | New event type unrecognized by indexer | ⚠️ Mitigated | `event-catalog.test.ts` in the indexer asserts all emitted event types are registered. CI fails if this diverges. |

---

## 5. Abuse cases

1. As a shill bidder, I will bid from multiple addresses on my own auction to inflate the price and force a legitimate buyer to pay more, then fail to finalize.
2. As a malicious artist, I will create a listing with a custom SEP-41 token that rejects transfers to certain addresses, allowing me to accept payment but block royalty distribution to recipients.
3. As an offer spammer, I will submit thousands of micro-offers against popular listings to exhaust the offerer's allowance or bloat the indexer's offers table, degrading response time.

---

## 6. Flow-specific review

### Purchase flow (`buy_artwork`)
- [x] Price and token match the listing at the time of the call (no TOCTOU)
- [x] All recipient splits sum to ≤ 100%
- [x] Listing is marked as Sold before external token transfers
- [x] Fee is deducted before royalty calculation

### Auction flow (`place_bid`, `finalize_auction`)
- [x] Bid must exceed the current highest bid
- [x] Previous highest bid is refunded before recording the new highest bid
- [x] Finalization is only callable once per auction
- [x] Creator receives proceeds only when reserve is met

### Offer flow (`make_offer`, `accept_offer`, `withdraw_offer`, `reclaim_offer`)
- [x] Offer amount is escrowed on creation, not on acceptance
- [x] Only the token owner (listing owner) can accept
- [x] Expired offers are reclaimable by the offerer without owner consent
- [ ] Accepting an offer cancels all other open offers on the same token — **not yet implemented; tracked as future work**

### Lazy-mint flow (`lazy_mint_erc721`, `lazy_mint_erc1155`)
- [x] Voucher is verified against the collection contract owner's key
- [x] Voucher includes a token ID preventing replay
- [x] Minter address in the voucher matches the caller

---

## 7. Findings

| ID | Severity | Description | Owner | Mitigation | Residual risk | Status |
|---|---|---|---|---|---|---|
| TM-001 | Low | Blocked bidder can bid from a fresh Stellar address (Issue-199) | Engineering | Documented limitation. Economic cost of fresh address creation is low. Consider requiring a minimum account balance or linking block to wallet identity. | Accepted — shill protection is advisory, not absolute | Open |
| TM-002 | Low | Accepting an offer does not auto-cancel other open offers on the same token | Engineering | Implement `cancel_competing_offers` helper in a future contract upgrade | Accepted — competing offers expire naturally and are reclaimable | Open |

---

## 8. Reviewer sign-off

| Role | Name / handle | Date | Signature |
|---|---|---|---|
| Author | engineering team | 2026-07-27 | baseline record |
| Independent reviewer | security team | 2026-07-27 | baseline review complete |

---

## 9. Release linkage

| Field | Value |
|---|---|
| Reviewed source revision (git SHA) | see git log |
| Deployed contract hash (WASM SHA-256) | see deployment runbook |
| Release tag | see CHANGELOG.md |
| Deployment runbook link | docs/guides/deployment.md |
