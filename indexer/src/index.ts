import { initSentry, Sentry } from './sentry.js';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import routes, { closeSSEClients } from './api/routes.js';
import { startPolling, registerShutdownHook } from './poller.js';
import { rateLimiter, globalRateLimiter } from './api/rate-limit-middleware.js';
import { metricsMiddleware, handleMetrics, requestLogger } from './metrics.js';
import { errorHandler } from './api/errors.js';
import { startReconciler } from './reconciler.js';
import { validateRequiredEnv, loadKeeperConfig } from './config.js';
import { parseCorsOrigins, buildCorsOptions } from './cors.js';
import { startKeeper } from './keeper/index.js';
import { startGapRepairWorker } from './gap-repair.js';
import { logger } from './logger.js';
import prisma from './db.js';
import docsRouter from './api/docs-router.js';

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

const app = express();
const PORT = process.env.PORT || 4000;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Parse the whitelist once at startup. An empty list = dev mode (all origins).
const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
app.use(cors(buildCorsOptions(corsOrigins)));
// Handle OPTIONS preflight explicitly — Express 5 requires a valid route pattern.
app.options(/.*/, cors(buildCorsOptions(corsOrigins)));
app.use(compression());
app.use(express.json());

// Apply global baseline rate limiter to all public endpoints
app.use(globalRateLimiter);

// Request logging and metrics
app.use(requestLogger);
app.use(metricsMiddleware);

// Expose /metrics for Prometheus scrapers
app.get('/metrics', handleMetrics);

// Apply standard rate limiting for fallback
app.use(rateLimiter);

// OpenAPI spec + Swagger UI (no rate-limit — static/read-only)
app.use('/', docsRouter);

// API Routes
app.use('/', routes);

// Sentry error handler must be registered before the custom error handler
Sentry.setupExpressErrorHandler(app);

// Central error handler — must be registered after all routes
app.use(errorHandler);

// Health check
app.get('/health', (_req: express.Request, res: express.Response) => {
  res.json({ status: 'ok' });
});

// ── Dev-only CORS debug endpoint ──────────────────────────────────────────────
// Echo the request origin, relevant headers, and the CORS decision so developers
// can verify their browser / curl config without reading server logs.
// Stripped in production — never exposed to end users.
if (process.env.NODE_ENV !== 'production') {
    app.get('/cors-test', (req: express.Request, res: express.Response) => {
        const origin = req.headers.origin ?? null;
        const allowed = corsOrigins.length === 0
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

// Readiness probe — returns 503 until the indexer has processed at least one ledger,
// or if the indexer has stalled (no progress for STALL_THRESHOLD_MS).
app.get('/readyz', async (req: express.Request, res: express.Response) => {
    if (isStalled()) {
        return res.status(503).json({ status: 'stalled', reason: 'Indexer not advancing' });
    }

    try {
        const contracts = await prisma.trackedContract.findMany({
            where: { active: true },
            select: { contractId: true, lastLedger: true, label: true },
        });
        const ready = contracts.length > 0 && contracts.some((c) => c.lastLedger > 0);
        if (ready) {
            return res.json({
                status: 'ready',
                contracts: contracts.map((c) => ({ contractId: c.contractId, label: c.label, lastLedger: c.lastLedger })),
            });
        }
        return res.status(503).json({ status: 'not_ready', reason: 'No ledgers indexed yet' });
    } catch {
        // Fall back to legacy SyncState check
        const state = await prisma.syncState.findUnique({ where: { id: 1 } });
        if (state && state.lastLedger > 0) {
            return res.json({ status: 'ready', lastLedger: state.lastLedger });
        }
        return res.status(503).json({ status: 'not_ready', reason: 'No ledgers indexed yet' });
    }
});

// Start the server
const httpServer = app.listen(PORT, () => {
    console.log(`Indexer API listening on http://localhost:${PORT}`);

    // Start the background polling loop
    startPolling().catch((err) => {
        logger.error('Fatal error in poller', { err });
        process.exit(1);
    });

    // Start the periodic reconciliation job (non-fatal if it fails)
    startReconciler().catch((err) => {
        console.error('[Reconciler] Failed to start:', err);
    });

    // Start gap-repair worker when GAP_REPAIR_ENABLED=true
    if (process.env.GAP_REPAIR_ENABLED === 'true') {
        startGapRepairWorker().catch((err) => {
            logger.error('gap-repair: worker fatal error', {
                err: err instanceof Error ? err.message : String(err),
            });
        });
    }

    // Start the keeper loop when KEEPER_ENABLED=true.
    // Validated here so a bad config fails loud at startup rather than silently
    // doing nothing.  Errors are non-fatal to the main indexer process.
    if (process.env.KEEPER_ENABLED === 'true') {
        try {
            const keeperCfg = loadKeeperConfig();
            logger.info('keeper: enabled — starting loop', {
                dryRun: keeperCfg.KEEPER_DRY_RUN,
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

// Register HTTP server and SSE cleanup so gracefulShutdown() in poller closes them too.
registerShutdownHook(() => new Promise<void>((resolve) => {
  closeSSEClients();
  httpServer.close(() => resolve());
}));
