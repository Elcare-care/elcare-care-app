/**
 * load-tests/k6/api-load.js
 *
 * k6 script — REST API load test
 *
 * Drives every major read endpoint with a realistic traffic mix:
 *   50% GET /listings          (paginated, filtered, FTS)
 *   15% GET /listings/:id
 *   10% GET /auctions
 *    8% GET /auctions/:id
 *    6% GET /offers
 *    5% GET /stats
 *    3% GET /collections
 *    2% GET /search
 *    1% GET /activity/recent
 *
 * Thresholds (resource budgets):
 *   p95 HTTP response latency  < 200 ms
 *   p99 HTTP response latency  < 500 ms
 *   error rate                 < 1 %
 *   cache-hit ratio (via header) inferred from X-Cache-Status
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:4001 load-tests/k6/api-load.js
 *
 * Stages (short load — ~4 min total):
 *   0→50 VU  ramp-up   60 s
 *   50 VU    sustained 120 s
 *   50→0 VU  ramp-down  60 s
 *
 * For soak mode set K6_SOAK=1:
 *   k6 run --env BASE_URL=http://localhost:4001 --env K6_SOAK=1 load-tests/k6/api-load.js
 *   Stages: 0→20 VU (2 min), 20 VU (30 min), 20→0 VU (2 min)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ── Custom metrics ────────────────────────────────────────────────────────────

const cacheHits   = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const cacheHitRate = new Rate('cache_hit_rate');
const p95Latency   = new Trend('p95_response_ms', true);

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4001';
const SOAK     = __ENV.K6_SOAK === '1';

// Pre-seeded listing IDs to avoid 404s on detail endpoints
const LISTING_IDS  = Array.from({ length: 100 }, (_, i) => i + 1);
const AUCTION_IDS  = Array.from({ length: 50  }, (_, i) => i + 1);
const SEARCH_TERMS = ['artwork', 'artist', 'collection', 'unique', 'digital', 'ab'];

// ── Stages ────────────────────────────────────────────────────────────────────

const shortStages = [
  { duration: '60s',  target: 50 },
  { duration: '120s', target: 50 },
  { duration: '60s',  target: 0  },
];

const soakStages = [
  { duration: '2m',  target: 20 },
  { duration: '30m', target: 20 },
  { duration: '2m',  target: 0  },
];

export const options = {
  stages: SOAK ? soakStages : shortStages,
  thresholds: {
    // Latency budgets
    http_req_duration:          ['p(95)<200', 'p(99)<500'],
    // Error budget — less than 1% of requests may fail
    http_req_failed:            ['rate<0.01'],
    // At least 60% of responses should be served from Redis cache
    cache_hit_rate:             ['rate>0.6'],
    // No individual request should exceed 2 s
    'http_req_duration{type:listing_list}':  ['p(99)<500'],
    'http_req_duration{type:listing_detail}':['p(99)<300'],
    'http_req_duration{type:auction_list}':  ['p(99)<500'],
    'http_req_duration{type:stats}':         ['p(99)<400'],
    'http_req_duration{type:search}':        ['p(99)<600'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function recordCache(res) {
  const status = res.headers['X-Cache-Status'] || res.headers['x-cache-status'] || '';
  if (status === 'HIT') {
    cacheHits.add(1);
    cacheHitRate.add(true);
  } else {
    cacheMisses.add(1);
    cacheHitRate.add(false);
  }
}

function get(path, tags) {
  const res = http.get(`${BASE_URL}${path}`, {
    tags,
    headers: { Accept: 'application/json' },
    timeout: '10s',
  });
  check(res, {
    'status 200': (r) => r.status === 200,
    'has body':   (r) => r.body && r.body.length > 2,
  });
  recordCache(res);
  p95Latency.add(res.timings.duration);
  return res;
}

// ── Virtual user scenario ─────────────────────────────────────────────────────

export default function () {
  const roll = Math.random();

  if (roll < 0.50) {
    // ── GET /listings (paginated / filtered / FTS) ────────────────────────────
    const offset = randomIntBetween(0, 200) * 20;
    const limit  = randomItem([10, 20, 50]);
    const useSearch = Math.random() < 0.15;
    const path = useSearch
      ? `/listings?limit=${limit}&search=${randomItem(SEARCH_TERMS)}`
      : `/listings?status=Active&limit=${limit}&offset=${offset}`;
    get(path, { type: 'listing_list' });

  } else if (roll < 0.65) {
    // ── GET /listings/:id ─────────────────────────────────────────────────────
    const id = randomItem(LISTING_IDS);
    get(`/listings/${id}`, { type: 'listing_detail' });

  } else if (roll < 0.75) {
    // ── GET /auctions ─────────────────────────────────────────────────────────
    const status = randomItem(['Active', 'Finalized', '']);
    const path = status ? `/auctions?status=${status}&limit=20` : '/auctions?limit=20';
    get(path, { type: 'auction_list' });

  } else if (roll < 0.83) {
    // ── GET /auctions/:id ─────────────────────────────────────────────────────
    const id = randomItem(AUCTION_IDS);
    get(`/auctions/${id}`, { type: 'auction_detail' });

  } else if (roll < 0.89) {
    // ── GET /offers ───────────────────────────────────────────────────────────
    const listingId = randomItem(LISTING_IDS);
    get(`/offers?listing_id=${listingId}&limit=20`, { type: 'offers' });

  } else if (roll < 0.94) {
    // ── GET /stats ────────────────────────────────────────────────────────────
    const range = randomItem(['day', 'week', 'month', '']);
    const path  = range ? `/stats?range=${range}` : '/stats';
    get(path, { type: 'stats' });

  } else if (roll < 0.97) {
    // ── GET /collections ──────────────────────────────────────────────────────
    get('/collections?limit=20', { type: 'collections' });

  } else if (roll < 0.99) {
    // ── GET /search ───────────────────────────────────────────────────────────
    const q = randomItem(SEARCH_TERMS);
    get(`/search?q=${q}&types=listings,collections&limit=10`, { type: 'search' });

  } else {
    // ── GET /activity/recent ──────────────────────────────────────────────────
    get('/activity/recent', { type: 'activity' });
  }

  // Think time: 0.3–1.5 s between requests (simulates real browser behaviour)
  sleep(Math.random() * 1.2 + 0.3);
}

// ── End-of-test summary ───────────────────────────────────────────────────────

export function handleSummary(data) {
  // Write JSON results alongside the text summary for the reporter to parse.
  return {
    'load-tests/results/api-load-latest.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// Minimal inline text summary (avoids external import in restricted envs)
function textSummary(data, _opts) {
  const dur = data.metrics.http_req_duration;
  if (!dur) return 'No duration metrics captured.\n';
  const v = dur.values;
  return [
    '',
    '── API Load Test Summary ────────────────────────────────',
    `  requests:    ${data.metrics.http_reqs?.values?.count ?? 'n/a'}`,
    `  avg:         ${v.avg?.toFixed(1)} ms`,
    `  p95:         ${v['p(95)']?.toFixed(1)} ms`,
    `  p99:         ${v['p(99)']?.toFixed(1)} ms`,
    `  error rate:  ${((data.metrics.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)}%`,
    `  cache hit:   ${((data.metrics.cache_hit_rate?.values?.rate ?? 0) * 100).toFixed(1)}%`,
    '─────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
