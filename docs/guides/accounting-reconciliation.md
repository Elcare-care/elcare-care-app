# On-Chain Accounting Reconciliation

Issue #279. This guide explains the on-chain accounting counters added to the
marketplace contract, the rounding rules that govern them, their immutability
guarantees, and how the indexer reconciles its own off-chain aggregation
against them.

---

## 1. Why

The marketplace emits settlement events (`protocol_fee_collected`,
`royalty_settlement`, ...) but, before this change, the only way to compute
"how much protocol fee has this token collected in total" or "how many
successful settlements happened" was to replay and sum every event off-chain.
That makes disputes hard to resolve — an indexing bug, a dropped event, or a
rounding mistake in aggregation is indistinguishable from a real discrepancy
unless there is a canonical on-chain number to check against.

This change adds that canonical number: three lifetime counters, kept in
contract storage, queryable via read-only view functions.

---

## 2. The counters

Defined in `contracts/soroban-marketplace/src/storage.rs` (`DataKey` variants
`ProtocolFeeTotal`, `RoyaltyTotal`, `SettlementCount`) and exposed as
read-only contract methods in `contract.rs`:

| View function | Keyed by | Meaning |
|---|---|---|
| `get_protocol_fee_total(token)` | payment token address | Lifetime sum of protocol fee `amount` collected in that token — identical to summing every `ProtocolFeeCollectedEvent.amount` for that token. |
| `get_royalty_total(token)` | payment token address | Lifetime sum of the gross settlement value (`total_amount`) across every successful settlement in that token — identical to summing every `RoyaltySettlementEvent.total_amount` for that token. |
| `get_settlement_count(token)` | payment token address | Lifetime count of successful settlements (purchase, auction-finalize-with-a-winner, offer-accept) in that token — one increment per `RoyaltySettlementEvent` emission. |

None of these functions require `require_auth` — they are plain storage
reads, safe for any caller (operators, creators, indexers, block explorers)
to invoke without a signed transaction.

### Why per-token, not per-recipient

`RoyaltyTotal` is a single lifetime aggregate per payment token, not broken
down per recipient. A per-recipient breakdown would add one new storage
entry (with its own TTL bookkeeping) for every distinct recipient address
that has ever received a payout — unbounded growth with no natural cap, for
a marketplace where recipient lists are creator-controlled and effectively
open-ended. The existing `RoyaltySettlementEvent` snapshot already carries
the full per-recipient split (`recipients: Vec<Recipient>`) for every
settlement, so anyone who needs recipient-level detail can reconstruct it by
replaying events; the on-chain counter intentionally stays a cheap,
storage-bounded per-token total.

### Why lifetime/monotonic, not resettable or period-scoped

The counters are **lifetime totals: they only ever increase, are never
reset, and are never decremented.** This is the simplest policy, and it is
the hardest to game — a resettable or period-scoped counter (e.g. "fees this
epoch") introduces a second axis of state (who can reset it, when does a
period roll over, what happens to in-flight transactions at the boundary)
that a lifetime monotonic counter avoids entirely. There is no existing
precedent elsewhere in this contract for period-scoped accounting state
(the closest analogues — `ListingCount`, `AuctionCount`, `OfferCount` — are
themselves lifetime, ever-incrementing counters), so this design is
consistent with the rest of the codebase.

If a caller wants a windowed view (e.g. "fees collected this month"), that is
an off-chain aggregation over the *events*, not something the on-chain
counters attempt to provide. Operators can always compute
`get_protocol_fee_total(token)` at two points in time and subtract to get the
delta over that window.

---

## 3. When counters are updated (and why failures can't corrupt them)

Soroban contract invocations are atomic: a panic anywhere in the call rolls
back every storage write and token transfer performed earlier in the same
invocation. The counter-increment calls
(`storage::add_protocol_fee_total`, `storage::add_royalty_total`,
`storage::increment_settlement_count`) are placed in `contract.rs` **after**
`distribute_payout` has already executed all of its token transfers,
directly alongside the existing `ProtocolFeeCollectedEvent` /
`RoyaltySettlementEvent` emissions, in all three settlement paths:

- `buy_artwork` (fixed-price listing purchase)
- `finalize_auction` (only on the winning-bidder branch — a no-bid finalize
  does not touch these counters)
- `accept_offer`

Because of atomicity, if any transfer within `distribute_payout` fails (bad
token contract, insufficient balance, etc.) the whole transaction reverts,
including the counter bump — the counters can never reflect a settlement
that didn't actually happen. This satisfies acceptance criterion #2 ("failed
or reverted settlements do not increment accounting state") without any
extra bookkeeping: it falls directly out of the existing CEI-atomic
transaction design already used throughout the contract.

---

## 4. Rounding

`distribute_payout` (in `contract.rs`) computes each recipient's share as
`payout * recipient.percentage / 10_000` (basis points), using integer
division that truncates toward zero — this can leave a small remainder
("dust") when the split does not divide evenly. The function already
handles this by giving the **last recipient in the list** the exact
remainder (`payout - sum_of_prior_shares`) instead of another `bps`-derived
share, so:

- No dust is ever left unaccounted for or stuck in the contract — the full
  `payout` amount is always transferred out across the recipient list.
- The last-listed recipient's payout can be a few stroops higher or lower
  than a naive `bps` calculation would suggest, because it absorbs the
  rounding remainder from every recipient before it.
- The protocol fee and the collection-level royalty deduction (via
  `royalty_info`) are computed the same way (`amount * bps / 10_000`,
  truncating), but since only one such deduction happens per settlement
  (not a list), there is no remainder-of-a-remainder to redistribute for
  those two amounts.

The `ProtocolFeeTotal` and `RoyaltyTotal` counters accumulate the exact
integer amounts that were actually transferred (post-rounding), so they are
never off by the rounding remainder — they reconcile exactly against the
sum of the corresponding events, with no fudge factor needed.

---

## 5. Indexer reconciliation

`indexer/src/reconciler.ts` already ran a periodic (default: every 5
minutes, `RECONCILE_INTERVAL_MS`) comparison of a *sample* of listing/auction
state against the chain. This change adds a second, non-sampled check:
`runAccountingReconciliation`.

It:

1. Sums `MarketplaceEvent.data.amount` for every `PROTOCOL_FEE_COLLECTED`
   row, grouped by `data.token`.
2. Sums `MarketplaceEvent.data.total_amount` for every `ROYALTY_SETTLEMENT`
   row, grouped by `data.token`.
3. For every token seen, calls `get_protocol_fee_total(token)` /
   `get_royalty_total(token)` on-chain (via
   `fetchProtocolFeeTotalOnChain` / `fetchRoyaltyTotalOnChain` — stub
   functions today, following the same pattern already established by
   `fetchListingOnChain` / `fetchAuctionOnChain` in the same file; wiring
   them up to a real `simulateTransaction` call against the deployed
   contract is a follow-up, not blocking this change) and logs a
   `[Reconciler] Accounting discrepancy` warning on any mismatch.

### A gap this change also closes

Before this change, the `royalty_settlement` contract event topic was
**missing from `parser.ts`'s `TOPIC_MAP`**, so every `RoyaltySettlementEvent`
emitted by the contract (added in Issue #270) was silently dropped by
`resolveEventType()` and never reached the database at all — there was no
off-chain royalty aggregate to reconcile against in the first place. This
change adds the `'royalty_settlement': 'ROYALTY_SETTLEMENT'` mapping and a
matching schema in `event-schemas.ts` so these events are now captured.
(The `royalty_paid` / `ROYALTY_PAID` topic and schema that already existed
in the indexer correspond to a `ROYALTY_PAID` event constant defined in
`events.rs` that the contract has never actually published — it predates
`RoyaltySettlementEvent` and is unused. It is left in place rather than
removed, since deleting event infrastructure is out of scope here.)

---

## 6. Manual verification

After a purchase, auction finalize, or offer accept on a given `token`:

```
get_protocol_fee_total(token)   // should equal the ProtocolFeeCollectedEvent.amount
                                 // just emitted, plus every prior fee collected in that token
get_royalty_total(token)        // should equal the RoyaltySettlementEvent.total_amount
                                 // just emitted, plus every prior settlement value in that token
get_settlement_count(token)     // should increase by exactly 1
```
