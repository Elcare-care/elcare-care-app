# Quarterly reliability review process

Lightweight process to keep reliability risk visible, assign backlog ownership, and record decisions
without pretending to know exact ship dates.

---

## 1. Participants and roles

| Role | Typical assignee | Responsibility in review |
|---|---|---|
| **Review chair** | Engineering manager or Backend Lead | Schedules session, publishes decision record |
| **On-chain safety** | Backend Lead (contracts) | Contract releases, invariants, pause/upgrade posture |
| **Data correctness** | Backend Lead (indexer) | Indexer drift, event schema, DB migrations |
| **Availability** | DevOps Engineer | Uptime, caches, RPC failover, deployment recovery |
| **Security** | Security Lead | Audits, dependency scans, secret inventory, threat model deltas |
| **Accessibility** | Frontend Lead | jest-axe / Playwright a11y regressions, WCAG gaps |
| **Privacy** | Security Lead + Legal (as needed) | PII handling, logs, retention, moderation data |
| **Support** | Frontend Lead or designated support liaison | User-reported trends, transaction UX friction |
| **Observer** | Any engineer | Notes, action-item tracking |

**Quorum:** Review chair plus at least one participant from **on-chain safety**, **data correctness**,
and **security**. Other domains may join async if no open backlog items exist in that domain.

---

## 2. Review inputs (collect before the session)

Gather artifacts into a single folder or PR comment bundle; link them in the decision record.

| Input | Source | Owner to prepare |
|---|---|---|
| Contract releases and `CONTRACT_VERSION` changes | Git tags, deploy logs, `versions.toml` | On-chain safety |
| Audit / security scan findings | CI (Cargo/npm audit, Gitleaks), `SECURITY_SCANNING_TRIAGE.md` | Security |
| Production metrics | Prometheus (indexer lag, error rates), health endpoints | Availability |
| Incidents and near misses | `docs/incidents/`, post-incident templates in runbooks | Review chair |
| Dependency and compatibility reports | `bash scripts/validate-compatibility.sh`, Dependabot | Data correctness |
| Support trends | GitHub issues labeled `support`, internal tickets | Support |
| Tabletop / exercise outcomes | [`tabletop-exercises.md`](../runbooks/tabletop-exercises.md) | Security |
| Open reliability backlog | [`backlog.md`](./backlog.md) | Review chair |

**Near miss:** Any event that would have been SEV-2+ if one more guard had failed (e.g. RPC 429
recovered manually before user-visible outage). Near misses follow the same backlog rules as
incidents.

---

## 3. Version alignment (required opening step)

At the start of each review, record the deployed baseline from [`versions.toml`](../../versions.toml):

- `release_id`
- Marketplace / launchpad contract package versions and `contract_version`
- Indexer version, `api_version`, `db_migration_version`
- Frontend version and `event_schema` version

Run locally or in CI:

```bash
bash scripts/validate-compatibility.sh
```

Any mismatch between production deploys and `versions.toml` is either:

1. **Fixed** — bump `versions.toml` and ship a aligned release, or  
2. **Documented** — note intentional skew and expiry date in the decision record (max one quarter).

Backlog items that assume older contract, indexer, or frontend behavior must be **updated or closed**
during this step.

---

## 4. Scoring open backlog items

Score each open item in [`backlog.md`](./backlog.md) on four axes (1 = low, 5 = high):

| Axis | Question |
|---|---|
| **Impact** | User harm or fund loss if this fails? |
| **Likelihood** | How often does the failure mode occur or drift toward us? |
| **Effort** | Engineering + operational cost to resolve (5 = very high) |
| **Dependency** | Blocked on another team, vendor, or release train? (5 = hard blocker) |

**Priority score** (for sorting only, not SLAs):

```text
priority = (impact × likelihood) − (effort × 0.5) − (dependency × 0.3)
```

Re-score items touched by incidents, audits, or version changes in the last quarter.

---

## 5. Ownership and milestones

- Every backlog row has a **named owner** (person or role from the domain table in [`backlog.md`](./backlog.md)).
- Target milestones use **release train IDs** or **quarters** (e.g. `release_id ≥ 2`, `2026-Q4`), not
  fixed calendar dates, unless tied to an external audit or compliance deadline.
- Owners update their rows within **5 business days** after the review.

---

## 6. Incident and near-miss backlog rules

Within **5 business days** of an incident or near-miss closing:

1. Add a new backlog row, **or**
2. Link an existing row and bump scores, **or**
3. Close a GitHub tracking issue with an explicit **closure rationale** in the issue comment (see §7).

Each incident write-up in `docs/incidents/` must include a **Backlog follow-up** section:

```markdown
## Backlog follow-up

- [ ] New/updated backlog ID: REL-___
- [ ] GitHub issue: #___ (opened | updated | closed with rationale)
```

---

## 7. Retiring obsolete backlog items

Do **not** silently drop work. When an item is no longer relevant:

1. Mark status **Retired** in [`backlog.md`](./backlog.md).
2. Add **Retirement rationale** (what changed: deploy version, feature removed, risk accepted).
3. If a GitHub issue tracked the item, close it with the same rationale and link the decision record.

Acceptable retirement reasons include: fixed in `release_id` N, threat removed, duplicate of another
item, or explicit risk acceptance approved in the decision record.

---

## 8. Decision record format

After each review, add `docs/reliability/reviews/YYYY-QN.md` (copy from
[`decision-record-template.md`](./reviews/decision-record-template.md)).

The record must include:

- Participants and date
- Deployed version baseline (`versions.toml` snapshot)
- Summary of inputs reviewed
- Scoring changes (table of item IDs and new priority)
- Decisions (prioritize, defer, retire, accept risk)
- Follow-up actions with owners
- Links to updated GitHub issues

Publish by merging to `main` within **3 business days** of the review meeting.

---

## 9. Calendar

| Quarter | Target review week (first Tuesday, UTC) |
|---|---|
| Q1 | First Tuesday of January |
| Q2 | First Tuesday of April |
| Q3 | First Tuesday of July |
| Q4 | First Tuesday of October |

**Next review:** See the latest file in [`reviews/`](./reviews/).

---

## Change log

| Date | Change |
|---|---|
| 2026-07-27 | Initial process (Issue #346 / internal Issue 81) |
