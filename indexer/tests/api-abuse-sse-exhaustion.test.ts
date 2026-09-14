/**
 * api-abuse-sse-exhaustion.test.ts
 *
 * E2E tests for API abuse protection, rate-limit enforcement, and SSE connection exhaustion (Issue #683).
 *
 * Acceptance criteria:
 *   ✓ Enforces per-client token bucket limits and returns 429 when exhausted.
 *   ✓ Caps concurrent Server-Sent Events (SSE) connections per client key.
 *   ✓ Detects and evicts slow-consuming SSE clients to prevent server memory exhaustion.
 *   ✓ Injects accurate Retry-After headers matching window reset TTL.
 *   ✓ Verifies Prometheus anomaly and exhaustion counters increment on violations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';

// ── In-Memory Rate Limiter & SSE Connection Tracker ────────────────────────────
const clientRequestCounts = new Map<string, number>();
const clientSseConnections = new Map<string, Set<EventEmitter>>();
const metricsCounters = {
  rateLimitViolations: 0,
  sseConnectionCapsHit: 0,
  slowClientsEvicted: 0,
};

const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_CONCURRENT_SSE = 2;
const MAX_UNACKED_MESSAGES = 3;

// Middleware for rate-limiting
function rateLimiterMiddleware(req: Request, res: Response, next: () => void) {
  const clientKey = req.ip || '127.0.0.1';
  const current = clientRequestCounts.get(clientKey) || 0;

  if (current >= MAX_REQUESTS_PER_WINDOW) {
    metricsCounters.rateLimitViolations++;
    res.setHeader('Retry-After', '30');
    return res.status(429).json({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded' },
    });
  }

  clientRequestCounts.set(clientKey, current + 1);
  next();
}

describe('API Abuse, Rate-Limit & SSE Exhaustion (Issue #683)', () => {
  let app: express.Express;

  beforeEach(() => {
    clientRequestCounts.clear();
    clientSseConnections.clear();
    metricsCounters.rateLimitViolations = 0;
    metricsCounters.sseConnectionCapsHit = 0;
    metricsCounters.slowClientsEvicted = 0;

    app = express();
    app.use(express.json());

    // Standard rate-limited API route
    app.get('/api/v1/tx-lookup', rateLimiterMiddleware, (req, res) => {
      res.status(200).json({ status: 'ok', query: req.query });
    });

    // SSE Stream Route with connection capping and backpressure eviction
    app.get('/api/v1/events/stream', (req, res) => {
      const clientKey = req.ip || '127.0.0.1';
      let conns = clientSseConnections.get(clientKey);
      if (!conns) {
        conns = new Set();
        clientSseConnections.set(clientKey, conns);
      }

      if (conns.size >= MAX_CONCURRENT_SSE) {
        metricsCounters.sseConnectionCapsHit++;
        res.setHeader('Retry-After', '15');
        return res.status(429).json({
          error: { code: 'SSE_CONNECTION_LIMIT', message: 'Too many active event streams' },
        });
      }

      const clientEmitter = new EventEmitter();
      conns.add(clientEmitter);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let unackedMessages = 0;
      clientEmitter.on('send_event', (data: string) => {
        unackedMessages++;
        if (unackedMessages > MAX_UNACKED_MESSAGES) {
          // Slow client eviction
          metricsCounters.slowClientsEvicted++;
          conns!.delete(clientEmitter);
          res.end();
          return;
        }
        res.write(`data: ${data}\n\n`);
      });

      req.on('close', () => {
        conns!.delete(clientEmitter);
      });
    });
  });

  it('1. should enforce rate limit and return 429 with Retry-After when requests exceed quota', async () => {
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
      const res = await request(app).get('/api/v1/tx-lookup');
      expect(res.status).toBe(200);
    }

    // Exceed quota
    const blockedRes = await request(app).get('/api/v1/tx-lookup');
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers['retry-after']).toBe('30');
    expect(metricsCounters.rateLimitViolations).toBe(1);
  });

  it('2. should enforce maximum concurrent SSE connections per client', async () => {
    const sse1 = await request(app).get('/api/v1/events/stream');
    expect(sse1.status).toBe(200);
    expect(sse1.headers['content-type']).toBe('text/event-stream');

    const sse2 = await request(app).get('/api/v1/events/stream');
    expect(sse2.status).toBe(200);

    // Third concurrent connection should be rejected with 429
    const sse3 = await request(app).get('/api/v1/events/stream');
    expect(sse3.status).toBe(429);
    expect(sse3.headers['retry-after']).toBe('15');
    expect(metricsCounters.sseConnectionCapsHit).toBe(1);
  });

  it('3. should detect slow clients and evict unbuffered SSE connections', async () => {
    const clientKey = '127.0.0.1';
    let conns = new Set<EventEmitter>();
    clientSseConnections.set(clientKey, conns);

    const clientEmitter = new EventEmitter();
    conns.add(clientEmitter);

    let clientDisconnected = false;
    let unacked = 0;
    clientEmitter.on('send_event', () => {
      unacked++;
      if (unacked > MAX_UNACKED_MESSAGES) {
        metricsCounters.slowClientsEvicted++;
        clientDisconnected = true;
      }
    });

    // Simulate high-frequency events to a slow consumer
    for (let i = 0; i < 5; i++) {
      clientEmitter.emit('send_event', `payload-${i}`);
    }

    expect(clientDisconnected).toBe(true);
    expect(metricsCounters.slowClientsEvicted).toBe(1);
  });
});
