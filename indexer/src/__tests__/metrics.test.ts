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

  describe('Request logging', () => {
    it('logs requests with method, path, status, and latency', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const testApp = express();
      testApp.use(requestLogger);
      testApp.get('/api/test', (req, res) => res.status(200).json({ ok: true }));

      await request(testApp).get('/api/test');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/GET \/api\/test 200 \d+ms/)
      );
      consoleSpy.mockRestore();
    });

    it('skips logging for /health', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const testApp = express();
      testApp.use(requestLogger);
      testApp.get('/health', (req, res) => res.json({ status: 'ok' }));

      await request(testApp).get('/health');

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('skips logging for /metrics', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const testApp = express();
      testApp.use(requestLogger);
      testApp.get('/metrics', (req, res) => res.json({}));

      await request(testApp).get('/metrics');

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('skips logging for /readyz', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const testApp = express();
      testApp.use(requestLogger);
      testApp.get('/readyz', (req, res) => res.json({}));

      await request(testApp).get('/readyz');

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('logs error responses', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const testApp = express();
      testApp.use(requestLogger);
      testApp.get('/error', (req, res) => res.status(500).json({ error: 'Internal' }));

      await request(testApp).get('/error');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/GET \/error 500 \d+ms/)
      );
      consoleSpy.mockRestore();
    });
  });

  describe('Histogram observation', () => {
    it('records histogram with correct labels and duration', async () => {
      const testApp = express();
      testApp.use(metricsMiddleware);
      testApp.get('/test-route', (req, res) => res.status(201).json({}));

      await request(testApp).get('/test-route');

      const res = await request(app)
        .get('/metrics')
        .expect(200);

      expect(res.text).toContain('method="GET"');
      expect(res.text).toContain('route="/test-route"');
      expect(res.text).toContain('status="201"');
      expect(res.text).toContain('http_request_duration_seconds');
    });
  });
});
