# SSE Protocol Specification

## Overview

The indexer exposes a real-time event stream at `GET /events` using
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html.html).

Clients MUST use the `text/event-stream` content type and keep the connection
open. The server sends:

- `data:` frames for marketplace events
- `:heartbeat` comment frames for keep-alive
- `event: reset` frames when the client’s replay cursor is too old

## Connection lifecycle

1. Client opens `GET /events`.
2. Server responds with HTTP 200 and `Content-Type: text/event-stream`.
3. Server immediately sends a `CONNECTED` event.
4. Server sends subsequent event frames as they occur.
5. On disconnect, server cleans up internal state.

## Replay / resubscribe

Clients MAY send `Last-Event-ID: <id>` on connect. The server replays all
buffered events with `id > <id>` from an in-memory ring buffer (default 200
events).

Clients that cannot set headers MAY pass the cursor as `?lastEventId=<id>`
instead. When both are present, the `Last-Event-ID` header wins. An empty
`Last-Event-ID` header is treated as absent.

### Accepted cursor format

A resume cursor MUST be an `id` this endpoint sent: a non-negative decimal
integer of 1 to 15 digits (`^[0-9]{1,15}$`). Signs, whitespace, decimals,
exponents, hex and Redis Stream ids (`<ms>-<seq>`, used only by
`/notifications/stream`) are not cursors for `/events`. The 15-digit bound
keeps every accepted value exactly representable as a JavaScript number.

A malformed or oversized cursor, in either the header or the query parameter,
is rejected with HTTP 400 before the stream opens, and nothing is replayed:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Last-Event-ID must be a non-negative integer event id of at most 15 digits",
    "class": "CLIENT_ERROR",
    "requestId": "f0ca8a65-367c-4ca2-9657-cbf54e5bf653",
    "retryable": false
  }
}
```

If the client’s `Last-Event-ID` is older than the retained buffer, the server
sends a `reset` event:

```
event: reset
data: {"reason":"cursor_too_old","since":"42"}
```

Clients should treat this as a hard reset and re-fetch state from a REST
endpoint.

## Event frame format

Every event frame follows the SSE wire format:

```
id: <number>
event: <event_type>
data: <json_payload>

```

### Common fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Monotonically increasing event ID |
| `event` | string | Event type (e.g. `LISTING_CREATED`, `ARTWORK_SOLD`) |
| `data` | JSON | Event payload |

### Event types

| Event type | Description |
|------------|-------------|
| `CONNECTED` | Emitted once on new connection |
| `reset` | Server cannot replay requested history |
| `CRITICAL_REORG` | Poller halted due to deep re-org |
| `<CONTRACT_EVENT>` | On-chain contract event (e.g. `LISTING_CREATED`) |

## Heartbeat

The server sends a comment heartbeat every 30 seconds:

```
: heartbeat

```

Clients should treat heartbeats as keep-alive signals and not render them.

## Error conditions

| HTTP status | Condition |
|-------------|-----------|
| 200 | Normal stream |
| 400 | Malformed or oversized `Last-Event-ID` / `?lastEventId=`, or an invalid `?types=` / `?listingId=` filter |
| 503 | Connection limit reached (`MAX_SSE_CONNECTIONS`) |

## Rate limits

- Max concurrent connections per key (wallet or IP): configurable via
  `SSE_CONCURRENT_PER_KEY` (default 5).
- Total connections per instance: configurable via `MAX_SSE_CONNECTIONS`
  (default 500).

When the per-key concurrency limit is reached, the server returns:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "SSE connection limit reached (5 concurrent per key). Retry later.",
    "details": { "limit": 5, "key": "wallet:GABC...XYZ" }
  }
}
```

## Client requirements

- Handle dropped connections with exponential backoff (1s, 2s, 4s, … up to 60s).
- On `reset` event, fall back to REST snapshots.
- Reconnect with `Last-Event-ID` equal to the last received `id`.
- Do not send request bodies; this is a GET endpoint.
