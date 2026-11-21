# Runbook: Dead-Letter Event Review (View → Classify → Redact → Resolve → Replay)

> Issue #1066. **Owner:** `@org/backend-lead-indexer` (parser and replay), with `@org/backend-lead-contracts`
> for `UNSUPPORTED_SCHEMA_VERSION` events.
> **Code:** `indexer/src/event-sync.ts` (`persistDeadLetter`), `indexer/src/dead-letter-service.ts`,
> `indexer/src/api/routes.ts` (`/admin/dead-letters*`), `indexer/src/dead-letter-replay.ts` (CLI).
> **Model:** `DeadLetterEvent`, `DeadLetterReplayAttempt` (`indexer/prisma/schema.prisma`).

A **dead letter** is an on-chain event that the indexer fetched but could not parse. Instead of
being dropped, the raw topics and value are stored so the event can be replayed after a parser
fix. This runbook is the standard way to review those events.

## Safety labels

| Label | Meaning |
|---|---|
| 🟢 **READ-ONLY** | Changes nothing. Safe at any time. |
| 🟠 **AUDIT-WRITE** | Leaves domain data alone but **writes audit rows** (`DeadLetterReplayAttempt`, `OperationalAudit`) and may update `remediationReason`. |
| 🔴 **MUTATING** | Re-projects the event into domain tables (listings, auctions, offers, …) and changes the record's status. |

---

## 0. Prerequisites

- Operator credential: send `OPERATOR_TOKEN` in the `X-Operator-Token` header. This is the only header
  `authMiddleware('operator')` accepts. Read it from an environment variable, never type it inline,
  and **never** use the `?operator_token=` query form, because query strings end up in proxy access logs.
- `OPERATOR_ALLOWLIST`, if set, must include your egress IP.
- Rate limit: these routes use `operationalRateLimiter`.

```bash
export INDEXER_URL=https://<indexer-host>          # no trailing slash
# OPERATOR_TOKEN must already be in your shell from your secret manager. Do not echo it.
AUTH=(-H "X-Operator-Token: ${OPERATOR_TOKEN}")
```

> **Actor labels (fixed in this PR).** Before this change, the HTTP remediate/replay routes (and
> snapshot verify) stored the raw `X-Operator-Token` value as `actor` in `DeadLetterReplayAttempt`,
> `DeadLetterEvent.replayedBy` and `OperationalAudit`. They now store
> `operator:tok-<12 hex of sha256(token)>` (`operatorActorLabel()` in `api/auth-middleware.ts`). The
> label is stable per token and cannot be reversed. CLI runs record `cli:<os-user>`.
> **Follow-up for owners:** rows written before this deploy may contain the raw token. Rotate
> `OPERATOR_TOKEN` (see `docs/runbooks/role-rotation.md`). Count the affected rows with the
> 🟢 READ-ONLY query in §7 and decide on a scrub. A scrub is 🔴 MUTATING and needs its own
> change ticket.

---

## 1. VIEW 🟢 READ-ONLY

Start with metrics:

| Metric | Meaning |
|---|---|
| `indexer_dead_letter_created_total{error_code}` | New dead letters by `SCHEMA_DECODE`, `UNSUPPORTED_SCHEMA_VERSION` or `UNKNOWN` |
| `indexer_dead_letter_pending` | Current `Pending` count |
| `indexer_dead_letter_oldest_age_seconds` | Age of the oldest `Pending` record. Watch it against the 30-day retention (§6). |
| `indexer_unsupported_schema_version_total{event_type,schema_version}` | Events from a newer contract schema than this build understands |

List the queue (summary fields only, no payload):

```bash
# READ-ONLY
curl -s "${AUTH[@]}" "$INDEXER_URL/admin/dead-letters?status=Pending&limit=50&offset=0"
curl -s "${AUTH[@]}" "$INDEXER_URL/admin/dead-letters?status=Failed&contractId=<C…>"
```

The list returns `id`, `status`, `errorCode`, `contractId`, `ledgerSequence`, `txHash`,
`eventIndex`, `attempts`, `remediationReason`, `replayedBy`, `lockedAt`, `createdAt`, `updatedAt`
and the attempt count. It is ordered oldest first. `limit` is capped at 200.

Inspect one record:

```bash
# READ-ONLY
curl -s "${AUTH[@]}" "$INDEXER_URL/admin/dead-letters/42"
```

`inspectDeadLetter` returns the record, its last 20 replay attempts, and a **truncated** payload:
`rawTopics` items are cut to 128 characters and `rawValue` to 256 characters. The stored row is
**not** modified, so the full raw payload stays in the database for replay.

CLI equivalents (🟢 READ-ONLY; they need DB access via `DATABASE_URL` in the environment):

```bash
cd indexer
npx tsx src/dead-letter-replay.ts --list --status=Pending
npx tsx src/dead-letter-replay.ts --inspect --id=42
```

---

## 2. CLASSIFY 🟢 READ-ONLY

| `errorCode` | Cause | Typical resolution | Owner |
|---|---|---|---|
| `UNSUPPORTED_SCHEMA_VERSION` | The event's `schema_version` is higher than `SUPPORTED_SCHEMA_VERSIONS` in `event-schemas.ts` | Ship a decoder update first, then replay (see `CONTRIBUTING-SCHEMA-CHANGES.md`) | contracts + indexer leads |
| `SCHEMA_DECODE` | The payload doesn't match the registered schema for its type | Parser or schema bug: fix it, then replay. If the event is corrupt or from the wrong contract: leave it unreplayed and document why | indexer lead |
| `UNKNOWN` | Any other exception while decoding | Read `errorMessage`, reproduce with `--replay --dry-run`, then fix | indexer lead |

Also check:

- **Same root cause?** Group by `errorCode` + `contractId` + the first topic. A burst after a
  contract deploy is usually one schema change.
- **Is it ours?** Compare `contractId` with the tracked contracts in the startup configuration
  report (`docs/runbooks/startup-config-report.md`).
- **Previous attempts.** Check `attempts`, `replayAttempts[].outcome` and `status`. `Failed` means
  `attempts` reached `MAX_REPLAY_ATTEMPTS` (3).

---

## 3. REDACT 🟢 READ-ONLY (handling rule)

Dead-letter payloads are **public on-chain data**: base64 XDR topics and values. Even so, decoded
payloads contain wallet addresses (`G…`), which the logging policy treats as personal data
(`docs/LOGGING_POLICY.md`).

- In tickets, chat and incident notes, refer to a dead letter by **`id` + `contractId` +
  `ledgerSequence` + `txHash` + `eventIndex`**. These are enough to re-fetch the event from any RPC.
- Do **not** paste `rawValue`, decoded payloads or wallet addresses into tickets. If a decoded field
  is needed, truncate addresses (`GABC…WXYZ`).
- Never paste request headers, shell history containing `OPERATOR_TOKEN`, or the full `DATABASE_URL`.
- **Do not edit `rawTopics` / `rawValue` in the database.** Replay re-parses exactly what is stored,
  so changing the payload makes the replay no longer a faithful record of what happened on-chain.
  Fix the parser instead.

---

## 4. RESOLVE 🟠 AUDIT-WRITE

Record *why* the record will be replayed, or why it will be left alone, before you act:

```bash
# AUDIT-WRITE: sets remediationReason + replayedBy, writes an OperationalAudit row. No domain data changes.
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"remediationReason":"parser fix in indexer v1.4.2 (PR #NNNN) handles schema_version 2"}' \
  "$INDEXER_URL/admin/dead-letters/42/remediate"
```

- The reason is required. It is stored truncated to 1000 characters, and to 200 in the audit context.
  Put the PR or release in it. No PII.
- Returns `409` if the record is already `Replayed`, and `404` if it does not exist.
- **Not replaying a record?** There is no "ignored" status. Remediate with a reason such as
  `"won't replay: event from untracked contract C…; see INC-123"` and leave it unreplayed. It will be
  archived by the retention job (§6).

---

## 5. REPLAY

### 5a. Dry run 🟠 AUDIT-WRITE

The dry run re-parses the stored payload but **does not** project it, change its status or take the
lock. It still writes a `DeadLetterReplayAttempt` (`dryRun=true`) and an `OperationalAudit` row.

```bash
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"dryRun":true}' "$INDEXER_URL/admin/dead-letters/42/replay"
# CLI: npx tsx src/dead-letter-replay.ts --replay --id=42 --dry-run
```

Expected outcomes:

| `outcome` | HTTP | Meaning | Next |
|---|---|---|---|
| `success` | 200 | Parser now decodes it (`parsedEventType` is set) | Go to 5b |
| `parse_null` | 422 | Parser returns null (unknown topic) | Fix `TOPIC_MAP` / the parser |
| `projection_error` | 422 | Parser **or** projection threw. Despite the name, parse exceptions also land here. Read `errorMessage`. | Fix, then dry-run again |
| `duplicate` | 200 | Already `Replayed`, or this `idempotencyKey` was already used | Nothing to do |

### 5b. Live replay 🔴 MUTATING

**Preconditions:** the dry run returned `success` on the build that is **currently deployed**, the
record is remediated (§4), and the poller is not halted for a re-org.

```bash
# MUTATING: re-projects into domain tables; status → Replayed on success
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"INC-123-dl-42"}' "$INDEXER_URL/admin/dead-letters/42/replay"

# MUTATING batch (≤ 50 per call, default status Pending). Always dry-run the same batch first.
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"ids":[42,43,44],"dryRun":true}' "$INDEXER_URL/admin/dead-letters/replay/batch"
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"ids":[42,43,44]}' "$INDEXER_URL/admin/dead-letters/replay/batch"
```

Guarantees from `dead-letter-service.ts`:

- **Idempotency.** Repeating a request with the same `idempotencyKey` returns `duplicate` and does
  not run again. Always send a key for live replays.
- **Concurrency.** `lockedAt` is an optimistic lock. A second concurrent replay gets `409`. Locks
  older than 120 s are treated as stale.
- **Ordering.** The projection commits **before** the status becomes `Replayed`. A crash between the
  two leaves the record `Pending`, so it can be retried. Re-projecting is safe because of the
  `eventHash` dedup in `event-idempotency.ts`.
- **Status.** `success` → `Replayed`. Otherwise `attempts` goes up by one, and at 3 attempts the
  status becomes `Failed`. A `Failed` record can still be replayed by `id` once it is fixed. Batch
  replay only picks `Pending` unless you pass `status`.

**Rollback boundary.** A live replay cannot be undone with a single command. The projected event goes
through the normal `processEvent` path, exactly as if the poller had ingested it on time. If the
projection turns out to be wrong, the fix is a re-org-style rollback or reconciler repair of the
affected entities (`docs/runbooks/reorganization.md`), not editing the dead-letter row.

### 5c. Verify 🟢 READ-ONLY

```bash
curl -s "${AUTH[@]}" "$INDEXER_URL/admin/dead-letters/42"       # status Replayed, latest attempt success
curl -s "$INDEXER_URL/metrics" | grep -E '^indexer_dead_letter_(pending|replay_attempts_total|replay_projected_total)'
```

Then spot-check the affected entity on a public route (for example `GET /listings/<id>`).

---

## 6. Retention

From `indexer/src/archive.ts` and `docs/retention-archival.md`:

| Table | Hot retention | Archive table | Rule |
|---|---|---|---|
| `DeadLetterEvent` | 30 days | `ArchivedDeadLetterEvent` | `createdAt < now() - 30 days`, **whatever the status** |

A `Pending` record older than 30 days is archived and is **no longer reachable** through
`/admin/dead-letters` or the replay CLI. Resolve every record within 30 days. Alert on
`indexer_dead_letter_oldest_age_seconds > 25 days` (2 160 000 s). Restoring from the archive is a
🔴 MUTATING DBA operation outside this runbook.

---

## 7. Read-only SQL (replica / read-only role)

```sql
-- READ-ONLY: queue summary (no payload columns)
SELECT status, "errorCode", "contractId", COUNT(*) AS n,
       MIN("createdAt") AS oldest, MAX(attempts) AS max_attempts
FROM "DeadLetterEvent"
GROUP BY status, "errorCode", "contractId"
ORDER BY oldest;

-- READ-ONLY: audit rows written before the actor-label fix that may hold a raw token.
-- Counts only. Never SELECT the actor value itself into a terminal or ticket.
SELECT COUNT(*) AS suspect_rows
FROM "DeadLetterReplayAttempt"
WHERE actor NOT LIKE 'operator:%' AND actor NOT LIKE 'cli:%' AND length(actor) >= 32;
```

---

## 8. Known gaps (for owners)

- The `/admin/dead-letters*` routes are listed in `auth-middleware.ts` but **not** registered in
  `indexer/src/api/openapi.ts`, so they don't appear in `openapi.json` or Swagger. Add them, then run
  `npm run generate-openapi`.
- `projection_error` covers parse exceptions too. A separate `parse_error` outcome would make
  triage clearer.

---

## 9. Review and revert

**Reviewing.** Check each route, field, limit and outcome against `api/routes.ts` (dead-letter
section) and `dead-letter-service.ts` (`redactPayload`, `MAX_REPLAY_ATTEMPTS = 3`,
`REPLAY_LOCK_TTL_SECONDS = 120`). The code change in this PR is `operatorActorLabel()`, covered by
`src/__tests__/operator-actor-label.test.ts`.

**Reverting.** The documentation can be reverted with `git revert`. Reverting the actor-label code
puts **raw tokens** back into audit rows, so don't do it. If you need to change the label format,
change `operatorActorLabel()` instead. No migration is involved.
