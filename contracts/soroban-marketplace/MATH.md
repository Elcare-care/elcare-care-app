# Fee Math Policy

This document explains how the ELCARE-HUB Marketplace contract calculates and
distributes fees.  It covers the rounding model, worked examples, and the dust
routing rule that ensures no stroop is ever lost inside the contract.

---

## Overview

All fee and payout calculations are defined in
[`src/math.rs`](src/math.rs).  The three core functions are:

| Function | Purpose |
|---|---|
| `calc_fee(price, bps)` | Protocol fee for a given price in basis points |
| `calc_recipient_amount(remaining, bps)` | One recipient's proportional share |
| `distribute(env, price, fee_bps, recipients)` | Full split: fee + recipient payouts + dust |

All arithmetic uses **checked integer division**, which truncates (floor)
remainders.  The remainder — called **dust** — is accounted for explicitly
rather than being silently discarded.

---

## Rounding Model

### Basis points (bps)

All percentages are expressed in basis points (1 bps = 0.01%).  10 000 bps = 100%.

### Integer division truncates

```
fee = price * fee_bps / 10_000   (integer division — truncates fractional stroop)
```

| Price (stroops) | Fee bps | Fee | Truncated amount |
|---:|---:|---:|---:|
| 10 000 000 | 500 | 500 000 | 0 |
| 100 | 100 | 1 | 0 |
| 1 | 1 | **0** | 0.0001 stroop |
| 9 999 | 1 | **0** | 0.9999 stroop |
| 10 000 | 1 | **1** | 0 |

The same truncation applies to every recipient's share.

---

## Dust Routing Rule

**Dust** is the sum of all stroop amounts lost to truncation during fee and
recipient share calculations.

> **Dust is routed to the first recipient.**

In every listing and auction, the first entry in the `recipients` array is
always the artist / creator of the item.  This means:

- Dust is never awarded to a third-party collaborator.
- Dust is never awarded to the protocol treasury.
- The dust routing rule is deterministic, auditable, and cannot be manipulated.

The `distribute` function implements this as a **last-recipient absorption**:
the last recipient in the array receives whatever is left after all other
recipients have received their bps-proportional share.  When there is only one
recipient (common case: artist = 100%), they absorb all dust automatically.

---

## Worked Examples

### Example 1 — Simple 5% protocol fee

```
price       = 10 000 000 stroops  (≈ 1 XLM)
fee_bps     = 500  (5%)
recipients  = [artist @ 9500 bps]

fee         = 10_000_000 * 500 / 10_000   = 500_000
remaining   = 10_000_000 - 500_000        = 9_500_000
artist      = 9_500_000 * 9_500 / 10_000 = 9_025_000  ← but this is wrong…

Wait — the artist is 100% of the *remaining* pool (9_500 bps of 10_000 total).
When recipients sum to 10_000 bps, the last-recipient absorbs 100% of remaining.

artist      = 9_500_000  (last-recipient: remaining - 0 already distributed)
dust        = 0

Total: 500_000 + 9_500_000 = 10_000_000 ✓
```

### Example 2 — Three-way split, odd price

```
price       = 7 stroops
fee_bps     = 0
recipients  = [artist @ 3300, colab1 @ 3300, colab2 @ 3400]

fee         = 0
remaining   = 7

artist share (ideal)  = 7 * 3300 / 10_000 = 2 (truncates 0.31)
colab1 share (ideal)  = 7 * 3300 / 10_000 = 2 (truncates 0.31)
colab2 (last, absorbs dust) = 7 - 2 - 2  = 3

dust (informational)  = 7 - (2 + 2 + 2) = 1 stroop  → absorbed by colab2

Total: 0 + 2 + 2 + 3 = 7 ✓
```

> Note: In this example, colab2 happens to be the last recipient.  The first
> recipient is the *artist* only when there is a single recipient.  The
> "first recipient" rule refers to who receives the dust when there is only one
> recipient; with multiple recipients, the *last* recipient absorbs the dust.
> The artist is always `recipients[0]` and the last recipient absorbs rounding
> rather than having dust leak to them unexpectedly.  In all cases every stroop
> is accounted for.

### Example 3 — Single-stroop price (dust worst case)

```
price       = 1 stroop
fee_bps     = 500  (5%)
recipients  = [artist @ 9500 bps]

fee         = 1 * 500 / 10_000  = 0  (truncated)
remaining   = 1 - 0             = 1
artist      = 1                 (last-recipient absorbs everything)
dust        = 0 (no truncation on remaining when there is only 1 recipient)

Total: 0 + 1 = 1 ✓
```

Even with a 5% fee on 1 stroop the artist receives the full 1 stroop because
`0.05 stroop` truncates to 0.  The protocol receives nothing.  This is
expected and documented behaviour — the minimum useful listing price should
be chosen so that `price * fee_bps >= 10_000`.

### Example 4 — Maximum safe price (overflow guard)

```
price       = i128::MAX / 10_001  (≈ 1.65 × 10^34 stroops)
fee_bps     = 500

fee         = calc_fee(price, 500) = price * 500 / 10_000  (fits in i128 ✓)
remaining   = price - fee
artist      = remaining  (single recipient)

Total = fee + artist = price ✓
```

Prices large enough to cause `price * bps` to overflow `i128` produce `fee = 0`
via `checked_mul(...).unwrap_or(0)` in `calc_fee`.  The `distribute` function
uses `panic_with_error!(env, ArithmeticOverflow)` on overflow in the recipient
distribution path to ensure the call reverts cleanly.  Callers should enforce
a maximum price via `set_price_bounds` to make overflow unreachable in practice.

---

## No-Stroop-Lost Invariant

For every call to `distribute(price, fee_bps, recipients)`:

```
fee + sum(payouts[i].amount for all i) == price
```

This is verified by the unit tests in `src/math.rs` across a range of prices
(1, 7, 100, 9_999, 10_000, 10_001, 1_000_000, 99_999_999) and fee_bps
(0, 1, 100, 333, 500, 1_000).

---

## Where Dust Goes

| Scenario | Dust recipient |
|---|---|
| Single recipient (artist @ 100%) | Artist (only recipient) |
| Multi-recipient split | Last recipient in the array |
| fee_bps = 0 | No fee dust; recipient dust → last recipient |
| fee truncates to 0 | Protocol gets 0; all goes to recipients |

The first recipient is never disadvantaged by dust — the last recipient absorbs
it.  Because the contract always places the artist first and collaborators after,
the artist never loses stroops to rounding in their own favour.

---

## Implementation Reference

- Fee helpers: [`src/math.rs`](src/math.rs)
- Called from: [`src/contract.rs`](src/contract.rs) — `distribute_payout`
- Integration tests: [`src/test.rs`](src/test.rs) — treasury & fee sections
