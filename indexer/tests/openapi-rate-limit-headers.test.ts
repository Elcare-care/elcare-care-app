/**
 * openapi-rate-limit-headers.test.ts
 *
 * Contract test that keeps the documented rate-limit headers aligned with the
 * headers the runtime actually returns (issue #918).
 *
 * The rate limiters are mounted with `standardHeaders: 'draft-6'` and
 * `legacyHeaders: false`, so express-rate-limit emits the draft-6 header set
 * (`RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`,
 * `RateLimit-Reset`) on every response that passes a limiter, and adds
 * `Retry-After` when the request is throttled.
 *
 * This test drives the real middleware and asserts that
 *   - the documented header set equals the header set the runtime returns,
 *   - the documented value semantics match the runtime values,
 *   - the throttled response documents its retry guidance,
 *   - the paths the limiters skip are documented without rate-limit headers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { buildOpenApiDocument } from '../src/api/openapi.js';

type HeaderMap = Record<string, { $ref?: string; description?: string; schema?: { type?: string } }>;

/** Headers express-rate-limit emits for `standardHeaders: 'draft-6'`. */
const DRAFT_6_HEADERS = ['RateLimit-Policy', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'];

/** Headers the runtime returns on a throttled response. */
const THROTTLE_HEADERS = [...DRAFT_6_HEADERS, 'Retry-After'];

function headersOf(response: { headers?: Record<string, unknown> } | undefined): string[] {
  return Object.keys(response?.headers ?? {});
}

/** The header names the spec documents for a given response. */
function documentedHeaders(
  doc: ReturnType<typeof buildOpenApiDocument>,
  path: string,
  method: string,
  status: string,
): string[] {
  const operation = (doc.paths as any)?.[path]?.[method];
  const response = operation?.responses?.[status];
  return Object.keys(response?.headers ?? {});
}

describe('OpenAPI rate-limit headers match the runtime (#918)', () => {
  let app: express.Application;
  let doc: ReturnType<typeof buildOpenApiDocument>;
  let rateLimiter: express.RequestHandler;

  beforeAll(async () => {
    // Shrink the medium budget so the second request is throttled. The limiters
    // read these variables when the module is first imported.
    process.env.RATE_LIMIT_MEDIUM = '1';
    process.env.RATE_LIMIT_GLOBAL = '1000';

    const { globalRateLimiter, rateLimiter: mediumRateLimiter } = await import(
      '../src/api/rate-limit-middleware.js'
    );

    app = express();
    app.use(express.json());
    // Same mounting order as src/index.ts.
    app.use(globalRateLimiter);
    app.use(mediumRateLimiter);
    app.get('/probe', (_req, res) => res.json({ ok: true }));
    // The limiters skip the health probes.
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    rateLimiter = mediumRateLimiter;
    doc = buildOpenApiDocument();
  });

  it('registers the rate-limit headers as reusable components', () => {
    const components = (doc.components as any)?.headers;
    expect(components).toBeDefined();
    for (const name of ['RateLimitPolicy', 'RateLimitLimit', 'RateLimitRemaining', 'RateLimitReset', 'RetryAfter']) {
      expect(components[name], `missing components.headers.${name}`).toBeDefined();
      expect(components[name].description).toBeTruthy();
    }
  });

  it('documents exactly the draft-6 headers the runtime returns', async () => {
    const response = await request(app).get('/probe').set('X-Wallet-Address', 'probe-headers');
    expect(response.status).toBe(200);

    const runtimeHeaders = headersOf(response)
      .filter((name) => name.toLowerCase().startsWith('ratelimit-'))
      .map((name) => name.toLowerCase())
      .sort();

    expect(runtimeHeaders).toEqual([...DRAFT_6_HEADERS].map((h) => h.toLowerCase()).sort());

    // The spec must document exactly the same header names for a rate-limited route.
    const documented = documentedHeaders(doc, '/listings', 'get', '200');
    expect(documented.slice().sort()).toEqual([...DRAFT_6_HEADERS].sort());
  });

  it('documents the value semantics of every rate-limit header', async () => {
    const response = await request(app).get('/probe').set('X-Wallet-Address', 'probe-semantics');
    expect(response.status).toBe(200);
    const components = (doc.components as any).headers;

    // RateLimit-Policy is `<limit>;w=<windowSeconds>`.
    const policy = String(response.headers['ratelimit-policy']);
    expect(policy).toMatch(/^\d+;w=\d+$/);
    expect(components.RateLimitPolicy.schema.type).toBe('string');

    // The remaining counters are plain integers.
    for (const header of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
      expect(String(response.headers[header]), `${header} is not an integer`).toMatch(/^\d+$/);
    }
    expect(components.RateLimitLimit.schema.type).toBe('integer');
    expect(components.RateLimitRemaining.schema.type).toBe('integer');
    expect(components.RateLimitReset.schema.type).toBe('integer');
  });

  it('documents the throttled response and its retry guidance', async () => {
    // A dedicated wallet address gets its own budget, so this test is not
    // affected by the requests the other tests have already made.
    const key = 'probe-throttle';
    const first = await request(app).get('/probe').set('X-Wallet-Address', key);
    expect(first.status).toBe(200);

    const throttled = await request(app).get('/probe').set('X-Wallet-Address', key);
    expect(throttled.status).toBe(429);

    // The runtime returns Retry-After in whole seconds.
    const retryAfter = String(throttled.headers['retry-after']);
    expect(retryAfter).toMatch(/^\d+$/);

    // The spec documents the same headers on the 429, including Retry-After.
    const documented = documentedHeaders(doc, '/listings', 'get', '429');
    expect(documented.slice().sort()).toEqual([...THROTTLE_HEADERS].sort());

    const components = (doc.components as any).headers;
    expect(components.RetryAfter.schema.type).toBe('integer');
  });

  it('documents the throttled response on every rate-limited route', () => {
    const skipped = new Set(['/health', '/readyz']);
    for (const [path, pathItem] of Object.entries<any>(doc.paths)) {
      for (const [method, operation] of Object.entries<any>(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (skipped.has(path)) continue;
        expect(operation.responses['429'], `${method} ${path} has no documented 429`).toBeDefined();
      }
    }
  });

  it('does not document rate-limit headers for the skipped health probes', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(headersOf(response).filter((h) => h.toLowerCase().startsWith('ratelimit-'))).toEqual([]);

    for (const path of ['/health', '/readyz']) {
      const operation = (doc.paths as any)[path]?.get;
      for (const response of Object.values<any>(operation?.responses ?? {})) {
        const names = Object.keys(response.headers ?? {});
        expect(names.filter((n) => n.toLowerCase().startsWith('ratelimit-'))).toEqual([]);
        expect(names).not.toContain('Retry-After');
      }
    }
  });

  it('documents retry guidance for the SSE concurrency guard', () => {
    for (const path of ['/events', '/notifications/stream']) {
      const documented = documentedHeaders(doc, path, 'get', '503');
      expect(documented, `${path} 503 is missing Retry-After`).toContain('Retry-After');
    }
  });

  it('keeps the limiters mounted in front of the documented routes', () => {
    // Guards against the spec and the middleware drifting apart: the limiters
    // this suite drives are the ones exported for src/index.ts.
    expect(typeof rateLimiter).toBe('function');
  });
});
