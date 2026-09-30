# Token Onboarding & Revocation Runbook

Operators use this runbook to add or remove a payment token from the marketplace whitelist with a reviewed, repeatable procedure. It combines on-chain whitelist behavior, frontend metadata, indexer serialization, admin controls, and communication requirements.

**Related:** [payment-tokens.md](../guides/payment-tokens.md) · [contract-pause.md](./contract-pause.md) · [financial-reconciliation-runbook.md](../financial-reconciliation-runbook.md)

---

## Acceptance criteria

| Criterion | Verification |
|-----------|--------------|
| Repeatable reviewed procedure | Two operators sign off on the checklist below before mainnet changes |
| Revocation behavior documented | §7 — existing listings after emergency removal |
| No unverified token shown as supported | Frontend `assertSupportedTokenAddress` + indexer `/tokens` must agree with on-chain whitelist |

---

## 1. Eligibility & issuer verification

Before any whitelist transaction:

1. **Asset type** — Token must be a Stellar Asset Contract (SAC) with a `C...` address, or the network-native XLM SAC.
2. **Issuer verification** — Confirm the issuing account / anchor via:
   - Stellar Expert or official issuer documentation
   - Treasury wallet ownership (see §5)
   - Compliance review for restricted jurisdictions (internal policy)
3. **Liquidity** — Token must have sufficient on-network liquidity for settlement; document DEX pools or OTC arrangements.
4. **Decimals confirmation** — Read on-chain `decimals()` if available; Stellar classic assets use **7** decimals. Non-7 values require explicit engineering sign-off (see §3).
5. **Symbol uniqueness** — Symbol must not collide with an existing `TOKEN_METADATA` entry in `frontend/elcarehub-app/src/config/tokens.ts`.

Record verification evidence in the change ticket (issuer URL, ledger of test transfer, reviewer names).

---

## 2. Three-layer identity model

| Layer | Source of truth | Onboarding action |
|-------|-----------------|-------------------|
| On-chain | `add_token_to_whitelist` / `remove_token_from_whitelist` in `contracts/soroban-marketplace` | Admin signs Soroban tx |
| Frontend | `config/tokens.ts` → `TOKEN_METADATA`, `SUPPORTED_TOKENS` | PR + deploy with env vars |
| Indexer | `indexer/src/token-metadata.ts` + optional `TOKEN_DECIMALS_JSON` | Deploy indexer with env override if decimals ≠ 7 |

**Rule:** A token is **not supported** until all three layers agree. The frontend gate (`lib/token-support.ts` → `assertSupportedTokenAddress`) rejects addresses missing from `TOKEN_METADATA` even if on-chain whitelisted.

When the on-chain whitelist is **empty**, the contract accepts any token address at settlement time; the frontend still restricts to configured metadata entries.

---

## 3. Decimal policy

- Contract stores opaque `i128` base units — never scales amounts.
- Indexer returns raw fields (`price`, `amount`, …) plus `<field>Decimal` siblings.
- Frontend converts with `baseUnitsToDisplay` / `displayToBaseUnits` using string/BigInt math only.

For a token with non-7 decimals:

1. Add entry to `TOKEN_METADATA` with correct `decimals`.
2. Set indexer `TOKEN_DECIMALS_JSON='{"C...ADDR":N}'`.
3. Run preflight (§9) and update `fixtures/test-token.json` if used in CI.

---

## 4. Onboarding procedure (add token)

### Pre-flight

```bash
bash scripts/preflight/token-onboarding.sh \
  --address CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  --symbol USDC \
  --decimals 7 \
  --network testnet
```

Resolve all errors before proceeding. See §9 for checks performed.

### Checklist

- [ ] Eligibility & issuer verification complete (§1)
- [ ] Preflight script exits 0
- [ ] Frontend PR adds `TOKEN_METADATA` + network address in `TOKEN_ADDRESSES_BY_NETWORK`
- [ ] Indexer `TOKEN_DECIMALS_JSON` updated if needed
- [ ] Second operator reviewed PR and verification evidence
- [ ] Test on testnet using `fixtures/test-token.json` as reference

### On-chain (admin)

Via admin UI (`/admin`) or CLI:

```bash
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --network testnet \
  --source admin \
  -- add_token_to_whitelist \
     --admin "$ADMIN_ADDRESS" \
     --token "$TOKEN_ADDRESS"
```

Contract emits `TokenWhitelisted` event (see `indexer/src/event-schemas.ts`).

### Off-chain deploy order

1. **Indexer** — deploy with decimal overrides; verify `GET /tokens` includes the new address after ingestion.
2. **Frontend** — deploy with token config + env vars (`NEXT_PUBLIC_*_TOKEN_CONTRACT_ID`).
3. **Communications** — announce supported payment option (§8).

### Post-deploy verification

```bash
# On-chain whitelist
stellar contract invoke --id "$MARKETPLACE" --network testnet -- get_token_whitelist

# Indexer
curl -s "$INDEXER_URL/tokens" | jq '.[] | select(.address=="'"$TOKEN_ADDRESS"'")'

# Frontend — create a 0.1 token test listing; confirm price display matches base units
```

---

## 5. Treasury handling

- Marketplace fees and royalties settle in the listing's payment token.
- After onboarding, confirm treasury / fee-recipient wallets can hold the new asset (trustline not required for SAC, but wallet UI must display it).
- Reconcile first settlements via [financial-reconciliation-runbook.md](../financial-reconciliation-runbook.md).

---

## 6. Indexer backfill

The poller ingests `TokenWhitelisted` / `TokenRemovedFromWhitelist` events into the `WhitelistedToken` table automatically. No manual backfill is required for new tokens.

If the indexer was down during the on-chain tx:

1. Confirm the event appears in Stellar RPC for the marketplace contract.
2. Trigger catch-up ingestion (poller resumes from `SyncState`) or operator backfill endpoint if configured.
3. Verify `GET /tokens` and listing `*Decimal` fields for existing listings using the token.

---

## 7. Revocation & emergency removal

### Standard removal

Same review process as onboarding. Order:

1. **Communications** — warn users that new listings/offers using the token will be blocked.
2. **On-chain** — `remove_token_from_whitelist` (admin UI or CLI).
3. **Off-chain** — remove or deprecate frontend metadata entry; deploy frontend + indexer.

### Effects on existing listings

| State | After revocation | User-visible behavior |
|-------|------------------|----------------------|
| **Active listing** (unsold) | Listing remains on-chain and in indexer DB | Frontend **blocks purchase** via `assertSupportedTokenAddress` before wallet prompt. Listing may still appear in API with historical token address; UI should show "payment token no longer supported" if surfaced. |
| **Active auction** | Auction remains; new bids using revoked token fail at contract | Bid UI disabled for unsupported token; existing highest bid stands until expiry/settlement rules apply. |
| **Open offers** | Offer remains on-chain | Acceptance/settlement blocked at frontend preflight. |
| **In-flight settlement** | Tx already submitted | Completes if mined before removal; otherwise fails with contract error. |
| **New listings/offers/auctions** | Contract rejects at creation if whitelist non-empty and token absent | Creation forms hide revoked token from `fetchSupportedTokens()`. |

**Emergency removal:** If the token is compromised or non-compliant, additionally:

1. Execute [contract-pause.md](./contract-pause.md) if active settlements must halt immediately.
2. Remove token from whitelist.
3. Post incident notice (§8).
4. Finance team reconciles any stuck escrow / partial settlements.

The indexer **never** promotes a token to "supported" without a matching `WhitelistedToken` row derived from chain events. API consumers should treat listings with unknown or revoked tokens as non-actionable for purchase.

---

## 8. Communication requirements

| Event | Audience | Channel | Content |
|-------|----------|---------|---------|
| Token added | All users | Status page, in-app banner | Symbol, supported actions, effective date |
| Token removed (planned) | Sellers using token | Email / in-app | Deadline, alternative tokens, listing impact |
| Emergency removal | All users | Status page | Reason (non-technical), pause state, support contact |
| Decimal correction | Integrators | GitHub release notes | API field behavior unchanged; display values corrected |

---

## 9. Preflight command

```bash
bash scripts/preflight/token-onboarding.sh --help
```

Checks:

- Stellar contract address format (`C` + 56 chars)
- Symbol present in `fixtures/test-token.json` schema or explicit `--symbol`
- Frontend `tokens.ts` contains metadata (or warns if pending PR)
- Decimals consistency across fixture, CLI arg, and optional `TOKEN_DECIMALS_JSON`
- Optional: live `get_token_whitelist` RPC call when `--network` provided

Root shortcut:

```bash
npm run preflight:token -- --address C... --symbol USDC --network testnet
```

---

## 10. Test token fixture

`fixtures/test-token.json` defines a disposable testnet token profile for CI and rehearsal:

```bash
cat fixtures/test-token.json
```

Use it in local/dev onboarding drills without production addresses. Override fields via env:

- `TEST_TOKEN_ADDRESS`
- `TEST_TOKEN_SYMBOL`
- `TEST_TOKEN_DECIMALS`

---

## 11. Admin controls reference

| Control | Location |
|---------|----------|
| Admin UI whitelist | `frontend/elcarehub-app/src/app/admin/page.tsx` |
| Contract methods | `add_token_to_whitelist`, `remove_token_from_whitelist`, `get_token_whitelist` |
| Frontend gate | `lib/token-support.ts` → `assertSupportedTokenAddress` |
| Indexer registry | `GET /tokens`, `token-metadata.ts` |

---

## Post-change review template

- [ ] Preflight log attached
- [ ] On-chain tx hash recorded
- [ ] Indexer `/tokens` verified
- [ ] Frontend purchase path smoke-tested
- [ ] Communications sent
- [ ] Incident / change ticket closed
