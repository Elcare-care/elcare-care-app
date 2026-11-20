# Issue #1054 — Price formatting for zero-decimal and split-decimal tokens

**Category:** Frontend UX and Accessibility
**Affected:** every surface that shows a token amount

## Goal

One explicit set of precision rules, reused everywhere, so a token amount
looks the same on every route regardless of the asset's `decimals`.

## Precision rules

The canonical registry is `src/config/tokens.ts`. It is the only place a
token's `decimals` may come from.

| Symbol | Name | `decimals` | 1 display unit = | Smallest unit |
|--------|------|-----------|------------------|---------------|
| XLM | Stellar Lumens (native SAC) | 7 | 10,000,000 base units (stroops) | 0.0000001 |
| USDC | USDC (SAC) | 7 | 10,000,000 base units | 0.0000001 |
| AFRI | ELCARE-HUB Token (SAC) | 7 | 10,000,000 base units | 0.0000001 |

All tokens configured today use 7 decimals, but the utilities must stay
correct for **any** `0 ≤ decimals ≤ 18` (`MAX_SUPPORTED_DECIMALS` in
`src/lib/amount.ts`). That covers:

- **Zero-decimal tokens** (`decimals: 0`), for example an indivisible
  points or ticket token. Base unit and display unit are the same; no
  decimal point is ever shown.
- **Split-decimal tokens**, where `decimals` differs from 7 (for example 2,
  6 or 18). Base-to-display conversion must use the token's own exponent,
  never `10_000_000n`.

### Rules

1. **Base units are integers (`bigint`).** Conversion uses bigint/string
   arithmetic only: `baseToDecimalString`, `decimalStringToBase`,
   `baseUnitsToDisplay`, `displayToBaseUnits`. Never use `Number`,
   `parseFloat` or `toFixed` on a raw base-unit value.
2. **Resolve the token from the asset address.** Use
   `getTokenConfigByAddress(address)` or `getAssetIdentity(address)`. If the
   address is unknown, refuse to format it as a payable amount; don't
   default to XLM precision.
3. **Display = `formatAmount(base, token, opts)`.** It groups the whole part
   by locale, strips trailing zeros, and appends the symbol. Whole parts
   beyond `Number.MAX_SAFE_INTEGER` are formatted as `BigInt` so precision
   isn't lost.
4. **Rounding.** Full precision (up to `token.decimals`) is the default for
   anything the user signs or compares (prices, bids, fees, totals). Compact
   displays (cards, charts, stats) may pass `maxFractionDigits`. When they
   do, they **truncate** (round toward zero) so a balance never appears
   larger than it is. Fees use floor division to match the contract
   (`buildFeePreview`).
5. **Zero** renders as `0 SYMBOL`. Don't render it as `0.0000000`, an empty
   string or "—", except for "no value yet" states, which use their own
   localized copy (for example "No bids yet").
6. **Maximum value.** Input above `MAX_I128` is rejected with `OVERFLOW`.
   `MAX_I128` itself must format without exponent notation or precision loss.
7. **The symbol is always shown** next to financial values
   (`formatAssetDisplay` / `formatAmount` default `showSymbol: true`).
8. **Locale.** Pass the active app locale to `Intl.NumberFormat`: `en` maps
   to `en-US`, `sw` maps to `sw-KE`. Don't hard-code `"en-US"` at call sites.

## Audit of current call sites

Call sites that bypass the rules above and should be migrated:

| File | Problem | Fix |
|------|---------|-----|
| `src/lib/contract.ts` → `stroopsToXlm` / `xlmToStroops` | Hard-coded 7 decimals (`10_000_000n`). Used for non-XLM auctions and listings. | Replace callers with `baseToDisplay(base, token)` / `displayToBase`. Keep the XLM-only helpers for genuinely XLM-only paths, or deprecate them. |
| `src/app/auctions/page.tsx:97` | `parseFloat(stroopsToXlm(highest_bid))`: float plus a 7-decimal assumption | Resolve the token and use `formatAmount` |
| `src/components/AuctionManagementPanel.tsx:221` | `parseFloat(stroopsToXlm(reserve_price))` | `baseToDisplay(reserve_price, token)` (keep as a string in form state) |
| `src/components/ListingForm.tsx:285` | `parseFloat(stroopsToXlm(listing.price))` | Same as above |
| `src/components/ListingWizard.tsx:528` | `parseFloat(form.price)` before conversion | `displayToBase(form.price, token)` |
| `src/app/profile/[address]/ProfileClient.tsx:364,495` | `parseFloat(totalEarned).toFixed(2 / 4)` + literal "XLM". The two lines use different precision on the same page. | `formatAmount(baseUnitsStringToBigInt(totalEarned), token, { maxFractionDigits: 4 })` |
| `src/app/api/og/artist/[address]/route.tsx:180` | `parseFloat(totalVolume).toFixed(1)` + "XLM" | Same as above, `maxFractionDigits: 1` (OG image) |
| `src/app/listings/[id]/ListingClient.tsx:680` | `Number(priceDisplay) * 0.12` hard-coded USD rate | Out of scope for formatting, but flag it: the rate is a placeholder and should come from a real price source or be removed |
| `src/components/PriceHistoryChart.tsx:36-37` | `K` / `M` abbreviations via `toFixed(2)` | Acceptable for chart axes. Use `Intl.NumberFormat({ notation: "compact" })` with the locale instead. |
| `src/lib/format.ts` → `formatAssetDisplay` | Defaults to `maxFractionDigits = 7` regardless of token | Accept a `TokenConfig` (or decimals) and default to `token.decimals` |

Percent and bps displays (`toFixed` on royalty percentages) are not token
amounts and are out of scope.

## Implementation plan

1. Keep `src/lib/amount.ts` as the single formatting module. If a
   compact-truncation option is needed, add it to `formatAmount` rather than
   creating a new helper.
2. Make `formatAmount` and `formatAssetDisplay` accept the app locale from
   `useLocale()` and map it to an Intl tag.
3. Migrate the call sites in the audit table one PR-sized group at a time
   (auctions, then listings, then profile and OG).
4. Add a short "Amounts" section to `docs/guides/payment-tokens.md` that
   links here. The current `docs/payment-tokens.md` lists USDT and "other
   stabilized coins", which aren't in the registry; correct it to match
   `src/config/tokens.ts`.

## Fixture tests

Add a table-driven suite to `src/__tests__/amount.test.ts` using synthetic
`TokenConfig` fixtures with 0, 2, 7 and 18 decimals:

| decimals | base input | `baseToDisplay` | `formatAmount` (en) | Notes |
|----------|-----------|-----------------|---------------------|-------|
| 0 | `0n` | `0` | `0 PTS` | zero |
| 0 | `1234n` | `1234` | `1,234 PTS` | no decimal point ever |
| 0 | `"1.5"` (input) | `null` / `TOO_MANY_DECIMALS` | — | reject fractions |
| 2 | `1n` | `0.01` | `0.01 TKN` | smallest unit |
| 2 | `150n` | `1.5` | `1.5 TKN` | trailing zero stripped |
| 7 | `0n` | `0` | `0 XLM` | zero |
| 7 | `1n` | `0.0000001` | `0.0000001 XLM` | smallest unit |
| 7 | `15_555_555n`, `maxFractionDigits: 2` | — | `1.55 XLM` | truncates, not `1.56` |
| 7 | `MAX_I128` | exact string | grouped, no `e+` | maximum |
| 18 | `1n` | `0.000000000000000001` | full precision | split-decimal |
| 18 | `10n ** 18n` | `1` | `1 ETHX` | |
| 19 | any | `RangeError` | — | above `MAX_SUPPORTED_DECIMALS` |

Also add:

- Round-trip `displayToBase(baseToDisplay(x)) === x` for each fixture.
- `sw` locale output for one value per decimals group.
- `validateAmountInput` for `ZERO`, `OVERFLOW` (`MAX_I128 + 1n`) and `TOO_MANY_DECIMALS`.

```bash
cd frontend/elcarehub-app
npx jest src/__tests__/amount.test.ts src/__tests__/format.test.ts src/__tests__/token-support.test.ts src/__tests__/offerAmountPrecision.test.ts
```

## Acceptance checklist

- [ ] The precision rules are documented (this file) and linked from the payment-tokens guide.
- [ ] Every audited call site resolves the token and uses `src/lib/amount.ts`.
- [ ] Fixture tests cover 0, 2, 7 and 18 decimals, plus zero, rounding and maximum values.
- [ ] No `NaN`, `e+` notation, `undefined` or wrongly scaled amount appears in the UI.
- [ ] No other route behavior changes.
