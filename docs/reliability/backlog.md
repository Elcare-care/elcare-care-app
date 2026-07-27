# Reliability backlog

Living backlog for cross-cutting reliability work. Updated during [quarterly reviews](./quarterly-review-process.md)
and after incidents. **Deployment baseline** must match [`versions.toml`](../../versions.toml) unless a
decision record documents intentional skew.

**Last reviewed:** 2026-07-27 (Q3 kickoff — see [reviews/2026-Q3.md](./reviews/2026-Q3.md))  
**Baseline `release_id`:** 1 (marketplace `0.1.0`, indexer `1.0.0`, frontend `0.1.0`, event schema `1`)

---

## Domain owners

Each reliability domain has a **named owner** responsible for backlog hygiene and review inputs.

| Domain | Owner | Scope |
|---|---|---|
| **On-chain safety** | Backend Lead (contracts) | Soroban invariants, pause/upgrade, admin key flows, launchpad salts |
| **Data correctness** | Backend Lead (indexer) | RPC ingestion, re-org handling, event parsing, Prisma schema |
| **Availability** | DevOps Engineer | Uptime, Redis/Postgres, RPC failover, deploy health gates |
| **Security** | Security Lead | Scans, secrets, threat model, incident disclosure |
| **Accessibility** | Frontend Lead | jest-axe, Playwright a11y, focus/labels/contrast |
| **Privacy** | Security Lead | PII in logs, retention, moderation-related data |
| **Support** | Frontend Lead | Transaction UX, wallet errors, user-visible failure modes |

---

## Scoring legend

Impact / Likelihood / Effort / Dependency: **1–5** (see [quarterly-review-process.md §4](./quarterly-review-process.md#4-scoring-open-backlog-items)).

**Status:** `Open` | `In progress` | `Done` | `Retired`

---

## Open items

| ID | Domain | Summary | I | L | E | D | Priority | Owner | Target | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| REL-001 | Availability | Enable `GAP_REPAIR_ENABLED` for production; document default risk | 4 | 3 | 2 | 1 | 10.3 | DevOps Engineer | `release_id ≥ 2` | Open |
| REL-002 | Availability | Automated Stellar RPC fallback (`STELLAR_RPC_FALLBACK_URL`) | 4 | 3 | 4 | 2 | 9.4 | DevOps Engineer | 2026-Q4 | Open |
| REL-003 | Data correctness | Clarify sync lag alert thresholds (degraded vs down) in runbooks + alerts | 3 | 4 | 2 | 1 | 10.7 | Backend Lead (indexer) | 2026-Q4 | Open |
| REL-004 | On-chain safety | Property tests coverage gaps for auction edge cases (post Issue-116) | 3 | 2 | 3 | 1 | 4.8 | Backend Lead (contracts) | 2027-Q1 | Open |
| REL-005 | Security | Quarterly secret inventory reconciliation vs production | 4 | 2 | 2 | 1 | 7.3 | Security Lead | Quarterly | Open |
| REL-006 | Security | Dependency audit SLA for high/critical findings | 4 | 3 | 2 | 1 | 10.3 | Security Lead | Ongoing | Open |
| REL-007 | Data correctness | Indexer drift detection vs `versions.toml` event schema | 4 | 3 | 3 | 2 | 9.4 | Backend Lead (indexer) | `release_id ≥ 2` | Open |
| REL-008 | Availability | Stale Redis cache invalidation on re-org rollback | 3 | 3 | 3 | 1 | 7.6 | DevOps Engineer | 2026-Q4 | Open |
| REL-009 | Support | Map contract error codes to user-facing copy (checkout/listing flows) | 3 | 4 | 3 | 1 | 10.6 | Frontend Lead | 2026-Q4 | Open |
| REL-010 | Accessibility | Serious/critical axe violations gate in CI for changed routes | 3 | 3 | 3 | 2 | 7.5 | Frontend Lead | 2027-Q1 | Open |
| REL-011 | Privacy | Log redaction audit for wallet addresses and emails | 3 | 2 | 2 | 1 | 5.3 | Security Lead | 2026-Q4 | Open |
| REL-012 | On-chain safety | Post-deploy checklist: contract ID env parity across indexer + frontend | 5 | 3 | 2 | 1 | 13.3 | DevOps Engineer | Ongoing | Open |

---

## Retired items

| ID | Summary | Retired | Rationale |
|---|---|---|---|
| — | — | — | — |

---

## Maintenance

- Add rows for new findings; never delete rows — move to **Retired** with rationale.
- After each quarterly review, update **Last reviewed**, baseline `release_id`, and scores.
- Link GitHub issues in the **Summary** cell or in the decision record when created.
