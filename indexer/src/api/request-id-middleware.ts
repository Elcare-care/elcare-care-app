import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

// ── Request correlation IDs ───────────────────────────────────────────────────
//
// Every inbound request is tagged with a request ID so a single request can
// be traced across every log line it produces (and across services, if the
// caller already supplies one via `X-Request-Id`). The ID is:
//   - read from the inbound `X-Request-Id` header when present, else generated
//   - stored on `res.locals.requestId` for downstream handlers to read
//   - echoed back as the `X-Request-Id` response header
//
// Two structured log lines bracket each request: "request started" and
// "request completed" (with status code + duration). Health/metrics polling
// endpoints are skipped to avoid drowning real traffic in noise, matching the
// behaviour of the previous plain-text requestLogger in metrics.ts.

const SKIP_PATHS = new Set(['/health', '/metrics', '/readyz']);

function normalizeRoute(req: Request): string {
  const route = req.baseUrl + (req.route ? req.route.path : req.path);
  return route && route !== '' ? route : req.path;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inboundId = req.headers['x-request-id'];
  const requestId =
    (Array.isArray(inboundId) ? inboundId[0] : inboundId) || randomUUID();

  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const skip = SKIP_PATHS.has(req.path);
  const startTime = Date.now();

  if (!skip) {
    logger.info('request started', {
      requestId,
      method: req.method,
      route: normalizeRoute(req),
    });
  }

  res.on('finish', () => {
    if (skip) return;

    const durationMs = Date.now() - startTime;
    logger.info('request completed', {
      requestId,
      method: req.method,
      route: normalizeRoute(req),
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}
