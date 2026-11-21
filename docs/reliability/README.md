# Reliability program

ElcareHub tracks cross-cutting reliability work in one place: contract invariants, indexer drift,
stale caches, transaction UX, security scanning, deployment recovery, accessibility, privacy, and
support. This directory defines **domain ownership**, the **quarterly review cadence**, the **living
backlog**, and **decision records**.

| Document | Purpose |
|---|---|
| [quarterly-review-process.md](./quarterly-review-process.md) | Participants, inputs, scoring, incident rules, version alignment |
| [quarterly-review-template-inputs.md](./quarterly-review-template-inputs.md) | Pre-review artifact collection template |
| [quarterly-review-template.md](./quarterly-review-template.md) | Copyable issue body pattern for the quarterly reliability review |
| [backlog.md](./backlog.md) | Domain owners, scored open items, deployment baseline |
| [reviews/](./reviews/) | Published decision records (one file per quarter) |

**Related:**

- Release train: [`versions.toml`](../../versions.toml) and `bash scripts/validate-compatibility.sh`
- Incidents: [`docs/incidents/`](../incidents/README.md) and [`docs/runbooks/`](../runbooks/README.md)
- Security scanning: [`docs/guides/security-triage.md`](../guides/security-triage.md)

**Cadence:** Full reliability review on the **first Tuesday of January, April, July, and October**
(UTC). Tabletop exercises ([`tabletop-exercises.md`](../runbooks/tabletop-exercises.md)) feed inputs
but do not replace the quarterly review.

**Issue template:** Open the quarterly review issue from the copyable body pattern in
[quarterly-review-template.md](./quarterly-review-template.md), which pulls evidence from incidents,
open backlog items, and release skew.