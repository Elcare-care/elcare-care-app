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
| | `STELLAR_RPC_URL` | Soroban RPC endpoint |
| | `MARKETPLACE_CONTRACT_ID` | Deployed marketplace contract address (`C...`) |
| | `LAUNCHPAD_CONTRACT_ID` | Deployed launchpad contract address (`C...`) |
| **Frontend** | `NEXT_PUBLIC_STELLAR_NETWORK` | `"testnet"` or `"mainnet"` |
| | `NEXT_PUBLIC_INDEXER_URL` | Indexer REST API URL |
| | `NEXT_PUBLIC_MARKETPLACE_CONTRACT_ID` | Marketplace contract address |

---

## 2. Smart Contract Deployment Workflow

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

## 3. Indexer Deployment Workflow (Docker & Kubernetes)

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

## 3a. Docker Compose Profiles and Services

Local compose commands can start too many or too few services and confuse readiness checks. Use the inventory below to pick the right compose file and profile before running `docker compose up`.

### Compose File Inventory

| File | Purpose | Default profile behavior |
|---|---|---|
| `docker-compose.yml` (root) | Base stack: database, cache, indexer, frontend | All services start (no explicit profile) |
| `docker-compose.prod.yml` (root) | Hardened production overlay (non-root, read-only FS, dropped caps) | Overlay only; combine with base file |
| `docker-compose.live-e2e.yml` (root) | Live end-to-end test stack against a real network | `e2e` profile |
| `indexer/docker-compose.yml` | Indexer-only local stack | All services start |
| `indexer/docker-compose.prod.yml` | Indexer hardened overlay | Overlay only |
| `frontend/elcarehub-app/docker-compose.yml` | Frontend-only local stack | All services start |
| `frontend/elcarehub-app/docker-compose.prod.yml` | Frontend hardened overlay | Overlay only |

### Service, Profile, Command, and Health Dependency Table

| Service | Compose file | Profile | Default command | Health dependency |
|---|---|---|---|---|
| `postgres` | `docker-compose.yml` (root), `indexer/docker-compose.yml` | default | `postgres` (image entrypoint) | `healthcheck`: `pg_isready`; required by `indexer` via `depends_on: condition: service_healthy` |
| `redis` | `docker-compose.yml` (root), `indexer/docker-compose.yml` | default | `redis-server` (image entrypoint) | `healthcheck`: `redis-cli ping`; required by `indexer` via `depends_on: condition: service_healthy` |
| `indexer` | `docker-compose.yml` (root), `indexer/docker-compose.yml` | default | `node dist/index.js` | `depends_on` `postgres` + `redis` (`service_healthy`); exposes `/livez` and `/readyz` |
| `frontend` | `docker-compose.yml` (root), `frontend/elcarehub-app/docker-compose.yml` | default | `npm run start` | `depends_on` `indexer` (`service_started`); readiness via `NEXT_PUBLIC_INDEXER_URL` reachability |
| `indexer` (hardened) | `docker-compose.prod.yml` (root), `indexer/docker-compose.prod.yml` | overlay | inherits base command | inherits base `depends_on`; adds `read_only`, `cap_drop: [ALL]`, `runAsNonRoot` |
| `frontend` (hardened) | `docker-compose.prod.yml` (root), `frontend/elcarehub-app/docker-compose.prod.yml` | overlay | inherits base command | inherits base `depends_on`; adds `read_only`, `cap_drop: [ALL]`, `runAsNonRoot` |
| `e2e-runner` | `docker-compose.live-e2e.yml` (root) | `e2e` | `npm run test:e2e` | `depends_on` `indexer` (`service_healthy`); waits for `/readyz` before running |

> **Note:** Overlay files (`*.prod.yml`) do not define standalone services; they must be combined with their base file using `-f`. Running an overlay alone will fail with "no such service".

### Choosing a Profile for Readiness Checks

- **Local development / readiness checks:** use the base file only — `docker compose up -d` from the repository root. This starts `postgres`, `redis`, `indexer`, and `frontend` with healthchecks wired through `depends_on`.
- **Production-like readiness validation:** combine base + hardened overlay — `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. Verify `/readyz` returns HTTP 200 before declaring the stack ready.
- **Live end-to-end validation:** use the `e2e` profile — `docker compose -f docker-compose.live-e2e.yml --profile e2e up -d`. The `e2e-runner` service only starts once `indexer` reports healthy.
- **Package-scoped checks:** run from `indexer/` or `frontend/elcarehub-app/` with that package's compose file when validating a single tier in isolation.

### Pre-flight Configuration Check

Before starting any profile, validate that required environment variables and compose files are present:

```bash
bash scripts/docker/init-config-check.sh
```

This script checks for missing `.env` files, unresolved required variables, and compose file syntax. A non-zero exit means the stack is not ready to start — fix the reported items before running `docker compose up`.

---

## 4. Frontend Deployment Workflow (Next.js / Vercel)

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

## 5. Decision Tree for Deployment Troubleshooting

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

## 6. Release Versioning

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
