# Contract ID & Network Settings Consistency Checklist

**Owner:** Backend Lead (contract IDs) · DevOps (network settings + deploy outputs) · Frontend Lead (`NEXT_PUBLIC_*` wiring)
**Last reviewed:** 2026-11-21

Contract IDs and Stellar network settings must be identical across the
frontend, the indexer, the shared config package, and the deployment scripts.
A drift here (frontend pointed at mainnet while the indexer still reads
testnet, or the two services pointed at different contract IDs) produces
silent, hard-to-diagnose failures — the indexer watches one contract while the
frontend renders data for another. This checklist makes the required fields,
where they live, and how to verify them explicit and repeatable.

> **Read-only.** The checklist and its validator
> ([`scripts/check-contract-network-consistency.mjs`](../scripts/check-contract-network-consistency.mjs))
> parse only committed placeholder templates (`*.env.example`) and the deploy
> shell scripts. They never load real environment, never write, and contain no
> secrets.

---

## 1. Required fields

| Field | Required | Format | Notes |
|---|---|---|---|
| Marketplace contract ID | yes (post-deploy) | 56 chars, starts with `C` | Empty in templates until a deployment writes it |
| Launchpad contract ID | yes (post-deploy) | 56 chars, starts with `C` | Same |
| `STELLAR_NETWORK` | yes | `testnet` \| `mainnet` | Drives the passphrase |
| `STELLAR_NETWORK_PASSPHRASE` | yes | must match the network above | Empty in `indexer/.env.example` means "derive from `STELLAR_NETWORK`" |
| `STELLAR_RPC_URL` | yes | `https://…` | Soroban RPC endpoint |
| `STELLAR_HORIZON_URL` | yes | `https://…` | Horizon REST endpoint |
| `INDEXER_URL` | yes (frontend/config) | `http(s)://…` | The indexer's own base URL; the indexer does not set its own |

## 2. Where each field must appear (and stay in sync)

| Field | Frontend `frontend/elcarehub-app/.env.example` | Indexer `indexer/.env.example` | Shared config `packages/config/.env.example` | Deployment |
|---|---|---|---|---|
| Marketplace contract ID | `NEXT_PUBLIC_CONTRACT_ID` | `MARKETPLACE_CONTRACT_ID` | `MARKETPLACE_CONTRACT_ID` | `scripts/deploy/deployed_ids.env` → `MARKETPLACE_CONTRACT_ID`; deploy writes `NEXT_PUBLIC_CONTRACT_ID` into frontend `.env.local` |
| Launchpad contract ID | `NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID` | `LAUNCHPAD_CONTRACT_ID` | `LAUNCHPAD_CONTRACT_ID` | `deployed_ids.env` → `LAUNCHPAD_CONTRACT_ID` |
| Network | `NEXT_PUBLIC_STELLAR_NETWORK` | `STELLAR_NETWORK` | `STELLAR_NETWORK` | `.env.deploy` → `NETWORK` |
| Network passphrase | `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | `STELLAR_NETWORK_PASSPHRASE` | `STELLAR_NETWORK_PASSPHRASE` | `deploy_contract.sh` / `deploy_launchpad.sh` pass `--network-passphrase` |
| Soroban RPC URL | `NEXT_PUBLIC_STELLAR_RPC_URL` | `STELLAR_RPC_URL` | `STELLAR_RPC_URL` | `.env.deploy` → `RPC_URL` |
| Horizon URL | `NEXT_PUBLIC_STELLAR_HORIZON_URL` | `STELLAR_HORIZON_URL` | `STELLAR_HORIZON_URL` | `.env.deploy` → `HORIZON_URL` |
| Indexer URL | `NEXT_PUBLIC_INDEXER_URL` | — (the indexer *is* the service) | `INDEXER_URL` | — |

`versions.toml` is the source of truth for **component versions**
(`contract_version`, indexer/frontend versions, `event_schema`) — validated by
`bash scripts/validate-compatibility.sh` — not for contract IDs. The on-chain
`contract_version` it records must correspond to the deployed contract ID
above, but the ID itself is not stored in `versions.toml`.

### How a deployed contract ID reaches each component

1. `scripts/deploy/deploy_contract.sh` deploys the contract and writes
   `MARKETPLACE_CONTRACT_ID` (+ `NETWORK`, `RPC_URL`) to
   `scripts/deploy/deployed_ids.env`.
2. `deployed_ids.env` is sourced to populate the indexer's `MARKETPLACE_CONTRACT_ID`.
3. The same script writes `NEXT_PUBLIC_CONTRACT_ID` into
   `frontend/elcarehub-app/.env.local`.

All three must hold the same ID after a deploy. The checklist's validator
checks the committed templates for consistency; after a real deploy, confirm
`deployed_ids.env`, the indexer env, and the frontend `.env.local` agree by
inspection (those runtime files are gitignored).

## 3. Verification commands

```bash
# 1. Cross-file consistency of contract IDs + network settings across the
#    committed templates AND the deploy scripts' hardcoded --network-passphrase.
#    Read-only. This is the gate wired into CI (contract-network-consistency).
node scripts/check-contract-network-consistency.mjs

# 2. Format/presence of a loaded config (network passphrase matches network,
#    contract IDs are 56 chars starting with 'C', URLs valid, operator token
#    length). Run before starting any component; CI runs it with placeholder env.
node scripts/validate-config.js

# 3. Component-version consistency (versions.toml ↔ package.json / Cargo.toml /
#    openapi.json / latest Prisma migration). Complementary, not contract IDs.
bash scripts/validate-compatibility.sh
```

## 4. Known limitation: deploy scripts hardcode the testnet passphrase

`deploy_contract.sh` and `deploy_launchpad.sh` currently pass
`--network-passphrase "Test SDF Network ; September 2015"` (testnet). The
consistency validator's Check D catches the case where the templates are
flipped to `mainnet` but the deploy scripts still hardcode the testnet
passphrase. Before any mainnet deployment, parameterize the passphrase in both
deploy scripts (read it from `.env.deploy` like `RPC_URL`/`NETWORK`) so it can
no longer drift from the templates.

## 5. Ownership, trigger, expected output, rollback / escalation

| | |
|---|---|
| **Owner** | Backend Lead owns contract IDs; DevOps owns network settings + deploy outputs; Frontend Lead owns `NEXT_PUBLIC_*` wiring |
| **Trigger** | `contract-network-consistency` job in `.github/workflows/ci.yml` runs on every push/PR; local: `node scripts/check-contract-network-consistency.mjs`; also run pre-deploy and post-deploy |
| **Expected output** | Exit 0 + `✓ contract IDs & network settings consistent …`. Exit 1 naming the conflicting field and which file holds which value |
| **Rollback** | A mismatch is a config error, not a deployed-state change — fix the offending template/deploy file to match the source of truth (`deployed_ids.env` for IDs, the network you intended for settings), re-run the check, and re-apply the runtime env. Contracts are immutable: a wrong contract ID that reached production is fixed by re-pointing consumers (indexer + frontend env) from `deployed_ids.env` and restarting, **not** by redeploying the contract |
| **Escalation** | Repeated drift between deploy outputs and templates → DevOps; a wrong contract ID that reached production users → Security Lead + Backend Lead (coordinated re-point, per [`docs/runbooks/`](./runbooks/)) |

## Change log

| Date | Change |
|---|---|
| 2026-11-21 | Initial checklist + `check-contract-network-consistency.mjs` read-only validator + CI gate |
