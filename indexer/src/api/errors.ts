import { Request, Response, NextFunction } from 'express';

// ── Error envelope ────────────────────────────────────────────────────────────
//
// All API error responses use a consistent JSON shape:
//
//   { "error": { "code": "BAD_REQUEST", "message": "...", "details"?: ... } }
//
// This makes it easy for clients to branch on `error.code` without parsing
// free-form message strings, and the optional `details` field carries
// structured context (e.g. validation issues) when available.

export const ErrorCode = {
  BAD_REQUEST:  'BAD_REQUEST',
  NOT_FOUND:    'NOT_FOUND',
  INTERNAL:     'INTERNAL_SERVER_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

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

// ── Factory helpers ───────────────────────────────────────────────────────────

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, ErrorCode.BAD_REQUEST, message, details);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, ErrorCode.NOT_FOUND, message);
}

export function internalError(message = 'An unexpected error occurred'): ApiError {
  return new ApiError(500, ErrorCode.INTERNAL, message);
}

// ── Domain-error mapper ───────────────────────────────────────────────────────

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  // Never surface raw error details (stack traces, SQL errors, etc.) to clients.
  return internalError();
}

// ── Global error handler ──────────────────────────────────────────────────────
//
// Registered as the last middleware in index.ts.
// Catches all errors passed via next(err) and returns the standardised envelope.
// 5xx errors are logged server-side; stack traces are NEVER sent to the client.

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiErr = toApiError(err);

  if (apiErr.statusCode >= 500) {
    // Log original error with full context for debugging; never echo to client.
    console.error('[ErrorHandler]', err);
  }

  const body: {
    error: { code: string; message: string; details?: unknown };
  } = {
    error: {
      code:    apiErr.code,
      message: apiErr.message,
    },
  };

  // Include `details` only for 4xx (client errors) where it aids debugging.
  if (apiErr.statusCode < 500 && apiErr.details !== undefined) {
    body.error.details = apiErr.details;
  }

  res.status(apiErr.statusCode).json(body);
}
