# Frontend Transaction Debugging Guide

This guide covers debugging wallet connections, Soroban transaction lifecycle, simulated contract calls, error mapping, and testing flows in the Next.js frontend application.

---

## 1. Transaction Lifecycle

Every write transaction performed by the user (e.g. buying an artwork, placing a bid, listing an NFT) follows this 5-stage lifecycle:

```
[1. User Action] ──► [2. Soroban Simulation] ──► [3. Wallet Signing]
                           │                             │
                           ▼                             ▼
                 `contract.ts` builds xdr        Freighter / Magic popup.
                 Simulates via RPC.              User approves / rejects.
                                                         │
                                                         ▼
[5. UI Refresh]  ◄── [4. RPC Submission & Indexer Wait] ─┘
  Reads updated      Tx submitted to Stellar.
  state from         UI polls Indexer until `txHash`
  Indexer REST API   or ledger is indexed.
```

---

## 2. Owning Files

- [`frontend/elcarehub-app/src/lib/contract.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/lib/contract.ts): Main Soroban SDK client for building and simulating transactions.
- [`frontend/elcarehub-app/src/lib/errors.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/lib/errors.ts): Soroban contract error code extractor (`extractSorobanContractCode`) and user rejection parser (`isUserRejectionError`).
- [`frontend/elcarehub-app/src/lib/freighter.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/lib/freighter.ts): Freighter wallet extension connection and signing adapter.
- [`frontend/elcarehub-app/src/lib/magic.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/lib/magic.ts): Magic.link SDK integration for email/passkey wallets.
- [`frontend/elcarehub-app/src/context/WalletContext.tsx`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/frontend/elcarehub-app/src/context/WalletContext.tsx): Global React context managing active wallet connection state.

---

## 3. Command Reference

### Local Development Server
```bash
cd frontend/elcarehub-app
npm run dev
```

### Run Component Unit Tests
```bash
cd frontend/elcarehub-app
npm run test
```

### Run Coverage & Threshold Enforcer
```bash
cd frontend/elcarehub-app
npm run test:coverage
```

### Run Accessibility (a11y) Audit Tests
```bash
cd frontend/elcarehub-app
npm run test:a11y
```

### Run End-to-End (E2E) Playwright Tests
E2E tests use a mock chain mode (`NEXT_PUBLIC_E2E_MOCK_CHAIN=true`) for deterministic execution:
```bash
cd frontend/elcarehub-app
npm run test:e2e
```

---

## 4. Error Diagnostics & Mapping

When a transaction fails, `frontend/elcarehub-app/src/lib/errors.ts` extracts the error code and maps it to a user-friendly message.

### Error Inspection Functions
- `isUserRejectionError(error)`: Detects if the user cancelled the signing popup in Freighter or LOBSTR.
- `extractSorobanContractCode(rawMessage)`: Extracts contract numeric code from Soroban RPC strings like `Error(Contract, #6)`.
- `mapSorobanErrorMessage(rawMessage)`: Maps code to human message (e.g. `You cannot buy your own listing. (code 6)`).

---

## 5. Decision Tree for Transaction Debugging

```
                      [ Transaction Failure in UI ]
                                    │
                                    ▼
                         Inspect Console & Toast Error
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
[ "User Rejected" ]          [ Simulation Error ]        [ "Contract Error #N" ]
       │                            │                            │
       ▼                            ▼                            ▼
 Expected behavior when       Contract execution failed   Look up error code in
 user cancels wallet          during preflight check.     `contracts/soroban-`
 popup. No retry needed.      Check balance/allowance     `marketplace/src/types.rs`
                              or parameter values.        or `lib/errors.ts`.
```

### First Diagnostic Steps for Common Failures

#### Failure 1: Freighter Extension Not Detected
* **Symptom:** UI displays "Freighter extension is not installed".
* **First Diagnostic Action:** Verify browser extension is installed and active. In dev tools console, run:
  ```js
  window.stellar
  ```
  Should return an object, not `undefined`.

#### Failure 2: Contract Error `#23` / Insufficient Token Balance
* **Symptom:** Toast error: `Insufficient token balance to complete this transaction. (code 23)`.
* **First Diagnostic Action:** Fund the test wallet using Stellar Laboratory Friendbot or verify account balance on testnet.

---

## 6. Safe Redaction Guidance

> [!WARNING]
> When debugging frontend transactions or submitting bug reports:

- **NEVER print or share private keys** starting with `S...`.
- **NEVER capture or share Magic.link API keys** or session tokens.
- Transaction hashes (`txHash: "a1b2c3d4..."`) and public Stellar addresses (`G...`) are public data and safe to share.
- Redact sensitive environment variables before attaching screenshots or logs:
  ```env
  NEXT_PUBLIC_STELLAR_NETWORK="testnet"
  NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY="pk_live_[REDACTED]"
  ```
