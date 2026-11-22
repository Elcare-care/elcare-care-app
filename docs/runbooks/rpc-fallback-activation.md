# RPC Fallback Activation Procedure

**Issue**: [#1116](https://github.com/Elcare-care/elcare-care-app/issues/1116)  
**Category**: Reliability, Security, and Operations  
**Severity**: HIGH  
**Owner**: On-call operator  
**Last updated**: 2026-07-27

---

## Overview

The indexer polls the Stellar network through a configured RPC endpoint (`RPC_URL` in
`scripts/deploy/.env.deploy` and `indexer/.env`). When that endpoint becomes unreachable
or consistently slow, switching to a fallback RPC can reduce or eliminate the outage.
This runbook covers detection, pre-switch verification, the cutover itself, post-switch
resync, and rollback — without embedding any credentials.

---

## 1. Detection

The indexer going stale is the primary signal. Any of the following indicate an RPC problem:

| Signal | Location |
|--------|----------|
| `indexer_stalled == 1` for > 2 min | Prometheus / Grafana |
| `indexer_ledger_lag > 500` | Prometheus / Grafana |
| RPC errors in indexer logs | `kubectl logs -n elcarehub deploy/indexer` |
| `/readyz` returning non-200 | Health endpoint |
| `indexer_open_gaps_count` rising continuously | Prometheus |

Distinguish an RPC failure from a Stellar network outage by checking the Stellar network
status page and comparing against `indexer_latest_ledger_processed`. If the latest ledger
on-chain is not advancing either, the problem is upstream; this runbook does not apply.

---

## 2. Pre-Switch Verification Checklist

Run these steps before changing any configuration. All are read-only.

```bash
# 1. Confirm the current RPC endpoint in use
kubectl exec -n elcarehub deploy/indexer -- printenv STELLAR_RPC_URL

# 2. Test the current endpoint's reachability
curl -sf "${STELLAR_RPC_URL}/status" | jq .

# 3. Test the candidate fallback endpoint (substitute your fallback URL)
FALLBACK_RPC_URL="<candidate-fallback-rpc-url>"
curl -sf "${FALLBACK_RPC_URL}/status" | jq .

# 4. Confirm the network passphrase matches between current and fallback
#    Both must return the same network identifier.
curl -sf "${FALLBACK_RPC_URL}/status" | jq '.infoResponse.networkPassphrase'

# 5. Check how far the fallback node is behind
#    The ledger sequence must be within a small delta of the primary.
curl -sf "${FALLBACK_RPC_URL}/status" | jq '.infoResponse.ledger.sequence'

# 6. Verify the marketplace contract ID is accessible on the fallback
#    (source deployed_ids.env to get MARKETPLACE_CONTRACT_ID)
source scripts/deploy/deployed_ids.env
curl -sf "${FALLBACK_RPC_URL}/getContractData" \
  -H "Content-Type: application/json" \
  -d "{\"contractId\": \"${MARKETPLACE_CONTRACT_ID}\", \"key\": \"ledger\"}" | jq .
```

**Gate**: Only proceed if the fallback RPC returns the same network passphrase and its
ledger sequence is within 10 of the primary. If the fallback is more than 10 ledgers
behind, it may cause a temporary resync delay after the switch but is still preferable to
a fully stalled indexer.

---

## 3. Fallback Activation

This change updates the running indexer configuration and triggers a pod restart. It does
**not** touch the contract or modify any on-chain state.

### 3a. Kubernetes (production)

```bash
# Set the fallback RPC URL in the existing secret (operator provides the value)
kubectl patch secret indexer-secrets -n elcarehub \
  --type='json' \
  -p="[{\"op\": \"replace\", \"path\": \"/data/stellar-rpc-url\", \
      \"value\": \"$(echo -n "${FALLBACK_RPC_URL}" | base64 -w0)\"}]"

# Restart the indexer to pick up the new value
kubectl rollout restart deployment/indexer -n elcarehub

# Monitor rollout (should complete within 60 s)
kubectl rollout status deployment/indexer -n elcarehub --timeout=120s

# Confirm the new URL is live
kubectl exec -n elcarehub deploy/indexer -- printenv STELLAR_RPC_URL
```

### 3b. Docker Compose (staging / local)

```bash
# Edit the environment file — do NOT commit this file
sed -i "s|^STELLAR_RPC_URL=.*|STELLAR_RPC_URL=${FALLBACK_RPC_URL}|" indexer/.env

# Restart the indexer container only
docker compose -f docker-compose.prod.yml up -d --no-deps indexer

# Confirm the URL took effect
docker compose -f docker-compose.prod.yml exec indexer printenv STELLAR_RPC_URL
```

---

## 4. Post-Switch Verification

```bash
# 1. Confirm the indexer is no longer stalled
curl -sf http://indexer:4000/health | jq .

# 2. Check readiness (database + sync lag OK)
curl -sf http://indexer:4000/readyz

# 3. Watch the ledger lag drop
watch -n 5 'curl -sf http://indexer:4000/metrics | grep indexer_ledger_lag'

# 4. Check open gap count is not rising
curl -sf http://indexer:4000/metrics | grep indexer_open_gaps_count

# 5. Run the post-deploy smoke route matrix
bash scripts/deploy/health-gate.sh
```

The indexer should return `stalled=false` and `indexer_ledger_lag` should decrease to
under 100 within five minutes of the restart. If the gap count is still rising after ten
minutes, treat the fallback as also unavailable and escalate.

---

## 5. Post-Fallback Resync

If the fallback node was behind, the indexer will automatically backfill missed ledgers
using the `LedgerGap` job queue. No manual action is needed. You can monitor progress:

```bash
# Count of outstanding gaps (should trend to 0)
curl -sf http://indexer:4000/metrics | grep indexer_open_gaps_count

# Indexer logs for gap-fill activity
kubectl logs -n elcarehub deploy/indexer --tail=100 | grep -i "gap\|backfill"
```

---

## 6. Rollback

If the fallback RPC causes new problems (e.g., event data inconsistency, mismatched
network passphrase), restore the original endpoint:

```bash
# Kubernetes
kubectl patch secret indexer-secrets -n elcarehub \
  --type='json' \
  -p="[{\"op\": \"replace\", \"path\": \"/data/stellar-rpc-url\", \
      \"value\": \"$(echo -n "${ORIGINAL_RPC_URL}" | base64 -w0)\"}]"
kubectl rollout restart deployment/indexer -n elcarehub
kubectl rollout status deployment/indexer -n elcarehub --timeout=120s

# Docker Compose
sed -i "s|^STELLAR_RPC_URL=.*|STELLAR_RPC_URL=${ORIGINAL_RPC_URL}|" indexer/.env
docker compose -f docker-compose.prod.yml up -d --no-deps indexer
```

Always record the original URL before switching so this rollback step can be executed
under time pressure.

---

## 7. Evidence Record

After completing this runbook, fill in the table below and commit it to
`docs/incidents/YYYY-MM-DD-rpc-fallback.md`.

| Field | Value |
|-------|-------|
| Incident date | |
| Original RPC URL (domain only, no credentials) | |
| Fallback RPC URL (domain only, no credentials) | |
| Ledger lag at switch time | |
| Time to recover (stalled → lag < 100) | |
| Gaps backfilled | |
| Operator who performed the switch | |
| Rollback required? | |
| Root cause (if known) | |

---

## Related

- [stalled-ingestion.md](./stalled-ingestion.md) — broader stall diagnosis
- [poller-health-checklist.md](./poller-health-checklist.md) — classify poller state before escalating
- `DEPLOYMENT.md` — rollback procedure for the indexer image
- `versions.toml` — component version compatibility matrix
