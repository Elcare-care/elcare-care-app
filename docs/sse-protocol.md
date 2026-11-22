# SSE Protocol Specification

> Updated for Issue #1070. Everything below was checked against
> `indexer/src/api/routes.ts` (`GET /events`), `indexer/src/api/rate-limit-middleware.ts`
> (`sseConcurrencyGuard`), `indexer/src/api/query-schemas.ts` (`eventsQuerySchema`),
> `indexer/src/reorg.ts`, `indexer/src/poller.ts`, `indexer/src/stall.ts`, and
> `indexer/src/recovery-state-machine.ts`.
> **Owners:** `@org/backend-lead-indexer` (server), `@org/frontend-lead` (clients).

## Overview

The indexer streams marketplace events in real time at `GET /events` using
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html).

There are two SSE endpoints, and they behave differently:

| Endpoint | Implementation | Event ids | Replay source | Scope |
|---|---|---|---|---|
| `GET /events` (this document) | `routes.ts` in-process registry | Per-process integers `1, 2, 3…` | In-memory ring (`SSE_LOCAL_BUFFER_SIZE`, default 200) | One API instance |
| `GET /notifications/stream` | `realtime/hub.ts` (`RealtimeHub`) | Redis Stream ids `<ms>-<seq>` (integers when Redis is down) | Redis Stream (`SSE_STREAM_MAXLEN`, default 1000) | All instances (Redis pub/sub) |

The rest of this document covers `GET /events` unless it says otherwise.

## Connection lifecycle

1. The client opens `GET /events` and may add query filters (see below).
2. The middleware chain runs in this order: `abuseDetection('sse')` →
   `sseConcurrencyGuard` → `validateQuery(eventsQuerySchema)` → instance
   connection cap.
3. On success the server responds `200` with the headers below and flushes
   them immediately.
4. If a resume cursor was supplied, the server **replays** buffered events
   newer than the cursor. It may then send `event: reset` (see
   [Replay](#replay--resubscribe)).
5. The server sends one `CONNECTED` frame **after** any replay.
6. Live frames follow as new events commit. A `: heartbeat` comment is sent
   every 30 s.
7. When the client disconnects, the server clears the heartbeat timer and
   removes the client. On graceful shutdown, `closeSSEClients()` ends every
   stream. **No final frame is sent**, so clients just see the connection close.

### Response headers (actual)

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
X-API-Version: 1
X-Request-Id: <uuid>
```

`X-Accel-Buffering: no` stops nginx-style proxies from buffering the stream.
`X-API-Version` is set by `versioningMiddleware`. `X-Request-Id` is set by
`requestIdMiddleware` and exposed to browsers through CORS (`exposedHeaders`).
When the browser sends an `Origin` header, the CORS headers from
[`docs/guides/cors-validation.md`](guides/cors-validation.md) are added too.

### Query parameters

| Param | Format (`eventsQuerySchema`) | Effect |
|---|---|---|
| `types` | `^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$` | Comma-separated `eventType` filter |
| `listingId` | `^\d+$` | Only events for this listing |
| `lastEventId` | `^\d+(-\d+)?$` | Resume cursor, for clients that cannot set headers |

> ⚠️ **Filters are applied only to replayed frames.** Live frames on
> `/events` go to every connected client without filtering. Replay also lets
> through any event that has no `eventType` field (for example, poller
> `REORG`/`CRITICAL_REORG`, `indexer-stalled`). **Clients must filter
> locally** whatever query parameters they send.

## Replay / resubscribe

The resume cursor comes from the `Last-Event-ID` request header, or from
`?lastEventId=` when the header is missing. The **header takes precedence**.

The server replays every buffered event with `id > cursor` that matches the
filters, in id order, as standard `id:`/`data:` frames.

The server sends a `reset` frame only when **no** buffered event qualified
for replay and the oldest buffered id is newer than the cursor:

```
event: reset
data: {"reason":"cursor_too_old","since":"42"}

```

`reset` carries no `id:` line, so it does not move the browser's
`lastEventId`.

> ⚠️ **The server does not reliably detect gaps.** Three cases produce no `reset`:
>
> - **The cursor is older than the buffer.** For example, the cursor is `10`
>   and the buffer holds `300–500`. The server replays `300–500` and sends no
>   `reset`, so events `11–299` are silently missing.
> - **The server restarted.** Ids start again from `1`. A cursor such as `500`
>   matches nothing, and no `reset` is sent.
> - **The client reconnected to a different instance.** Each instance has its
>   own counter and buffer, so the cursor from one instance means nothing to
>   another.
>
> When filters are not used, ids on one instance are **contiguous integers**,
> so the client can detect all three cases itself (see the checklist). Treat
> `reset` as a hint, not a guarantee.

## Event frame format

### Data frames

Normal frames have **no `event:` line**. Browsers deliver them through
`EventSource.onmessage` / the `"message"` event:

```
id: 1287
data: {"eventType":"LISTING_CREATED","listingId":"42","actor":"G…","ledgerSequence":51234,"data":{…},"eventHash":"9f2c…","contractId":"C…","txHash":"…","eventIndex":0,"eventId":"…","txIndex":1}

```

The payload is the decoded event (`DecodedEvent` in `indexer/src/parser.ts`)
serialized as JSON, with `bigint` values written as strings. Use `eventHash`
to dedupe on the client (see
[`guides/event-deduplication.md`](guides/event-deduplication.md)).

### Named frames

The server sets the `event:` field in exactly two cases:

| `event:` | Emitted when | Payload | Has `id:` |
|---|---|---|---|
| `reorg` (lowercase) | The emitted object has `eventType` `REORG` or `CRITICAL_REORG` | e.g. `reorg.ts` → `{"eventType":"REORG","safeLedger":51200,"detectedAt":"…"}` | yes |
| `reset` | Cursor is too old (see above) | `{"reason":"cursor_too_old","since":"<cursor>"}` | no |

SSE event names are **case-sensitive**. `addEventListener("REORG", …)` does
**not** receive `event: reorg` frames.

### Control and system messages (delivered on `message`)

| Discriminator | Source | Payload fields | Has `id:` |
|---|---|---|---|
| `type: "CONNECTED"` | `routes.ts` (once, after replay) | `requestId` | no |
| `type: "REORG"` | `poller.ts` `emitReorgEvent` | `from_ledger`, `to_ledger`, `depth`, `timestamp` | yes |
| `type: "CRITICAL_REORG"` | `poller.ts` `emitCriticalReorgEvent` (poller halted) | `from_ledger`, `to_ledger`, `depth`, `timestamp`, `message` | yes |
| `eventType: "REORG_ENTITY"` | `reorg.ts` (one per rolled-back entity) | `entityType` (`listing`\|`auction`\|`offer`), `entityId`, `safeLedger` | yes |
| `type: "indexer-stalled"` | `stall.ts` (once per escalation) | `stallDurationMs`, `level`, `timestamp` | yes |
| `type: "indexer-recovery-mode"` | `recovery-state-machine.ts` | `mode`, `previousMode`, `reason`, `timestamp` | yes |

> Poller re-org notices use the key **`type`**. `reorg.ts` correction events
> use the key **`eventType`**. Only the `eventType` variant gets the named
> `event: reorg` frame. To catch every re-org signal, a client must handle
> **both** `onmessage` (checking `type` and `eventType`) **and**
> `addEventListener("reorg", …)`.

### Heartbeat

```
: heartbeat

```

This comment is sent every 30 s per connection (hard-coded in `routes.ts`).
Browsers never surface comments to script. A client can only notice that
heartbeats have stopped by running its own idle timer (see the checklist).

### `retry:` field

The server **never sends `retry:`**. Browsers fall back to their built-in
reconnection delay, which is UA-defined and usually a few seconds. Apply your
own backoff for the cases the browser does not retry (below).

## Ordering and delivery guarantees

| Property | Guarantee on `/events` |
|---|---|
| Order within a poll window | Events are applied and emitted in `(ledgerSequence, txIndex, eventIndex)` order (`sortDecodedEvents` in `event-sync.ts`). |
| Emission timing | Emitted only **after** the DB transaction commits, and only for newly inserted (non-duplicate) events. |
| Id monotonicity | Ids strictly increase per process. They are not shared across instances and restart from `1` when the process restarts. |
| Delivery | At most once per connection. No acknowledgements, and no server-side per-client queue on `/events`. |
| Replay horizon | The last `SSE_LOCAL_BUFFER_SIZE` events (default 200) **on that instance**. |
| Cross-contract order | Contracts are polled one after another. Events from different contracts can interleave, but each contract's events stay in order. |
| Re-org | An emitted event can be rolled back later. The rollback is announced with `REORG`/`REORG_ENTITY` frames, never by retracting the earlier frame. |

## Error conditions

| HTTP status | Condition | Body `error.code` | Headers |
|---|---|---|---|
| 200 | Normal stream | — | see above |
| 400 | Invalid `types` / `listingId` / `lastEventId` | validation error envelope | — |
| 503 | Per-key concurrency cap (`SSE_CONCURRENT_PER_KEY`, default 5) | `RATE_LIMIT_EXCEEDED` | `Retry-After: 30` |
| 503 | Instance cap (`MAX_SSE_CONNECTIONS`, default 500) | `SERVICE_UNAVAILABLE` | — |
| 4xx | Abuse detection (`abuseDetection('sse')`) | see `docs/ABUSE_DETECTION.md` | — |

Example of a per-key limit response:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "SSE connection limit reached (5 concurrent per key). Retry later.",
    "class": "CLIENT_ERROR",
    "details": { "limit": 5, "key": "<rate-limit key>" }
  }
}
```

> Browser `EventSource` **does not reconnect after a non-200 response** or a
> non-`text/event-stream` content type. It fires `error`, sets `readyState`
> to `CLOSED`, and stops. It also cannot read `Retry-After`. The application
> must recreate the connection with its own backoff.

## Configuration

| Variable | Default | Applies to |
|---|---|---|
| `MAX_SSE_CONNECTIONS` | 500 | `/events` instance cap |
| `SSE_CONCURRENT_PER_KEY` | 5 | per wallet/IP key, shared by `/events` and `/notifications/stream` |
| `SSE_LOCAL_BUFFER_SIZE` | 200 | `/events` replay ring |
| `SSE_MAX_CONNECTIONS`, `SSE_HEARTBEAT_MS`, `SSE_STREAM_MAXLEN`, `SSE_CLIENT_QUEUE_MAX` | 100, 30000, 1000, 100 | `RealtimeHub` only (`/notifications/stream`) |

## Browser reconnection checklist

Use this checklist for any browser consumer of `GET /events`. The reference
client is `subscribeToEvents` in `frontend/elcarehub-app/src/lib/indexer.ts`.

**Connecting**

- [ ] Open the stream with `new EventSource(url, { withCredentials: false })`
      unless cookies are really needed. The API authenticates with headers,
      and `EventSource` cannot send custom headers anyway.
- [ ] Put filters in the query string, and **still filter locally** (live
      frames are not filtered by the server).
- [ ] Treat the `CONNECTED` frame (`type === "CONNECTED"`) as "stream is
      live". Log its `requestId` for support tickets. It contains no PII.

**Tracking ids**

- [ ] After every frame that has an id, save `MessageEvent.lastEventId`. This
      also applies to named `reorg` frames: register `addEventListener("reorg")`
      and read `evt.lastEventId` there too.
- [ ] Keep the saved id in memory, or in `sessionStorage` for one tab only.
      Ids are per instance and per process, so never share them between users
      or devices.
- [ ] **Gap check (unfiltered streams):** when `id !== lastId + 1`, a gap
      happened. Resync (see *Stale state recovery*).
- [ ] **Restart check:** when `id <= lastId`, the server restarted or you
      reached a different instance. Reset `lastId` to the new id and resync.
- [ ] Dedupe data frames by `eventHash` (a bounded LRU is fine). Replays can
      overlap events you already applied.

**Backoff**

- [ ] Let the browser's automatic reconnect handle plain network drops. It
      resends `Last-Event-ID` for you.
- [ ] In `onerror`, if `es.readyState === EventSource.CLOSED`, the browser
      has given up (non-200, 503, 400). Call `es.close()`, then recreate the
      connection after an **exponential backoff with jitter**: 1 s, 2 s, 4 s …
      capped at 60 s, multiplied by a random 0.5–1.5. Pass
      `?lastEventId=<lastId>`, because a new `EventSource` cannot set the
      header.
- [ ] After a 503 (`RATE_LIMIT_EXCEEDED`), wait at least **30 s**. That is
      the server's `Retry-After`, which `EventSource` cannot read. Also look
      for duplicate tabs or leaked connections, since the limit is 5 per key.
- [ ] Stop retrying after a 400. The URL or cursor is malformed. Drop
      `lastEventId` and reconnect once from scratch.
- [ ] Reset the backoff counter after receiving `CONNECTED`.
- [ ] Run an idle watchdog. If no frame **or** `onopen` arrives for 75 s (2.5
      heartbeat intervals), close the connection and reconnect. A dead proxy
      can keep a socket "open" without delivering anything.
- [ ] Pause the connection while the page is hidden (`visibilitychange`) to
      free up per-key slots, and resume it with `lastEventId`.

**Re-org handling**

- [ ] Handle `addEventListener("reorg", …)` (lowercase) **and** `onmessage`
      payloads where `type` or `eventType` is `REORG`, `CRITICAL_REORG` or
      `REORG_ENTITY`.
- [ ] On `REORG` / `REORG_ENTITY`: drop or refetch every cached entity whose
      ledger is greater than `safeLedger` (or `from_ledger`). For
      `REORG_ENTITY`, refetch the named `entityType`/`entityId` from REST.
- [ ] On `CRITICAL_REORG`: the poller has **halted** until an operator calls
      `POST /admin/reorg-recovery`. Show a persistent "data may be stale"
      banner, keep the connection open, and do not keep refetching in a loop.
- [ ] Do not "undo" frames locally. Always re-read the server's truth from
      REST.

**Stale state recovery**

- [ ] Resync after any of these: a `reset` frame, a failed gap or restart
      check, an idle-watchdog reconnect, a filtered stream reconnecting
      (gaps cannot be detected there), or `indexer-recovery-mode` /
      `indexer-stalled` returning to normal.
- [ ] Resync = refetch the REST snapshot for the current view (for example
      `GET /listings/:id`, `GET /activity/recent`), replace local state, then
      keep applying live frames, deduped by `eventHash`.
- [ ] Buffer live frames that arrive during the REST fetch and apply them
      after the snapshot. Skip any whose `ledgerSequence` is ≤ the snapshot's
      ledger.

**Known frontend gap (for `@org/frontend-lead`):**
`frontend/elcarehub-app/src/components/ReorgNotifier.tsx` registers
`addEventListener("REORG")` / `("CRITICAL_REORG")`, but the server names the
frame `reorg`. The poller-emitted `type: "REORG"` notices still arrive through
`onmessage`, but `reorg.ts` correction frames (`eventType: "REORG"`) are missed.
Add a `"reorg"` listener there.

## Validation (read-only)

These commands only read the stream. They send no credentials. Press `Ctrl-C`
to stop.

```bash
# READ-ONLY: show the response headers and the first frames
curl -sN -D - http://localhost:4000/events | head -n 20

# READ-ONLY: resume from a cursor via the header
curl -sN -H 'Last-Event-ID: 120' http://localhost:4000/events

# READ-ONLY: resume via query string (equivalent; the header wins if both are given)
curl -sN 'http://localhost:4000/events?lastEventId=120&types=LISTING_CREATED,ARTWORK_SOLD'
```

## Review and revert

**Reviewing.** Compare each table with the source file named in the header
note. The parts most likely to drift are the response headers
(`routes.ts` `GET /events`), the frame-naming rule (`isReorg` in
`emitSSEEvent`), and the error codes (`sseConcurrencyGuard`).

**Reverting.** This change is documentation only. Revert it with
`git revert <commit>`, or restore this file from the previous commit. No
service restart or configuration change is needed.
