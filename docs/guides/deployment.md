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

### Health & Readiness Checks
The indexer exposes HTTP probes:
- Liveness Probe: `GET http://localhost:4000/livez` (Returns HTTP 200)
- Readiness Probe: `GET http://localhost:4000/readyz` (Checks DB connection & ingestion stall status)

---

## 4. Frontend Deployment Workflow (Next.js / Vercel)

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

## 6. Safe Redaction Guidance

> [!WARNING]
> During deployment procedures:

- **NEVER print `STELLAR_SECRET_KEY`** in CI logs or terminal recordings.
- Store production secrets in encrypted secrets managers (Kubernetes Secrets, HashiCorp Vault, Vercel Environment Variables).
- Verify deployment scripts sanitize output before printing environment details.
