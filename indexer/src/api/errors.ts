import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodIssue } from 'zod';
import { logger } from '../logger.js';
import { redact, redactString } from '../redact.js';

export const ErrorCode = {
  BAD_REQUEST:  'BAD_REQUEST',
  NOT_FOUND:    'NOT_FOUND',
  INTERNAL:     'INTERNAL_SERVER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN:    'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMIT_EXCEEDED',
  QUERY_TOO_EXPENSIVE: 'QUERY_TOO_EXPENSIVE',
  // New stable codes for Prisma-level errors
  CONFLICT:     'CONFLICT',           // unique constraint violation
  GONE:         'GONE',               // record existed but was deleted
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE', // DB/Redis timeout
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Error classification ──────────────────────────────────────────────────────
//
// Two operational buckets: CLIENT_ERROR (4xx — caller's fault, not paged) and
// SERVER_ERROR (5xx — our fault, paged). Used in structured log lines so
// dashboards can route alerts without re-parsing status codes.

export type ErrorClass = 'CLIENT_ERROR' | 'SERVER_ERROR';

function classifyError(statusCode: number): ErrorClass {
  return statusCode >= 500 ? 'SERVER_ERROR' : 'CLIENT_ERROR';
}

// ── Retry guidance ────────────────────────────────────────────────────────────
//
// retryable: false — caller MUST NOT retry (bad input, auth failure).
// retryable: true  — caller MAY retry after retryAfterSeconds.
// retryAfterSeconds: hint for Retry-After header and client back-off.

export interface RetryGuidance {
  retryable: boolean;
  retryAfterSeconds?: number;
}

function retryGuidanceForCode(code: ErrorCode, statusCode: number): RetryGuidance {
  switch (code) {
    case ErrorCode.RATE_LIMITED:
      return { retryable: true, retryAfterSeconds: 60 };
    case ErrorCode.SERVICE_UNAVAILABLE:
      return { retryable: true, retryAfterSeconds: 30 };
    case ErrorCode.INTERNAL:
      // 5xx errors are potentially transient — clients may retry with back-off.
      return { retryable: true, retryAfterSeconds: 10 };
    default:
      // All 4xx except rate-limit and 5xx server errors are not retryable.
      return { retryable: statusCode >= 500 };
  }
}

// ── Field-level validation details ───────────────────────────────────────────
//
// Zod issues are normalised to a stable { field, message } shape so clients
// can branch on field names without parsing free-form strings.

export interface FieldError {
  field: string;
  message: string;
}

function zodIssuesToFieldErrors(issues: ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    field:   issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, ErrorCode.BAD_REQUEST, message, details);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, ErrorCode.NOT_FOUND, message);
}

export function unauthorized(message = 'Missing or invalid credentials'): ApiError {
  return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
}

export function forbidden(message = 'Insufficient permissions'): ApiError {
  return new ApiError(403, ErrorCode.FORBIDDEN, message);
}

export function internalError(message = 'An unexpected error occurred'): ApiError {
  return new ApiError(500, ErrorCode.INTERNAL, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, ErrorCode.CONFLICT, message);
}

export function serviceUnavailable(message = 'Service temporarily unavailable'): ApiError {
  return new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, message);
}

// ── Prisma error mapping ──────────────────────────────────────────────────────
//
// Maps Prisma client error codes to stable API error codes so the frontend
// can branch on code strings rather than HTTP status numbers.
//
// Reference: https://www.prisma.io/docs/reference/api-reference/error-reference

function prismaErrorToApiError(err: unknown): ApiError | null {
  if (!err || typeof err !== 'object') return null;

  const prismaErr = err as { code?: string; message?: string; meta?: unknown };

  switch (prismaErr.code) {
    // Unique constraint violation
    case 'P2002':
      return conflict('A record with the provided values already exists');

    // Record not found (findUniqueOrThrow / update / delete)
    case 'P2025':
      return notFound('The requested record does not exist');

    // Foreign key constraint violation
    case 'P2003':
      return badRequest('Invalid reference: the related record does not exist');

    // Null constraint violation
    case 'P2011':
      return badRequest('Required field is missing');

    // Value too long for column
    case 'P2000':
      return badRequest('A provided value exceeds the maximum allowed length');

    // Invalid input (e.g. bigint overflow)
    case 'P2007':
    case 'P2006':
      return badRequest('Invalid input value');

    // Database connection / timeout (P1xxx codes)
    case 'P1001': // Can't reach DB server
    case 'P1002': // DB server timeout
    case 'P1008': // Operations timed out
    case 'P1017': // Connection closed by server
      return serviceUnavailable('Database temporarily unavailable — please retry');

    default:
      return null;
  }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  // ZodError — validation failure with field-level detail
  if (err instanceof ZodError) {
    const fieldErrors = zodIssuesToFieldErrors(err.issues);
    const message = err.issues
      .map((e) => `${e.path.join('.') || '_root'}: ${e.message}`)
      .join('; ');
    return new ApiError(400, ErrorCode.BAD_REQUEST, message, { fieldErrors });
  }

  // Prisma client error
  const prismaApiError = prismaErrorToApiError(err);
  if (prismaApiError) return prismaApiError;

  return internalError();
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiErr = toApiError(err);
  const requestId: string | undefined = res.locals.requestId as string | undefined;
  const errorClass = classifyError(apiErr.statusCode);
  const retry = retryGuidanceForCode(apiErr.code, apiErr.statusCode);

  // Structured operational log — server errors include the original cause so
  // on-call engineers can triage without accessing raw stdout.
  if (apiErr.statusCode >= 500) {
    logger.error('request error', {
      requestId,
      errorClass,
      statusCode: apiErr.statusCode,
      code: apiErr.code,
      message: apiErr.message,
      path: req.path,
      method: req.method,
      // Safe: only include stack when not in production so CI logs are useful
      // but production logs never contain internal file paths.
      ...(process.env.NODE_ENV !== 'production' && err instanceof Error
        ? { stack: err.stack }
        : {}),
    });
  } else {
    logger.debug('client error', {
      requestId,
      errorClass,
      statusCode: apiErr.statusCode,
      code: apiErr.code,
      message: apiErr.message,
      path: req.path,
      method: req.method,
    });
  }

  // Set Retry-After header when retryable.
  if (retry.retryable && retry.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(retry.retryAfterSeconds));
  }

  type ErrorBody = {
    error: {
      code: string;
      message: string;
      requestId?: string;
      class: ErrorClass;
      retryable: boolean;
      retryAfterSeconds?: number;
      details?: unknown;
    };
  };

  const body: ErrorBody = {
    error: {
      code:    apiErr.code,
      // Redacted so a secret shape (Stellar key, DB URL, Pinata token, ...)
      // accidentally interpolated into an error message never reaches the client.
      message: redactString(apiErr.message),
      class:   errorClass,
      // Include correlation ID so clients can reference it when reporting issues.
      ...(requestId ? { requestId } : {}),
      // Retry guidance — always present so clients don't need to guess.
      retryable: retry.retryable,
      ...(retry.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: retry.retryAfterSeconds }
        : {}),
    },
  };

  // Surface structured validation details for 4xx but never for 5xx (leak prevention).
  if (apiErr.statusCode < 500 && apiErr.details !== undefined) {
    body.error.details = redact(apiErr.details);
  }

  res.status(apiErr.statusCode).json(body);
}
