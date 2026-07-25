import client from 'prom-client';
import express from 'express';
import { logger } from './logger.js';

// Enable default metrics (CPU, memory, etc.)
client.collectDefaultMetrics();

// Custom Metrics
export const latestLedgerProcessedGauge = new client.Gauge({
  name: 'indexer_latest_ledger_processed',
  help: 'The sequence number of the latest ledger processed by the indexer',
});

export const networkLatestLedgerGauge = new client.Gauge({
  name: 'indexer_network_latest_ledger',
  help: 'The sequence number of the latest ledger on the Stellar network',
});

export const syncLatencyGauge = new client.Gauge({
  name: 'indexer_sync_latency_ledgers',
  help: 'The difference between the latest network ledger and the processed ledger',
});

export const rpcRetryExhaustedCounter = new client.Counter({
  name: 'indexer_rpc_retry_exhausted_total',
  help: 'Total number of times RPC retries were exhausted, indicating sustained failures',
  labelNames: ['operation'],
});

export const decodeErrorsCounter = new client.Counter({
  name: 'indexer_decode_errors_total',
  help: 'Total number of XDR event decode errors encountered during sync',
});

/** Per-event-type decode error counter (labeled). */
export const eventDecodeErrorsCounter = new client.Counter({
  name: 'indexer_decode_errors_by_type_total',
  help: 'Total XDR event decode errors by event type',
  labelNames: ['event_type'],
});

export const duplicateEventsCounter = new client.Counter({
  name: 'elcarehub_duplicate_events_total',
  help: 'Total number of duplicate on-chain events skipped during idempotent processing',
});

export const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// ── Stall gauge ───────────────────────────────────────────────────────────────

/** Set to 1 when the indexer has stalled (no ledger progress), 0 otherwise. */
export const stalledGauge = new client.Gauge({
  name: 'indexer_stalled',
  help: '1 when the indexer has not advanced within the stall threshold, 0 otherwise',
});

// ── Business KPI Metrics ──────────────────────────────────────────────────────

/** Total listings created (labelled by NFT collection kind). */
export const listingsCreatedTotal = new client.Counter({
  name: 'elcarehub_listings_created_total',
  help: 'Total number of listings created, by NFT collection kind',
  labelNames: ['collection_kind'],
});

/** Total sales (labelled by payment token type). */
export const salesTotalCounter = new client.Counter({
  name: 'elcarehub_sales_total',
  help: 'Total number of artwork sales, by token type',
  labelNames: ['token_type'],
});

/** Total auction finalizations. */
export const auctionFinalizationsTotal = new client.Counter({
  name: 'elcarehub_auction_finalizations_total',
  help: 'Total number of auctions finalized',
});

/** Total offers made. */
export const offersMadeTotal = new client.Counter({
  name: 'elcarehub_offers_made_total',
  help: 'Total number of offers submitted',
});

/** Total offers accepted. */
export const offersAcceptedTotal = new client.Counter({
  name: 'elcarehub_offers_accepted_total',
  help: 'Total number of offers accepted',
});

/** Total SSE connections opened (ever). */
export const sseConnectionsTotal = new client.Counter({
  name: 'elcarehub_sse_connections_total',
  help: 'Total SSE connections opened since the indexer started',
});

/** Current number of active listings. */
export const activeListingsGauge = new client.Gauge({
  name: 'elcarehub_active_listings',
  help: 'Current number of active listings in the marketplace',
});

/** Current number of active auctions. */
export const activeAuctionsGauge = new client.Gauge({
  name: 'elcarehub_active_auctions',
  help: 'Current number of active auctions in the marketplace',
});

/** Current number of live SSE connections. */
export const sseActiveConnectionsGauge = new client.Gauge({
  name: 'elcarehub_sse_active_connections',
  help: 'Current number of active SSE client connections',
});

/** Sync lag in ledgers (alias of syncLatencyGauge for business-facing dashboards). */
export const syncLagLedgersGauge = new client.Gauge({
  name: 'elcarehub_sync_lag_ledgers',
  help: 'Number of ledgers the indexer is behind the network tip',
});

// ── Per-endpoint and per-event histograms ─────────────────────────────────────

/** Per-route API request duration (with method, route, status_code labels). */
export const apiRequestDurationHistogram = new client.Histogram({
  name: 'elcarehub_api_request_duration_seconds',
  help: 'HTTP API request duration in seconds, labelled by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/** Per-event-type processing duration. */
export const eventProcessingDurationHistogram = new client.Histogram({
  name: 'elcarehub_event_processing_duration_seconds',
  help: 'Time spent processing each on-chain event, labelled by event_type',
  labelNames: ['event_type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

// Request logging middleware
export function requestLogger(req: express.Request, res: express.Response, next: express.NextFunction) {
  const startTime = Date.now();

  res.on('finish', () => {
    const latency = Date.now() - startTime;
    const statusClass = res.statusCode < 400 ? '2xx/3xx' : res.statusCode < 500 ? '4xx' : '5xx';
    
    // Skip logging for health checks and metrics
    if (req.path !== '/health' && req.path !== '/metrics' && req.path !== '/readyz') {
      console.log(
        `${req.method} ${req.path} ${res.statusCode} ${latency}ms`
      );
    }
  });

  next();
}

// Middleware to track HTTP response times
export function metricsMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const start = process.hrtime();
  
  res.on('finish', () => {
    const duration = process.hrtime(start);
    const durationInSeconds = duration[0] + duration[1] / 1e9;
    
    // Normalize route to avoid high-cardinality issues
    let route = req.baseUrl + (req.route ? req.route.path : req.path);
    if (!route || route === '') {
      route = req.path;
    }
    
    httpRequestDurationMicroseconds.labels(
      req.method,
      route,
      res.statusCode.toString()
    ).observe(durationInSeconds);
  });
  
  next();
}

// ── Keeper metrics ────────────────────────────────────────────────────────────
//
// entry_point label values: "expire_listing" | "finalize_auction" | "reclaim_offer"
// outcome      label values: "succeeded" | "failed" | "skipped" | "dry_run"

/** Total keeper action attempts, labelled by entry point and final outcome. */
export const keeperActionsTotal = new client.Counter({
  name: 'keeper_actions_total',
  help: 'Total number of keeper maintenance actions attempted, by entry point and outcome',
  labelNames: ['entry_point', 'outcome'],
});

/** Total XLM fees spent (in stroops) by the keeper, labelled by entry point. */
export const keeperFeesSpentStroops = new client.Counter({
  name: 'keeper_fees_spent_stroops_total',
  help: 'Cumulative transaction fees paid by the keeper in stroops, by entry point',
  labelNames: ['entry_point'],
});

/** Number of times the daily fee budget was exhausted, halting the cycle. */
export const keeperBudgetExhaustedTotal = new client.Counter({
  name: 'keeper_budget_exhausted_total',
  help: 'Number of times the keeper halted because the daily fee budget was exhausted',
});

/** Gauge set to 1 when the daily fee budget is currently exhausted, 0 otherwise. */
export const keeperBudgetExhaustedGauge = new client.Gauge({
  name: 'keeper_budget_exhausted',
  help: '1 when the keeper daily fee budget is currently exhausted, 0 otherwise',
});

/** Number of simulation failures (RPC-level, not contract reverts), by entry point. */
export const keeperSimulationFailuresTotal = new client.Counter({
  name: 'keeper_simulation_failures_total',
  help: 'Number of simulateTransaction failures (RPC errors, not contract reverts)',
  labelNames: ['entry_point'],
});

/** Duration of each full keeper sweep cycle in seconds. */
export const keeperCycleDurationSeconds = new client.Histogram({
  name: 'keeper_cycle_duration_seconds',
  help: 'Duration of a complete keeper sweep cycle in seconds',
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120],
});

/** How many candidates were discovered in the last sweep, by type. */
export const keeperCandidatesDiscovered = new client.Gauge({
  name: 'keeper_candidates_discovered',
  help: 'Number of actionable candidates discovered in the most recent sweep, by target type',
  labelNames: ['target_type'],
});

/** Number of fee-bump escalations triggered, by entry point. */
export const keeperFeeBumpsTotal = new client.Counter({
  name: 'keeper_fee_bumps_total',
  help: 'Number of fee-bump resubmissions triggered due to timeout or fee errors',
  labelNames: ['entry_point'],
});

// ── Backfill / gap-repair metrics ─────────────────────────────────────────────

/** Number of Open LedgerGap rows currently in the DB (set each gap-repair cycle). */
export const openGapsGauge = new client.Gauge({
  name: 'indexer_open_ledger_gaps',
  help: 'Number of LedgerGap rows currently in Open status',
});

/** Total ledgers covered by open gaps (sum of toLedger - fromLedger + 1). */
export const openGapLedgersTotalGauge = new client.Gauge({
  name: 'indexer_open_ledger_gap_ledgers_total',
  help: 'Total number of ledgers covered by all Open LedgerGap rows',
});

/** Total gap rows created, labelled by source. */
export const gapsCreatedTotal = new client.Counter({
  name: 'indexer_ledger_gaps_created_total',
  help: 'Total LedgerGap rows created, by source (rpc_window_skip | reorg | manual)',
  labelNames: ['source'],
});

/** Total BackfillJob outcomes, labelled by terminal status. */
export const backfillJobsTotal = new client.Counter({
  name: 'indexer_backfill_jobs_total',
  help: 'Total BackfillJob completions, by final status (Completed | Failed | Cancelled)',
  labelNames: ['status'],
});

/** Duration of a complete BackfillJob run in seconds. */
export const backfillDurationSeconds = new client.Histogram({
  name: 'indexer_backfill_duration_seconds',
  help: 'Wall-clock duration of a BackfillJob from Running to terminal state',
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
});

/** Ledgers processed per backfill batch (useful for sizing BACKFILL_BATCH_SIZE). */
export const backfillBatchLedgers = new client.Histogram({
  name: 'indexer_backfill_batch_ledgers',
  help: 'Number of ledgers processed in each backfill batch',
  buckets: [100, 500, 1000, 2500, 5000, 10000],
});

/** Events inserted per backfill batch. */
export const backfillBatchInserted = new client.Histogram({
  name: 'indexer_backfill_batch_inserted_events',
  help: 'Number of events inserted in each backfill batch',
  buckets: [0, 1, 10, 50, 100, 500, 1000, 5000],
});

/** Number of concurrent advisory-lock contentions (two workers raced for same job). */
export const backfillLockContentions = new client.Counter({
  name: 'indexer_backfill_lock_contentions_total',
  help: 'Number of times a BackfillJob advisory lock was already held by another worker',
});

// ── Correctness & reconciliation metrics ─────────────────────────────────────

/**
 * Total reconciliation mismatches found (field-level discrepancies between
 * DB and on-chain state). Labelled by kind (listing | auction) and field.
 */
export const reconciliationMismatchesTotal = new client.Counter({
  name: 'elcarehub_reconciliation_mismatches_total',
  help: 'Total field-level discrepancies found during reconciliation, by resource kind and field',
  labelNames: ['kind', 'field'],
});

/**
 * Gauge: number of listings with ESCROW status that have remained unresolved
 * beyond a configurable threshold (set externally on each reconciler run).
 */
export const unresolvedEscrowGauge = new client.Gauge({
  name: 'elcarehub_unresolved_escrow_listings',
  help: 'Number of listings currently in Escrow status (payment held, NFT not yet transferred)',
});

/**
 * Total dead-letter events — events that could not be applied after all retries.
 * Labelled by event_type so operators can identify the failing event class.
 */
export const deadLetterEventsTotal = new client.Counter({
  name: 'elcarehub_dead_letter_events_total',
  help: 'Total events that exhausted all retry attempts and were moved to dead-letter state, by event type',
  labelNames: ['event_type'],
});

/**
 * Gauge: age (in seconds) of the oldest unprocessed dead-letter event.
 * Useful for alerting when dead letters are accumulating without resolution.
 */
export const deadLetterAgeSecondsGauge = new client.Gauge({
  name: 'elcarehub_dead_letter_age_seconds',
  help: 'Age in seconds of the oldest unprocessed dead-letter event (0 when queue is empty)',
});

/**
 * Total re-org rollback events, labelled by depth bucket.
 * Depth label is coarsened to <10, 10-50, 50-100, >100 to keep cardinality low.
 */
export const reorgRollbacksTotal = new client.Counter({
  name: 'elcarehub_reorg_rollbacks_total',
  help: 'Total chain re-org rollback events detected by the indexer, by approximate depth bucket',
  labelNames: ['depth_bucket'],
});

/**
 * Gauge: current chain re-org depth during an active rollback (0 when none).
 */
export const reorgDepthGauge = new client.Gauge({
  name: 'elcarehub_reorg_depth_current',
  help: 'Current chain re-org rollback depth (ledgers rewound). 0 when no active reorg.',
});

// ── Ingestion lag metrics ─────────────────────────────────────────────────────

/**
 * Histogram: wall-clock seconds between a ledger being finalised on-chain and
 * the indexer applying its events to the database. Measures ingestion lag.
 */
export const ingestionLagSeconds = new client.Histogram({
  name: 'elcarehub_ingestion_lag_seconds',
  help: 'Wall-clock lag between ledger close time and event application to the database',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

/**
 * Histogram: seconds between a ledger being finalised on-chain and the indexer
 * emitting the corresponding SSE event — the end-to-end "finalized lag".
 */
export const finalizedLagSeconds = new client.Histogram({
  name: 'elcarehub_finalized_lag_seconds',
  help: 'End-to-end lag from ledger close time to SSE event emission',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

/**
 * Total event replays triggered (e.g. by re-org recovery or manual backfill).
 * Labelled by reason so operators can distinguish the source.
 */
export const eventReplaysTotal = new client.Counter({
  name: 'elcarehub_event_replays_total',
  help: 'Total event replay operations triggered, by reason (reorg | backfill | manual)',
  labelNames: ['reason'],
});

// ── Cache behaviour metrics ───────────────────────────────────────────────────

/**
 * Total Redis cache hits. Labelled by cache_key_prefix to identify hot paths
 * without exposing full dynamic keys.
 */
export const cacheHitsTotal = new client.Counter({
  name: 'elcarehub_cache_hits_total',
  help: 'Total Redis cache hits, by cache key prefix',
  labelNames: ['key_prefix'],
});

/**
 * Total Redis cache misses.
 */
export const cacheMissesTotal = new client.Counter({
  name: 'elcarehub_cache_misses_total',
  help: 'Total Redis cache misses, by cache key prefix',
  labelNames: ['key_prefix'],
});

/**
 * Total Redis cache invalidations (pattern or key).
 */
export const cacheInvalidationsTotal = new client.Counter({
  name: 'elcarehub_cache_invalidations_total',
  help: 'Total cache invalidation operations, by scope (key | pattern)',
  labelNames: ['scope'],
});

// ── Endpoint error class metrics ──────────────────────────────────────────────

/**
 * Total API errors categorised into low-cardinality classes.
 * Classes: rpc_error, parser_error, db_error, validation_error, not_found,
 *          rate_limited, unknown.
 */
export const apiErrorsTotal = new client.Counter({
  name: 'elcarehub_api_errors_total',
  help: 'Total API errors by low-cardinality error class and HTTP method',
  labelNames: ['error_class', 'method'],
});

// ── Expose metrics handler ────────────────────────────────────────────────────

export async function handleMetrics(req: express.Request, res: express.Response) {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    logger.error('Failed to retrieve metrics', { err });
    res.status(500).end('Failed to retrieve metrics');
  }
}
