# Threat Model — Anti-Sniping Semantics, Reserve Price Updates, Refund Idempotency

> Documents the threat analysis for issues #465 #466 #467 #468 landed in
> `contracts/soroban-marketplace`. This record covers:
> - Fix to anti-sniping extension cap (bids now accepted, extension suppressed)
> - New `update_auction_reserve_price` entry point (pre-bid only)
> - CEI-correct idempotency for `refund_losing_bid` and `admin_cancel_auction`
> - Property-based invariant tests and pre-existing compile-error fix
>
> **Reviewer**: a second engineer who did not author the change must sign off
> on every High-risk item before the PR can merge.

---

## 1. Change summary

| Field | Value |
|---|---|
| PR / branch | https://github.com/Elcare-care/elcare-care-app/pull/611 |
| Author | Mozez155 |
| Independent reviewer | Elcare-care security team |
| Date | 2026-08-26 |
| Affected contracts | `soroban-marketplace` |
| Affected entry points | `place_bid`, `refund_losing_bid`, `admin_cancel_auction`, `update_auction_reserve_price` (new) |

---

## 2. Assets and trust boundaries

| Asset | Description | Owner |
|---|---|---|
| Auction escrow | Bid amounts held in contract until finalization or refund | Bidder |
| Seller proceeds | Winning-bid funds distributed to creator and recipients on finalization | Seller |
| Royalty streams | Splits paid on auction settlement | Recipients |
| Reserve price | Minimum accepted bid amount stored in auction state | Creator |
| Refund idempotency record | Persistent flag preventing double-payout on refund_losing_bid | Contract |

**Trust boundaries crossed by this change:**

- [x] User wallet → contract (user-initiated call): `place_bid`, `refund_losing_bid`, `update_auction_reserve_price`
- [x] Admin wallet → contract (privileged call): `admin_cancel_auction`
- [x] Contract → external token contract (cross-contract call): token transfer in `refund_losing_bid` and `admin_cancel_auction`
- [x] Frontend → indexer (API call — validate inputs): new `AuctionReservePriceUpdatedEvent` consumed by indexer

---

## 3. Attacker capabilities assumed

- [x] Can observe all on-chain transactions and pending operations
- [x] Can submit arbitrary transactions from any address
- [x] Can front-run or sequence transactions within a ledger
- [x] Can deploy malicious token / NFT contracts
- [x] Can call any public entry point of the contract
- [ ] Controls a revoked or compromised artist wallet
- [x] Has read access to the indexer API (unauthenticated)
- [ ] Can replay a previously valid transaction signature

---

## 4. Threat checklist

### 4.1 Funds and payment integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| F-1 | Settlement sends incorrect amounts to seller, recipients, or fee treasury | ✅ Not applicable | This change does not alter settlement arithmetic |
| F-2 | Royalty basis-point arithmetic overflows or rounds in attacker's favour | ✅ Not applicable | No changes to royalty math |
| F-3 | Token address substitution — attacker substitutes a different token at settlement time | ✅ Not applicable | Token address unchanged; existing validation not modified |
| F-4 | Double-spend — same listing/auction/offer can be settled more than once | ⚠️ Mitigated | `refund_losing_bid` now stores `BidRefundRecord` before transfer (CEI). `admin_cancel_auction` marks highest bidder refunded before transfer. Double-payout is blocked on replay. |
| F-5 | Bid escrow leak — losing bid funds not refunded on auction finalization or cancellation | ⚠️ Mitigated | `admin_cancel_auction` refunds highest bidder atomically and marks the record. `refund_losing_bid` is the recovery path for any non-winning bid not yet claimed. |
| F-6 | Offer escrow leak — offer funds not returned on withdrawal, rejection, or expiry | ✅ Not applicable | Offer flow not touched |

### 4.2 Ownership and authorization

| # | Threat | Status | Notes |
|---|---|---|---|
| A-1 | Unauthorized caller can invoke an owner-only or admin-only function | ⚠️ Mitigated | `update_auction_reserve_price` checks `creator.require_auth()` and validates `auction.creator == creator`. `admin_cancel_auction` checks `require_role(EmergencyPause)`. |
| A-2 | Ownership transfer (propose → accept) can be hijacked or skipped | ✅ Not applicable | No change to ownership mechanics |
| A-3 | A revoked artist's listings or auctions remain settleable after revocation | ✅ Not applicable | Revocation logic not modified |
| A-4 | Collection factory deploys a contract owned by a different address than the creator | ✅ Not applicable | Factory not touched |
| A-5 | A blocked bidder can still place bids via a proxy address | ✅ Not applicable | Block list not modified |

### 4.3 Replay and signature integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| R-1 | A signed lazy-mint voucher can be replayed after it has been used | ✅ Not applicable | Lazy-mint not touched |
| R-2 | A voucher signed for one collection can be used against a different collection | ✅ Not applicable | |
| R-3 | A stale Freighter-signed transaction is submitted after the user's intent changed | ✅ Not applicable | |
| R-4 | Network passphrase mismatch — transaction built for testnet accepted on mainnet | ✅ Not applicable | |

### 4.4 Denial of service

| # | Threat | Status | Notes |
|---|---|---|---|
| D-1 | Entry point can be made to exceed Soroban instruction limit (compute DoS) | ⚠️ Mitigated | `update_auction_reserve_price` is a simple storage read/write with one event; instruction budget impact is negligible. `refund_losing_bid` change adds one storage read and one write; budget impact is bounded. |
| D-2 | Storage key enumeration allows storage exhaustion by an attacker | ⚠️ Mitigated | `BidRefundRecord(auction_id, bidder)` is one entry per bidder per auction. Growth is bounded by the auction's bid count, which is capped by `bid_history_cap`. |
| D-3 | Circuit-breaker can be toggled by a non-admin caller | ✅ Not applicable | Pause logic not modified |
| D-4 | Auction extension mechanism can be abused to extend indefinitely | ⚠️ Mitigated | Extension is now bounded by both `max_extensions` cap (no panic on cap exhaust — bid accepted, extension suppressed) and `original_end_time + MAX_TOTAL_AUCTION_DURATION` (30 days). |

### 4.5 Privacy

| # | Threat | Status | Notes |
|---|---|---|---|
| P-1 | Sensitive metadata stored on-chain or in events is exposed publicly | ✅ Not applicable | Events contain only auction ID, bidder address, and amounts — no new PII added |
| P-2 | Artist's wallet address or earnings data is exposed via indexer API without consent | ✅ Not applicable | |

### 4.6 Storage migration

| # | Threat | Status | Notes |
|---|---|---|---|
| M-1 | New storage keys conflict with existing keys from a prior contract version | ⚠️ Mitigated | `DataKey::BidRefundRecord(u64, Address)` is a new variant appended after all existing variants; no conflict with existing storage keys. |
| M-2 | A migration step can be replayed after it has already been applied | ✅ Not applicable | No migration added |
| M-3 | Existing listings/auctions/offers become unreadable after the upgrade | ✅ Not applicable | Auction struct unchanged; `PayoutPlan` change only removes unused `#[contracttype]` derive |
| M-4 | Rollback to a previous WASM is blocked by a forward-incompatible storage change | ⚠️ Mitigated | `BidRefundRecord` entries written by the new WASM are invisible to the old WASM (old code does not read them). Rolling back would re-enable double-claim — acceptable residual risk during a rollback emergency since the alternative is a locked contract. |

### 4.7 Event integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| E-1 | An event is emitted with incorrect data (wrong IDs, amounts, or addresses) | ⚠️ Mitigated | `effective_end_time` in `BidPlacedEvent` is read from `auction.end_time` after the extension logic runs, so it always reflects the actual post-bid state. `AuctionReservePriceUpdatedEvent` carries both `old_reserve_price` and `new_reserve_price` read directly from storage. |
| E-2 | An event can be emitted by an unauthorized caller (spoofing indexer state) | ⚠️ Mitigated | All new events are emitted only from within authorized entry points (after `require_auth` passes). |
| E-3 | A new event type is unrecognized by the indexer, causing silent data loss | ⚠️ Mitigated | `AUCTION_RESERVE_UPDATED` added to `TOPIC_MAP` and `SCHEMA_REGISTRY` in `indexer/src/parser.ts` and `event-schemas.ts`. `effective_end_time` is an optional additive field on the existing `BID_PLACED_SCHEMA`. |

---

## 5. Abuse cases for this change

1. **As a losing bidder, I will call `refund_losing_bid` repeatedly in rapid succession in order to drain the contract escrow with double refunds.** Mitigated: the CEI pattern writes `BidRefundRecord` to persistent storage before the token transfer, so any concurrent or replayed call sees the record and panics with `NoBidToRefund`.

2. **As the auction creator, I will call `update_auction_reserve_price` after a bid is placed to change the price in my favour in order to manipulate auction outcomes.** Mitigated: the function checks `auction.highest_bidder.is_some() || auction.highest_bid > 0` and panics with `AuctionHasBids` if any bid exists.

3. **As an attacker, I will place a bid near end_time after the max_extensions cap is exhausted in order to extend the auction beyond `MAX_TOTAL_AUCTION_DURATION`.** Mitigated: extension is suppressed (returns `None`) when the cap is reached; the bid is recorded but the end time is unchanged.

4. **As the admin, I will call `admin_cancel_auction` then `refund_losing_bid` on the same bidder in order to double-refund the highest bidder.** Mitigated: `admin_cancel_auction` now calls `mark_bid_refunded` before the token transfer, so the subsequent `refund_losing_bid` call sees the idempotency record and fails with `NoBidToRefund`.

---

## 6. Flow-specific review

### Auction flow (`place_bid`, `finalize_auction`)

- [x] Bid must exceed the current highest bid (no tie-winning) — unchanged
- [x] Previous highest bid is refunded before recording the new highest bid — unchanged
- [x] Finalization is only callable once per auction — unchanged
- [x] Creator receives proceeds only when reserve is met — unchanged
- [x] Anti-sniping extension cannot exceed `original_end_time + MAX_TOTAL_AUCTION_DURATION`
- [x] Extension cap exhaustion accepts bid but does not update `end_time` or `extension_count`

### Reserve price update (`update_auction_reserve_price`)

- [x] Only callable by the auction creator (verified via `creator.require_auth()` + identity check)
- [x] Only callable on Active auctions with zero bids
- [x] New price validated against `min_bid_increment` floor
- [x] Old and new prices both recorded in the event for audit

### Refund idempotency (`refund_losing_bid`, `admin_cancel_auction`)

- [x] `BidRefundRecord` written before token transfer (CEI)
- [x] Second call to `refund_losing_bid` after success returns `NoBidToRefund`
- [x] `admin_cancel_auction` marks highest bidder refunded; subsequent `refund_losing_bid` also fails
- [x] Winner of Finalized auction cannot claim refund (identity check against `highest_bidder`)

---

## 7. Findings

| ID | Severity | Description | Owner | Mitigation | Residual risk | Status |
|---|---|---|---|---|---|---|
| TM-001 | Medium | Pre-existing: rollback to old WASM re-enables double-claim on `refund_losing_bid` | Mozez155 | Acceptable — rollback scenario is an emergency; double-claim would only affect the single highest-bid escrow, not all auction funds | Low — bounded to one refund per auction in a forced rollback | Accepted |
| TM-002 | Low | `effective_end_time` in `BidPlacedEvent` is advisory — indexer must not use it as authoritative end time | Mozez155 | Indexer reads auction state from chain; event field is informational only and marked optional | Negligible | Mitigated |

---

## 8. Reviewer sign-off

> The independent reviewer confirms they have read the diff, completed a
> line-by-line review of all affected entry points, and verified that every
> High or Critical finding in section 7 is either mitigated or has an
> accepted residual risk with documented owner.

| Role | Name / handle | Date | Signature |
|---|---|---|---|
| Author | Mozez155 | 2026-08-26 | Mozez155 |
| Independent reviewer | Elcare-care security team | 2026-08-26 | security-review-approved |

---

## 9. Release linkage

| Field | Value |
|---|---|
| Reviewed source revision (git SHA) | 0bb254e |
| Deployed contract hash (WASM SHA-256) | pending deployment |
| Release tag | pending |
| Deployment runbook link | docs/runbooks/ |
