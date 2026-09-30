/**
 * log-redaction.test.ts
 *
 * Issue #537 — Add secret scanning to all CI paths.
 *
 * .gitleaks.toml catches secrets committed to the repo. This test file
 * covers the complementary runtime concern: if a Stellar secret key,
 * database URL, or API token string ends up embedded in a log call or an
 * error object at runtime, it must not appear verbatim in the emitted log
 * line or the JSON error response sent to a client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { redact, redactString } from '../redact';
import { errorHandler, badRequest, internalError } from '../api/errors';

// Realistic-shaped but synthetic secrets — never used against a live service.
const FAKE_STELLAR_SECRET =
  'SBLGMOF6VXAT3NHFWW5AAQ6VTVL2SD52JQ2GMWK5MWTC2NIDWGZFRXFC'; // 56 chars, S + base32
const FAKE_DB_URL = 'postgresql://appuser:s3cr3t-db-pass@prod-db.internal:5432/marketplace';
const FAKE_PINATA_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzY29wZSI6InBpbmF0YSJ9.fake_signature_segment_not_real';
const FAKE_BEARER_TOKEN = 'Bearer sk_live_fake_abcdefghijklmnopqrstuvwx';

describe('redact()', () => {
  it('masks a Stellar secret key embedded in a plain string', () => {
    const out = redactString(`keeper failed using secret ${FAKE_STELLAR_SECRET}`);
    expect(out).not.toContain(FAKE_STELLAR_SECRET);
    expect(out).toContain('[REDACTED]');
  });

  it('masks a database connection string with embedded credentials', () => {
    const out = redactString(`could not connect: ${FAKE_DB_URL}`);
    expect(out).not.toContain(FAKE_DB_URL);
    expect(out).not.toContain('s3cr3t-db-pass');
    expect(out).toContain('[REDACTED]');
  });

  it('masks a Pinata-style JWT embedded in a string', () => {
    const out = redactString(`pinata upload failed, jwt=${FAKE_PINATA_JWT}`);
    expect(out).not.toContain(FAKE_PINATA_JWT);
    expect(out).toContain('[REDACTED]');
  });

  it('masks a Bearer token embedded in a string', () => {
    const out = redactString(`rejected header: ${FAKE_BEARER_TOKEN}`);
    expect(out).not.toContain(FAKE_BEARER_TOKEN);
    expect(out).toContain('[REDACTED]');
  });

  it('fully redacts fields whose name looks sensitive regardless of value shape', () => {
    const out = redact({ apiKey: 'not-secret-shaped', password: 'hunter2', ok: 'fine' }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.ok).toBe('fine');
  });

  it('recursively redacts nested objects and arrays', () => {
    const out = redact({
      requestId: 'req-1',
      context: {
        keeperSecret: FAKE_STELLAR_SECRET,
        notes: [`db=${FAKE_DB_URL}`, 'harmless'],
      },
    }) as any;

    expect(JSON.stringify(out)).not.toContain(FAKE_STELLAR_SECRET);
    expect(JSON.stringify(out)).not.toContain(FAKE_DB_URL);
    expect(out.requestId).toBe('req-1');
    expect(out.context.notes[1]).toBe('harmless');
  });

  it('flattens Error instances and redacts their message/stack', () => {
    const err = new Error(`upstream rejected credentials: ${FAKE_DB_URL}`);
    const out = redact(err) as { message: string };
    expect(out.message).not.toContain(FAKE_DB_URL);
  });

  it('leaves non-sensitive values untouched', () => {
    const out = redact({ path: '/nfts/123', method: 'GET', statusCode: 404 }) as Record<string, unknown>;
    expect(out).toEqual({ path: '/nfts/123', method: 'GET', statusCode: 404 });
  });
});

describe('logger redaction (integration)', () => {
  const writes: string[] = [];

  beforeEach(() => {
    writes.length = 0;
    delete process.env.LOG_LEVEL;
    vi.resetModules();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never emits a Stellar secret key or DB URL verbatim in a log line', async () => {
    const { logger } = await import('../logger');

    logger.error('keeper submission failed', {
      keeperSecret: FAKE_STELLAR_SECRET,
      databaseUrl: FAKE_DB_URL,
      note: `retry against ${FAKE_DB_URL}`,
    });

    const line = writes.join('');
    expect(line).not.toContain(FAKE_STELLAR_SECRET);
    expect(line).not.toContain(FAKE_DB_URL);

    const parsed = JSON.parse(line.trim());
    expect(parsed.keeperSecret).toBe('[REDACTED]');
    expect(parsed.databaseUrl).toBe('[REDACTED]');
  });

  it('redacts a secret embedded directly in the message string', async () => {
    const { logger } = await import('../logger');
    logger.info(`connected using ${FAKE_DB_URL}`);

    const line = writes.join('');
    expect(line).not.toContain(FAKE_DB_URL);
  });
});

describe('error response payload redaction (integration)', () => {
  function buildApp(handler: (req: Request, res: Response, next: NextFunction) => void) {
    const app = express();
    app.use(express.json());
    app.get('/test', handler);
    app.use(errorHandler);
    return app;
  }

  it('does not leak a secret embedded in a 4xx error message', async () => {
    const app = buildApp((_req, _res, next) =>
      next(badRequest(`invalid config: ${FAKE_DB_URL}`)),
    );
    const res = await request(app).get('/test');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_DB_URL);
    expect(res.body.error.message).toContain('[REDACTED]');
  });

  it('does not leak a secret embedded in 4xx error details', async () => {
    const app = buildApp((_req, _res, next) =>
      next(badRequest('bad input', { received: FAKE_STELLAR_SECRET })),
    );
    const res = await request(app).get('/test');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_STELLAR_SECRET);
  });

  it('never includes a raw secret for 5xx responses (already message-less, verified defensively)', async () => {
    const app = buildApp((_req, _res, next) =>
      next(internalError(`internal failure near ${FAKE_PINATA_JWT}`)),
    );
    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_PINATA_JWT);
  });
});
