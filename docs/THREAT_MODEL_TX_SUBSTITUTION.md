# Threat Model — Wallet Transaction Substitution (Issue #536)

This is a focused deep-dive on one entry from `docs/THREAT_MODEL.md` §3
("Wallet phishing / UI redress"): the risk that the transaction a user is
shown does not match the transaction their wallet is actually asked to sign.
It documents the threat, the mitigations added in this change, how to
verify them, and — per the acceptance criteria for Issue #536 — the
residual risk that remains outside this application's control.

---

## 1. The threat

**Transaction substitution**: something between "the user reviews a
transaction summary" and "the wallet signs bytes" swaps in a different
transaction than the one displayed — same UI, different outcome.

### 1.1 Attacker capabilities considered

- **Malicious or compromised browser extension.** A browser extension with
  page-script access (not necessarily a wallet extension) can monkey-patch
  `window.freighter`, intercept the `signTransaction` call, or mutate a
  variable holding an XDR string before it reaches the wallet bridge.
- **Compromised frontend build / supply-chain.** A tampered dependency or a
  compromised build/deploy pipeline could ship JavaScript that constructs a
  different transaction than what the confirmation UI rendered, while
  reusing the same UI components so nothing looks different to the user.
- **Stale or incorrect network/contract configuration.** A misconfigured
  `NEXT_PUBLIC_CONTRACT_ID` / `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE`, or a
  build that mixes environments, could cause the app to silently target the
  wrong contract or network while displaying the intended one.

### 1.2 Why the existing preflight guard is not sufficient

`lib/preflight.ts` (`assertWritePreflight`, Issue #305) checks that the
**wallet's** connected network passphrase matches the app's configured
passphrase, and that a contract ID is configured, immediately before a
transaction is built. That closes a real gap (mid-session network switches),
but it says nothing about:

- whether the **method** being invoked is the one the user was shown,
- whether the **arguments** (recipient, amount, asset/token, listing ID,
  etc.) match what was displayed, or
- whether the transaction object **itself** was substituted or mutated
  after preflight passed but before signing.

Those are exactly the gaps this change closes.

---

## 2. Mitigations added

### 2.1 Canonical transaction intent (`src/lib/tx-intent.ts`)

`buildTransactionIntent(tx)` decodes a real, assembled Soroban `Transaction`
into a small, stable, JSON-safe `TransactionIntent`:

```
{ method, contractId, networkPassphrase, sourceAccount, args: [{ index, label, value }, ...] }
```

This is the **single canonical representation** used both to render the
confirmation UI and to verify what is about to be signed — there is no
second, independently-hand-rolled "display" code path that could silently
drift from the real arguments.

**Included** (all user-verifiable, all public/on-chain once submitted):
`method`, `contractId`, `networkPassphrase`, `sourceAccount`, and labelled
call arguments (recipient/counterparty addresses, amounts, asset/token
addresses, listing/auction IDs).

**Deliberately redacted / omitted** (not user-verifiable or not
security-relevant, so they are excluded to keep the comparison meaningful
and avoid false-positive noise):

| Field | Why it's excluded |
|---|---|
| Sequence number | Internal replay-protection bookkeeping; not something a user can meaningfully verify |
| Fee / resource fee | Varies per simulation attempt; already shown separately in the settlement preview |
| Time bounds | Internal replay-protection plumbing |
| Soroban resource footprint / instructions | Internal execution metadata, meaningless to a human reviewer |
| Signatures | Never present before signing |

Decoding **fails closed**: if a transaction has no `invokeHostFunction`
contract-call operation, `buildTransactionIntent` throws rather than
returning an empty/placeholder intent that would silently pass comparison.

### 2.2 Runtime pre-sign assertion (`src/lib/contract.ts`, `invokeContract`)

Every write flow in the app funnels through `invokeContract()`. Immediately
after the transaction is assembled and immediately before
`signWithFreighter()` is called, the guard:

1. Builds the intent from `preparedTx` (the object just assembled).
2. Independently **re-parses the literal `txXdr` string** that is about to
   be passed into the wallet adapter's `signTransaction` — via
   `TransactionBuilder.fromXDR(txXdr, networkPassphrase)` — and builds the
   intent from that. Re-deriving from the exact bytes about to cross the
   wallet boundary (rather than trusting the in-memory object was not
   mutated) is what makes this a check of what the wallet will actually
   see.
3. Compares the two (`intentsMatch`). Any difference aborts before the
   wallet is ever asked to sign, and throws `TxIntentMismatchError`.
4. When the calling UI supplied the intent it actually rendered
   (`expectedIntent` — wired for the `buy_artwork` / checkout flow via
   `buildExpectedBuyArtworkIntent`), that is compared too. This is the
   literal "confirmation summary vs. exact args sent to the wallet" check.

Any mismatch in `method`, `contractId`, `networkPassphrase`,
`sourceAccount`, or any argument (recipient, amount, asset, listing/auction
ID, etc.) is treated as fatal. Signing never proceeds past a detected
mismatch.

### 2.3 Confirmation UI derived from the same intent (`CheckoutModal.tsx`)

The checkout confirmation modal's "Transaction Details" panel renders
`buildExpectedBuyArtworkIntent(listing.listing_id, buyerPublicKey)` —
the exact same construction logic `buyArtwork()` uses for its real
on-chain arguments — rather than a separately hand-rolled summary. The
same object is passed down (built independently, by the same pure
function, from the same listing/buyer inputs) to the pre-sign guard in
§2.2, so the UI and the guard are provably looking at the same data.

### 2.4 Diagnostic event, no secrets (`src/lib/wallet-telemetry.ts`)

`walletTelemetry.txIntentMismatch(context, method, contractId, mismatchedFields)`
fires the `tx_intent_mismatch` PostHog event whenever any of the checks in
§2.2 fail. The payload contains only:

- `context` — which check failed (`pre_sign_self_check`,
  `pre_sign_xdr_decode`, `confirmation_ui_vs_signing_tx`)
- `method`, `contract_id` — public transaction parameters, not secrets
- `mismatched_fields` — **field names only** (e.g. `"args[1].amount"`,
  `"contractId"`), never the mismatched values themselves, and never
  wallet secrets (keys, seeds, signatures — none of which this code path
  ever touches; it only reads an unsigned `Transaction` object).

`useTxLifecycle.classifyTxError` recognizes `TxIntentMismatchError` by name
(not message content) and categorizes it as `intent_mismatch`, so it is
never mis-bucketed as a generic failure and always produces a clear,
non-alarming user-facing message ("we stopped before asking your wallet to
sign").

---

## 3. What this protects, precisely

This change protects the boundary between **"this application assembled a
transaction"** and **"this application's code handed bytes to the wallet
adapter."** Concretely:

- If a compromised bundle or malicious extension shim alters the
  transaction between assembly and the `signTransaction` call, §2.2 step 3
  detects it (self-check).
- If the transaction handed to the wallet does not match what the
  confirmation UI told the user, §2.2 step 4 detects it (UI-vs-signing
  check, wired for the checkout/purchase flow).
- If the transaction cannot be decoded as a recognizable contract call at
  all, decoding fails closed rather than passing silently.

---

## 4. Residual risk — the wallet's own confirmation UI is out of scope

**This is the most important limitation to state plainly.** Everything in
§2 verifies data **inside this application**, up to the moment the signed
bytes are handed to the wallet extension/app. It cannot verify — and no
purely application-side mitigation can verify — that:

- The wallet extension (Freighter, LOBSTR, etc.) or Magic.link's own
  confirmation screen **renders** the transaction it received correctly to
  the user.
- A compromised or malicious wallet extension **itself** doesn't lie about
  what it is signing, once it has received a valid, unmodified XDR blob
  from this app.
- The user actually reads and verifies the wallet's own summary before
  approving.

In other words: this change closes the gap between "what our frontend
computed" and "what our frontend sent to the wallet." It does **not**, and
cannot, close the gap between "what the wallet received" and "what the
wallet's own UI displays to the human." That gap is owned by the wallet
provider, not by this application, and is explicitly out of scope here.

This mirrors the existing `docs/THREAT_MODEL.md` §3 "Wallet phishing / UI
redress" entry's residual risk rating (**Medium** — dependent on user
vigilance and browser-extension security) — this change lowers the
likelihood of *this app* being the source of a substituted transaction, but
does not and cannot change the wallet-provider-UI risk rating.

**Mitigating factors outside this app's control that reduce, but do not
eliminate, this residual risk:**
- Reputable wallet extensions (Freighter) are open-source and widely
  audited by the Stellar ecosystem.
- Freighter and similar wallets display the raw operation/method/args on
  their own confirmation screen, giving the user an independent
  cross-check against this app's confirmation UI — but only if the user
  looks at both.

**What users/operators should still do:**
- Encourage users to install wallet extensions from official sources only.
- Encourage users to compare the wallet's own summary against the app's
  confirmation screen before approving, especially for high-value
  transactions.
- Treat any wallet prompt that doesn't match the in-app confirmation as a
  reason to reject and investigate, not merely a UI glitch.

---

## 5. Test coverage

`src/__tests__/tx-intent.test.ts` covers, per the Issue #536 acceptance
criteria, substitution of each of: modified arguments, contract ID,
network, asset, recipient, and amount — asserting each is detected by
`intentsMatch` and that `assertIntentsMatch` throws `TxIntentMismatchError`
without leaking argument values in its message. It also covers the
fail-closed behavior for a non-contract-invocation transaction, and that
`buildExpectedBuyArtworkIntent` (the UI-side intent) matches the intent
decoded from a genuinely assembled `buy_artwork` transaction.

`src/__tests__/useTxLifecycle.test.tsx` covers that `TxIntentMismatchError`
is classified as `intent_mismatch` by name, independent of message wording.
