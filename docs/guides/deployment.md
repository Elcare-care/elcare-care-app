# Deployment Guide

This guide details deployment workflows for Soroban smart contracts, indexer microservices, and the Next.js frontend across staging, testnet, and production environments.

---

## 1. Environment Variables Matrix

Before deploying any service, verify that the required environment variables are set:

| Tier | Required Environment Variables | Description |
|---|---|---|
| **Contracts** | `STELLAR_SECRET_KEY` | Admin account secret key (`S...`) used to deploy WASM |
| | `STELLAR_NETWORK_PASSPHRASE` | `"Test SDF Network ; November 2015"` or `"Public Global Stellar Network ; September 2015"` |
| **Indexer** | `DATABASE_URL` | PostgreSQL connection string |
| | `REDIS_URL` | Redis connection URL |
| | `STELLAR_RPC_URL` | Primary Soroban RPC endpoint (used when `RPC_PROVIDER_POOL` is unset) |
| | `RPC_PROVIDER_POOL` | JSON array of provider objects for multi-provider failover (optional; takes priority over `STELLAR_RPC_URL`) |
| | `STELLAR_NETWORK` | `"testnet"` or `"mainnet"` — sets the expected network passphrase guard |
| | `MARKETPLACE_CONTRACT_ID` | Deployed marketplace contract address (`C...`) |
| | `LAUNCHPAD_CONTRACT_ID` | Deployed launchpad contract address (`C...`) |
| **Frontend** | `NEXT_PUBLIC_STELLAR_NETWORK` | `"testnet"` or `"mainnet"` |
| | `NEXT_PUBLIC_INDEXER_URL` | Indexer REST API URL |
| | `NEXT_PUBLIC_MARKETPLACE_CONTRACT_ID` | Marketplace contract address |

---

## 2. RPC Provider Pool Configuration

The indexer supports a single primary RPC endpoint or an ordered pool of providers with automatic failover and primary recovery. Configure one of these two modes before deploying.

### Single-provider mode (default)

Set `STELLAR_RPC_URL` and omit `RPC_PROVIDER_POOL`. The indexer creates a one-entry pool from this URL.

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK=testnet
```

### Multi-provider mode (recommended for production)

Set `RPC_PROVIDER_POOL` to a JSON array of provider objects. Each entry requires `url` and `priority` (0 = primary, higher numbers = lower priority fallbacks). An optional `label` is used for Prometheus metrics and logs; when omitted, the hostname is extracted automatically.

```bash
RPC_PROVIDER_POOL='[
  {"url":"https://primary-rpc.example.com","priority":0,"label":"primary"},
  {"url":"https://fallback-rpc.example.com","priority":1,"label":"fallback"}
]'
STELLAR_NETWORK=testnet
```

> **Note:** Use placeholder hostnames in examples and staging configs. Never commit real endpoint URLs that contain credentials or API keys in query strings.

When `RPC_PROVIDER_POOL` is set it takes full priority over `STELLAR_RPC_URL`; the `STELLAR_RPC_URL` value is ignored.

### Provider selection and failover

Providers are tried in ascending `priority` order. The pool tracks each provider's health separately:

| Behaviour | Detail |
|---|---|
| **Failover trigger** | After `RPC_MAX_CONSECUTIVE_ERRORS` consecutive errors on the active provider (default: 5), that provider enters a cooldown period and the next healthy, chain-compatible provider is promoted. |
| **Cooldown duration** | Configured by `RPC_FAILOVER_COOLDOWN_MS` (default: 60 000 ms / 60 s). A failed provider is not eligible for promotion until its cooldown expires. |
| **Primary recovery** | Every `RPC_RECOVERY_PROBE_MS` (default: 30 000 ms / 30 s) the pool probes the primary. If the primary has recovered and its latest ledger is within `RPC_STALE_LEDGER_THRESHOLD` ledgers of the global latest (default: 50), the pool promotes back to primary automatically. |
| **Network passphrase guard** | On first contact, each provider's network passphrase is fetched via `getNetwork()`. Any provider returning a passphrase that does not match the baseline is permanently rejected for the lifetime of the process. Set `STELLAR_NETWORK` to `testnet` or `mainnet` to seed the expected passphrase before any provider is contacted. |
| **Stale ledger guard** | During primary recovery, if the primary's latest ledger is more than `RPC_STALE_LEDGER_THRESHOLD` behind the global latest seen ledger, recovery is deferred until the primary catches up. |

### Optional pool tuning variables

All four variables are validated at startup. Malformed, zero, negative, or out-of-range values cause the process to exit with an error naming the offending variable.

| Variable | Default | Accepted range | Description |
|---|---|---|---|
| `RPC_FAILOVER_COOLDOWN_MS` | `60000` | 1 000 – 3 600 000 | Cooldown duration before a failed provider can be re-promoted (ms) |
| `RPC_STALE_LEDGER_THRESHOLD` | `50` | 1 – 10 000 | Max ledgers a recovering primary may lag behind the global latest |
| `RPC_RECOVERY_PROBE_MS` | `30000` | 1 000 – 3 600 000 | Interval between primary recovery probes (ms) |
| `RPC_MAX_CONSECUTIVE_ERRORS` | `5` | 1 – 1 000 | Consecutive errors on the active provider before failover |

### Verifying the active provider

At runtime, the pool's current state is available without exposing endpoint credentials:

```bash
# Prometheus — check which provider is active (label = hostname or configured label)
curl -s http://localhost:4000/metrics | grep indexer_rpc_provider_active

# Status endpoint — inspect provider list, cooldown, ledger, and chain verification
curl http://localhost:4000/health/details \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN" \
  | jq '.rpcPool'
```

The `label` field in every response uses the configured `label` value or the hostname only — credentials and query strings are never exposed.

### Confirming failover and recovery

See the [Failover Verification Procedure](../runbooks/stalled-ingestion.md#failover-and-recovery-verification-staging-only) in the stalled-ingestion runbook for a step-by-step staging checklist.

---

## 3. Smart Contract Deployment Workflow

### 1. Build and Optimize WASM
```bash
cargo build --target wasm32v1-none --release
stellar contract optimize \
  --wasm target/wasm32v1-none/release/soroban_marketplace.wasm \
  --wasm-out target/wasm32v1-none/release/soroban_marketplace.optimized.wasm
```

### 2. Install WASM Bytecode on Chain
```bash
WASM_HASH=$(stellar contract install \
  --wasm target/wasm32v1-none/release/soroban_marketplace.optimized.wasm \
  --source admin \
  --network testnet)
echo "Installed WASM Hash: $WASM_HASH"
```

### 3. Deploy Contract Instance
```bash
CONTRACT_ID=$(stellar contract deploy \
  --wasm-hash $WASM_HASH \
  --source admin \
  --network testnet)
echo "Deployed Contract ID: $CONTRACT_ID"
```

### 4. Initialize Contract State
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin <ADMIN_ADDRESS> \
  --protocol_fee 250
```

---

## 4. Indexer Deployment Workflow (Docker & Kubernetes)

### Docker Deployment (Local / Staging)
```bash
cd indexer
docker compose up --build -d
```

### Docker Deployment (Production - Hardened)
For production deployments, always use the hardened configuration:
```bash
cd indexer
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

> **Important:** Production deployments must use the hardened configuration with non-root users, read-only filesystems, and dropped capabilities. See [Docker Hardening Guide](./docker-hardening.md) for detailed security measures and documented exceptions.

### Kubernetes Deployment (Production)
To apply new indexer updates in production:
```bash
# 1. Apply Prisma migrations
npx prisma migrate deploy

# 2. Restart deployment rollout
kubectl rollout restart deployment/indexer

# 3. Monitor rollout status
kubectl rollout status deployment/indexer
```

**Kubernetes Security Context:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: indexer
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
        capabilities:
          drop:
            - ALL
      containers:
      - name: indexer
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
```

### Health & Readiness Checks
The indexer exposes HTTP probes:
- Liveness Probe: `GET http://localhost:4000/livez` (Returns HTTP 200)
- Readiness Probe: `GET http://localhost:4000/readyz` (Checks DB connection & ingestion stall status)

---

## 5. Frontend Deployment Workflow (Next.js / Vercel)

### Docker Deployment (Local / Staging)
```bash
cd frontend/elcarehub-app
docker compose up --build -d
```

### Docker Deployment (Production - Hardened)
For production deployments, always use the hardened configuration:
```bash
cd frontend/elcarehub-app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

> **Important:** Production deployments must use the hardened configuration with non-root users, read-only filesystems, and dropped capabilities. See [Docker Hardening Guide](./docker-hardening.md) for detailed security measures and documented exceptions.

### Production Build Check
Always run a local production build before pushing to production:
```bash
cd frontend/elcarehub-app
npm run build
```
*Expected output:* `✓ Compiled successfully` with route sizes summary.

---

## 6. Decision Tree for Deployment Troubleshooting

```
                      [ Deployment Failure ]
                                │
                                ▼
                       Identify Failed Tier
                                │
       ┌────────────────────────┼────────────────────────┐
       ▼                        ▼                        ▼
[ Contract Deploy Failed ]   [ Indexer Crash / 502 ]  [ Frontend Build Error ]
       │                        │                        │
       ▼                        ▼                        ▼
 Check Admin Balance:        Check Pod Logs:          Check Next.js Build Output:
 1. Check testnet account    `kubectl logs -f         Run `npm run build`
    balance (Friendbot)       deployment/indexer`     Inspect missing exports
 2. Verify WASM optimization Check `/readyz` endpoint or type errors.
```

---

## 7. Release Versioning

ElcareHub uses a multi-component versioning scheme. Each component (contracts, indexer, frontend, event schema, database migrations) has an independent version number tracked in `versions.toml` at the repository root.

### Version Source of Truth

| Component | Where version lives | Runtime exposure |
|-----------|-------------------|-----------------|
| Marketplace Contract | `contracts/soroban-marketplace/Cargo.toml` + `contract.rs` `CONTRACT_VERSION` | `version()` view function |
| Launchpad Contract | `contracts/launchpad/Cargo.toml` + `contract.rs` `CONTRACT_VERSION` | `version()` view function |
| Indexer | `indexer/package.json` | `GET /version`, `GET /health/details`, `X-Indexer-Version` header |
| Frontend | `frontend/elcarehub-app/package.json` | `NEXT_PUBLIC_APP_VERSION` env, footer `<meta>` tag |
| Event Schema | `versions.toml` | `X-Event-Schema-Version` header |
| Database | `versions.toml` `db_migration_version` | `X-DB-Migration-Version` header |

### Checking Versions at Runtime

```bash
# Indexer version endpoint
curl http://localhost:4000/version

# Health details (includes versions)
curl http://localhost:4000/health/details

# Check response headers for any API call
curl -I http://localhost:4000/listings
# Returns: X-Indexer-Version, X-API-Version, X-Event-Schema-Version, X-DB-Migration-Version
```

### Docker Image Versioning

When building the indexer Docker image, pass version build args:

```bash
docker build \
  --build-arg BUILD_SHA=$(git rev-parse --short HEAD) \
  --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --build-arg INDEXER_VERSION=1.0.0 \
  --build-arg API_VERSION=1.0.0 \
  --build-arg EVENT_SCHEMA_VERSION=1 \
  --build-arg DB_MIGRATION_VERSION=20260724000000 \
  -t elcarehub-indexer:1.0.0 \
  indexer/
```

### Validating Version Consistency

Run the validation script before any release:

```bash
bash scripts/validate-compatibility.sh
```

This checks that `versions.toml`, `package.json`, `Cargo.toml`, `openapi.json`, and the latest Prisma migration all declare consistent versions.

### Compatibility Matrix

See [COMPATIBILITY.md](../../COMPATIBILITY.md) for the full matrix of tested and supported version combinations.

---

## 8. Safe Redaction Guidance

> [!WARNING]
> During deployment procedures:

- **NEVER print `STELLAR_SECRET_KEY`** in CI logs or terminal recordings.
- Store production secrets in encrypted secrets managers (Kubernetes Secrets, HashiCorp Vault, Vercel Environment Variables).
- Verify deployment scripts sanitize output before printing environment details.
