# E2E Wallet Failure Matrix — Release Report

Issue #525. A compact, deterministic Playwright suite
(`tests/e2e/wallet-failure-matrix.spec.ts`) that exercises the purchase
write surface (checkout / `buy_artwork`) against nine wallet, RPC, chain,
and indexer failure scenarios, run against the existing E2E mock chain
(`NEXT_PUBLIC_E2E_MOCK_CHAIN=true`) — no real wallet, RPC, or indexer is
ever contacted, and no secrets are required. CI wiring:
`.github/workflows/e2e-wallet-failure-matrix.yml`, run via
`npm run test:e2e:wallet-matrix`.

## How failures are injected

`src/lib/e2e-chain-mock.ts` exposes `window.__E2E_SET_FAILURE_MODE__`,
registered on first paint by `E2eMockChainInit`. Setting a mode makes the
next mock `buy_artwork` call throw an error worded the way a real
Freighter / Soroban RPC / Horizon failure would word it, so the suite
exercises the app's real `classifyTxError` → `TxErrorPanel` code path —
the mock only decides *when* to fail, never how the app reacts.

## Scenario coverage

| # | Scenario | How it's forced | What's asserted |
|---|----------|------------------|------------------|
| 1 | Rejection | `wallet_rejection` failure mode | `tx-error-panel` visible, "declined" messaging, checkout stays open and editable, no full public key leaked into the error surface |
| 2 | Disconnect | No wallet connected, click Buy Now | `GuardButton` opens the Connect Wallet modal instead of checkout — no crash |
| 3 | Network mismatch | `mockFreighterWrongNetwork` | Wrong-network messaging shown, checkout never opens |
| 4 | Simulation failure | `simulation_failure` failure mode | `tx-error-panel` with "refresh and retry" guidance |
| 5 | Insufficient balance | `insufficient_balance` failure mode | Funds-specific message; raw technical detail only behind the collapsed "Technical details" `<details>` |
| 6 | Submission timeout | `submission_timeout` failure mode (delayed `ETIMEDOUT`) | Network-error panel with retry |
| 7 | Chain failure | `chain_failure` failure mode (Horizon 503) | Network-error panel with retry |
| 8 | Indexer lag | Normal success path | Transient "Waiting for indexer confirmation…" button label is reachable |
| 9 | Reorg reset | Indexer briefly reports the sold listing as `Active` again, then reconciles | No crash, no `tx-error-panel`, and the UI ends up consistent with the latest indexer response |

## Known limitations

- **Single write surface.** The matrix currently drives everything through
  the purchase flow, since it's the only write path the existing mock
  chain (`e2eMockBuyArtwork`) supports end-to-end. Listing creation,
  bidding, and offers are covered by other suites
  (`listing-flow.spec.ts`, `auction-flow.spec.ts`, `offers-flow.spec.ts`)
  but not yet by this failure-mode injection mechanism. Extending
  `setE2eFailureMode`/`maybeThrowForFailureMode` to those mock entry
  points is straightforward follow-up work.
- **Indexer lag is not waited out.** In production,
  `useTxLifecycle`'s `indexer_pending` phase waits up to
  `indexerConfirmTimeoutMs` (default 30s) before declaring success. The
  mock chain never returns a trackable tx hash, so the RPC-confirmation
  phase is skipped entirely and the flow goes straight to
  `indexer_pending`. The test asserts the transient "Waiting for indexer
  confirmation…" state is reachable but does not wait out the full 30s
  to observe the eventual `success` transition, to keep the suite fast.
- **`indexer_delay` as a terminal error category is effectively dead code
  today.** Reading `useTxLifecycle.run()`, the `indexer_pending` phase
  always resolves to `success` after the timeout elapses — nothing in the
  current lifecycle ever sets `error.category = "indexer_delay"`. The
  `IndexerDelayNotice` UI component exists and is wired into
  `TxErrorPanel`, but nothing currently triggers it. This suite therefore
  cannot exercise that specific UI state and treats indexer lag as the
  transient in-flight label instead. Worth a follow-up issue.
- **"Reorg reset" models an indexer reconciliation blip, not a true
  consensus reorg.** Stellar/Soroban has fast finality; there is no
  chain-level reorg concept comparable to probabilistic-finality chains.
  The scenario instead validates the practical equivalent: the read model
  (indexer) can present a transient inconsistency, and the UI must
  recover to the correct state on the next fetch without getting stuck or
  leaking raw diagnostic state.
- **First-compile latency in constrained sandboxes.** Next.js dev-mode
  compiles routes on first request. In a CPU-constrained environment
  (observed while developing this suite) that first compile — running
  concurrently with a Playwright-launched browser — took noticeably
  longer than a standalone `curl` timing of the same route suggested.
  Page-load assertions in this suite use a 60s timeout to absorb that;
  real CI runners with more consistent CPU should compile well within
  it, but if this suite is flaky in a given CI environment, that's the
  first thing to check.

## Two pre-existing bugs fixed to make this suite runnable

Both were already broken on `main`, independent of this issue, but
blocked the app from compiling / rendering at all:

- `src/components/ListingCard.tsx` contained the entire component defined
  twice back-to-back (duplicate imports, duplicate `export function
  ListingCard`), which broke the Next.js build for every page that
  renders a listing card. Removed the stale, older duplicate.
- `src/components/TxErrorPanel.tsx` and `src/components/WalletErrorDisplay.tsx`
  each had a string literal with unescaped nested double quotes — a
  syntax error blocking compilation of any file importing them (which
  includes every write-action surface in the app).
