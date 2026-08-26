// math.rs — Fee arithmetic helpers for the ELCARE-HUB Marketplace
//
// # Rounding Policy
//
// All fee calculations use integer (floor) division, which truncates any
// fractional stroop.  The truncated remainder — called *dust* — is explicitly
// tracked and routed to a documented recipient rather than being silently
// discarded.
//
// ## Why dust matters
//
// For a listing priced at 1 stroop with `protocol_fee_bps = 1`:
//   fee = (1 * 1) / 10_000 = 0   ← integer division truncates the 0.0001 stroop
//
// Without explicit dust routing that stroop stays in the contract forever.
// Instead `distribute` routes the total rounding remainder (dust) to the
// *last recipient* in the recipients array.  In the common single-recipient
// case that is the artist, so dust never silently disappears.
//
// ## Dust routing rule
//
// The **last recipient** absorbs dust via the "last-one-gets-remainder" pattern:
// their amount is computed as `remaining − already_distributed` rather than
// the strict `remaining * bps / 10_000`.  Every listing places the artist at
// index 0 and any collaborators after; in the single-artist case the artist
// absorbs dust automatically.
//
// In all cases: `fee + sum(payouts) == price`.
//
// ## Checked arithmetic
//
// `calc_fee` returns 0 on multiplication overflow (safe for single queries).
// `distribute` panics with `ArithmeticOverflow` on any overflow so the call
// reverts cleanly rather than silently producing wrong amounts.

use crate::types::{MarketplaceError, Recipient};
use soroban_sdk::{panic_with_error, Address, Env, Vec};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum number of recipients accepted per listing / auction (mirrors the
/// contract constant MAX_RECIPIENTS = 4).  Used to size the stack-allocated
/// payout buffer so `distribute` needs no heap allocation.
pub const MAX_RECIPIENTS: usize = 4;

// ── Public helper types ───────────────────────────────────────────────────────

/// One resolved payout: recipient address + stroop amount.
/// Plain Rust struct — never stored or serialised, used only during settlement.
pub struct Payout {
    pub address: Address,
    pub amount:  i128,
}

/// Full distribution result returned by [`distribute`].
///
/// `payouts` is a fixed-capacity stack-allocated array; only the first
/// `payout_len` entries are populated.
pub struct DistributeResult {
    /// Protocol fee collected (transferred to treasury).
    pub fee: i128,
    /// Per-recipient payout amounts. Index with `[0..payout_len]`.
    pub payouts: [Option<Payout>; MAX_RECIPIENTS],
    /// Number of valid entries in `payouts`.
    pub payout_len: usize,
    /// Rounding remainder absorbed by `payouts[payout_len - 1]` (informational).
    pub dust: i128,
}

impl DistributeResult {
    /// Iterate over the valid payouts.
    pub fn iter_payouts(&self) -> impl Iterator<Item = &Payout> {
        self.payouts[..self.payout_len]
            .iter()
            .filter_map(|p| p.as_ref())
    }
}

// ── Core math functions ───────────────────────────────────────────────────────

/// Calculate the protocol fee for `price` at `bps` basis points.
///
/// Uses checked arithmetic; returns 0 when the multiplication overflows
/// (callers enforce `PriceOutOfBounds` to keep prices in a safe range).
///
/// # Examples
/// - `calc_fee(10_000_000, 500)` → 500 000   (5 %)
/// - `calc_fee(1, 1)`            → 0          (0.0001 % truncated)
/// - `calc_fee(0, 500)`          → 0          (zero price)
pub fn calc_fee(price: i128, bps: u32) -> i128 {
    if bps == 0 || price == 0 {
        return 0;
    }
    price
        .checked_mul(bps as i128)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0)
}

/// Calculate a single recipient's proportional share of `remaining` stroops.
///
/// Returns 0 when either input is zero.
pub fn calc_recipient_amount(remaining: i128, bps: u32) -> i128 {
    if bps == 0 || remaining == 0 {
        return 0;
    }
    remaining
        .checked_mul(bps as i128)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0)
}

/// Distribute `price` among the protocol treasury and all `recipients`,
/// routing rounding dust to the last recipient.
///
/// # Arguments
/// - `env`        — Soroban environment (for `panic_with_error`).
/// - `price`      — Total sale price in stroops.
/// - `fee_bps`    — Protocol fee in basis points (0–10 000).
/// - `recipients` — Soroban `Vec<Recipient>` (1–`MAX_RECIPIENTS` entries).
///
/// # Returns
/// A [`DistributeResult`] where `fee + sum(payouts) == price`.
///
/// # Panics (contract error)
/// - `ArithmeticOverflow` on any checked-multiply overflow.
/// - `InvalidSplit` if `recipients` is empty.
pub fn distribute(
    env: &Env,
    price: i128,
    fee_bps: u32,
    recipients: &Vec<Recipient>,
) -> DistributeResult {
    let len = recipients.len() as usize;
    if len == 0 {
        panic_with_error!(env, MarketplaceError::InvalidSplit);
    }

    // ── Protocol fee ─────────────────────────────────────────────────────────
    let fee = if fee_bps > 0 && price > 0 {
        price
            .checked_mul(fee_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
    } else {
        0
    };

    let remaining = price
        .checked_sub(fee)
        .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow));

    // ── Recipient shares ──────────────────────────────────────────────────────
    // Stack-allocated; the contract rejects > 4 recipients before calling here.
    const NONE: Option<Payout> = None;
    let mut payouts: [Option<Payout>; MAX_RECIPIENTS] = [NONE; MAX_RECIPIENTS];
    let mut distributed: i128 = 0;

    for i in 0..len {
        let r = recipients.get(i as u32).unwrap();
        let amount = if i == len - 1 {
            // Last recipient absorbs all rounding dust.
            remaining
                .checked_sub(distributed)
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
        } else {
            remaining
                .checked_mul(r.percentage as i128)
                .and_then(|v| v.checked_div(10_000))
                .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow))
        };
        distributed = distributed
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(env, MarketplaceError::ArithmeticOverflow));
        payouts[i] = Some(Payout { address: r.address.clone(), amount });
    }

    // ── Dust accounting (informational) ───────────────────────────────────────
    let mut ideal: i128 = 0;
    for i in 0..len {
        let r = recipients.get(i as u32).unwrap();
        ideal = ideal.saturating_add(calc_recipient_amount(remaining, r.percentage));
    }
    let dust = remaining.saturating_sub(ideal).max(0);

    DistributeResult { fee, payouts, payout_len: len, dust }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Address, Env};

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn single(env: &Env, addr: &Address, bps: u32) -> Vec<Recipient> {
        vec![env, Recipient { address: addr.clone(), percentage: bps }]
    }

    fn multi(env: &Env, entries: &[(Address, u32)]) -> Vec<Recipient> {
        let mut v = Vec::new(env);
        for (addr, bps) in entries {
            v.push_back(Recipient { address: addr.clone(), percentage: *bps });
        }
        v
    }

    fn sum_payouts(r: &DistributeResult) -> i128 {
        r.iter_payouts().map(|p| p.amount).fold(0i128, |a, b| a + b)
    }

    // ── calc_fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_calc_fee_normal() {
        assert_eq!(calc_fee(10_000_000, 500), 500_000);
        assert_eq!(calc_fee(10_000_000, 250), 250_000);
        assert_eq!(calc_fee(100, 100), 1);
    }

    #[test]
    fn test_calc_fee_zero_price() {
        assert_eq!(calc_fee(0, 500), 0);
    }

    #[test]
    fn test_calc_fee_zero_bps() {
        assert_eq!(calc_fee(10_000_000, 0), 0);
    }

    #[test]
    fn test_calc_fee_single_stroop_truncates() {
        assert_eq!(calc_fee(1, 1),     0); // 0.0001 stroop truncated
        assert_eq!(calc_fee(9_999, 1), 0); // 0.9999 stroop truncated
        assert_eq!(calc_fee(10_000, 1), 1); // exact
    }

    #[test]
    fn test_calc_fee_max_bps_equals_price() {
        assert_eq!(calc_fee(1_000_000, 10_000), 1_000_000);
    }

    #[test]
    fn test_calc_fee_near_max_no_overflow() {
        let price = i128::MAX / 10_001;
        let fee = calc_fee(price, 500);
        assert!(fee >= 0 && fee <= price);
    }

    #[test]
    fn test_calc_fee_overflow_returns_zero() {
        // i128::MAX/2 + 1 multiplied by 2 overflows → returns 0
        let price = i128::MAX / 2 + 1;
        assert_eq!(calc_fee(price, 2), 0);
    }

    // ── calc_recipient_amount ─────────────────────────────────────────────────

    #[test]
    fn test_calc_recipient_amount_normal() {
        assert_eq!(calc_recipient_amount(10_000_000, 3_000), 3_000_000);
        assert_eq!(calc_recipient_amount(10_000_000, 10_000), 10_000_000);
    }

    #[test]
    fn test_calc_recipient_amount_zero_remaining() {
        assert_eq!(calc_recipient_amount(0, 5_000), 0);
    }

    #[test]
    fn test_calc_recipient_amount_zero_bps() {
        assert_eq!(calc_recipient_amount(1_000_000, 0), 0);
    }

    #[test]
    fn test_calc_recipient_amount_single_stroop_truncation() {
        assert_eq!(calc_recipient_amount(1, 5_000), 0); // 0.5 truncated
    }

    // ── distribute: no stroop ever lost ───────────────────────────────────────

    #[test]
    fn test_distribute_zero_price() {
        let env = Env::default();
        let a = Address::generate(&env);
        let result = distribute(&env, 0, 0, &single(&env, &a, 10_000));
        assert_eq!(result.fee, 0);
        assert_eq!(sum_payouts(&result), 0);
        assert_eq!(result.dust, 0);
    }

    #[test]
    fn test_distribute_single_stroop_low_fee() {
        // 1 stroop, fee_bps=1 → fee truncates to 0, artist gets 1
        let env = Env::default();
        let a = Address::generate(&env);
        let result = distribute(&env, 1, 1, &single(&env, &a, 10_000));
        assert_eq!(result.fee, 0);
        assert_eq!(sum_payouts(&result), 1);
        assert_eq!(result.fee + sum_payouts(&result), 1);
    }

    #[test]
    fn test_distribute_normal_5pct_fee() {
        let env = Env::default();
        let a = Address::generate(&env);
        let price = 10_000_000_i128;
        let result = distribute(&env, price, 500, &single(&env, &a, 9_500));
        assert_eq!(result.fee, 500_000);
        assert_eq!(sum_payouts(&result), 9_500_000);
        assert_eq!(result.fee + sum_payouts(&result), price);
    }

    #[test]
    fn test_distribute_3way_split_no_stroop_lost() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let price = 10_000_000_i128;
        let recipients = multi(&env, &[
            (a.clone(), 3_300),
            (b.clone(), 3_300),
            (c.clone(), 3_400),
        ]);
        let result = distribute(&env, price, 0, &recipients);
        assert_eq!(result.fee + sum_payouts(&result), price);
    }

    #[test]
    fn test_distribute_dust_absorbed_by_last_recipient() {
        // 7 stroops, 3-way equal-ish split
        // first: 7*3300/10000 = 2, second: 2, last: 7-2-2 = 3 (dust absorbed)
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let result = distribute(&env, 7, 0, &multi(&env, &[
            (a.clone(), 3_300),
            (b.clone(), 3_300),
            (c.clone(), 3_400),
        ]));
        assert_eq!(result.fee + sum_payouts(&result), 7, "all 7 stroops accounted for");
        assert!(result.dust >= 0);
    }

    #[test]
    fn test_distribute_maximum_safe_price() {
        let env = Env::default();
        let a = Address::generate(&env);
        let price = i128::MAX / 10_001;
        let result = distribute(&env, price, 500, &single(&env, &a, 10_000));
        assert_eq!(result.fee + sum_payouts(&result), price);
    }

    #[test]
    fn test_distribute_all_to_protocol_boundary() {
        // fee_bps=9_999, artist bps=1 — last recipient absorbs the tiny remainder
        let env = Env::default();
        let a = Address::generate(&env);
        let price = 10_000_i128;
        let result = distribute(&env, price, 9_999, &single(&env, &a, 1));
        assert_eq!(result.fee, 9_999);
        assert_eq!(result.payouts[0].as_ref().unwrap().amount, 1);
        assert_eq!(result.fee + sum_payouts(&result), price);
    }

    #[test]
    fn test_distribute_zero_fee_bps() {
        let env = Env::default();
        let a = Address::generate(&env);
        let result = distribute(&env, 5_000_000, 0, &single(&env, &a, 10_000));
        assert_eq!(result.fee, 0);
        assert_eq!(sum_payouts(&result), 5_000_000);
    }

    #[test]
    fn test_distribute_two_recipients_exact() {
        // 100 stroops, 60/40 split — exact, no dust
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let result = distribute(&env, 100, 0, &multi(&env, &[
            (a.clone(), 6_000),
            (b.clone(), 4_000),
        ]));
        assert_eq!(result.payouts[0].as_ref().unwrap().amount, 60);
        assert_eq!(result.payouts[1].as_ref().unwrap().amount, 40);
        assert_eq!(result.dust, 0);
    }

    #[test]
    fn test_distribute_odd_price_fee_truncation() {
        // price=3, fee_bps=333 → fee = 3*333/10000 = 0 (truncated)
        // remaining=3; first: 3*5000/10000=1, last: 3-1=2
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let result = distribute(&env, 3, 333, &multi(&env, &[
            (a.clone(), 5_000),
            (b.clone(), 5_000),
        ]));
        assert_eq!(result.fee, 0);
        assert_eq!(result.fee + sum_payouts(&result), 3);
    }

    #[test]
    fn test_distribute_four_recipients_max_capacity() {
        // 4 recipients = MAX_RECIPIENTS, all with 2500 bps each = 10000 total
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let d = Address::generate(&env);
        let price = 10_000_i128;
        let result = distribute(&env, price, 0, &multi(&env, &[
            (a.clone(), 2_500),
            (b.clone(), 2_500),
            (c.clone(), 2_500),
            (d.clone(), 2_500),
        ]));
        assert_eq!(result.payout_len, 4);
        assert_eq!(result.fee + sum_payouts(&result), price);
    }

    #[test]
    fn test_distribute_invariant_no_stroop_ever_lost() {
        // Parametric: fee + sum(payouts) == price for many price/fee combinations
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let recipients = multi(&env, &[(a.clone(), 6_000), (b.clone(), 4_000)]);

        let prices  = [1i128, 7, 100, 9_999, 10_000, 10_001, 1_000_000, 99_999_999];
        let fee_bps = [0u32, 1, 100, 333, 500, 1_000];

        for &price in &prices {
            for &bps in &fee_bps {
                let result = distribute(&env, price, bps, &recipients);
                let total = result.fee + sum_payouts(&result);
                assert_eq!(total, price,
                    "invariant violated: price={price}, fee_bps={bps}");
            }
        }
    }
}
