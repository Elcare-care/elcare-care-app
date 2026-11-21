# Contract Pause Communication Template

**Issue:** [#1119](https://github.com/Elcare-care/elcare-care-app/issues/1119)  
**Category:** Reliability, Security, and Operations  
**Owner:** Security Lead (content); Marketing (status page posting)  
**Last updated:** 2025-07-19

---

## Purpose

A contract pause stops all state-changing marketplace operations. Users, partners, and internal teams need consistent, accurate messaging that covers scope, reason, expected recovery time, and post-unpause verification steps. This document provides ready-to-fill templates for each phase of a pause incident.

The contract pause runbook (procedure for executing a pause, running the CLI commands, and completing the unpause checklist) is in [`contract-pause.md`](./contract-pause.md).

---

## Template Fields

Every communication must resolve these fields before posting. Leave a field blank only if the information is genuinely unknown — never guess.

| Field | Description | Example |
|---|---|---|
| `{SCOPE}` | What is paused: global, a named collection, or a named function | `Global marketplace pause` |
| `{REASON_PUBLIC}` | User-facing reason — no exploit details, no internal jargon | `a potential security concern we are actively investigating` |
| `{REASON_INTERNAL}` | Full internal reason for incident channel | `Unconfirmed report of self-purchase bypass on buy_artwork (error 17)` |
| `{PAUSE_TIME}` | UTC timestamp when pause was executed | `2025-07-19 14:32 UTC` |
| `{NEXT_UPDATE}` | UTC time of the next scheduled status page update | `15:00 UTC` |
| `{ESTIMATED_RECOVERY}` | Best honest estimate, or "unknown" | `~2 hours` or `unknown` |
| `{SAFE_ASSETS}` | Confirm existing escrow status | `All listed NFTs and escrowed tokens are safe and held in the contract.` |
| `{UNPAUSE_TIME}` | UTC timestamp when unpause was confirmed | `2025-07-19 16:45 UTC` |
| `{INCIDENT_SUMMARY}` | One sentence for public post-unpause message | `We identified and resolved an edge case in listing creation.` |
| `{INCIDENT_REPORT_ETA}` | When the full post-mortem will be published | `within 48 hours` |

---

## Phase 1 — Immediate Pause Announcement

Post within 5 minutes of executing the pause. Use all three channels simultaneously.

### Status Page (public)

```
ElcareHub Marketplace — Service Paused
{PAUSE_TIME}

We have temporarily paused the ElcareHub marketplace due to {REASON_PUBLIC}.

{SAFE_ASSETS}

You cannot submit new transactions until the pause is lifted. Existing listings and open auctions are not affected.

We are actively investigating and will post an update by {NEXT_UPDATE}.
```

### Internal Incident Channel (Slack / Discord ops channel)

```
[INCIDENT] Contract pause executed
Time: {PAUSE_TIME}
Scope: {SCOPE}
Reason: {REASON_INTERNAL}
Executor: @{your-handle}
is_paused confirmed: true (run `stellar contract invoke ... -- is_paused`)
Estimated recovery: {ESTIMATED_RECOVERY}
Incident commander: @{incident-commander}
Next status update: {NEXT_UPDATE}
```

### Partner / Integration Webhook (if applicable)

```json
{
  "event": "marketplace.paused",
  "timestamp": "{PAUSE_TIME}",
  "scope": "{SCOPE}",
  "message": "ElcareHub marketplace is temporarily paused. No state-changing transactions are accepted. Read-only queries remain available.",
  "safe_assets": true,
  "next_update": "{NEXT_UPDATE}"
}
```

---

## Phase 2 — Ongoing Update (every 30 minutes while paused)

```
[Update — {CURRENT_TIME} UTC] ElcareHub Marketplace remains paused.

Our team is continuing the investigation. {SAFE_ASSETS}

No action is required from you. Next update at {NEXT_UPDATE}.
```

Internal channel update (abbreviated):

```
[UPDATE {CURRENT_TIME}] Still investigating. {BRIEF_STATUS_LINE}. Next update: {NEXT_UPDATE}.
```

---

## Phase 3 — Unpause Announcement

Post only after completing every item on the unpause checklist in [`contract-pause.md`](./contract-pause.md) and confirming `is_paused` returns `false`.

### Status Page (public)

```
ElcareHub Marketplace — Service Restored
{UNPAUSE_TIME}

The ElcareHub marketplace has resumed normal operations. All marketplace functions — listings, auctions, offers, and purchases — are available.

{INCIDENT_SUMMARY}

A full incident report will be published {INCIDENT_REPORT_ETA}.

Thank you for your patience.
```

### Internal Incident Channel

```
[RESOLVED] Contract unpaused
Time: {UNPAUSE_TIME}
is_paused confirmed: false
Post-unpause checks passed: readyz 200, indexer ingesting UNPAUSED event, Prometheus baseline normal
Duration paused: {PAUSE_DURATION}
Root cause: {REASON_INTERNAL}
Action items: see incident issue #{ISSUE_NUMBER}
Incident report due: {INCIDENT_REPORT_ETA}
```

---

## Phase 4 — Post-Unpause Verification Checklist

Before posting the unpause announcement, confirm each item:

- [ ] `is_paused` returns `false` on-chain
- [ ] Indexer event log contains a `CONTRACT_UNPAUSED` event with the correct timestamp
  ```sql
  SELECT "eventType", actor, "ledgerTimestamp"
  FROM "MarketplaceEvent"
  WHERE "eventType" = 'CONTRACT_UNPAUSED'
  ORDER BY "ledgerSequence" DESC
  LIMIT 1;
  ```
- [ ] `/readyz` returns `200 {"ready": true}`
- [ ] Prometheus metrics show no anomalous spike in `elcarehub_sales_total` or `elcarehub_reentrancy_guard`
- [ ] A test read-only query (`get_active_listings_count`) returns without error
- [ ] Keeper bot is re-enabled if it was manually disabled during the pause
- [ ] Status page updated to "Resolved"
- [ ] Incident report drafted and assigned an owner

---

## UI Behavior During Pause

The frontend shows a banner when `is_paused` returns `true`. Confirm the banner text is consistent with the status page wording. The UI banner is not a substitute for status page communication — post the status page update first.

Write-action buttons (Buy, Bid, List, Make Offer) are disabled while paused. Read views (listings, auction history, activity feed) remain accessible.

---

## Who Posts What

| Channel | Posted by | Reviewed by |
|---|---|---|
| Status page | Marketing | Security Lead or Incident Commander |
| Internal Slack | Incident Commander | — |
| Partner webhook | DevOps automation (or manual) | Incident Commander |
| Incident report | Backend Lead or Security Lead | CTO |

---

## Related Documents

- [Contract Pause Runbook](./contract-pause.md) — CLI procedure, pause types, unpause checklist
- [Compromised Admin Key](./compromised-admin-key.md) — escalation path if the pause executor is unavailable
- [Observability Alerts](./observability-alerts.md) — Prometheus alert definitions that may trigger a pause
