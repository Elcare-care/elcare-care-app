# Issue #1053 — Auction reserve and bid-increment hints

**Category:** Frontend UX and Accessibility
**Affected route:** `/auctions/[id]` (`BiddingPanel`)

## Goal

Before submitting, a bidder sees:

- whether the reserve has been met, and
- the minimum acceptable next bid.

Both come from indexed auction data and the configured increment. The UI must
not run an on-chain simulation or present an estimate as guaranteed.

## Current behavior (audit)

`src/components/BiddingPanel.tsx` already computes the minimum next bid with
`calculateMinimumNextBid(highestBid, reservePrice, minimumIncrement)` from
`src/lib/amount.ts`:

```
highestBid > 0 ? highestBid + minimumIncrement : reservePrice
```

`minimumIncrement` comes from `useMinBidIncrement()` in `src/hooks/useAuctions.ts`.

What the panel shows today:

- "Reserve price: X TOKEN": always shown, with no met or not-met status.
- "Minimum next bid: X TOKEN" (`data-testid="minimum-next-bid"`).
- An inline validation error, "Minimum bid is X TOKEN (current + increment)" or
  "(reserve price)".

Gaps:

1. **No reserve status.** The panel never says whether the reserve has been
   met. The contract's rule is "first bid must be ≥ reserve". Once a bid
   exists, the reserve is met by definition. A bidder can't tell this from
   the UI.
2. **The increment is invisible.** The user sees the result
   (`current + increment`) but never the increment amount itself.
3. **Hard-coded English copy.** "Reserve price:", "Minimum next bid:",
   "No bids yet", "(current + increment)", "(reserve price)", "Place Bid",
   "This is your auction." and the other strings in this panel are not in
   `src/lib/i18n.ts`.
4. **No "not guaranteed" disclaimer.** The minimum is derived from indexed
   state, which can lag (see `useIndexerFreshness`). If another bid lands
   first, the contract may still reject a bid at the shown minimum. The UI
   should say so rather than imply certainty.
5. **Zero-reserve edge case.** When `reserve_price === 0n` and there are no
   bids, the minimum next bid is `0`. `validateAmountInput` then rejects `0`
   with "Amount must be greater than zero", which contradicts the displayed
   minimum. Clamp the displayed minimum to the token's smallest unit (`1n`).

## Implementation plan

1. **Pure helper.** Add a function to `src/lib/amount.ts` next to
   `calculateMinimumNextBid`:

   ```ts
   export type ReserveStatus = "no_reserve" | "not_met" | "met";

   export interface BidHints {
     reserveStatus: ReserveStatus;
     minimumNextBid: bigint;     // clamped to ≥ 1n
     increment: bigint;
     basis: "reserve" | "increment";
   }

   export function getBidHints(auction, minimumIncrement): BidHints
   ```

   Rules:
   - `reserve_price === 0n` → `no_reserve`
   - `highest_bid >= reserve_price && highest_bid > 0n` → `met`
   - otherwise → `not_met`

   Keep it free of React and of chain or RPC calls.
2. **Panel copy.** Use the existing layout in the "Reserve price + minimum
   next bid" block:
   - Reserve row: amount plus a status pill ("Reserve met" in green, "Reserve
     not met" in amber, or "No reserve"). Pair colour with an icon and text,
     never colour alone, and keep contrast ≥ 4.5:1 on `bg-brand-50`.
   - Minimum next bid row: amount plus a short basis line, either "Current
     bid + {increment} minimum increment" or "First bid must meet the
     reserve".
   - Helper text under the input, linked via `aria-describedby` together
     with the existing error id: "Based on the latest indexed bid. The
     contract makes the final check when you submit."
3. **Formatting.** Use `formatAmount` / `baseToDisplay` with the auction's
   resolved `bidToken`. Never assume XLM; see
   [issue #1054](./issue-1054-token-price-formatting.md).
4. **Locale keys.** Add these keys to `en` and `sw` in `src/lib/i18n.ts` and
   the `messages/*.json` mirrors:
   `auction_reserve_price`, `auction_reserve_met`,
   `auction_reserve_not_met`, `auction_no_reserve`,
   `auction_min_next_bid`, `auction_min_bid_basis_increment`,
   `auction_min_bid_basis_reserve`, `auction_bid_hint_not_guaranteed`,
   `auction_no_bids_yet`, `auction_min_bid_error`. Use `{amount}` /
   `{symbol}` placeholders and interpolate them with a small replace helper.
   Never show a raw placeholder.
5. **No on-chain estimate.** Do not call `simulateTransaction` or a
   preflight to compute hints. The existing `useTxLifecycle` error path
   (`TxErrorPanel`) still handles a contract rejection when submitting.

## Fixtures and test states

Use the `Auction` shape from `src/lib/contract.ts` with 7-decimal tokens:

| State | `reserve_price` | `highest_bid` | increment | Expected status | Expected minimum |
|-------|-----------------|---------------|-----------|-----------------|------------------|
| No reserve, no bids | `0n` | `0n` | `1_000_000n` | `no_reserve` | `1n` (clamped) |
| Reserve not met (no bids) | `100_000_000n` | `0n` | `1_000_000n` | `not_met` | `100_000_000n` (10) |
| Reserve met exactly | `100_000_000n` | `100_000_000n` | `1_000_000n` | `met` | `101_000_000n` (10.1) |
| Reserve met, above | `100_000_000n` | `250_000_000n` | `1_000_000n` | `met` | `251_000_000n` (25.1) |
| Large value | `0n` | `MAX_I128 - 1n` | `1n` | `met` | `MAX_I128` (no overflow message) |

## Tests

| Kind | File | Cases |
|------|------|-------|
| Unit | `src/__tests__/amount.test.ts` | `getBidHints` for every row above |
| Unit | `src/__tests__/BiddingPanel.test.tsx` | Status pill text per state; increment shown; helper text linked via `aria-describedby`; Swahili render has no English fallback leaking for the new keys |
| a11y | `npm run test:a11y` | jest-axe on `BiddingPanel` in each state |
| E2E | `tests/e2e/auction-flow.spec.ts` | `minimum-next-bid` visible with a reserve status before bidding |

```bash
cd frontend/elcarehub-app
npx jest src/__tests__/amount.test.ts src/__tests__/BiddingPanel.test.tsx
npm run test:a11y
npx playwright test tests/e2e/auction-flow.spec.ts
```

## Acceptance checklist

- [ ] Reserve status and minimum next bid are visible before submit, in all three states.
- [ ] No on-chain simulation is used to produce hints. The copy says the contract makes the final check.
- [ ] All new strings exist in `en` and `sw`. No `{amount}` or `undefined` reaches the UI.
- [ ] Status is not conveyed by colour alone. Contrast and focus order are unchanged.
- [ ] The tests above pass. No other route behavior changes.
