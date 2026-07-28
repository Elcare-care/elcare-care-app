# Payment Tokens: Canonical Asset Identity & Decimal Policy

This guide documents how the marketplace identifies accepted payment tokens (XLM and whitelisted
Stellar Asset Contracts), how amounts are represented at each layer of the stack, and how raw
on-chain values map to human-readable display amounts. It exists to prevent the class of bug this
guide was written to close: a token that is technically whitelisted but rendered with the wrong
decimal precision, producing a materially incorrect price or fee to the user. (Issue #282.)

---

## 1. Canonical asset identity

Every payment token accepted by the marketplace is identified by its **Stellar contract address**
(a `C...` SAC — Stellar Asset Contract — address), which is either:

- **native** — the Stellar Asset Contract wrapping the native XLM asset, or
- **sac** — a Stellar Asset Contract wrapping some other classic asset (e.g. USDC, AFRI).

The single source of truth for "which addresses are accepted, and what are their properties" is:

- **On-chain**: `contracts/soroban-marketplace/src/contract.rs` — `get_token_whitelist()` /
  `add_token_to_whitelist()` / `remove_token_from_whitelist()`, backed by `DataKey::TokenWhitelist`
  in `storage.rs`. An empty whitelist means "accept any token" (permissive default); once at least
  one token is whitelisted, only listed addresses are accepted.
- **Off-chain (frontend)**: `frontend/elcarehub-app/src/config/tokens.ts` — `TOKEN_METADATA`,
  `SUPPORTED_TOKENS`, and the `AssetIdentity` helpers (`getAssetIdentity`, `isSupportedAsset`).
- **Off-chain (indexer)**: `indexer/src/token-metadata.ts` — mirrors the frontend's decimals table
  for API serialization.

The contract itself cannot cheaply or safely introspect an arbitrary token contract's
`decimals()`/`symbol()` from inside a purchase/offer/auction call — cross-contract calls to
unknown token contracts are exactly the kind of operation Soroban discourages doing implicitly on
a hot settlement path. So the contract's responsibility is narrower and cheaper:

1. Treat every `price` / `reserve_price` / bid / offer `amount` as an **opaque `i128` base unit** —
   it never scales, rounds, or reinterprets these values.
2. Reject a small set of **obviously-wrong** token addresses at the moment a listing, auction, or
   offer is created — see `Contract::validate_token_asset` in `contract.rs`, which rejects:
   - the marketplace contract's own address (nothing can pay itself), and
   - the same address as the NFT `collection` being listed/auctioned (a payment token can never
     legitimately equal the asset being sold — this is almost always a copy-paste bug).
3. Defer to the admin-curated whitelist (`is_token_whitelisted`) for everything else.

Canonical **decimal precision** is therefore an off-chain policy, not an on-chain one — see §2.

---

## 2. Decimal policy

Stellar fixes 7 decimal places for both the native XLM asset and every classic-asset Stellar Asset
Contract. Every token in `TOKEN_METADATA` (frontend) and the indexer's token registry uses
`decimals: 7` today. The data model supports per-token overrides (see
`frontend/elcarehub-app/src/config/tokens.ts`'s `TokenConfig.decimals` and the indexer's
`TOKEN_DECIMALS_JSON` env override in `indexer/src/token-metadata.ts`) for the day a
differently-scaled asset is whitelisted, but nothing in production uses a value other than 7 yet.

**Rule of thumb: a "base unit" (stroop, for XLM) is `10^-decimals` of one display unit.**

| Layer | Representation | Conversion helper |
|---|---|---|
| Soroban contract | `i128` base units, opaque, never scaled | n/a — contract does no scaling |
| Indexer DB / API | Same raw base-unit integer, stored in a `Decimal(32,7)` column (headroom, not scaling) | `indexer/src/token-metadata.ts` → `baseUnitsToDecimalString` |
| Frontend | `bigint` base units in transaction-building code; decimal strings for display/input | `frontend/elcarehub-app/src/config/tokens.ts` → `baseUnitsToDisplay` / `displayToBaseUnits`; `frontend/elcarehub-app/src/lib/contract.ts` → `stroopsToXlm` / `xlmToStroops` (XLM-specific convenience wrappers) |

All of these conversions use **string/BigInt arithmetic exclusively** — never `Number`/`parseFloat`
on a raw base-unit value, which silently loses precision once the value exceeds
`Number.MAX_SAFE_INTEGER` (~9 × 10¹⁵, i.e. ~900M XLM at 7 decimals).

---

## 3. Raw vs. human-readable amounts in the indexer API

`GET /listings`, `GET /listings/:id`, `GET /auctions`, `GET /auctions/:id`, and `GET /offers` each
return the on-chain **raw** base-unit amount(s) under their existing field name(s) (`price`,
`reservePrice`, `highestBid`, `amount`), plus a `<field>Decimal` sibling with the human-readable
value, computed from the row's own `token` address via `indexer/src/token-metadata.ts`.

Example — `GET /listings/42` for a 10 XLM listing:

```json
{
  "listingId": "42",
  "artist": "GABC...XYZ",
  "price": "100000000",
  "priceDecimal": "10.0000000",
  "currency": "XLM",
  "token": "CDLZ...CYSC",
  "status": "Active"
}
```

`price` is the raw stroop amount emitted by the contract (an `i128`, serialized as a JSON string to
avoid the double-precision-float truncation that plain JSON numbers would suffer for large i128
values). `priceDecimal` is `price / 10^decimals` for the token at `token`, computed with exact
integer arithmetic (see `baseUnitsToDecimalString`) — safe to render directly in a UI without any
further conversion.

The same pattern applies to `Auction.reservePrice` / `Auction.highestBid` (→
`reservePriceDecimal` / `highestBidDecimal`) and `Offer.amount` (→ `amountDecimal`).

> Note: the `Decimal(32, 7)` Postgres column type used for these fields is **not** evidence the
> stored value is already human-scaled — it's simply headroom for `i128`-sized raw integers. Do
> not assume a `Decimal`-typed API field is display-ready; use the field's `Decimal`-suffixed
> sibling instead, or convert explicitly using the token's known decimals.

---

## 4. Frontend validation before settlement

`frontend/elcarehub-app/src/lib/token-support.ts`'s `assertSupportedTokenAddress()` is the gate
that must run before any transaction is built for an unfamiliar token address. It:

1. Rejects a malformed/invalid Stellar contract address.
2. Rejects an address with no matching entry in the canonical `TOKEN_METADATA` registry
   (`config/tokens.ts`) — an "unsupported asset form".
3. Rejects an address that isn't present in the live on-chain whitelist (when the whitelist is
   non-empty).

This is already wired into listing creation, auction creation, and launchpad collection creation
(`useMarketplace.ts`, `useAuctions.ts`, `useLaunchpad.ts`). It is also invoked immediately before
`buy_artwork` inside `useBuyArtwork` (`useMarketplace.ts`), so a listing whose payment token has
since become unsupported can never reach a wallet-signing prompt, let alone settlement.

---

## 5. Related files

- `contracts/soroban-marketplace/src/types.rs` — `MarketplaceError::InvalidTokenAsset`, and doc
  comments on `Listing::token` / `Listing::price` clarifying the base-unit contract.
- `contracts/soroban-marketplace/src/contract.rs` — `validate_token_asset`, and its call sites in
  `add_token_to_whitelist`, `create_listing`, `update_listing`, `create_auction`, `make_offer`.
- `frontend/elcarehub-app/src/config/tokens.ts` — `AssetIdentity`, `getAssetIdentity`,
  `isSupportedAsset`, `baseUnitsToDisplay`, `displayToBaseUnits`.
- `frontend/elcarehub-app/src/lib/token-support.ts` — `assertSupportedTokenAddress`.
- `indexer/src/token-metadata.ts` — `getTokenDecimals`, `baseUnitsToDecimalString`,
  `withDecimalAmounts`.
- `indexer/src/api/routes.ts` — `serializeListing(s)`, `serializeAuction(s)`, `serializeOffers`.
- `indexer/src/api/openapi.ts` — `ListingSchema` / `AuctionSchema` / `OfferSchema` field docs.
