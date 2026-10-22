# SSE Protocol Specification

## Overview

The indexer exposes a real-time event stream at `GET /events` using
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html).

Clients MUST use the `text/event-stream` content type and keep the connection
open. The server sends:

- `data:` frames for marketplace events (and a `CONNECTED` frame on connect)
- `: heartbeat` comment frames for keep-alive (every 30 seconds)
- `event: reset` frames when the client’s replay cursor is too old

## Connection lifecycle

1. Client opens `GET /events` (optionally with a resume cursor).
2. Server responds with HTTP 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no`.
3. Server immediately sends a `CONNECTED` event as a `data:` frame.
4. If a resume cursor is provided and valid, the server replays missed events before continuing with live events.
5. Server sends subsequent event frames as they occur, with periodic `: heartbeat` comments.
6. On disconnect, server cleans up internal state.

## Reconnection and cursor behavior

### Supported cursors
- **Header (preferred):** `Last-Event-ID: <id>` - takes precedence if both header and query are present.
- **Query parameter:** `?lastEventId=<id>` - used when the header is absent.
- **Event IDs:** Monotonically increasing IDs assigned by the server (integer string form in the current implementation). Clients must treat IDs as opaque for ordering/comparison and store the last received `id` to resume.

### Resume / replay
1. On reconnect, the client SHOULD send the `Last-Event-ID` header set to the last event `id` it successfully received (or `?lastEventId=<id>`).
2. The server replays all buffered/streamed events with `id > <lastEventId>` that match any active filters, in order, with no duplicates across the resume boundary.
3. After replay (or immediately if no replay), the client receives live events as they occur.

### Cursor too old (reset)
If the client’s cursor is older than the retained replay window (no events to replay, but the buffer/stream starts after the cursor), the server emits:

```
event: reset
data: {"reason":"cursor_too_old","since":"<lastEventId>"}
```

Clients MUST treat `reset` as a hard reset: drop in-memory state for the stream and re-fetch authoritative state from REST endpoints before resuming. The `since` field contains the cursor the client provided.

### Retry guidance
- The server does **not** emit an SSE `retry:` field. Clients MUST implement reconnection logic with **exponential backoff** (e.g., 1s, 2s, 4s, … up to ~60s) on disconnects or errors.
- On reconnect, always resume using the last received event `id` via `Last-Event-ID` (or `?lastEventId=`).
- Heartbeats (`: heartbeat`) are keep-alive signals; clients should not render them as events.

**Important:** The server does **not** guarantee exactly-once delivery. Clients must be idempotent when applying events.

### Example reconnect
```http
GET /events HTTP/1.1
Host: indexer.example.com
Accept: text/event-stream
Last-Event-ID: 123
```

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

data: {"type":"CONNECTED","requestId":"req_abc"}

id: 124
event: LISTING_CREATED
data: {"listingId":"42","price":"1000000","token":"CDLZ...","seller":"GABC..."}

: heartbeat

id: 125
event: ARTWORK_SOLD
data: {"listingId":"7","buyer":"GDEF...","price":"5000000"}

```

If the cursor is too old:
```http
GET /events HTTP/1.1
Accept: text/event-stream
Last-Event-ID: 10
```
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

data: {"type":"CONNECTED","requestId":"req_def"}

event: reset
data: {"reason":"cursor_too_old","since":"10"}

```

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
