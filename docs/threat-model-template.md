# Threat Model — [Feature / Change Title]

> Complete this template for every change that touches: contract entry points,
> settlement logic, authorization, signatures, storage layout, events, or
> deployment scripts. Link the completed record to your pull request.
>
> **Reviewer**: a second engineer who did not author the change must sign off
> on every High-risk item before the PR can merge.

---

## 1. Change summary

| Field | Value |
|---|---|
| PR / branch | |
| Author | |
| Independent reviewer | |
| Date | |
| Affected contracts | `soroban-marketplace` / `launchpad` / `collection_nft_erc721` / `collection_nft_erc1155` / `lazy_mint_erc721` / `lazy_mint_erc1155` |
| Affected entry points | _(list function names)_ |

---

## 2. Assets and trust boundaries

List every asset whose confidentiality, integrity, or availability this change could affect.

| Asset | Description | Owner |
|---|---|---|
| Seller proceeds | XLM / token funds held in active listings | Seller |
| Auction escrow | Bid amounts held until finalization | Bidder |
| Royalty streams | Splits paid to recipients on settlement | Recipients |
| Admin privileges | pause, set_fee, revoke_artist, token whitelist | Admin wallet |
| NFT ownership | Token ownership state stored in collection contract | Token holder |
| Offer escrow | Token amounts locked by pending offers | Offerer |

**Trust boundaries crossed by this change** (delete inapplicable):

- [ ] User wallet → contract (user-initiated call)
- [ ] Contract → external token contract (cross-contract call)
- [ ] Contract → launchpad / collection contract (factory call)
- [ ] Admin wallet → contract (privileged call)
- [ ] Indexer → contract (read-only, but confirm no write path exists)
- [ ] Frontend → indexer (API call — validate inputs)

---

## 3. Attacker capabilities assumed

Check all that apply for this change:

- [ ] Can observe all on-chain transactions and pending operations
- [ ] Can submit arbitrary transactions from any address
- [ ] Can front-run or sequence transactions within a ledger
- [ ] Can deploy malicious token / NFT contracts
- [ ] Can call any public entry point of the contract
- [ ] Controls a revoked or compromised artist wallet
- [ ] Has read access to the indexer API (unauthenticated)
- [ ] Can replay a previously valid transaction signature

---

## 4. Threat checklist

For each item, record: **Status** (✅ Not applicable / ⚠️ Mitigated / ❌ Open finding) and a brief note.

### 4.1 Funds and payment integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| F-1 | Settlement sends incorrect amounts to seller, recipients, or fee treasury | | |
| F-2 | Royalty basis-point arithmetic overflows or rounds in attacker's favour | | |
| F-3 | Token address substitution — attacker substitutes a different token at settlement time | | |
| F-4 | Double-spend — same listing/auction/offer can be settled more than once | | |
| F-5 | Bid escrow leak — losing bid funds not refunded on auction finalization or cancellation | | |
| F-6 | Offer escrow leak — offer funds not returned on withdrawal, rejection, or expiry | | |

### 4.2 Ownership and authorization

| # | Threat | Status | Notes |
|---|---|---|---|
| A-1 | Unauthorized caller can invoke an owner-only or admin-only function | | |
| A-2 | Ownership transfer (propose → accept) can be hijacked or skipped | | |
| A-3 | A revoked artist's listings or auctions remain settleable after revocation | | |
| A-4 | Collection factory deploys a contract owned by a different address than the creator | | |
| A-5 | A blocked bidder can still place bids via a proxy address | | |

### 4.3 Replay and signature integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| R-1 | A signed lazy-mint voucher can be replayed after it has been used | | |
| R-2 | A voucher signed for one collection can be used against a different collection | | |
| R-3 | A stale Freighter-signed transaction is submitted after the user's intent changed | | |
| R-4 | Network passphrase mismatch — transaction built for testnet accepted on mainnet | | |

### 4.4 Denial of service

| # | Threat | Status | Notes |
|---|---|---|---|
| D-1 | Entry point can be made to exceed Soroban instruction limit (compute DoS) | | |
| D-2 | Storage key enumeration allows storage exhaustion by an attacker | | |
| D-3 | Circuit-breaker can be toggled by a non-admin caller | | |
| D-4 | Auction extension mechanism can be abused to extend indefinitely | | |

### 4.5 Privacy

| # | Threat | Status | Notes |
|---|---|---|---|
| P-1 | Sensitive metadata stored on-chain or in events is exposed publicly | | |
| P-2 | Artist's wallet address or earnings data is exposed via indexer API without consent | | |

### 4.6 Storage migration

| # | Threat | Status | Notes |
|---|---|---|---|
| M-1 | New storage keys conflict with existing keys from a prior contract version | | |
| M-2 | A migration step can be replayed after it has already been applied | | |
| M-3 | Existing listings/auctions/offers become unreadable after the upgrade | | |
| M-4 | Rollback to a previous WASM is blocked by a forward-incompatible storage change | | |

### 4.7 Event integrity

| # | Threat | Status | Notes |
|---|---|---|---|
| E-1 | An event is emitted with incorrect data (wrong IDs, amounts, or addresses) | | |
| E-2 | An event can be emitted by an unauthorized caller (spoofing indexer state) | | |
| E-3 | A new event type is unrecognized by the indexer, causing silent data loss | | |

---

## 5. Abuse cases for this change

Describe how a sophisticated attacker would attempt to exploit the specific code paths introduced.
Use the format: **"As [attacker], I will [action] in order to [goal]."**

1.
2.
3.

---

## 6. Flow-specific review (check the flows this change affects)

### Purchase flow (`buy_artwork`)
- [ ] Price and token match the listing at the time of the call (no TOCTOU)
- [ ] All recipient splits sum to ≤ 100%
- [ ] Listing is marked as Sold before external token transfers
- [ ] Fee is deducted before royalty calculation

### Auction flow (`place_bid`, `finalize_auction`)
- [ ] Bid must exceed the current highest bid (no tie-winning)
- [ ] Previous highest bid is refunded before recording the new highest bid
- [ ] Finalization is only callable once per auction
- [ ] Creator receives proceeds only when reserve is met

### Offer flow (`make_offer`, `accept_offer`, `withdraw_offer`, `reclaim_offer`)
- [ ] Offer amount is escrowed on creation, not on acceptance
- [ ] Only the token owner (or the listing owner) can accept
- [ ] Expired offers are reclaimable by the offerer without owner consent
- [ ] Accepting an offer cancels all other open offers on the same token

### Lazy-mint flow (`lazy_mint_erc721`, `lazy_mint_erc1155`)
- [ ] Voucher is verified against the collection contract owner's key
- [ ] Voucher includes a nonce or token ID preventing replay
- [ ] Minter address in the voucher matches the caller

---

## 7. Findings

Document any open or mitigated findings. At least one must be filed per ❌ in section 4.

| ID | Severity | Description | Owner | Mitigation | Residual risk | Status |
|---|---|---|---|---|---|---|
| TM-001 | | | | | | Open / Mitigated / Accepted |

**Severity guide**: Critical → can drain funds or take admin control; High → significant value at risk; Medium → limited impact or requires specific conditions; Low → informational.

---

## 8. Reviewer sign-off

> The independent reviewer confirms they have read the diff, completed a
> line-by-line review of all affected entry points, and verified that every
> High or Critical finding in section 7 is either mitigated or has an
> accepted residual risk with documented owner.

| Role | Name / handle | Date | Signature |
|---|---|---|---|
| Author | | | |
| Independent reviewer | | | |

---

## 9. Release linkage

| Field | Value |
|---|---|
| Reviewed source revision (git SHA) | |
| Deployed contract hash (WASM SHA-256) | |
| Release tag | |
| Deployment runbook link | |
