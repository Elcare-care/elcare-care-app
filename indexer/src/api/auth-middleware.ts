import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { unauthorized, forbidden } from './errors.js';
import { getAuditService, AuditActionType, AuditOutcome } from '../audit/audit-service.js';
import { PrismaClient } from '@prisma/client';

// ── Route classification ────────────────────────────────────────────────────────
//
// Public:        no auth required (listings, auctions, offers, collections, search, SSE, health)
// Authenticated: optional wallet auth (wallets, stats, artists)
// Operator:      requires service credential (admin, reconciliation, backfill, keeper, sync)

export type RoutePolicy = 'public' | 'authenticated' | 'operator';

export interface AuthConfig {
  operatorToken: string | undefined;
  allowlist: string[];
}

let cachedConfig: AuthConfig | null = null;

export function loadAuthConfig(): AuthConfig {
  if (cachedConfig) return cachedConfig;

  const operatorToken = process.env.OPERATOR_TOKEN || process.env.HEALTH_DETAILS_TOKEN || '';
  const allowlist = (process.env.OPERATOR_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  cachedConfig = { operatorToken, allowlist };
  return cachedConfig;
}

export let prismaClient: PrismaClient | null = null;

export function setPrismaClient(client: PrismaClient): void {
  prismaClient = client;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getClientIp(req: Request): string {
  // Respect X-Forwarded-For when the server is behind a trusted proxy (e.g.
  // nginx, AWS ALB). Fall back through socket address to 'unknown'.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return (req.ip || req.socket?.remoteAddress || 'unknown').toString();
}

function extractWallet(req: Request): string | undefined {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query.wallet;
  if (typeof query === 'string' && query.length > 0) return query;
  return undefined;
}

// ── Correlation helper ─────────────────────────────────────────────────────────

function getRequestId(res: Response): string | undefined {
  return (res.locals.requestId as string) || undefined;
}

// ── Audit logger ───────────────────────────────────────────────────────────────
//
// Every auth decision — allowed or denied — is emitted as a structured log line
// with a stable `event` field so log aggregators can build dashboards from it
// without parsing free-form strings. The `requestId` correlation key ties each
// audit entry to the surrounding request/response log lines.

export function auditLog(
  req: Request,
  res: Response,
  outcome: 'allowed' | 'denied',
  reason: string,
  policy: RoutePolicy,
): void {
  logger.info('auth.decision', {
    event: 'auth.decision',
    outcome,
    policy,
    reason,
    requestId: getRequestId(res),
    ip: getClientIp(req),
    wallet: extractWallet(req),
    path: req.path,
    method: req.method,
    userAgent: req.headers['user-agent'] || undefined,
  });

  // Log operator auth attempts to audit trail
  if (policy === 'operator' && prismaClient) {
    const auditService = getAuditService(prismaClient);
    auditService.log({
      actor: getClientIp(req),
      actionType: AuditActionType.AdminRoleChange,
      target: req.path,
      requestId: getRequestId(res) || undefined,
      outcome: outcome === 'allowed' ? AuditOutcome.Success : AuditOutcome.Failure,
      context: {
        reason,
        policy,
        method: req.method,
      },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] as string,
    }).catch((err) => {
      // Don't block auth if audit logging fails
      logger.error('audit.log_failed', { error: err.message });
    });
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export function authMiddleware(policy: RoutePolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = loadAuthConfig();

    if (policy === 'public') {
      return next();
    }

    if (policy === 'authenticated') {
      // Authenticated routes accept any request; wallet is optional metadata.
      // No auth check needed — the route itself may use wallet for filtering.
      return next();
    }

    if (policy === 'operator') {
      const provided = req.headers['x-operator-token'] ?? req.query.operator_token;

      if (!config.operatorToken) {
        // No token configured — allow but emit a warning so operators know the
        // endpoint is effectively unprotected.
        logger.warn('auth.unconfigured', {
          event: 'auth.unconfigured',
          policy,
          path: req.path,
          requestId: getRequestId(res),
          ip: getClientIp(req),
        });
        return next();
      }

      if (!provided || provided !== config.operatorToken) {
        auditLog(req, res, 'denied', 'invalid_or_missing_token', policy);
        return next(unauthorized('Invalid or missing operator token'));
      }

      // Token is valid — check allowlist if configured
      if (config.allowlist.length > 0) {
        const clientIp = getClientIp(req);
        if (!config.allowlist.includes(clientIp)) {
          auditLog(req, res, 'denied', 'ip_not_in_allowlist', policy);
          return next(forbidden('Operator access not allowed from this IP'));
        }
      }

      auditLog(req, res, 'allowed', 'token_valid', policy);
      return next();
    }

    next();
  };
}

// ── Route map ──────────────────────────────────────────────────────────────────

export const PUBLIC_ROUTES = new Set([
  '/health',
  '/readyz',
  '/version',
  '/metrics',
  '/openapi.json',
  '/docs',
  '/cors-test',
  '/events',
  '/listings',
  '/listings/{id}',
  '/listings/{id}/history',
  '/listings/{id}/price-history',
  '/auctions',
  '/auctions/{id}',
  '/auctions/{id}/blocked-bidders',
  '/offers',
  '/collections',
  '/collections/{address}/fee',
  '/creators/{address}/collections',
  '/search',
  '/activity/recent',
  '/artists/{address}/metrics',
  '/ipfs/{cid}',
]);

export const AUTHENTICATED_ROUTES = new Set([
  '/wallets/{address}/activity',
  '/wallets/{address}/royalty-stats',
  '/wallets/{address}/royalty-breakdown',
]);

export const OPERATOR_ROUTES = new Set([
  '/health/details',
  '/reconciliation/status',
  '/backfill/status',
  '/keeper/status',
  '/sync/gaps',
  '/sync/gaps/{id}',
  '/sync/jobs',
  '/sync/jobs/{id}',
  '/admin/contracts',
  '/admin/audit',
  '/admin/audit/{requestId}',
  '/admin/audit/stats',
]);

export function classifyRoute(path: string): RoutePolicy {
  if (PUBLIC_ROUTES.has(path)) return 'public';
  if (AUTHENTICATED_ROUTES.has(path)) return 'authenticated';
  if (OPERATOR_ROUTES.has(path)) return 'operator';
  return 'public';
}
