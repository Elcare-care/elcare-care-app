import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { parseCorsOrigins, buildCorsOptions } from '../cors';

// ── parseCorsOrigins ──────────────────────────────────────────────────────────

describe('parseCorsOrigins', () => {
  it('returns empty array for undefined', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });

  it('returns empty array for blank string', () => {
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
  });

  it('parses a single origin', () => {
    expect(parseCorsOrigins('https://app.example.com')).toEqual([
      'https://app.example.com',
    ]);
  });

  it('parses multiple comma-separated origins', () => {
    expect(
      parseCorsOrigins('https://app.example.com,https://staging.example.com')
    ).toEqual(['https://app.example.com', 'https://staging.example.com']);
  });

  it('trims whitespace around each origin', () => {
    expect(
      parseCorsOrigins('  https://a.com  ,  https://b.com  ')
    ).toEqual(['https://a.com', 'https://b.com']);
  });

  it('drops empty entries from trailing commas', () => {
    expect(parseCorsOrigins('https://a.com,,https://b.com,')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('deduplicates repeated origins', () => {
    expect(
      parseCorsOrigins('https://a.com,https://a.com,https://b.com')
    ).toEqual(['https://a.com', 'https://b.com']);
  });
});

// ── buildCorsOptions — helper app factory ────────────────────────────────────

function makeApp(allowedOrigins: string[]) {
  const app = express();
  const opts = buildCorsOptions(allowedOrigins);
  app.use(cors(opts));
  app.options(/.*/, cors(opts)); // Express 5: wildcard must be a regex
  app.get('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

// ── Origin allow / deny ───────────────────────────────────────────────────────

describe('buildCorsOptions — origin matching', () => {
  it('dev mode: reflects any origin when whitelist is empty', async () => {
    const app = makeApp([]);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:3000');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('dev mode: reflects a random origin when whitelist is empty', async () => {
    const app = makeApp([]);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://random-dev-tool.io');

    expect(res.headers['access-control-allow-origin']).toBe('https://random-dev-tool.io');
  });

  it('production mode: allows a whitelisted origin', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('production mode: allows each origin in a multi-origin whitelist', async () => {
    const origins = ['https://app.example.com', 'https://staging.example.com'];
    const app = makeApp(origins);

    for (const origin of origins) {
      const res = await request(app).get('/test').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('production mode: denies an origin not in the whitelist', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('production mode: denies a subdomain not explicitly in the whitelist', async () => {
    const app = makeApp(['https://example.com']);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://sub.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests with no Origin header (same-origin / server-to-server)', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app).get('/test'); // no Origin header
    expect(res.status).toBe(200);
    // No CORS headers needed for same-origin requests
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ── Credentials ───────────────────────────────────────────────────────────────

describe('buildCorsOptions — credentials', () => {
  it('sets Access-Control-Allow-Credentials: true for allowed origin', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.example.com');

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('sets Access-Control-Allow-Credentials: true in dev mode', async () => {
    const app = makeApp([]);
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:3000');

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

// ── Preflight caching ─────────────────────────────────────────────────────────

describe('buildCorsOptions — preflight', () => {
  it('responds 204 to OPTIONS preflight for allowed origin', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('includes Access-Control-Max-Age: 86400 on preflight response', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('includes Access-Control-Max-Age: 86400 in dev mode preflight', async () => {
    const app = makeApp([]);
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('does not set CORS headers on preflight from denied origin', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://evil.com')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows multiple consecutive preflight requests without degrading', async () => {
    const app = makeApp(['https://app.example.com']);
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .options('/test')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type,X-API-Key');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    }
  });

  it('allows X-API-Key in Access-Control-Allow-Headers', async () => {
    const app = makeApp(['https://app.example.com']);
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'X-API-Key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(/x-api-key/i);
  });
});

// ── SSE headers ───────────────────────────────────────────────────────────────

describe('SSE response headers', () => {
  function makeSseApp() {
    const app = express();
    app.get('/events', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.end();
    });
    return app;
  }

  it('sets X-Accel-Buffering: no to prevent nginx buffering', async () => {
    const res = await request(makeSseApp()).get('/events');
    expect(res.headers['x-accel-buffering']).toBe('no');
  });

  it('sets Cache-Control: no-cache', async () => {
    const res = await request(makeSseApp()).get('/events');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('sets Content-Type: text/event-stream', async () => {
    const res = await request(makeSseApp()).get('/events');
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ── /cors-test debug endpoint ─────────────────────────────────────────────────

describe('/cors-test endpoint', () => {
  const ORIG = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIG };
  });

  function makeDebugApp(allowedOrigins: string[]) {
    const app = express();
    const opts = buildCorsOptions(allowedOrigins);
    app.use(cors(opts));
    // Mirror the real guard from index.ts
    if (process.env.NODE_ENV !== 'production') {
      app.get('/cors-test', (req, res) => {
        const origin = req.headers.origin ?? null;
        const allowed =
          allowedOrigins.length === 0
            ? true
            : origin !== null && allowedOrigins.includes(origin);
        res.json({
          origin,
          allowed,
          whitelist: allowedOrigins,
          mode:
            allowedOrigins.length === 0
              ? 'development (all origins)'
              : 'production (whitelist)',
        });
      });
    }
    return app;
  }

  it('returns 200 and echoes origin in dev mode', async () => {
    process.env.NODE_ENV = 'development';
    const app = makeDebugApp([]);
    const res = await request(app)
      .get('/cors-test')
      .set('Origin', 'http://localhost:3000');

    expect(res.status).toBe(200);
    expect(res.body.origin).toBe('http://localhost:3000');
    expect(res.body.allowed).toBe(true);
    expect(res.body.mode).toMatch(/development/);
  });

  it('reports allowed=true for a whitelisted origin', async () => {
    process.env.NODE_ENV = 'development';
    const app = makeDebugApp(['https://app.example.com']);
    const res = await request(app)
      .get('/cors-test')
      .set('Origin', 'https://app.example.com');

    expect(res.body.allowed).toBe(true);
    expect(res.body.whitelist).toContain('https://app.example.com');
  });

  it('reports allowed=false for a non-whitelisted origin', async () => {
    process.env.NODE_ENV = 'development';
    const app = makeDebugApp(['https://app.example.com']);
    const res = await request(app)
      .get('/cors-test')
      .set('Origin', 'https://attacker.com');

    expect(res.body.allowed).toBe(false);
  });

  it('is not registered in production mode', async () => {
    process.env.NODE_ENV = 'production';
    const app = makeDebugApp(['https://app.example.com']);
    const res = await request(app).get('/cors-test');
    expect(res.status).toBe(404);
  });
});
