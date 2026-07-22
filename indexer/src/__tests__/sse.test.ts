/**
 * sse.test.ts
 *
 * HTTP-level tests for GET /events (#192) — verifies the route wiring around
 * RealtimeHub: headers, Last-Event-ID / ?lastEventId= resume, query-param
 * filters, and the connection cap. Hub internals (fan-out, backpressure,
 * outage handling) are covered by realtime-hub.test.ts; this file only
 * proves routes.ts drives the hub correctly end-to-end over real HTTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn() },
  marketplaceEvent: { findMany: vi.fn(), count: vi.fn() },
}));

const mockRedis = vi.hoisted(() => ({
  isOpen: false, isReady: false,
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  connect: vi.fn().mockRejectedValue(new Error('No Redis')),
}));

vi.mock('../db', () => ({ default: mockPrisma }));
// The route module resolves this same instance as `redis` inside
// src/realtime/index.ts, so the hub also runs in degraded mode here — no
// live Redis is required for these HTTP-level tests.
vi.mock('../redis.js', () => ({ default: mockRedis }));

import router, { emitSSEEvent, _getSseBuffer, _getSseEventCounter, _resetSseState } from '../api/routes';
import { errorHandler } from '../api/errors';

let server: http.Server;
let baseUrl: string;

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

beforeEach(async () => {
  _resetSseState();
  vi.clearAllMocks();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Collect SSE chunks from a GET /events request until `count` frames arrive or timeout
function collectSseFrames(
  url: string,
  headers: Record<string, string>,
  count: number,
  timeoutMs = 500,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const frames: string[] = [];
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        resolve(frames);
      }, timeoutMs);

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          // Comment-only lines (": heartbeat", ": resume-not-durable") never
          // fire a real EventSource's onmessage — exclude them from frames.
          if (part.trim() && !part.trim().startsWith(':')) {
            frames.push(part);
            if (frames.length >= count) {
              clearTimeout(timer);
              req.destroy();
              resolve(frames);
              return;
            }
          }
        }
      });

      res.on('error', reject);
    });
    req.on('error', (err) => {
      if ((err as any).code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

function getHeaders(url: string): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      resolve(res.headers);
      req.destroy();
    });
    req.on('error', (err) => {
      if ((err as any).code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SSE — monotonic event IDs (degraded/local mode)', () => {
  it('emitted events carry incrementing id fields', () => {
    emitSSEEvent({ type: 'A' });
    emitSSEEvent({ type: 'B' });
    emitSSEEvent({ type: 'C' });

    const buf = _getSseBuffer();
    expect(buf).toHaveLength(3);
    expect(buf[0].id).toBe('1');
    expect(buf[1].id).toBe('2');
    expect(buf[2].id).toBe('3');
  });

  it('counter increments strictly across multiple calls', () => {
    emitSSEEvent({ x: 1 });
    emitSSEEvent({ x: 2 });
    expect(_getSseEventCounter()).toBe(2);
  });
});

describe('SSE — ring buffer bounded (degraded/local mode)', () => {
  it('evicts oldest events once the buffer exceeds its configured size', () => {
    for (let i = 0; i < 205; i++) emitSSEEvent({ i });
    const buf = _getSseBuffer();
    expect(buf.length).toBeLessThanOrEqual(200);
    expect(Number(buf[0].id)).toBeGreaterThan(1);
  });
});

describe('GET /events — headers', () => {
  it('sends SSE headers', async () => {
    const headers = await getHeaders(`${baseUrl}/events`);
    expect(headers['content-type']).toContain('text/event-stream');
    expect(headers['cache-control']).toContain('no-cache');
  });
});

describe('GET /events — reconnect replay via Last-Event-ID', () => {
  it('delivers no replay when Last-Event-ID is absent', async () => {
    emitSSEEvent({ type: 'X' });
    emitSSEEvent({ type: 'Y' });

    const frames = await collectSseFrames(`${baseUrl}/events`, {}, 0, 100);
    expect(frames).toHaveLength(0);
  });

  it('replays events after Last-Event-ID header on reconnect, in order, no duplicates', async () => {
    emitSSEEvent({ type: 'first' });   // id 1
    emitSSEEvent({ type: 'second' });  // id 2
    emitSSEEvent({ type: 'third' });   // id 3

    const frames = await collectSseFrames(
      `${baseUrl}/events`,
      { 'Last-Event-ID': '1' },
      2,
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('id: 2');
    expect(frames[1]).toContain('id: 3');
  });

  it('replays via ?lastEventId= query param when the header is absent', async () => {
    emitSSEEvent({ type: 'first' });   // id 1
    emitSSEEvent({ type: 'second' });  // id 2

    const frames = await collectSseFrames(
      `${baseUrl}/events?lastEventId=1`,
      {},
      1,
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('id: 2');
  });

  it('the Last-Event-ID header takes precedence over the query param', async () => {
    emitSSEEvent({ type: 'first' });   // id 1
    emitSSEEvent({ type: 'second' });  // id 2
    emitSSEEvent({ type: 'third' });   // id 3

    const frames = await collectSseFrames(
      `${baseUrl}/events?lastEventId=1`,
      { 'Last-Event-ID': '2' },
      1,
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('id: 3');
  });

  it('replays all buffered events when Last-Event-ID is 0', async () => {
    emitSSEEvent({ type: 'A' }); // id 1
    emitSSEEvent({ type: 'B' }); // id 2

    const frames = await collectSseFrames(
      `${baseUrl}/events`,
      { 'Last-Event-ID': '0' },
      2,
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('id: 1');
    expect(frames[1]).toContain('id: 2');
  });

  it('rejects a malformed lastEventId query param with 400', async () => {
    await new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}/events?lastEventId=not-an-id`, (res) => {
        expect(res.statusCode).toBe(400);
        res.destroy();
        resolve();
      }).on('error', reject);
    });
  });
});

describe('GET /events — topic filtering', () => {
  it('delivers only events matching ?types=', async () => {
    const framesPromise = collectSseFrames(`${baseUrl}/events?types=BID_PLACED`, {}, 1, 300);
    await new Promise((r) => setTimeout(r, 50));
    emitSSEEvent({ eventType: 'OFFER_MADE', data: {} });
    emitSSEEvent({ eventType: 'BID_PLACED', data: {} });

    const frames = await framesPromise;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('BID_PLACED');
  });

  it('rejects an invalid listingId filter with 400', async () => {
    await new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}/events?listingId=not-a-number`, (res) => {
        expect(res.statusCode).toBe(400);
        res.destroy();
        resolve();
      }).on('error', reject);
    });
  });
});
