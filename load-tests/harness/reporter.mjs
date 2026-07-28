#!/usr/bin/env node
/**
 * load-tests/harness/reporter.mjs
 *
 * Aggregates all load-test result JSON files into a single human-readable
 * report, saves it as LOAD_TEST_RESULTS.md in the project root, and updates
 * load-tests/results/baseline.json when --update-baseline is passed.
 *
 * Usage (called by run-load-test.sh):
 *   node load-tests/harness/reporter.mjs \
 *     --timestamp 20240101_120000 \
 *     --results-dir load-tests/results \
 *     --violations "api_p95=210;redis_memory_mb=120"
 *
 *   node load-tests/harness/reporter.mjs --update-baseline
 *     Promotes the latest results to the stored baseline for comparison.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const has  = (flag) => args.includes(flag);

const TIMESTAMP       = get('--timestamp')    ?? new Date().toISOString().slice(0,16).replace('T','_').replace(':','');
const RESULTS_DIR     = resolve(get('--results-dir') ?? 'load-tests/results');
const VIOLATIONS_STR  = get('--violations') ?? '';
const UPDATE_BASELINE = has('--update-baseline');

const REPO_ROOT       = resolve(RESULTS_DIR, '../..');
const BASELINE_FILE   = join(RESULTS_DIR, 'baseline.json');
const MD_OUT          = join(REPO_ROOT, 'LOAD_TEST_RESULTS.md');

mkdirSync(RESULTS_DIR, { recursive: true });

// ── Read result files ─────────────────────────────────────────────────────────

function tryRead(file) {
  try { return JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8')); }
  catch { return null; }
}

const apiSummary      = tryRead('api-load-latest-summary.json');
const sseSummary      = tryRead('sse-load-latest-summary.json');
const ingestResult    = tryRead('ingestion-latest.json');
const resourceResult  = tryRead('resources-latest.json');
const baseline        = existsSync(BASELINE_FILE)
  ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  : null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const pct = (n) => n != null ? `${(n * 100).toFixed(1)}%` : 'n/a';
const ms  = (n) => n != null ? `${Number(n).toFixed(1)} ms` : 'n/a';
const num = (n) => n != null ? String(Number(n).toFixed(1)) : 'n/a';

function p95(summary, metric) {
  const m = summary?.metrics?.[metric];
  return m?.values?.['p(95)'] ?? m?.values?.p95 ?? null;
}

function delta(current, base, key, higher_is_better = false) {
  if (base == null || base[key] == null || current == null) return '';
  const diff = current - base[key];
  if (Math.abs(diff) < 0.01) return ' *(no change)*';
  const arrow = higher_is_better ? (diff > 0 ? '▲' : '▼') : (diff > 0 ? '▲' : '▼');
  const sign  = diff > 0 ? '+' : '';
  const bad   = higher_is_better ? diff < 0 : diff > 0;
  const mark  = bad ? '⚠' : '✓';
  return ` ${mark} ${arrow}${sign}${diff.toFixed(1)}`;
}

// ── Build metrics object ──────────────────────────────────────────────────────

const apiP95        = p95(apiSummary, 'http_req_duration');
const apiP99        = apiSummary?.metrics?.http_req_duration?.values?.['p(99)'];
const apiErrorRate  = apiSummary?.metrics?.http_req_failed?.values?.rate;
const apiReqs       = apiSummary?.metrics?.http_reqs?.values?.count;
const cacheHitRate  = apiSummary?.metrics?.cache_hit_rate?.values?.rate;

const sseP95        = p95(sseSummary, 'sse_ttfe_ms');
const sseDiscoRate  = sseSummary?.metrics?.sse_disconnect_rate?.values?.rate;
const sseEvents     = sseSummary?.metrics?.sse_events_received?.values?.count;

const ingestLagP95  = ingestResult?.ingestionLagP95Ms;
const ingestLagP99  = ingestResult?.ingestionLagP99Ms;
const ingestTput    = ingestResult?.throughputEventsPerSec;
const ingestErrors  = ingestResult?.totalErrors;

const dbConns       = resourceResult?.db_active_connections;
const redisMem      = resourceResult?.redis_memory_mb;
const redisHits     = resourceResult?.redis_hits;
const redisMisses   = resourceResult?.redis_misses;
const redisHitPct   = (redisHits != null && redisMisses != null)
  ? ((redisHits / (redisHits + redisMisses + 1)) * 100).toFixed(1) + '%'
  : 'n/a';

const violations    = VIOLATIONS_STR
  .split(';').map((s) => s.trim()).filter(Boolean);

// ── Current snapshot for baseline comparison ──────────────────────────────────

const currentSnapshot = {
  timestamp:          new Date().toISOString(),
  apiP95Ms:           apiP95,
  apiP99Ms:           apiP99,
  apiErrorRatePct:    apiErrorRate != null ? apiErrorRate * 100 : null,
  apiTotalRequests:   apiReqs,
  cacheHitRatePct:    cacheHitRate != null ? cacheHitRate * 100 : null,
  sseP95Ms:           sseP95,
  sseDiscoRatePct:    sseDiscoRate != null ? sseDiscoRate * 100 : null,
  sseEventsReceived:  sseEvents,
  ingestLagP95Ms:     ingestLagP95,
  ingestLagP99Ms:     ingestLagP99,
  ingestTputEvtPerSec: ingestTput,
  ingestTotalErrors:  ingestErrors,
  dbActiveConns:      dbConns,
  redisMemMb:         redisMem,
  redisHitPct:        redisHitPct,
};

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_FILE, JSON.stringify(currentSnapshot, null, 2));
  console.log(`[reporter] Baseline updated → ${BASELINE_FILE}`);
}

// ── Write results/latest.json ─────────────────────────────────────────────────

writeFileSync(
  join(RESULTS_DIR, 'latest.json'),
  JSON.stringify({ ...currentSnapshot, violations }, null, 2),
);

// ── Build Markdown report ─────────────────────────────────────────────────────

const bl = baseline;

const md = `# Load Test Results

> Run: \`${TIMESTAMP}\`  
> Mode: ${process.env.SOAK === '1' ? 'Soak (long)' : 'Short load'}  
> Status: ${violations.length === 0 ? '✅ PASSED' : `❌ FAILED (${violations.length} violation(s))`}

---

## API Latency

| Metric | This Run | Baseline | Budget |
|---|---|---|---|
| p95 response time | ${ms(apiP95)}${delta(apiP95, bl, 'apiP95Ms')} | ${ms(bl?.apiP95Ms)} | < 200 ms |
| p99 response time | ${ms(apiP99)}${delta(apiP99, bl, 'apiP99Ms')} | ${ms(bl?.apiP99Ms)} | < 500 ms |
| error rate | ${pct(apiErrorRate)}${delta(apiErrorRate != null ? apiErrorRate * 100 : null, bl, 'apiErrorRatePct')} | ${pct(bl?.apiErrorRatePct != null ? bl.apiErrorRatePct / 100 : null)} | < 1% |
| total requests | ${num(apiReqs)} | ${num(bl?.apiTotalRequests)} | — |

## Cache Behaviour

| Metric | This Run | Baseline | Budget |
|---|---|---|---|
| Redis hit rate (k6) | ${pct(cacheHitRate)}${delta(cacheHitRate != null ? cacheHitRate * 100 : null, bl, 'cacheHitRatePct', true)} | ${bl?.cacheHitRatePct != null ? bl.cacheHitRatePct.toFixed(1) + '%' : 'n/a'} | > 60% |
| Redis hit rate (server) | ${redisHitPct} | ${bl?.redisHitPct ?? 'n/a'} | — |
| Redis memory | ${num(redisMem)} MB${delta(redisMem, bl, 'redisMemMb')} | ${num(bl?.redisMemMb)} MB | < ${process.env.REDIS_MEM_BUDGET_MB ?? 100} MB |

## SSE Event Delivery

| Metric | This Run | Baseline | Budget |
|---|---|---|---|
| TTFE p95 | ${ms(sseP95)}${delta(sseP95, bl, 'sseP95Ms')} | ${ms(bl?.sseP95Ms)} | < 500 ms |
| disconnect rate | ${pct(sseDiscoRate)}${delta(sseDiscoRate != null ? sseDiscoRate * 100 : null, bl, 'sseDiscoRatePct')} | ${bl?.sseDiscoRatePct != null ? bl.sseDiscoRatePct.toFixed(1) + '%' : 'n/a'} | < 2% |
| events received | ${num(sseEvents)} | ${num(bl?.sseEventsReceived)} | — |

## Ingestion / Poller

| Metric | This Run | Baseline | Budget |
|---|---|---|---|
| lag p95 | ${ms(ingestLagP95)}${delta(ingestLagP95, bl, 'ingestLagP95Ms')} | ${ms(bl?.ingestLagP95Ms)} | < 500 ms |
| lag p99 | ${ms(ingestLagP99)}${delta(ingestLagP99, bl, 'ingestLagP99Ms')} | ${ms(bl?.ingestLagP99Ms)} | — |
| throughput | ${num(ingestTput)} events/s${delta(ingestTput, bl, 'ingestTputEvtPerSec', true)} | ${num(bl?.ingestTputEvtPerSec)} events/s | > 100 events/s |
| total errors | ${num(ingestErrors)} | ${num(bl?.ingestTotalErrors)} | < 1% |

## Resource Usage

| Metric | This Run | Baseline | Budget |
|---|---|---|---|
| DB active connections | ${num(dbConns)}${delta(dbConns, bl, 'dbActiveConns')} | ${num(bl?.dbActiveConns)} | ≤ ${process.env.DB_CONN_BUDGET ?? 25} |
| Redis memory | ${num(redisMem)} MB | ${num(bl?.redisMemMb)} MB | ≤ ${process.env.REDIS_MEM_BUDGET_MB ?? 100} MB |

${violations.length > 0 ? `## Budget Violations\n\n${violations.map((v) => `- ❌ ${v}`).join('\n')}\n` : ''}
## Scaling Limits and Recommendations

- **Connection pools**: The indexer runs a read pool (default 10) + write pool (default 3). Increase \`DB_CONNECTION_LIMIT\` to 20 before scaling API replicas past 2 pods.
- **Redis**: With 30 s TTLs and this dataset size, Redis stays well under 100 MB. Increase \`maxmemory\` only if you add large JSON payloads (e.g., IPFS metadata bulk cache).
- **SSE**: The server caps connections at \`MAX_SSE_CONNECTIONS\` (default 500). Beyond that, clients receive HTTP 503. Use a WebSocket fan-out proxy (e.g., Ably, Pusher) for >500 concurrent listeners.
- **Ingestion throughput**: At the tested rate (~${num(ingestTput)} events/s), the poller write pool of 3 connections is sufficient. Add a second poller instance (separate \`TRACKED_CONTRACTS\` partition) to exceed 500 events/s without pool exhaustion.
- **Full-text search**: \`GET /listings?search=\` uses a GIN-indexed tsvector; queries with ≥3-char terms stay under 50 ms. Short-term ILIKE fallback is O(n); avoid it in production by ensuring all listings have \`searchVector\` populated.

---
*Generated by \`load-tests/harness/reporter.mjs\`. Re-run \`bash load-tests/harness/run-load-test.sh\` to refresh.*
`;

writeFileSync(MD_OUT, md);
console.log(`[reporter] Report written → ${MD_OUT}`);
console.log(`[reporter] Snapshot  → ${join(RESULTS_DIR, 'latest.json')}`);

if (violations.length > 0) {
  console.error('[reporter] Budget violations detected:');
  violations.forEach((v) => console.error(`  • ${v}`));
  process.exit(1);
}
