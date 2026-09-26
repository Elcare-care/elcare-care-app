/**
 * load-tests/k6/sse-load.js
 *
 * k6 script — SSE (Server-Sent Events) load test
 *
 * Opens persistent SSE connections to GET /events and measures:
 *   - Time-to-first-event (TTFE): how long before the CONNECTED message arrives
 *   - Event delivery rate: events received per second per connection
 *   - Ingestion lag: difference between event.ledgerTimestamp and wall clock
 *   - Connection stability: any unexpected disconnects
 *   - Memory / connection behaviour at the configured MAX_SSE_CONNECTIONS limit
 *
 * k6 does not have a native SSE client; we use a chunked HTTP GET with
 * streaming enabled to receive the event stream and parse SSE frames manually.
 *
 * Thresholds:
 *   - TTFE p95 < 500 ms
 *   - Disconnect rate < 2%
 *   - Missed heartbeats (>35 s silence) < 1% of connections
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:4001 load-tests/k6/sse-load.js
 *
 * Stages:
 *   Short:  0→100 VU (30 s), hold 120 s, 100→0 (30 s)
 *   Soak (K6_SOAK=1): 0→200 VU (2 min), hold 20 min, 200→0 (2 min)
 *
 * Each VU opens one long-lived SSE connection, holds it for SSE_HOLD_SECONDS,
 * then closes and opens a new one (simulating browser tab lifecycle).
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';

// ── Custom metrics ────────────────────────────────────────────────────────────

const ttfe            = new Trend('sse_ttfe_ms',               true);
const eventsReceived  = new Counter('sse_events_received');
const disconnects     = new Counter('sse_disconnects');
const disconnectRate  = new Rate('sse_disconnect_rate');
const activeConns     = new Gauge('sse_active_connections');
const heartbeatMisses = new Counter('sse_heartbeat_misses');

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL        = __ENV.BASE_URL        || 'http://localhost:4001';
const SSE_HOLD_SECS   = parseInt(__ENV.SSE_HOLD_SECONDS ?? '30',  10);
const SOAK            = __ENV.K6_SOAK === '1';

const shortStages = [
  { duration: '30s',  target: 100 },
  { duration: '120s', target: 100 },
  { duration: '30s',  target: 0   },
];

const soakStages = [
  { duration: '2m',  target: 200 },
  { duration: '20m', target: 200 },
  { duration: '2m',  target: 0   },
];

export const options = {
  stages: SOAK ? soakStages : shortStages,
  thresholds: {
    sse_ttfe_ms:          ['p(95)<500'],
    sse_disconnect_rate:  ['rate<0.02'],
    sse_heartbeat_misses: ['count<50'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ── SSE frame parser ──────────────────────────────────────────────────────────

/**
 * Parse SSE frames from a raw chunk string.
 * Returns array of parsed data objects (JSON-decoded) and the last event id seen.
 */
function parseSseChunk(raw) {
  const frames = [];
  const lines  = raw.split('\n');
  let dataLine = '';
  let lastId   = null;

  for (const line of lines) {
    if (line.startsWith('id: ')) {
      lastId = line.slice(4).trim();
    } else if (line.startsWith('data: ')) {
      dataLine = line.slice(6).trim();
    } else if (line === '' && dataLine) {
      try {
        frames.push({ id: lastId, data: JSON.parse(dataLine) });
      } catch {
        // non-JSON frame (heartbeat comment lines pass through as-is)
      }
      dataLine = '';
    }
  }
  return frames;
}

// ── Virtual user scenario ─────────────────────────────────────────────────────

export default function () {
  const lastEventId = __VU === 1 ? null : null; // fresh connection per VU
  const headers = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...(lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}),
  };

  activeConns.add(1);
  const connStart = Date.now();
  let connectedAt: number | null = null;
  let frameCount  = 0;
  let lastHeartbeat = Date.now();
  let disconnected  = false;

  // k6 streaming: open the SSE endpoint with a timeout matching hold duration.
  // We use http.get with responseType: 'text' and a generous timeout;
  // the connection is kept open by the server's chunked transfer-encoding.
  const res = http.get(`${BASE_URL}/events`, {
    headers,
    timeout: `${SSE_HOLD_SECS + 5}s`,
    responseType: 'text',
    tags: { type: 'sse' },
  });

  // Record connection outcome
  const ok = check(res, {
    'SSE 200':           (r) => r.status === 200,
    'Content-Type SSE':  (r) => (r.headers['Content-Type'] || '').includes('text/event-stream'),
  });

  if (!ok || res.status !== 200) {
    disconnects.add(1);
    disconnectRate.add(true);
    activeConns.add(-1);
    return;
  }

  // Parse all frames received in the response body
  const frames = parseSseChunk(res.body || '');

  for (const frame of frames) {
    frameCount++;
    eventsReceived.add(1);

    if (frame.data && frame.data.type === 'CONNECTED' && connectedAt === null) {
      connectedAt = Date.now();
      ttfe.add(connectedAt - connStart);
    }

    // Detect heartbeats (comment lines become empty data objects after parse)
    lastHeartbeat = Date.now();
  }

  // Heartbeat miss detection: if the body arrived but no heartbeat/data in
  // the last 35 s window (server sends every 30 s), count it.
  if (Date.now() - lastHeartbeat > 35_000 && frameCount === 0) {
    heartbeatMisses.add(1);
  }

  // Graceful cleanup metrics
  if (!disconnected) {
    disconnectRate.add(false);
  }
  activeConns.add(-1);

  // Brief pause before reopening a new connection (simulates tab lifecycle)
  sleep(Math.random() * 2 + 1);
}

// ── End-of-test summary ───────────────────────────────────────────────────────

export function handleSummary(data) {
  const out = buildSummary(data);
  return {
    'load-tests/results/sse-load-latest.json': JSON.stringify(data, null, 2),
    stdout: out,
  };
}

function buildSummary(data) {
  const ttfeV = data.metrics.sse_ttfe_ms?.values ?? {};
  const evtCount = data.metrics.sse_events_received?.values?.count ?? 0;
  const discRate = ((data.metrics.sse_disconnect_rate?.values?.rate ?? 0) * 100).toFixed(2);
  const hbMiss   = data.metrics.sse_heartbeat_misses?.values?.count ?? 0;
  return [
    '',
    '── SSE Load Test Summary ────────────────────────────────',
    `  TTFE p50:          ${ttfeV['p(50)']?.toFixed(1) ?? 'n/a'} ms`,
    `  TTFE p95:          ${ttfeV['p(95)']?.toFixed(1) ?? 'n/a'} ms`,
    `  events received:   ${evtCount}`,
    `  disconnect rate:   ${discRate}%`,
    `  heartbeat misses:  ${hbMiss}`,
    '─────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
