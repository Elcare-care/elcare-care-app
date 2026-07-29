import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export const ErrorCode = {
  BAD_REQUEST:  'BAD_REQUEST',
  NOT_FOUND:    'NOT_FOUND',
  INTERNAL:     'INTERNAL_SERVER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN:    'FORBIDDEN',
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

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return internalError();
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiErr = toApiError(err);

  if (apiErr.statusCode >= 500) {
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

  if (apiErr.statusCode < 500 && apiErr.details !== undefined) {
    body.error.details = apiErr.details;
  }

  res.status(apiErr.statusCode).json(body);
}
