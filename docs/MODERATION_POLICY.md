# Moderation Policy

> **Effective date:** 2026-07-26  
> **Scope:** All artwork images and metadata uploaded to ElcareHub via Pinata / IPFS

---

## 1. Acceptable-Content Policy

ElcareHub is a marketplace celebrating African art and culture. All uploaded content must comply with the following rules:

| Category | Policy |
|---|---|
| Artwork images | Must be original or properly licensed visual art. Photographs, digital art, and scans of physical works are all accepted. |
| Metadata | Must accurately describe the artwork. False attribution, misleading provenance, or copied descriptions are prohibited. |
| Prohibited content | Child sexual abuse material (CSAM), content that promotes hatred or violence based on protected characteristics, unlicensed third-party intellectual property where you lack rights, malware-like files, and spam are all prohibited. |
| AI-generated content | Permitted but must be disclosed in the `description` field. |

---

## 2. Moderation State Model

Every uploaded asset (image CID or metadata CID) moves through the following states:

```
PENDING ──► APPROVED
    │
    └─────► QUARANTINED ──► REJECTED
                 │
                 └──────────► APPROVED   (false-positive review)

REPORTED ──► (advances to QUARANTINED at threshold)
```

| State | Visible in UI | Can be minted | Description |
|---|---|---|---|
| `PENDING` | ✅ | ❌ | Default after upload; awaiting automated scan or manual review |
| `APPROVED` | ✅ | ✅ | Passed automated and/or manual review |
| `REPORTED` | ✅ | ❌ | Flagged by ≥1 community report; still visible, under review |
| `QUARANTINED` | ❌ | ❌ | Hidden from all public paths; active investigation |
| `REJECTED` | ❌ | ❌ | Permanently blocked |

### Automatic quarantine threshold

Content is automatically moved to `QUARANTINED` when it receives **3 or more** unique user reports.

---

## 3. Scanning Hooks

When an asset is uploaded via `/api/ipfs/upload-image` or `/api/ipfs/upload-metadata`:

1. The route registers a `PENDING` moderation record in the in-memory store (development) or the indexer database (production).
2. A background scanning job (future: integrated virus scanner / CSAM hash database) can update the state to `APPROVED` or `QUARANTINED` asynchronously.
3. Until the state is `APPROVED`, the asset **cannot be minted** through normal UI paths.

---

## 4. Reporting Workflow

### User reports

Users can report content via **POST /api/moderation/report**:

```json
{
  "cid": "bafybeig…",
  "kind": "IMAGE",
  "category": "PROHIBITED_CONTENT",
  "reporterAddress": "G…",
  "description": "Optional context (max 1000 chars)"
}
```

Report categories: `PROHIBITED_CONTENT`, `INTELLECTUAL_PROPERTY`, `MISLEADING_METADATA`, `SPAM`, `MALWARE_SUSPECTED`, `OTHER`.

### Admin review

Platform administrators can update a moderation state via the indexer's admin API with:
- actor (admin wallet address)
- new state
- reason (internal audit trail only — never shown to uploaders)

All state changes are recorded in a tamper-evident audit log with actor, timestamp, previous state, and reason.

---

## 4a. Moderation API (Issue #542)

The workflow above is implemented by the indexer's `/moderation` endpoints
(`indexer/src/api/moderation-routes.ts`), persisted in Postgres via Prisma
(`ModerationCase`, `ModerationReport`, `ModerationDecision`, `ModerationAppeal`
in `indexer/prisma/schema.prisma`):

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /moderation/reports` | Public | Submit a report. Never echoes the reporter's address. Deduplicates by (cid, reporterAddress). |
| `GET /moderation/cases/:cid` | Public | State + report count only — no reporter identity, no evidence text, no internal reason. |
| `GET /moderation/cases` | Operator | Paginated triage list, filterable by state. |
| `GET /moderation/cases/:cid/full` | Operator | Full case: reports (with evidence + reporter address), decisions, appeals. |
| `POST /moderation/cases/:cid/decision` | Operator | Set state (`APPROVED` / `QUARANTINED` / `REJECTED`), writes a `ModerationDecision`. |
| `POST /moderation/cases/:cid/appeals` | Authenticated | Uploader/creator appeals a `QUARANTINED` or `REJECTED` case. |
| `POST /moderation/appeals/:id/decision` | Operator | Resolve an appeal — `UPHELD` keeps the rejection, `OVERTURNED` reinstates the case's state. |

Operator routes require the `OPERATOR_TOKEN` credential (see
`indexer/src/api/auth-middleware.ts`). The frontend never holds this token in
the browser bundle — the admin UI (`/admin`) calls it through a Next.js
server-side proxy (`frontend/elcarehub-app/src/app/api/moderation/admin/*`).

Listing responses (`GET /listings`, `GET /listings/:id`, `GET /search`)
include a `moderationState` field derived from the associated
`ModerationCase` by `listingId`. Listings in a `QUARANTINED` or `REJECTED`
state are excluded from default public list/search results but remain
fetchable by id — the record itself, including all provenance fields, is
never deleted or rewritten.

---

## 5. Blocked-Content Presentation

When a page detects that an asset's state is `QUARANTINED` or `REJECTED`:

- The artwork image is replaced with an opaque overlay (see `ModerationBlockedOverlay`).
- The listing/auction **cannot be purchased or bid on**.
- The `ModerationBadge` component surfaces the state to the user in the appropriate UI colour.
- Creators are shown a non-specific message ("content under review") without exposing the identity of reporters.

---

## 6. Takedown Limitations for IPFS Content

IPFS content is **content-addressed and globally replicated**. Pinning a CID to Pinata does not make it the sole host of that content. As a result:

- **ElcareHub can:** Remove the pin from Pinata, preventing further replication via our gateway. Block the CID from all UI paths. Prevent the CID from being registered in any new on-chain listing or auction.
- **ElcareHub cannot:** Delete content that has already been replicated to third-party IPFS nodes or public gateways. Remove the content from the Stellar blockchain where the metadata CID has already been committed.

If you are a rights holder seeking a formal DMCA takedown or equivalent, please follow the procedure in [SECURITY.md](../SECURITY.md). We will unpin the CID from Pinata, remove it from the ElcareHub UI, and provide you with written confirmation.

---

## 7. Escalation Path

| Stage | Action |
|---|---|
| 1 | User submits report via `/api/moderation/report` |
| 2 | Threshold crossed → automatic `QUARANTINED` state |
| 3 | Admin reviews audit log within 48 hours |
| 4 | Admin sets final state: `APPROVED` (false positive) or `REJECTED` (confirmed violation) |
| 5 | For CSAM or credible threats, escalate to NCMEC / local law enforcement immediately |
| 6 | The uploader/creator may file an appeal via `POST /moderation/cases/:cid/appeals` against a `QUARANTINED` or `REJECTED` decision |
| 7 | An admin resolves the appeal via `POST /moderation/appeals/:id/decision` — `UPHELD` keeps the decision, `OVERTURNED` reinstates the case |

---

## 8. Policy Updates

This document is versioned in the repository. Any material changes will be announced in the project's changelog and communicated to active creators via the platform dashboard.
