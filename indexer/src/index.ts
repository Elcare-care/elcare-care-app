import { initSentry, Sentry } from './sentry.js';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import routes, { closeSSEClients } from './api/routes.js';
import { startPolling, registerShutdownHook, stopPoller, gracefulShutdown } from './poller.js';
import { rateLimiter, globalRateLimiter } from './api/rate-limit-middleware.js';
import { metricsMiddleware, handleMetrics, requestLogger } from './metrics.js';
import { errorHandler } from './api/errors.js';
import { startReconciler } from './reconciler.js';
import { validateRequiredEnv, loadKeeperConfig, loadConfig } from './config.js';
import { parseCorsOrigins, buildCorsOptions } from './cors.js';
import { startKeeper } from './keeper/index.js';
import { startGapRepairWorker } from './gap-repair.js';
import { logger } from './logger.js';
import prisma from './db.js';
import docsRouter from './api/docs-router.js';
import { startDbHealthProbe } from './db-health.js';
import { isStalled } from './stall.js';

dotenv.config();

// Initialise Sentry before the Express app is constructed so it can instrument
// framework integrations automatically. No-op when SENTRY_DSN is not set.
initSentry();

// Fail fast — refuse to start if any required environment variable is missing.
try {
  validateRequiredEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const cfg  = loadConfig();
const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
app.use(cors(buildCorsOptions(corsOrigins)));
app.options(/.*/, cors(buildCorsOptions(corsOrigins)));
app.use(compression());
app.use(express.json());

// Global baseline rate limiter
app.use(globalRateLimiter);

// Request logging and metrics
app.use(requestLogger);
app.use(metricsMiddleware);

// Prometheus metrics endpoint
app.get('/metrics', handleMetrics);

// Standard rate limiting fallback
app.use(rateLimiter);

// OpenAPI spec + Swagger UI
app.use('/', docsRouter);

// API routes
app.use('/', routes);

// Sentry error handler must come before the custom error handler
Sentry.setupExpressErrorHandler(app);

// ── Global error handler ──────────────────────────────────────────────────────
// Catches any unhandled errors from route/middleware and returns a sanitized
// 500 response.  Stack traces are never leaked to clients.
app.use(errorHandler);

// ── Liveness probe ────────────────────────────────────────────────────────────
app.get('/health', (_req: express.Request, res: express.Response) => {
  res.json({ status: 'ok' });
});

// ── Dev-only CORS debug endpoint ──────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.get('/cors-test', (req: express.Request, res: express.Response) => {
    const origin = req.headers.origin ?? null;
    const allowed =
      corsOrigins.length === 0
        ? true
        : origin !== null && corsOrigins.includes(origin);

    res.json({
      origin,
      allowed,
      whitelist: corsOrigins,
      mode: corsOrigins.length === 0 ? 'development (all origins)' : 'production (whitelist)',
      headers: {
        'access-control-allow-origin': res.getHeader('access-control-allow-origin') ?? null,
        'access-control-allow-credentials': res.getHeader('access-control-allow-credentials') ?? null,
      },
    });
  });
}

// ── Readiness probe ───────────────────────────────────────────────────────────
app.get('/readyz', async (_req: express.Request, res: express.Response) => {
  if (isStalled()) {
    return res.status(503).json({ status: 'stalled', reason: 'Indexer not advancing' });
  }

  try {
    const contracts = await prisma.trackedContract.findMany({
      where:  { active: true },
      select: { contractId: true, lastLedger: true, label: true },
    });
    const ready = contracts.length > 0 && contracts.some((c) => c.lastLedger > 0);
    if (ready) {
      return res.json({
        status: 'ready',
        contracts: contracts.map((c) => ({
          contractId: c.contractId,
          label:      c.label,
          lastLedger: c.lastLedger,
        })),
      });
    }
    return res.status(503).json({ status: 'not_ready', reason: 'No ledgers indexed yet' });
  } catch {
    const state = await prisma.syncState.findUnique({ where: { id: 1 } });
    if (state && state.lastLedger > 0) {
      return res.json({ status: 'ready', lastLedger: state.lastLedger });
    }
    return res.status(503).json({ status: 'not_ready', reason: 'No ledgers indexed yet' });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  logger.info(`Indexer API listening on http://localhost:${PORT}`);

  // ── DB health probe — warns on pool exhaustion before requests time out ──
  const stopProbe = startDbHealthProbe();
  registerShutdownHook(async () => { stopProbe(); });

  // ── Background polling loop ───────────────────────────────────────────────
  startPolling().catch((err) => {
    logger.error('Fatal error in poller', { err });
    process.exit(1);
  });

  // ── Periodic reconciliation (non-fatal) ───────────────────────────────────
  startReconciler().catch((err) => {
    logger.error('[Reconciler] Failed to start', { err });
  });

  // ── Gap-repair worker ─────────────────────────────────────────────────────
  if (process.env.GAP_REPAIR_ENABLED === 'true') {
    startGapRepairWorker().catch((err) => {
      logger.error('gap-repair: worker fatal error', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── Keeper loop ───────────────────────────────────────────────────────────
  if (process.env.KEEPER_ENABLED === 'true') {
    try {
      const keeperCfg = loadKeeperConfig();
      logger.info('keeper: enabled — starting loop', {
        dryRun:     keeperCfg.KEEPER_DRY_RUN,
        intervalMs: keeperCfg.KEEPER_INTERVAL_MS,
      });
      startKeeper().catch((err) => {
        logger.error('keeper: fatal loop error', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.error('keeper: invalid configuration — keeper not started', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Register HTTP server + SSE cleanup as a shutdown hook so gracefulShutdown()
// in poller.ts drains in-flight requests and sends server-shutdown to SSE clients.
registerShutdownHook(
  () =>
    new Promise<void>((resolve) => {
      // 1. Tell SSE clients the server is going down.
      closeSSEClients();

      // 2. Stop accepting new connections; wait for in-flight requests.
      httpServer.close(() => resolve());

      // 3. If requests haven't drained within the configured timeout, force-close.
      setTimeout(resolve, cfg.shutdownTimeoutMs).unref();
    }),
);

// ── Signal handlers ───────────────────────────────────────────────────────────
// SIGTERM is sent by Kubernetes / docker stop.
// SIGINT  is sent by Ctrl-C in development.
//
// Sequence:
//   1. Set shuttingDown flag — poller loop exits after current batch.
//   2. Call gracefulShutdown() — drains HTTP, closes SSE, disconnects DB/Redis.
//   3. Exit with code 0.

function handleSignal(signal: string): void {
  logger.info(`[shutdown] ${signal} received — initiating graceful shutdown`);

  // Signal the poller to stop after its current ledger batch completes.
  stopPoller();

  // Run the full shutdown sequence (registered hooks + DB/Redis disconnect).
  gracefulShutdown().catch((err) => {
    logger.error('[shutdown] Graceful shutdown failed', { err });
    process.exit(1);
  });
}

process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT',  () => handleSignal('SIGINT'));
