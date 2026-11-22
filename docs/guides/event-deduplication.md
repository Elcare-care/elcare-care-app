# Event Deduplication Keys

> Issue #1071. **Audience:** indexer developers and operators.
> **Owner:** `@org/backend-lead-indexer` (see [`.github/CODEOWNERS`](../../.github/CODEOWNERS)).

This guide explains how the indexer stops a repeated RPC delivery from creating a
second database row, applying a state change twice, or emitting a second SSE
frame. It covers the dedup fields, where uniqueness is enforced, and how the
parser tests line up with the code. It also lists open discrepancies that the
indexer owner needs to review.

Nothing in this guide changes how the application runs. The only code-adjacent
change in this PR is a test-fixture update (see
[Parser and dedup test alignment](#parser-and-dedup-test-alignment)).

---

## 1. Why duplicates happen

The same on-chain event can reach the indexer more than once:

| Source | Why it re-delivers |
|---|---|
| Poller window retry | A failed `$transaction` rolls back the checkpoint, so the same ledger window is fetched again. |
| Overlapping windows | Backfill (`backfill.ts`), gap repair (`gap-repair.ts`) and the live poller can cover the same ledgers. |
| Multiple workers | Lease hand-off (`fenced-lease.ts`) can briefly let two workers process the same range. |
| Dead-letter replay | `dead-letter-replay.ts` re-parses events that previously failed. |
| RPC provider failover | `rpc-provider-pool.ts` may return the same events from a different provider. |

All of these paths end up in the same write primitive, so a single key decides
whether an event is new.

---

## 2. Ingestion trace

```
RPC getEvents
   │
   ▼
event-sync.ts  extractEventOrdering()   → txIndex, eventIndex from the RPC event id ("<toid>-<idx>")
   │           parseMarketplaceEvent()  (parser.ts)
   │               computeEventHash(contractId, ledger, txHash, eventIndex)  → eventHash
   │               eventId = RPC id || eventHash
   │           sortDecodedEvents()      → total order (ledgerSequence, txIndex, eventIndex)
   ▼
poller.ts      prisma.$transaction(async tx => {
                 applyDecodedEvents(events, tx)
                   └─ upsertEvents()     (event-idempotency.ts)
                        └─ upsertEvent(): tx.marketplaceEvent.create(...)
                             ├─ success        → event is "new"
                             └─ Prisma P2002   → duplicateEventsCounter.inc(); event is skipped
                   └─ processEvent(e, tx, skipInsert=true) for NEW events only
                 commitCheckpoint(...)
               })
               for (ev of newEvents) emitSSEEvent(ev)   ← only after commit, only new events
```

The important properties:

1. **Domain projections run only for new events.** `applyDecodedEvents` calls
   `processEvent` only for the events `upsertEvents` actually inserted. A
   replayed event never re-runs `listing.upsert`, `bid.upsert`, `auction.updateMany`
   and so on.
2. **SSE frames are emitted only for new events and only after the transaction
   commits.** A replay produces no SSE frame.
3. **First write wins.** `upsertEvent` uses `INSERT` and catches the conflict
   on purpose instead of using `upsert`. An `upsert` could overwrite the
   stored payload with a replayed payload that differs (see the comment in
   `indexer/src/event-idempotency.ts`).
4. **Direct callers of `processEvent`** (when `skipInsert` is `false`) go
   through the same `upsertEvents` path and return early on a duplicate.

---

## 3. Deduplication fields

| Field | Computed in | Formula / source | Persisted on `MarketplaceEvent`? | Role |
|---|---|---|---|---|
| `eventHash` | `parser.ts` → `computeEventHash` | `sha256("<contractId>:<ledgerSequence>:<txHash>:<eventIndex>")` as 64-char lowercase hex | **Yes** (`eventHash String? @unique`) | **Canonical identity.** Primary dedup key. |
| `contractId` | `event-sync.ts` | Source contract address | Yes | Hash input; part of the effective scope. |
| `ledgerSequence` | RPC | Ledger number | Yes (partition key) | Hash input; part of the composite key. |
| `txHash` | RPC | Transaction hash | **No.** Only a hash input. | Hash input. |
| `eventIndex` | `event-sync.ts` → `extractEventOrdering` | Suffix of the RPC event id, or the array position as a fallback | Yes (`eventIndex Int?`) | Hash input; same-ledger ordering. |
| `txIndex` | `event-sync.ts` | Bits of the TOID in the RPC event id (`-1` when missing) | **No** | Ordering only. |
| `eventId` | `parser.ts` | RPC event id, or `eventHash` as a fallback | **No** (see [§6](#6-open-discrepancies-for-owner-review)) | In-memory identity used by `resolveEventId()` and tests. |
| `(listingId, eventType, ledgerSequence)` | — | Columns | Yes | Secondary composite unique key. |

`eventHash` depends only on immutable on-chain data. Retries, restarts and
different workers therefore always compute the same value for the same event.
`deduplication.test.ts` asserts that it is deterministic, is
64 hex characters long, and changes when any one of its four inputs changes.

---

## 4. Where uniqueness is enforced

### 4.1 `MarketplaceEvent` (the event log)

| Layer | Mechanism | Defined in |
|---|---|---|
| Prisma model | `eventHash String? @unique` | `indexer/prisma/schema.prisma` |
| Prisma model | `@@unique([listingId, eventType, ledgerSequence])` | `indexer/prisma/schema.prisma` |
| Database (current) | `MarketplaceEvent_eventHash_unique` (partial, `WHERE "eventHash" IS NOT NULL`) | `prisma/migrations/20260827000005_ledger_range_partitioning` |
| Database (current) | `MarketplaceEvent_idempotency_unique` on `(listingId, eventType, ledgerSequence)` (partial, `WHERE "listingId" IS NOT NULL`) | same migration |
| Database | `CHECK ("eventHash" IS NULL OR length("eventHash") > 0)` blocks the empty-string placeholder hash | `20260725000001_strengthen_event_idempotency` (the partitioned table recreates the column without a default) |
| Application | `upsertEvent` treats Prisma `P2002` (or a message containing `Unique constraint`) as a harmless replay | `indexer/src/event-idempotency.ts` |

How the dedup keys changed over time (most recent last). This history explains
why older docs disagree with each other:

| Migration | Change |
|---|---|
| `20231231000000_baseline` | `UNIQUE (listingId, eventType, ledgerSequence)` |
| `20260719000001_add_event_hash` | Adds `eventHash` with a `UNIQUE` index |
| `20260720000000_add_event_identity_ordering_and_history` | Adds `eventId` (unique), `txHash`, `txIndex`, and drops the composite key as "lossy" |
| `20260725000001_strengthen_event_idempotency` | `eventHash` becomes nullable; adds `UNIQUE (contractId, COALESCE(listingId::text,''), eventType, ledgerSequence)` and the non-empty CHECK |
| `20260827000002_check_constraints_preflight` | Backfills legacy NULL hashes with `legacy:<contractId>:<ledger>:<eventType>:<id>` |
| `20260827000005_ledger_range_partitioning` | Recreates the table as `PARTITION BY RANGE ("ledgerSequence")`. The column set has **no** `eventId`/`txHash`/`txIndex`. Recreates the partial `eventHash` unique index and the partial `(listingId, eventType, ledgerSequence)` unique index |

### 4.2 Related tables

| Model | Unique key | Purpose |
|---|---|---|
| `Bid` | `@@unique([auctionId, ledgerSequence, bidder])` | Written with `bid.upsert`, so a replayed `BID_PLACED` cannot add a second bid row. |
| `DeadLetterEvent` | `@@unique([contractId, ledgerSequence, txHash, eventIndex])` | The same four inputs as `eventHash`, so a failing event is dead-lettered only once. |
| `DeadLetterEvent` | `idempotencyKey @unique` | Admin replay requests are idempotent per caller-supplied key. |
| `KeeperAction` | `@@unique([targetType, targetId])` | One live keeper action per target. |
| `LedgerGap` | `@@unique([fromLedger, toLedger, source])` | Stops gap rows from being recorded twice. |
| `Listing` / `Auction` / `Offer` / `Collection` | Natural primary/unique keys + `upsert` | Projections converge even if they were applied twice. |

### 4.3 Metrics

| Metric | Meaning |
|---|---|
| `elcarehub_duplicate_events_total` (counter, `indexer/src/metrics.ts`) | +1 for each event that `upsertEvent` skipped as a replay. A steady low rate is normal around retries and backfills. A sudden sustained rise means overlapping workers or windows. |
| `DeadLetterReplayAttempt.outcome = "duplicate"` | A dead-letter replay found the event already projected. |

A replay never increments the business counters (sales volume, listings
created and similar), because those are updated from `processEvent`, which
runs only for new events.

---

## 5. Parser and dedup test alignment

| Behaviour | Code | Test |
|---|---|---|
| `eventHash` is deterministic, 64-hex, and changes with each input | `parser.ts` `computeEventHash` | `deduplication.test.ts` (`computeEventHash …` cases) |
| `eventId` falls back to `eventHash` when the RPC omits the id | `parser.ts` (`eventId: eventId \|\| eventHash`) | **Gap.** No dedicated assertion in `parser.test.ts` yet. `eventId` is not persisted (see §6.4), so the risk is low. |
| A second delivery inserts no row and returns no "new" event | `event-idempotency.ts` `upsertEvent` (INSERT + P2002 catch) | `deduplication.test.ts` "inserts exactly one row…" |
| `elcarehub_duplicate_events_total` goes up by exactly 1 per replay | `upsertEvent` → `duplicateEventsCounter.inc()` | `deduplication.test.ts` "increments duplicate_events_total…" |
| A full replay makes no projection writes | `applyDecodedEvents` → `processEvent` for new events only | `deduplication.test.ts` "a full replay of a mixed batch…" |
| A concurrent writer winning the race does not double-insert | DB unique index → P2002 | `deduplication.test.ts` "concurrent insert race…" |

**Fixture update in this PR.** `deduplication.test.ts` used to model dedup as
`findMany` + `createMany({ skipDuplicates: true })` keyed on `eventId`. That is
not what the code does. `upsertEvent` calls `marketplaceEvent.create` once per
event and relies on the database rejecting the duplicate with `P2002`. With the
old fixture, the `create` mock never rejected anything, so the tests could not
exercise the real dedup path. The fixture now:

- keeps an in-memory store that enforces **both** current unique keys
  (`eventHash`, and `(listingId, eventType, ledgerSequence)` when `listingId`
  is non-null), and
- makes `create` throw a Prisma-shaped `{ code: 'P2002' }` error on a conflict.

The test cases and assertions still check the same behaviour. Only the mocked
persistence layer changed to match `event-idempotency.ts`.

---

## 6. Open discrepancies for owner review

These were found while tracing the code. This PR documents them and does **not**
fix them, because each fix changes runtime behaviour or the schema and needs a
dedicated, reviewed change.

1. **A partitioned unique index must include the partition key.** PostgreSQL
   rejects a unique index on a partitioned table unless it includes every
   partition column (`ledgerSequence`). `MarketplaceEvent_eventHash_unique`
   covers only `"eventHash"`, so on a partitioned parent that statement fails.
   Check which indexes actually exist in each environment (read-only query
   below) before relying on hash-level uniqueness. A valid equivalent would be
   `UNIQUE ("ledgerSequence", "eventHash")`, which works because `ledgerSequence`
   is one of the hash inputs. `indexer/docs/partitioning-operations.md` says the
   index "propagates to all partitions". Reconcile that once this is verified.
2. **A unique violation inside an interactive transaction.** `upsertEvent`
   catches `P2002` *inside* the poller's `prisma.$transaction`. In PostgreSQL, a
   failed statement aborts the whole transaction unless a savepoint was taken.
   Later statements in the same transaction (more inserts, `commitCheckpoint`)
   would then fail with `25P02`, and the window would roll back and retry. Add
   an integration test against real Postgres (`vitest.integration.config.mts`)
   that replays a committed window to confirm the behaviour. Possible fixes are
   `INSERT … ON CONFLICT DO NOTHING` (Prisma `createMany({ skipDuplicates })`)
   or a pre-filter `findMany` on `eventHash`.
3. **The composite key can drop legitimate events.** `(listingId, eventType,
   ledgerSequence)` cannot tell apart two real same-type events for one
   listing in one ledger (for example, two `OFFER_MADE` from different users).
   Migration `20260720000000` dropped this key as "lossy". The partitioning
   migration brought it back. Today the second event is counted as a
   *duplicate* and skipped. `deduplication.test.ts` includes a
   characterization test that pins this behaviour. Change that test on purpose
   when the key is fixed.
4. **`eventId` / `txHash` / `txIndex` are not persisted.** The parser fills
   them in and `resolveEventId()` prefers `eventId`, but the current
   `MarketplaceEvent` table has none of these columns. `upsertEvent` does not
   write them either. Treat `eventHash` as the only persisted identity.
5. **`schema.prisma` and the migrations disagree.** The Prisma model declares
   non-partial uniques. The migrations create partial uniques (`WHERE … IS NOT
   NULL`). Behaviour is the same for non-null values, but
   `prisma migrate diff` will report drift.

---

## 7. Read-only verification

All of the following are **read-only**. Run them against a replica or with a
read-only role. They print no secrets or PII. `actor` values are wallet
addresses, so they are deliberately left out.

```sql
-- READ-ONLY: which unique indexes actually exist on the event log?
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'MarketplaceEvent' AND indexdef ILIKE '%UNIQUE%';

-- READ-ONLY: any duplicated canonical identity? (expect zero rows)
SELECT "eventHash", COUNT(*) AS n
FROM "MarketplaceEvent"
WHERE "eventHash" IS NOT NULL
GROUP BY "eventHash"
HAVING COUNT(*) > 1;

-- READ-ONLY: legacy rows without a real hash
SELECT COUNT(*) FROM "MarketplaceEvent"
WHERE "eventHash" IS NULL OR "eventHash" LIKE 'legacy:%';
```

```bash
# READ-ONLY: duplicate-skip counter (internal metrics endpoint, no credentials)
curl -s http://localhost:4000/metrics | grep '^elcarehub_duplicate_events_total'
```

---

## 8. Review and revert

**Reviewing.** Check each table above against the referenced file. The key
claims are in `indexer/src/parser.ts` (`computeEventHash`),
`indexer/src/event-idempotency.ts`, `indexer/src/poller.ts`
(`applyDecodedEvents`, the poll transaction), `indexer/prisma/schema.prisma`
(`MarketplaceEvent`), and the migrations listed in §4.1.

**Reverting.** This guide adds no runtime code, migration or configuration.
To revert, delete `docs/guides/event-deduplication.md`, remove its links from
`docs/guides/indexer-ingestion.md`, and restore
`indexer/src/__tests__/deduplication.test.ts` with
`git checkout <previous-sha> -- indexer/src/__tests__/deduplication.test.ts`.
No data migration or redeploy is needed.
