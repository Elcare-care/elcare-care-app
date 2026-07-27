import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  latestLedgerProcessedGauge,
  networkLatestLedgerGauge,
  syncLatencyGauge,
  metricsMiddleware,
  handleMetrics,
  requestLogger,
  httpRequestDurationMicroseconds,
  // Issue #299 — new correctness & business metrics
  reconciliationMismatchesTotal,
  unresolvedEscrowGauge,
  deadLetterEventsTotal,
  deadLetterAgeSecondsGauge,
  reorgRollbacksTotal,
  reorgDepthGauge,
  ingestionLagSeconds,
  finalizedLagSeconds,
  eventReplaysTotal,
  cacheHitsTotal,
  cacheMissesTotal,
  cacheInvalidationsTotal,
  apiErrorsTotal,
} from '../metrics';

// We can construct a minimal Express app to verify the middleware and handler
const app = express();
app.use(requestLogger);
app.use(metricsMiddleware);
app.get('/metrics', handleMetrics);
app.get('/test', (req, res) => {
  res.status(200).json({ test: 'ok' });
});

describe('Prometheus Metrics API & Middleware', () => {
  it('exposes a valid /metrics endpoint', async () => {
    const res = await request(app)
      .get('/metrics')
      .expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('indexer_latest_ledger_processed');
    expect(res.text).toContain('indexer_network_latest_ledger');
    expect(res.text).toContain('indexer_sync_latency_ledgers');
    expect(res.text).toContain('http_request_duration_seconds');
  });

  it('records metrics for standard HTTP calls', async () => {
    // Send a request to a standard endpoint to trigger metrics collection
    await request(app)
      .get('/test')
      .expect(200);

    const res = await request(app)
      .get('/metrics')
      .expect(200);

    expect(res.text).toContain('method="GET"');
    expect(res.text).toContain('route="/test"');
    expect(res.text).toContain('status="200"');
  });

  it('exports the latest ledger gauges with their current values', async () => {
    latestLedgerProcessedGauge.set(321);
    networkLatestLedgerGauge.set(654);
    syncLatencyGauge.set(333);

    const res = await request(app)
      .get('/metrics')
      .expect(200);

    expect(res.text).toContain('indexer_latest_ledger_processed 321');
    expect(res.text).toContain('indexer_network_latest_ledger 654');
    expect(res.text).toContain('indexer_sync_latency_ledgers 333');
  });

  it('reflects updated gauge values after each simulated poll cycle', async () => {
    // Cycle 1: far behind
    latestLedgerProcessedGauge.set(1000);
    networkLatestLedgerGauge.set(5000);
    syncLatencyGauge.set(4000); // 5000 - 1000

    let res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('indexer_latest_ledger_processed 1000');
    expect(res.text).toContain('indexer_network_latest_ledger 5000');
    expect(res.text).toContain('indexer_sync_latency_ledgers 4000');

    // Cycle 2: caught up partially
    latestLedgerProcessedGauge.set(3000);
    networkLatestLedgerGauge.set(5100);
    syncLatencyGauge.set(2100); // 5100 - 3000

    res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('indexer_latest_ledger_processed 3000');
    expect(res.text).toContain('indexer_network_latest_ledger 5100');
    expect(res.text).toContain('indexer_sync_latency_ledgers 2100');

    // Cycle 3: fully synced
    latestLedgerProcessedGauge.set(5200);
    networkLatestLedgerGauge.set(5200);
    syncLatencyGauge.set(0);

    res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('indexer_latest_ledger_processed 5200');
    expect(res.text).toContain('indexer_network_latest_ledger 5200');
    expect(res.text).toContain('indexer_sync_latency_ledgers 0');
  });
});

// ── Issue #299: new correctness & business metrics ────────────────────────────

describe('Issue #299 — new correctness & business metrics registration', () => {
  it('exports reconciliation_mismatches_total from /metrics', async () => {
    reconciliationMismatchesTotal.inc({ kind: 'listing', field: 'status' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_reconciliation_mismatches_total');
  });

  it('exports unresolved_escrow_listings gauge', async () => {
    unresolvedEscrowGauge.set(3);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_unresolved_escrow_listings 3');
  });

  it('exports dead_letter_events_total counter', async () => {
    deadLetterEventsTotal.inc({ event_type: 'ARTWORK_SOLD' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_dead_letter_events_total');
  });

  it('exports dead_letter_age_seconds gauge', async () => {
    deadLetterAgeSecondsGauge.set(120);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_dead_letter_age_seconds 120');
  });

  it('exports reorg_rollbacks_total counter', async () => {
    reorgRollbacksTotal.inc({ depth_bucket: '<10' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_reorg_rollbacks_total');
  });

  it('exports reorg_depth_current gauge', async () => {
    reorgDepthGauge.set(5);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_reorg_depth_current 5');
  });

  it('exports ingestion_lag_seconds histogram', async () => {
    ingestionLagSeconds.observe(2.5);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_ingestion_lag_seconds');
  });

  it('exports finalized_lag_seconds histogram', async () => {
    finalizedLagSeconds.observe(8);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_finalized_lag_seconds');
  });

  it('exports event_replays_total counter', async () => {
    eventReplaysTotal.inc({ reason: 'reorg' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_event_replays_total');
  });

  it('exports cache_hits_total and cache_misses_total counters', async () => {
    cacheHitsTotal.inc({ key_prefix: 'listings' });
    cacheMissesTotal.inc({ key_prefix: 'listings' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_cache_hits_total');
    expect(res.text).toContain('elcarehub_cache_misses_total');
  });

  it('exports cache_invalidations_total counter', async () => {
    cacheInvalidationsTotal.inc({ scope: 'pattern' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_cache_invalidations_total');
  });

  it('exports api_errors_total counter', async () => {
    apiErrorsTotal.inc({ error_class: 'db_error', method: 'GET' });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('elcarehub_api_errors_total');
  });

  it('prevents duplicate metric registration (no duplicate-name error)', async () => {
    // If prom-client throws on duplicate name, this would fail. Exporting again
    // must not throw — the registry returns the same instance.
    const { reconciliationMismatchesTotal: same } = await import('../metrics');
    expect(same).toBeDefined();
  });
});
