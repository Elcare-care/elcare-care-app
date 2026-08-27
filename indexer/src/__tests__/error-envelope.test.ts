/**
 * error-envelope.test.ts
 *
 * Verifies the acceptance criteria for Feature 4: unified error envelope.
 *
 *  1. Every non-success API response matches the documented envelope.
 *  2. Every response includes the requestId (when middleware is present).
 *  3. Validation identifies fields without exposing SQL or credentials.
 *  4. Frontend error handling can branch on stable error codes.
 *  5. Retry guidance (retryable, retryAfterSeconds) is correct for each code.
 *  6. Zod and Prisma errors are mapped to stable codes with field-level detail.
 *  7. Sensitive data is never leaked in 5xx responses.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { ZodError, z } from 'zod';

// ── Module-level mocks (must be hoisted before other module imports) ──────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findMany:  vi.fn().mockResolvedValue([]),
    count:     vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue({ _sum: { price: null } }),
  },
  auction:          { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  offer:            { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  collection:       { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  marketplaceEvent: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  moderationCase:   { findMany: vi.fn().mockResolvedValue([]) },
  $queryRawUnsafe:  vi.fn().mockResolvedValue([{ count: BigInt(0) }]),
}));

vi.mock('../db.js',           () => ({ default: mockPrisma }));
vi.mock('../prisma-write.js', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: {
    isOpen: false, isReady: false,
    get: vi.fn().mockResolvedValue(null), setEx: vi.fn(), on: vi.fn(), connect: vi.fn(),
  },
}));

import {
  errorHandler,
  ApiError,
  badRequest,
  notFound,
  unauthorized,
  forbidden,
  internalError,
  conflict,
  serviceUnavailable,
  ErrorCode,
  type FieldError,
} from '../api/errors.js';
import apiRouter from '../api/routes.js';

// ── Test-app factories ────────────────────────────────────────────────────────

/** Minimal app: no router, just a single handler + errorHandler */
function buildApp(handler: (req: Request, res: Response, next: NextFunction) => void) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.requestId = 'test-req-id-123'; next(); });
  app.get('/test', handler);
  app.use(errorHandler);
  return app;
}

/** Full app: real API router wired up */
const fullApp = (() => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.requestId = 'integration-req-id'; next(); });
  app.use(apiRouter);
  app.use(errorHandler);
  return app;
})();

// ── Envelope shape ────────────────────────────────────────────────────────────

describe('Error envelope shape', () => {
  it('every error response has { error: { code, message, class } }', async () => {
    const cases: Array<() => ApiError> = [
      () => badRequest('bad'),
      () => notFound('nope'),
      () => unauthorized(),
      () => forbidden(),
      () => internalError(),
      () => conflict('dup'),
      () => serviceUnavailable(),
    ];
    for (const factory of cases) {
      const app = buildApp((_req, _res, next) => next(factory()));
      const res = await request(app).get('/test');
      expect(res.body.error, `Shape check for ${factory().code}`).toMatchObject({
        code:    expect.any(String),
        message: expect.any(String),
        class:   expect.stringMatching(/^(CLIENT|SERVER)_ERROR$/),
      });
    }
  });

  it('error response includes requestId from res.locals', async () => {
    const app = buildApp((_req, _res, next) => next(badRequest('bad')));
    const res = await request(app).get('/test');
    expect(res.body.error.requestId).toBe('test-req-id-123');
  });

  it('retryable field is always present', async () => {
    const cases: Array<() => ApiError> = [
      () => badRequest('x'), () => notFound('x'), () => internalError(), () => serviceUnavailable(),
    ];
    for (const factory of cases) {
      const app = buildApp((_req, _res, next) => next(factory()));
      const res = await request(app).get('/test');
      expect(typeof res.body.error.retryable, `retryable for ${factory().code}`).toBe('boolean');
    }
  });
});

// ── HTTP status codes ─────────────────────────────────────────────────────────

describe('HTTP status codes', () => {
  it('badRequest → 400', async () => {
    expect((await request(buildApp((_r,_s,n) => n(badRequest('x')))).get('/test')).status).toBe(400);
  });
  it('notFound → 404', async () => {
    expect((await request(buildApp((_r,_s,n) => n(notFound('x')))).get('/test')).status).toBe(404);
  });
  it('unauthorized → 401', async () => {
    expect((await request(buildApp((_r,_s,n) => n(unauthorized()))).get('/test')).status).toBe(401);
  });
  it('forbidden → 403', async () => {
    expect((await request(buildApp((_r,_s,n) => n(forbidden()))).get('/test')).status).toBe(403);
  });
  it('internalError → 500', async () => {
    expect((await request(buildApp((_r,_s,n) => n(internalError()))).get('/test')).status).toBe(500);
  });
  it('conflict → 409', async () => {
    expect((await request(buildApp((_r,_s,n) => n(conflict('dup')))).get('/test')).status).toBe(409);
  });
  it('serviceUnavailable → 503', async () => {
    expect((await request(buildApp((_r,_s,n) => n(serviceUnavailable()))).get('/test')).status).toBe(503);
  });
});

// ── Error classification ──────────────────────────────────────────────────────

describe('Error classification (class field)', () => {
  it('4xx errors have class CLIENT_ERROR', async () => {
    const cases = [badRequest('x'), notFound('x'), unauthorized(), forbidden(), conflict('x')];
    for (const err of cases) {
      const app = buildApp((_req, _res, next) => next(err));
      const res = await request(app).get('/test');
      expect(res.body.error.class, `class for ${err.code}`).toBe('CLIENT_ERROR');
    }
  });

  it('5xx errors have class SERVER_ERROR', async () => {
    const cases = [internalError(), serviceUnavailable()];
    for (const err of cases) {
      const app = buildApp((_req, _res, next) => next(err));
      const res = await request(app).get('/test');
      expect(res.body.error.class, `class for ${err.code}`).toBe('SERVER_ERROR');
    }
  });

  it('unknown errors are wrapped as 500 SERVER_ERROR', async () => {
    const app = buildApp((_req, _res, next) => next(new Error('internal boom')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error.class).toBe('SERVER_ERROR');
    expect(res.body.error.code).toBe(ErrorCode.INTERNAL);
  });
});

// ── Stable error codes ────────────────────────────────────────────────────────

describe('Stable error codes', () => {
  const CODE_TABLE: Array<[string, () => ApiError]> = [
    [ErrorCode.BAD_REQUEST,         () => badRequest('x')],
    [ErrorCode.NOT_FOUND,           () => notFound('x')],
    [ErrorCode.UNAUTHORIZED,        () => unauthorized()],
    [ErrorCode.FORBIDDEN,           () => forbidden()],
    [ErrorCode.INTERNAL,            () => internalError()],
    [ErrorCode.CONFLICT,            () => conflict('x')],
    [ErrorCode.SERVICE_UNAVAILABLE, () => serviceUnavailable()],
  ];

  for (const [expectedCode, factory] of CODE_TABLE) {
    it(`${expectedCode} is stable in the response body`, async () => {
      const app = buildApp((_req, _res, next) => next(factory()));
      const res = await request(app).get('/test');
      expect(res.body.error.code).toBe(expectedCode);
    });
  }
});

// ── Retry guidance ────────────────────────────────────────────────────────────

describe('Retry guidance', () => {
  it('RATE_LIMIT_EXCEEDED is retryable with retryAfterSeconds=60', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new ApiError(429, ErrorCode.RATE_LIMITED, 'Too many requests')));
    const res = await request(app).get('/test');
    expect(res.body.error.retryable).toBe(true);
    expect(res.body.error.retryAfterSeconds).toBe(60);
  });

  it('SERVICE_UNAVAILABLE is retryable with retryAfterSeconds=30', async () => {
    const app = buildApp((_req, _res, next) => next(serviceUnavailable()));
    const res = await request(app).get('/test');
    expect(res.body.error.retryable).toBe(true);
    expect(res.body.error.retryAfterSeconds).toBe(30);
  });

  it('INTERNAL_SERVER_ERROR is retryable with retryAfterSeconds=10', async () => {
    const app = buildApp((_req, _res, next) => next(internalError()));
    const res = await request(app).get('/test');
    expect(res.body.error.retryable).toBe(true);
    expect(res.body.error.retryAfterSeconds).toBe(10);
  });

  it('BAD_REQUEST is NOT retryable', async () => {
    const app = buildApp((_req, _res, next) => next(badRequest('bad input')));
    const res = await request(app).get('/test');
    expect(res.body.error.retryable).toBe(false);
    expect(res.body.error.retryAfterSeconds).toBeUndefined();
  });

  it('NOT_FOUND is NOT retryable', async () => {
    const app = buildApp((_req, _res, next) => next(notFound('nope')));
    const res = await request(app).get('/test');
    expect(res.body.error.retryable).toBe(false);
  });

  it('RATE_LIMIT_EXCEEDED sets Retry-After response header', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new ApiError(429, ErrorCode.RATE_LIMITED, 'slow down')));
    const res = await request(app).get('/test');
    expect(res.headers['retry-after']).toBe('60');
  });

  it('SERVICE_UNAVAILABLE sets Retry-After response header', async () => {
    const app = buildApp((_req, _res, next) => next(serviceUnavailable()));
    const res = await request(app).get('/test');
    expect(res.headers['retry-after']).toBe('30');
  });

  it('non-retryable errors do NOT set Retry-After header', async () => {
    const app = buildApp((_req, _res, next) => next(badRequest('x')));
    const res = await request(app).get('/test');
    expect(res.headers['retry-after']).toBeUndefined();
  });
});

// ── Zod error mapping ─────────────────────────────────────────────────────────

describe('Zod error mapping', () => {
  it('ZodError is mapped to 400 BAD_REQUEST', async () => {
    const zodResult = z.object({ limit: z.number().max(100) }).safeParse({ limit: 999 });
    const err = (zodResult as any).error as ZodError;
    const app = buildApp((_req, _res, next) => next(err));
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('ZodError provides field-level details in error.details.fieldErrors', async () => {
    const schema = z.object({
      limit:  z.number().max(100),
      status: z.enum(['Active', 'Sold']),
    });
    const zodResult = schema.safeParse({ limit: 999, status: 'Invalid' });
    const err = (zodResult as any).error as ZodError;

    const app = buildApp((_req, _res, next) => next(err));
    const res = await request(app).get('/test');

    const fieldErrors: FieldError[] = res.body.error.details?.fieldErrors;
    expect(Array.isArray(fieldErrors)).toBe(true);
    expect(fieldErrors.some((e) => e.field === 'limit')).toBe(true);
    expect(fieldErrors.some((e) => e.field === 'status')).toBe(true);
  });

  it('ZodError message identifies the failing fields', async () => {
    const zodResult = z.object({ q: z.string().min(1) }).safeParse({ q: '' });
    const err = (zodResult as any).error as ZodError;
    const app = buildApp((_req, _res, next) => next(err));
    const res = await request(app).get('/test');
    expect(res.body.error.message).toContain('q');
  });

  it('ZodError does not expose SQL or internal stack in message', async () => {
    const zodResult = z.object({ id: z.number() }).safeParse({ id: 'not-a-number' });
    const err = (zodResult as any).error as ZodError;
    const app = buildApp((_req, _res, next) => next(err));
    const res = await request(app).get('/test');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/stack/i);
    expect(body).not.toMatch(/prisma/i);
    expect(body).not.toMatch(/sql/i);
  });

  it('field errors use dot-notation for nested fields', async () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const zodResult = schema.safeParse({ user: { email: 'not-email' } });
    const err = (zodResult as any).error as ZodError;

    const app = buildApp((_req, _res, next) => next(err));
    const res = await request(app).get('/test');

    const fieldErrors: FieldError[] = res.body.error.details?.fieldErrors ?? [];
    expect(fieldErrors.some((e) => e.field === 'user.email')).toBe(true);
  });
});

// ── Prisma error mapping ───────────────────────────────────────────────────────

describe('Prisma error mapping', () => {
  function makePrismaError(code: string, message = 'prisma error') {
    const err = new Error(message) as any;
    err.code = code;
    err.clientVersion = '5.0.0';
    return err;
  }

  it('P2002 (unique constraint) → 409 CONFLICT', async () => {
    const app = buildApp((_req, _res, next) => next(makePrismaError('P2002')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.CONFLICT);
  });

  it('P2025 (record not found) → 404 NOT_FOUND', async () => {
    const app = buildApp((_req, _res, next) => next(makePrismaError('P2025')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('P2003 (foreign key constraint) → 400 BAD_REQUEST', async () => {
    const app = buildApp((_req, _res, next) => next(makePrismaError('P2003')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('P1001 (DB unreachable) → 503 SERVICE_UNAVAILABLE', async () => {
    const app = buildApp((_req, _res, next) => next(makePrismaError('P1001')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(res.body.error.retryable).toBe(true);
  });

  it('P1002 (DB timeout) → 503 SERVICE_UNAVAILABLE', async () => {
    const app = buildApp((_req, _res, next) => next(makePrismaError('P1002')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error.retryable).toBe(true);
  });

  it('unknown Prisma error → 500 INTERNAL_SERVER_ERROR', async () => {
    const app = buildApp((_req, _res, next) => next(makePrismaError('P9999', 'unknown error')));
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ErrorCode.INTERNAL);
  });

  it('Prisma 5xx errors do NOT expose raw error message containing credentials', async () => {
    const app = buildApp((_req, _res, next) =>
      next(makePrismaError('P1001', 'postgres://user:s3cr3t@localhost/db timed out')));
    const res = await request(app).get('/test');
    expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });
});

// ── Sensitive data leak prevention ────────────────────────────────────────────

describe('Sensitive data is never leaked', () => {
  it('500 does not include stack trace in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = buildApp((_req, _res, next) => {
      const err = new Error('internal');
      (err as any).stack = 'at /src/secrets.ts line 99';
      next(err);
    });
    const res = await request(app).get('/test');
    expect(JSON.stringify(res.body)).not.toContain('secrets.ts');
    process.env.NODE_ENV = originalEnv;
  });

  it('500 does not expose original unknown error message', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new Error('secret db password is hunter2')));
    const res = await request(app).get('/test');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('secret db password');
  });

  it('400 details redact fields whose names match sensitive patterns', async () => {
    const app = buildApp((_req, _res, next) =>
      next(badRequest('Bad input', { password: 'hunter2', field: 'username' })));
    const res = await request(app).get('/test');
    expect(res.body.error.details?.password).toBe('[REDACTED]');
    expect(res.body.error.details?.field).toBe('username');
  });

  it('500 never exposes details even when ApiError carries them', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new ApiError(500, ErrorCode.INTERNAL, 'fail', { sensitiveData: true })));
    const res = await request(app).get('/test');
    expect(res.body.error.details).toBeUndefined();
  });
});

// ── Endpoint family coverage ───────────────────────────────────────────────────

describe('Endpoint family coverage — all 400s use the stable envelope', () => {
  const invalidParamCases: Array<[string, string]> = [
    ['GET /listings with limit > max',       '/listings?limit=999'],
    ['GET /auctions with limit > max',       '/auctions?limit=999'],
    ['GET /offers with invalid listing_id',  '/offers?listing_id=not-a-number'],
    ['GET /collections with limit > max',    '/collections?limit=999'],
    ['GET /search with empty q',             '/search?q='],
    [
      'GET /royalty-breakdown with bad from',
      '/wallets/GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F/royalty-breakdown?from=notanumber',
    ],
  ];

  for (const [label, url] of invalidParamCases) {
    it(`${label} — envelope is stable`, async () => {
      const res = await request(fullApp).get(url);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code:      ErrorCode.BAD_REQUEST,
        class:     'CLIENT_ERROR',
        retryable: false,
      });
      expect(res.body.error.requestId).toBe('integration-req-id');
    });
  }

  it('GET /listings/:id with non-numeric id returns a structured error', async () => {
    const res = await request(fullApp).get('/listings/not-a-number');
    expect([400, 404, 500]).toContain(res.status);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('class');
    expect(res.body.error).toHaveProperty('retryable');
  });
});
