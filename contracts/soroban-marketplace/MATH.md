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

## Settlement Protocol Fee & Royalty Reconciliation (Issue #1091)

All live settlement operations (`buy_artwork`, `accept_offer`, `finalize_auction`) as well as the read-only preview `simulate_payout` execute through the settlement pipeline implemented in `contract.rs::distribute_payout_tracked` and `math.rs::distribute`.

### Core Settlement Invariant

$$\text{royalty} + \text{protocol\_fee} + \sum_{i=0}^{N-1} \text{recipients}[i] = \text{gross\_amount}$$

Every stroop is conserved. No value leaks, and no fractional remainder remains in the contract escrow.

### Exact Calculation Sequence

1. **Collection Royalty**:
   $$\text{royalty} = \begin{cases} \lfloor \frac{\text{amount} \times \text{royalty\_bps}}{10\,000} \rfloor & \text{if } \text{royalty\_bps} > 0 \land \text{receiver} \neq \text{seller} \\ 0 & \text{otherwise} \end{cases}$$
   $$\text{remaining} = \text{amount} - \text{royalty}$$

2. **Protocol Fee**:
   $$\text{fee} = \begin{cases} \lfloor \frac{\text{remaining} \times \text{effective\_fee\_bps}}{10\,000} \rfloor & \text{if treasury is configured} \\ 0 & \text{otherwise} \end{cases}$$
   $$\text{net\_seller\_pool} = \text{remaining} - \text{fee}$$

3. **Seller Recipient Splits**:
   For recipients $i = 0, \dots, N-2$:
   $$\text{payout}[i] = \lfloor \frac{\text{net\_seller\_pool} \times \text{percentage}_i}{10\,000} \rfloor$$
   For the final recipient $i = N-1$ (absorbs all rounding dust):
   $$\text{payout}[N-1] = \text{net\_seller\_pool} - \sum_{j=0}^{N-2} \text{payout}[j]$$

### Worked Settlement Vectors

#### Vector 1 — Standard 1 XLM Sale with Collection Royalty & Protocol Fee
* **Inputs**:
  * Gross Amount: `10_000_000` stroops (1 XLM)
  * `royalty_bps`: `1_000` (10.00%)
  * `effective_fee_bps`: `500` (5.00%)
  * Recipients: 1 recipient (Artist @ 10,000 bps)
* **Integer Arithmetic**:
  * Royalty: $\lfloor 10\,000\,000 \times 1\,000 / 10\,000 \rfloor = 1\,000\,000$ stroops (0 dust)
  * Remaining Pool: $10\,000\,000 - 1\,000\,000 = 9\,000\,000$ stroops
  * Protocol Fee: $\lfloor 9\,000\,000 \times 500 / 10\,000 \rfloor = 450\,000$ stroops (0 dust)
  * Net Seller Pool: $9\,000\,000 - 450\,000 = 8\,550\,000$ stroops
  * Artist Payout: $8\,550\,000$ stroops (last recipient absorbs remainder: $8\,550\,000 - 0$)
* **Reconciliation**:
  $$1\,000\,000 + 450\,000 + 8\,550\,000 = 10\,000\,000 \text{ stroops } \checkmark$$

#### Vector 2 — Multi-Recipient Truncation with Dust Across All Legs
* **Inputs**:
  * Gross Amount: `9_999` stroops
  * `royalty_bps`: `500` (5.00%)
  * `effective_fee_bps`: `250` (2.50%)
  * Recipients: 3 recipients: `[A @ 3_333, B @ 3_333, C @ 3_334]`
* **Integer Arithmetic**:
  * Royalty: $\lfloor 9\,999 \times 500 / 10\,000 \rfloor = \lfloor 4\,999\,500 / 10\,000 \rfloor = 499$ stroops (truncates 0.95 stroop)
  * Remaining Pool: $9\,999 - 499 = 9\,500$ stroops
  * Protocol Fee: $\lfloor 9\,500 \times 250 / 10\,000 \rfloor = \lfloor 2\,375\,000 / 10\,000 \rfloor = 237$ stroops (truncates 0.50 stroop)
  * Net Seller Pool: $9\,500 - 237 = 9\,263$ stroops
  * Recipient A: $\lfloor 9\,263 \times 3\,333 / 10\,000 \rfloor = \lfloor 30\,873\,579 / 10\,000 \rfloor = 3\,087$ stroops (truncates 0.3579)
  * Recipient B: $\lfloor 9\,263 \times 3\,333 / 10\,000 \rfloor = \lfloor 30\,873\,579 / 10\,000 \rfloor = 3\,087$ stroops (truncates 0.3579)
  * Recipient C (Last): $9\,263 - 3\,087 - 3\,087 = 3\,089$ stroops (absorbs 2 stroops dust)
* **Reconciliation**:
  $$499 + 237 + 3\,087 + 3\,087 + 3\,089 = 9\,999 \text{ stroops } \checkmark$$

#### Vector 3 — Micro-Dust Settlement (7 stroops, 2 recipients)
* **Inputs**:
  * Gross Amount: `7` stroops
  * `royalty_bps`: `500` (5.00%)
  * `effective_fee_bps`: `333` (3.33%)
  * Recipients: 2 recipients: `[A @ 5_000, B @ 5_000]`
* **Integer Arithmetic**:
  * Royalty: $\lfloor 7 \times 500 / 10\,000 \rfloor = 0$ stroops (truncates 0.35 stroop)
  * Remaining Pool: $7 - 0 = 7$ stroops
  * Protocol Fee: $\lfloor 7 \times 333 / 10\,000 \rfloor = 0$ stroops (truncates 0.2331 stroop)
  * Net Seller Pool: $7 - 0 = 7$ stroops
  * Recipient A: $\lfloor 7 \times 5\,000 / 10\,000 \rfloor = 3$ stroops (truncates 0.5 stroop)
  * Recipient B (Last): $7 - 3 = 4$ stroops (absorbs 1 stroop dust)
* **Reconciliation**:
  $$0 + 0 + 3 + 4 = 7 \text{ stroops } \checkmark$$

---

## Royalty Recipient Split Fixtures & Rounding Order (Issue #1090)

The marketplace contract enforces strict recipient taxonomy and rounding order for 0, 1, and many recipients.

### Recipient Case Taxonomy

| Recipient Count | Supported Range | Settlement Behavior | Error / Absorption |
|:---|:---|:---|:---|
| **Zero Recipients** ($N = 0$) | Not Allowed | Rejects at creation and settlement | Reverts with `MarketplaceError::InvalidSplit` (`#7`) |
| **One Recipient** ($N = 1$) | Artist @ 10,000 bps | Receives 100% of net seller pool | Automatic dust absorption ($net - 0 = net$) |
| **Many Recipients** ($2 \le N \le 4$) | $N \in [2, 4]$ (`MAX_RECIPIENTS = 4`) | Recipients $0..N-2$ get floor shares; recipient $N-1$ absorbs dust | Strict last-recipient remainder absorption |

### Rounding Order Specification
1. **Royalty First**: Collection royalty is computed strictly on gross `amount` before any fee deduction.
2. **Protocol Fee Second**: Protocol fee is computed on remaining amount (`amount - royalty`).
3. **Seller Recipients Third**: Intermediate recipients ($0..N-2$) are allocated proportional truncated shares.
4. **Dust Absorption Fourth**: Final recipient ($N-1$) receives the exact difference $net - \sum_{i=0}^{N-2} payout_i$.

### Test Suite Inventory for Recipient Splits

* `contracts/soroban-marketplace/src/math.rs`:
  * `test_distribute_zero_price`: Zero price boundary.
  * `test_distribute_single_stroop_low_fee`: Single stroop with low fee truncation.
  * `test_distribute_normal_5pct_fee`: Standard 5% fee and single artist recipient.
  * `test_distribute_two_recipients_exact`: 2-recipient 60/40 exact split (0 dust).
  * `test_distribute_odd_price_fee_truncation`: 2-recipient split with fee truncating to 0.
  * `test_distribute_3way_split_no_stroop_lost`: 3-recipient split verifying total conservation.
  * `test_distribute_dust_absorbed_by_last_recipient`: 3-recipient split explicitly asserting dust absorption on `recipients[2]`.
  * `test_distribute_four_recipients_max_capacity`: 4-recipient split at `MAX_RECIPIENTS` capacity (2,500 bps each).
  * `test_distribute_invariant_no_stroop_ever_lost`: Property matrix across prices $[1, 7, 100, 9999, 10000, 10001, 1000000, 99999999]$ and fee rates $[0, 1, 100, 333, 500, 1000]$.
* `contracts/soroban-marketplace/src/royalty_boundary_tests.rs`:
  * `test_recipient_bps_at_exact_maximum_accepted`: Single recipient at 10,000 bps accepted.
  * `test_recipient_bps_one_above_maximum_rejected`: Single recipient at 10,001 bps panics with `RoyaltyExceedsLimit` (`#26`).
  * `test_recipient_bps_above_maximum_no_partial_state_update`: Verifies no state write occurs when bps $> 10\,000$.

---

## Offer Precision Fixture Notes (Issue #1089)

Offer settlements through `accept_offer` invoke `distribute_payout_tracked` using the offer's escrowed `amount`. Payout simulation via `simulate_payout` mirrors this arithmetic identically.

### 1. Dust Amounts ($1 \le \text{amount} < 10\,000$ stroops)
* Because Stellar base units (stroops) are integers, any percentage calculation where $\text{amount} \times \text{bps} < 10\,000$ truncates to zero.
* For standard 5% fee (`500` bps) and 10% royalty (`1_000` bps):
  * Amounts $< 20$ stroops yield `0` fee ($\lfloor 19 \times 500 / 10\,000 \rfloor = 0$).
  * Amounts $< 10$ stroops yield `0` royalty ($\lfloor 9 \times 1\,000 / 10\,000 \rfloor = 0$).
* **Invariant**: Truncated fees and royalties are not lost; they stay in the net pool and flow directly to the seller recipients.
* **Zero amount check**: `make_offer` strictly forbids `amount <= 0`, rejecting with `InsufficientOfferAmount` (`#19`).

### 2. Exact Amounts ($\text{amount} \pmod{10\,000} == 0$)
* For multiples of 10,000 stroops (e.g. 1 XLM = 10,000,000 stroops):
  * Every basis-point fraction $\text{bps} / 10\,000$ computes to an exact integer.
  * Truncation dust is zero across all stages.
  * Intermediate remaining balances reconcile identically to floating-point calculations.

### 3. Overflow-Risk Amounts ($\text{amount} > i128::\text{MAX} / 10\,001$)
* Soroban signed 128-bit integer maximum is:
  $$i128::\text{MAX} = 2^{127} - 1 = 170\,141\,183\,460\,469\,231\,731\,687\,303\,715\,884\,105\,727$$
* The multiplication $\text{amount} \times \text{bps}$ is safe against overflow whenever:
  $$\text{amount} \le \frac{i128::\text{MAX}}{10\,000} \approx 1.7014 \times 10^{34} \text{ base units}$$
* Any computation that exceeds $i128::\text{MAX}$ panics with `MarketplaceError::ArithmeticOverflow` (`#40`).
* In practice, the total circulating supply of XLM is $\approx 5 \times 10^{10}$ XLM ($5 \times 10^{17}$ stroops), which is $16$ orders of magnitude below the overflow threshold.
* The contract provides `set_price_bounds(min, max)` to establish a global ceiling, ensuring overflow-risk amounts are rejected at offer/listing creation time.

---

## Implementation Reference

- Fee helpers: [`src/math.rs`](src/math.rs)
- Called from: [`src/contract.rs`](src/contract.rs) — `distribute_payout`
- Integration tests: [`src/test.rs`](src/test.rs) — treasury & fee sections
