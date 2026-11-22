# Runbook: Indexer Startup Configuration Report

> Issue #1067. **Owner:** `@org/backend-lead-indexer` (code), `@org/devops` (per-environment values).
> **Code:** `indexer/src/startup-report.ts`, called from `indexer/src/index.ts` right after `loadConfig()`.
> **Tests / fixtures:** `indexer/src/__tests__/startup-report.test.ts`, `indexer/src/__tests__/helpers/startup-env-fixtures.ts`.

When the indexer API process starts, it writes one structured INFO log line listing the configuration
it booted with. It also writes one WARN line for each testnet/mainnet misconfiguration it finds.
Use the report to confirm a deploy targets the right network, contracts and backing services
**before** you trust any indexed data.

---

## 1. Startup sequence

| Step | Code | On failure |
|---|---|---|
| 1. Required variables present: `DATABASE_URL`, `REDIS_URL`, `STELLAR_RPC_URL`, `STELLAR_NETWORK`, and `MARKETPLACE_CONTRACT_ID` or `TRACKED_CONTRACTS` | `validateRequiredEnv()` (`indexer/src/config.ts`) | **Fatal.** The process exits `1` with one aggregated message that names the missing variables. |
| 2. Shared schema and cross-checks: network enum, passphrase ↔ network, 56-char `C…` contract IDs, `postgresql://` / `redis://` schemes, `OPERATOR_TOKEN` ≥ 32 chars | `loadConfig()` in `packages/config/src/index.ts` | **Fatal.** The message is prefixed `[NETWORK]`, `[CONTRACT]`, `[INDEXER]`, `[DATABASE]` and so on. |
| 3. Poll settings are positive integers: `POLL_INTERVAL_MS`, `MAX_LEDGERS_PER_CYCLE`, `CONFIRMATION_DEPTH`, … | `loadConfig()` (`indexer/src/config.ts`) | **Fatal** (thrown). |
| 4. **Startup configuration report** | `buildStartupConfigReport()` + `logStartupConfigReport()` | **Never fatal.** Problems become `WARN` lines. |

Step 2 also prints its own short `[CONFIG]` summary to stdout: network, RPC hostname, and the first
8 characters of each contract ID. The step 4 report is the complete, structured version.

---

## 2. What the report contains

| Field | Source setting(s) | What is reported | Never reported |
|---|---|---|---|
| `network` | `STELLAR_NETWORK` | the value (`testnet` / `mainnet`) | — |
| `networkPassphrase` | `STELLAR_NETWORK_PASSPHRASE` | a label: `testnet`, `mainnet`, `default` (unset) or `unrecognized` | the raw passphrase |
| `rpc`, `archivalRpc`, `horizon` | `STELLAR_RPC_URL`, `ARCHIVAL_STELLAR_RPC_URL`, `STELLAR_HORIZON_URL` | `scheme`, `host`, `port`, `invalid` | user/password, **path, query, fragment** (providers often put API keys there) |
| `database` | `DATABASE_URL` | `scheme`, `host`, `port`, `name` (database name) | username, password, query parameters |
| `redis` | `REDIS_URL` | `scheme`, `host`, `port`, `db` (logical index) | username, password |
| `contracts[]`, `contractSource` | `TRACKED_CONTRACTS`, otherwise `MARKETPLACE_CONTRACT_ID` / `LAUNCHPAD_CONTRACT_ID` | full contract ID, which is a public on-chain address, plus `type`, `label`, `startLedger` | — |
| `poll` | `POLL_INTERVAL_MS`, `MAX_LEDGERS_PER_CYCLE`, `CONFIRMATION_DEPTH` | the parsed numbers, or `null` plus a warning if they are invalid | — |
| `credentialsSet` / `credentialsUnset` | `OPERATOR_TOKEN`, `OPERATOR_API_KEY`, `HEALTH_DETAILS_TOKEN`, `CURSOR_SECRET`, `KEEPER_SECRET`, `PINATA_JWT`, `SENTRY_DSN` | **the setting names only**, split into set and unset | any secret value |
| `warnings[]` | derived | `{ code, setting, message }` | secret values |

Example line (JSON log format, fake values):

```json
{"level":"info","msg":"[startup] configuration report","startupConfig":{
  "network":"mainnet","networkPassphrase":"mainnet",
  "rpc":{"scheme":"https:","host":"rpc.mainnet.example.net","port":null,"invalid":false},
  "database":{"scheme":"postgresql:","host":"db.internal.example","port":"5432","invalid":false,"name":"marketplace_prod"},
  "redis":{"scheme":"redis:","host":"cache.internal.example","port":"6380","invalid":false,"db":"2"},
  "contractSource":"MARKETPLACE_CONTRACT_ID/LAUNCHPAD_CONTRACT_ID",
  "contracts":[{"id":"CAAAA…AAAA","type":"marketplace","label":"marketplace","startLedger":0}],
  "poll":{"pollIntervalMs":3000,"maxLedgersPerCycle":1000,"confirmationDepth":10},
  "credentialsSet":["OPERATOR_TOKEN"],"credentialsUnset":["KEEPER_SECRET","PINATA_JWT"],
  "warnings":[]}}
```

The logger's redaction layer (`indexer/src/redact.ts`) runs on top of this as defence in depth. The
report uses `credentialsSet` / `credentialsUnset` arrays rather than keys named after the secrets,
because the redactor masks any field whose *key* contains `token` or `secret`.

---

## 3. Warning codes

Each warning is also logged on its own line as `[startup] configuration warning: <CODE>`, so a
log-based alert can match on the code.

| Code | Trigger | Usually means |
|---|---|---|
| `PASSPHRASE_NETWORK_MISMATCH` | mainnet with the testnet or unset passphrase, or testnet with the mainnet passphrase | Wrong env file. The shared validator (step 2) also rejects this, so on a normal boot you see it as a fatal error. |
| `RPC_NETWORK_MISMATCH` | mainnet with a `testnet`/`futurenet` RPC host, or testnet with a `mainnet`/`pubnet` host (checked for both live and archival RPC) | Copy-pasted RPC URL from the other environment |
| `HORIZON_NETWORK_MISMATCH` | mainnet with a testnet Horizon, or testnet with `horizon.stellar.org` | Same as above |
| `CONTRACT_LABEL_NETWORK_MISMATCH` | a `TRACKED_CONTRACTS` label names the other network | The contract list came from the other environment |
| `CONTRACT_ID_FORMAT` | contract ID is not 56 characters starting with `C` | Truncated or mistyped ID |
| `NO_TRACKED_CONTRACTS` / `TRACKED_CONTRACTS_INVALID` | no contracts configured, or the JSON is invalid | The poller will index nothing |
| `MAINNET_LOCAL_DEPENDENCY` | mainnet with `localhost` / `127.0.0.1` for the RPC, DB or Redis | Dev values leaked into a production config |
| `MAINNET_INSECURE_RPC` | mainnet RPC over plain `http:` | Missing TLS |
| `NETWORK_UNKNOWN` | `STELLAR_NETWORK` is not `testnet`/`mainnet` | Typo (the shared validator rejects this too) |
| `INVALID_URL` | a URL setting is present but cannot be parsed | Typo or quoting problem |
| `POLL_SETTINGS_INVALID` | poll settings are not positive integers | Typo (step 3 also rejects this) |

The RPC hostname checks are heuristics, so treat any warning as "verify before proceeding".
Mainnet RPC hostnames are provider-specific, so a testnet endpoint configured with a neutral
hostname will **not** be flagged.

---

## 4. Operator procedure (READ-ONLY)

All of these steps are **READ-ONLY**. They only read logs.

1. After a deploy, find the line `[startup] configuration report` for the new pod or container.
2. Check that `network`, `networkPassphrase`, `rpc.host`, `database.host`/`name`, `redis.host`/`db`
   and `contracts[].id` match the change ticket for that environment.
3. Check that `warnings` is `[]`. If it isn't, stop the rollout and fix the env file. Do **not**
   override a mismatch "temporarily", because the indexer would write the other network's data
   into this database.
4. Check that `credentialsSet` includes every credential the environment needs (for example
   `OPERATOR_TOKEN` in staging and production).

```bash
# READ-ONLY: Kubernetes
kubectl logs -n elcarehub deploy/indexer | grep '\[startup\] configuration'
# READ-ONLY: Docker Compose
docker compose logs indexer | grep '\[startup\] configuration'
```

When you share the report in a ticket, paste it as it is. It is designed to be safe to share. Never
"enrich" it with the raw env file.

---

## 5. Configuration notes

- `CONFIRMATION_DEPTH`, `POLL_INTERVAL_MS` and `MAX_LEDGERS_PER_CYCLE` must be **positive** integers.
  `parsePositiveInt` rejects `0`, so `CONFIRMATION_DEPTH=0` stops the process at startup. That
  contradicts the old `.env.example` comment, which this PR corrects.
- The shared validator uses the **testnet** passphrase when `STELLAR_NETWORK_PASSPHRASE` is unset.
  A mainnet deployment must set it explicitly.
- `MAX_ROLLBACK_DEPTH` and `REORG_HALT_ON_DEEP` are parsed in `loadConfig()` but are not part of its
  return value. Re-org behaviour is configured in `reorg.ts` / `poller.ts`, so they are left out
  of the report.

---

## 6. Review and revert

**Reviewing.**
- `startup-report.ts` only reads `env` and never throws. Check that every value it reports comes from
  `toSafeEndpoint()` (scheme, host, port), the database name or Redis index, contract IDs, or numbers.
- Check that `SECRET_SETTING_NAMES` lists every secret-bearing variable, including any new one added
  to `.env.example`.
- `startup-report.test.ts` covers this with leak sentinels: fake credentials sit in DB, Redis and RPC
  URLs and tokens, and the tests assert they never appear in the report or in the logger calls.
- `loadConfig(env)` and `parseTrackedContracts(env)` now take an optional `env` argument that
  defaults to `process.env`. Existing callers behave exactly as before.

**Reverting.**
- Remove the `logStartupConfigReport(...)` call and its import from `indexer/src/index.ts`. Delete
  `indexer/src/startup-report.ts`, the test and the fixture file.
- The `env` parameter on `loadConfig` / `parseTrackedContracts` is backward compatible and can stay,
  or you can revert it with `git revert`.
- No migrations, data changes or configuration changes are involved. Restart the indexer to pick up
  the reverted build.
