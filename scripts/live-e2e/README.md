# Live Integration Environment

A repeatable, disposable environment that runs the marketplace/launchpad
contracts, PostgreSQL, Redis, the indexer, and the frontend against **real**
Stellar testnet infrastructure — no mocked wallet, no mocked chain, no mocked
indexer. It exists to catch the class of bug the mocked `tests/e2e` suite
structurally cannot: wrong contract argument order/types, Soroban events the
indexer's parser doesn't recognize, indexer replication lag, and real
wallet/network configuration mismatches.

## Strategy: disposable testnet, not a local sandbox

This reuses the existing, already-idempotent deploy tooling in
`scripts/deploy/` against Stellar **testnet** rather than standing up a local
Soroban sandbox/validator. That keeps behavior identical to what actually
runs in production (real RPC, real ledger close times ~5s, real fee/resource
limits) at the cost of needing network access and being slower than a local
sandbox. Contract IDs are deterministic *within a run* (recorded in
`scripts/deploy/deployed_ids.env` and `scripts/live-e2e/seed_ids.env`) but a
fresh deploy gets fresh IDs — this is a disposable environment, not a fixed
one.

## Prerequisites

Same as `scripts/deploy/` (Stellar CLI, `jq`, `curl`), plus Docker with the
Compose v2 plugin. Bash-only tooling — run under WSL/Git Bash on Windows.

## Usage

```bash
# 1. Deploy contracts, seed on-chain state, and bring up the stack.
npm run live-e2e:setup

# 2. Run the live suite (sources scripts/live-e2e/.env.live-e2e for you).
npm run live-e2e:test

# 3. Tear down (collects logs to scripts/live-e2e/artifacts/<timestamp>/ first).
npm run live-e2e:teardown
```

Iterating on tests without redeploying contracts every time:

```bash
npm run live-e2e:setup -- --skip-deploy   # reuses scripts/deploy/deployed_ids.env
```

## What gets seeded

`seed.sh` deploys one Normal-721 collection and seeds three independent
tokens so the purchase, auction, and offer flows never contend for the same
listing:

| Token | Flow            | Seeded state                          |
|-------|-----------------|----------------------------------------|
| #0    | Direct purchase | Listed for 15 XLM                      |
| #1    | Auction         | Reserve 5 XLM, 1 hour duration         |
| #2    | Offer           | Listed for 30 XLM (offer flow leaves it listed) |

A second funded testnet keypair (independent of the deployer/seller) is
generated as the "buyer" for every flow.

## Isolation from the mocked suite

- **Config**: `playwright.live.config.ts` (testDir `tests/live-e2e`,
  matches `*.live.spec.ts`) is entirely separate from `playwright.config.ts`
  (testDir `tests/e2e`). Running `npm run test:e2e` never picks up live
  tests, and `npm run test:e2e:live` never picks up mocked ones.
- **No shared `webServer`**: the mocked config boots its own dev server with
  `NEXT_PUBLIC_E2E_MOCK_CHAIN=true`; the live config assumes
  `docker-compose.live-e2e.yml` is already running and never mocks the
  chain.
- **Wallet**: `tests/e2e/freighter-mock.ts` fakes the entire chain.
  `tests/live-e2e/helpers/real-signer.ts` shims only the wallet extension
  surface with a *real* signer backed by a real keypair — every transaction
  it produces is genuinely submitted and confirmed on testnet.

## Diagnosing a failure

`scripts/live-e2e/collect-logs.sh` (also run automatically by
`teardown.sh` unless `--skip-logs` is passed) writes per-service container
logs, `docker compose ps` output, indexer health/sample responses, seeded
contract IDs, and indexer DB row counts to
`scripts/live-e2e/artifacts/<timestamp>/`.
