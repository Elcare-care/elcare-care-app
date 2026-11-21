# Quarterly Reliability Review Issue Template

This document provides a copyable GitHub issue body pattern for the quarterly reliability review. It consolidates evidence from incidents, open backlog items, and release skew so each review produces a consistent, auditable record.

**Related documents:**
- [Quarterly Review Process](./quarterly-review-process.md)
- [Reliability Backlog](./backlog.md)
- [Reliability README](./README.md)

## How to Use

1. Open a new GitHub issue in this repository.
2. Title it: `Quarterly Reliability Review — YYYY-QN` (for example, `Quarterly Reliability Review — 2025-Q1`).
3. Copy the issue body pattern below into the issue description.
4. Fill in every section. Use `N/A` only with a short justification.
5. Link the completed issue from the reliability README review log (if present) and attach it to the review meeting notes.

## Copyable Issue Body Pattern

```markdown
## Quarterly Reliability Review — YYYY-QN

**Owner:** @<review-owner>
**Trigger:** Scheduled quarterly review (first week after quarter close)
**Expected output:** Completed review record, prioritized action items with owners and due dates, and escalation notes
**Rollback / escalation:** If the review cannot be completed on schedule, escalate to @<reliability-lead> and record the reason in this issue.

### 1. Review Period

- **Quarter:** YYYY-QN
- **Start date:** YYYY-MM-DD
- **End date:** YYYY-MM-DD
- **Review meeting date:** YYYY-MM-DD

### 2. Attendees / Owners

| Role | Name / Handle | Responsibility |
| --- | --- | --- |
| Review owner | @ | Drives the review, files this issue |
| Reliability lead | @ | Approves action items and escalations |
| On-call representative | @ | Incident summary input |
| Service owner(s) | @ | Backlog and release skew input |

### 3. Incident Summary

Summarize incidents from the review period. Reference incident issues or postmortems.

| Incident | Date | Severity | Impact | Root cause | Postmortem link | Status |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

- **Total incidents:** N
- **Sev1 / Sev2 count:** N / N
- **Recurring themes:** <list>
- **Open postmortem action items carried forward:** <list or N/A>

### 4. Open Backlog Items with Scores

List open items from [backlog.md](./backlog.md) using the scoring legend defined there (impact, likelihood, and resulting priority score). Include the score and priority tier for each item.

| Item | Description | Impact | Likelihood | Score | Priority | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |

- **Scoring legend reference:** See [backlog.md](./backlog.md) for impact/likelihood definitions and score thresholds.
- **Items re-scored this quarter:** <list or N/A>
- **Items closed this quarter:** <list or N/A>

### 5. Release Skew vs versions.toml

Compare deployed versions against the pinned versions in `versions.toml`. Record any skew and its risk.

| Component | Pinned version (versions.toml) | Deployed version | Skew | Risk | Remediation owner |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

- **Components in compliance:** N / N
- **Components with skew:** N
- **Accepted skew (with justification):** <list or N/A>

### 6. Action Items

Every action item must have an owner and a due date. Link follow-up issues where applicable.

| # | Action item | Owner | Due date | Linked issue | Status |
| --- | --- | --- | --- | --- | --- |
| 1 |  | @ | YYYY-MM-DD | # | Open |

### 7. Rollback / Escalation Notes

- **Rollback considerations for this quarter's changes:** <summary or N/A>
- **Escalation path:** @<review-owner> → @<reliability-lead> → @<engineering-manager>
- **Unresolved risks carried to next quarter:** <list or N/A>
- **Next review date:** YYYY-MM-DD

### Evidence Result

- **Validation performed:** <e.g., markdown lint, link check, versions.toml comparison command>
- **Result:** <pass/fail and summary>
- **Recorded by:** @<name> on YYYY-MM-DD
```

## Notes

- Keep this template in sync with [quarterly-review-process.md](./quarterly-review-process.md) and the scoring legend in [backlog.md](./backlog.md). If either changes, update this template in the same pull request.
- Do not include secrets, live credentials, or customer-identifying data in the issue body.
- The review owner is responsible for closing the issue only after all action items have owners and due dates recorded.