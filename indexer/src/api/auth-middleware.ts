import { Request, Response, NextFunction } from 'express';
import { unauthorized, forbidden } from './errors.js';

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

export function resetAuthConfigCache(): void {
  cachedConfig = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getClientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').toString();
}

function extractWallet(req: Request): string | undefined {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query.wallet;
  if (typeof query === 'string' && query.length > 0) return query;
  return undefined;
}

// ── Audit logger ───────────────────────────────────────────────────────────────

export function auditLog(req: Request, outcome: 'allowed' | 'denied', reason: string, policy: RoutePolicy): void {
  const { logger } = require('../logger.js');
  logger.info('[auth] audit', {
    outcome,
    policy,
    reason,
    ip: getClientIp(req),
    wallet: extractWallet(req),
    path: req.path,
    method: req.method,
    userAgent: req.headers['user-agent'] || undefined,
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export function authMiddleware(policy: RoutePolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = loadAuthConfig();

    if (policy === 'public') {
      return next();
    }

    const wallet = extractWallet(req);

    if (policy === 'authenticated') {
      // Authenticated routes accept any request; wallet is optional metadata.
      // No auth check needed — the route itself may use wallet for filtering.
      return next();
    }

    if (policy === 'operator') {
      const provided = req.headers['x-operator-token'] ?? req.query.operator_token;

      if (!config.operatorToken) {
        // No token configured — allow but log warning
        logger.warn('[auth] operator endpoint accessed without OPERATOR_TOKEN configured', {
          path: req.path,
          ip: getClientIp(req),
        });
        return next();
      }

      if (!provided || provided !== config.operatorToken) {
        auditLog(req, 'denied', 'invalid_or_missing_token', policy);
        return next(unauthorized('Invalid or missing operator token'));
      }

      // Token is valid — check allowlist if configured
      if (config.allowlist.length > 0) {
        const clientIp = getClientIp(req);
        if (!config.allowlist.includes(clientIp)) {
          auditLog(req, 'denied', 'ip_not_in_allowlist', policy);
          return next(forbidden('Operator access not allowed from this IP'));
        }
      }

      auditLog(req, 'allowed', 'token_valid', policy);
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
]);

export function classifyRoute(path: string): RoutePolicy {
  if (PUBLIC_ROUTES.has(path)) return 'public';
  if (AUTHENTICATED_ROUTES.has(path)) return 'authenticated';
  if (OPERATOR_ROUTES.has(path)) return 'operator';
  return 'public';
}
