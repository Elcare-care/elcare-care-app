# ElcareHub Operational Runbooks

This directory contains incident response runbooks for ElcareHub's critical failure modes.  
Each runbook covers: detection, containment, diagnosis, recovery, and post-incident review.

---

## Index

| Runbook | Incident Type | Severity |
|---|---|---|
| [admin-read-only-diagnostic.md](./admin-read-only-diagnostic.md) | First-step read-only sync/health check for support | LOW |
| [stalled-ingestion.md](./stalled-ingestion.md) | Indexer stops processing new ledgers | HIGH |
| [gap-repair.md](./gap-repair.md) | Ledger gap repair: dry review (READ-ONLY) vs. repair execution (MUTATING), reconciliation | HIGH |
| [backfill-job-status.md](./backfill-job-status.md) | BackfillJob states, safe restart, stuck-job ownership, read-only diagnostics | MEDIUM |
| [dead-letter-review.md](./dead-letter-review.md) | Parser dead letters: view → classify → redact → resolve → replay | MEDIUM |
| [poller-health-checklist.md](./poller-health-checklist.md) | Classify poller as healthy / degraded / stalled / re-org (read-only) | LOW |
| [stale-cache-diagnostic.md](./stale-cache-diagnostic.md) | Compare a Redis-cached listing/auction with PostgreSQL (read-only) | LOW |
| [redis-key-registry.md](./redis-key-registry.md) | Redis key prefixes, TTLs, and review checklist | — |
| [cache-ttl-reference.md](./cache-ttl-reference.md) | Source-of-truth table for response-cache TTLs | — |
| [reorganization.md](./reorganization.md) | Stellar chain reorg detected | MEDIUM–HIGH |
| [database-outage.md](./database-outage.md) | PostgreSQL unavailable | CRITICAL |
| [redis-outage.md](./redis-outage.md) | Redis cache unavailable | MEDIUM |
| [compromised-admin-key.md](./compromised-admin-key.md) | Admin Stellar key exposed or stolen | CRITICAL |
| [role-rotation.md](./role-rotation.md) | Role-holder rotation procedure (Issue #473) | HIGH |
| [contract-pause.md](./contract-pause.md) | Emergency pause / unpause procedure | CRITICAL |
| [token-onboarding.md](./token-onboarding.md) | Add or remove a payment token from the whitelist | HIGH |
| [pinata-outage.md](./pinata-outage.md) | Pinata/IPFS unavailable | MEDIUM |
| [wallet-incompatibility.md](./wallet-incompatibility.md) | Freighter or Magic.link failures | HIGH |
| [incorrect-deployment-config.md](./incorrect-deployment-config.md) | Wrong contract ID, network, or secrets | HIGH |
| [startup-config-report.md](./startup-config-report.md) | Read the non-secret startup configuration report and its testnet/mainnet warnings | LOW |
| [observability-alerts.md](./observability-alerts.md) | Prometheus alert interpretations and responses | MEDIUM |
| [game-day-scenario-combined-failure.md](./game-day-scenario-combined-failure.md) | Quarterly "Perfect Storm" combined-failure game day | — |
| [tabletop-exercises.md](./tabletop-exercises.md) | Exercise records and individual scenarios | — |

**Secret inventory:** [../secret-inventory.md](../secret-inventory.md)  
**Reliability reviews & backlog:** [../reliability/README.md](../reliability/README.md)  
**Existing incident runbook:** [../INCIDENT_RUNBOOK.md](../INCIDENT_RUNBOOK.md) (contract pause, key rotation, keeper)

---

## Severity Levels

| Level | Description | Response Time |
|---|---|---|
| **CRITICAL** | Funds at risk; contract compromised; full outage | < 5 minutes |
| **HIGH** | Service degraded; users blocked from transacting | < 15 minutes |
| **MEDIUM** | Partial degradation; workaround available | < 30 minutes |
| **LOW** | Minor UX issue; monitoring gap | Next business day |

---

## First Response Quick Reference

**Contract paused unexpectedly?**  
→ [contract-pause.md](./contract-pause.md) — verify admin key; check `is_paused`

**Indexer not advancing?**  
→ [stalled-ingestion.md](./stalled-ingestion.md) — check RPC, DB, logs

**All transactions failing?**  
→ [wallet-incompatibility.md](./wallet-incompatibility.md) — check network passphrase and contract IDs first

**Admin key potentially leaked?**  
→ [compromised-admin-key.md](./compromised-admin-key.md) — pause immediately, then rotate

**No NFT images loading?**  
→ [pinata-outage.md](./pinata-outage.md) — check Pinata status, swap gateway

**Chain reorg logged?**  
→ [reorganization.md](./reorganization.md) — classify depth; most are auto-resolved

**Database returns 503?**  
→ [database-outage.md](./database-outage.md) — check container, pool, disk

**Token whitelist change needed?**  
→ [token-onboarding.md](./token-onboarding.md) — full two-operator sign-off checklist before mainnet

**Prometheus alert firing?**  
→ [observability-alerts.md](./observability-alerts.md) — per-alert triage steps

---

## Versioning

Runbooks follow the project version in `versions.toml`.  
**Current version:** 1.0.0  
**Runbooks last updated:** 2026-07-27

Each runbook includes a post-incident review template. Completed reviews are stored in `docs/incidents/YYYY-MM-DD-<type>.md`.

---

## Contributing

1. Update the runbook when the system changes
2. Complete the post-incident review template after every real incident
3. Use tabletop exercises to validate runbooks quarterly
4. Feed exercise and incident outcomes into the [reliability backlog](../reliability/backlog.md)
5. Update escalation contacts in [tabletop-exercises.md](./tabletop-exercises.md) when team changes

---

## Ownership

| Domain | Runbook(s) | Primary Owner | Rollback / Escalation |
|---|---|---|---|
| Smart contracts | `contract-pause.md`, `role-rotation.md`, `compromised-admin-key.md`, `token-onboarding.md`, `incorrect-deployment-config.md` | Security Lead | CTO |
| Indexer / ingestion | `stalled-ingestion.md`, `poller-health-checklist.md`, `reorganization.md`, `admin-read-only-diagnostic.md` | Backend Lead | On-call engineer |
| Database | `database-outage.md` | Backend Lead | CTO — restore from last verified backup |
| Cache / Redis | `redis-outage.md`, `redis-key-registry.md`, `cache-ttl-reference.md`, `stale-cache-diagnostic.md` | Backend Lead | Restart Redis, flush stale keys per registry |
| Frontend / wallets | `wallet-incompatibility.md`, `pinata-outage.md` | Frontend Lead | Roll back frontend deploy; swap IPFS gateway |
| Observability | `observability-alerts.md` | DevOps Engineer | Silence alert, open investigation ticket |
| Game days | `tabletop-exercises.md`, `game-day-scenario-combined-failure.md` | Security Lead | No production impact — exercise only |
