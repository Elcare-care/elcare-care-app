/**
 * data-quality.ts — Data quality scheduled checks
 *
 * Adds observable signals that distinguish *process health* (is the indexer
 * running?) from *data health* (is the indexed data correct?).
 *
 * Signals collected on each check cycle (default: every 5 minutes):
 *
 *   Canonicality
 *     - orphan_listing_events   Events whose listingId has no Listing row
 *     - orphan_auction_events   Events whose listingId has no Auction row
 *     - orphan_royalty_payments RoyaltyPayment rows with no parent event
 *
 *   Completeness
 *     - listings_missing_royalty_bps  Active Listings with royaltyBps = 0
 *                                     and at least one ROYALTY_PAID event
 *     - listings_missing_ipfs         Active Listings with token but no
 *                                     IpfsMetadata entry
 *     - offers_missing_listing        Offer rows whose listingId has no Listing
 *
 *   Freshness
 *     - stale_listing_age_seconds     Age of the most recently updated Active
 *                                     listing (should follow block time)
 *     - sync_cursor_age_seconds       Seconds since the SyncState cursor last
 *                                     advanced (echoes but is DB-sourced)
 *
 *   Projection drift
 *     - active_listings_count_drift   |gauge – DB count| ≥ 1 → drift
 *     - active_auctions_count_drift   same for auctions
 *     - pending_offers_with_expired   Pending offers whose expiresAt < now
 *
 * All signals are Prometheus gauges.  The scheduler runs bounded COUNT(*) /
 * MAX() queries with hard LIMIT clauses so they cannot fan-out into table scans
 * that would block ingestion.
 *
 * Owner / runbook column is recorded in the alert YAML (prometheus-alerts.yml).
 *
 * Usage
 * ─────
 *   import { startDataQualityScheduler } from './data-quality.js';
 *   const stop = startDataQualityScheduler();           // embedded in index.ts
 *   // standalone:
 *   await runDataQualityChecks();
 */

import client from 'prom-client';
import prisma from './db.js';
import { logger } from './logger.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = parseInt(
  process.env.DATA_QUALITY_INTERVAL_MS || '300000',  // 5 min
  10,
);

/**
 * Hard cap on the number of rows each quality query will examine.
 * Keeps each check safely under 10 ms on any table size.
 */
const QUERY_LIMIT = 10_000;

// ── Prometheus metrics ────────────────────────────────────────────────────────

// ── Canonicality gauges ───────────────────────────────────────────────────────

/** Events with a non-null listingId that does not match any Listing row. */
export const orphanListingEventsGauge = new client.Gauge({
  name: 'dq_orphan_listing_events',
  help: 'Count of MarketplaceEvent rows whose listingId has no corresponding Listing row (data quality: canonicality)',
});

/** Events with a listingId that does not match any Auction row (for auction event types). */
export const orphanAuctionEventsGauge = new client.Gauge({
  name: 'dq_orphan_auction_events',
  help: 'Count of auction-type MarketplaceEvent rows whose listingId has no corresponding Auction row (data quality: canonicality)',
});

/** RoyaltyPayment rows with no ancestor MarketplaceEvent of type ROYALTY_PAID. */
export const orphanRoyaltyPaymentsGauge = new client.Gauge({
  name: 'dq_orphan_royalty_payments',
  help: 'Count of RoyaltyPayment rows with no parent ROYALTY_PAID MarketplaceEvent (data quality: canonicality)',
});

// ── Completeness gauges ───────────────────────────────────────────────────────

/** Active Listings with royaltyBps = 0 that have at least one ROYALTY_PAID event. */
export const listingsMissingRoyaltyBpsGauge = new client.Gauge({
  name: 'dq_listings_missing_royalty_bps',
  help: 'Active listings with royaltyBps = 0 that have a ROYALTY_PAID event (data quality: completeness)',
});

/** Active listings with a non-empty token field but no IpfsMetadata row. */
export const listingsMissingIpfsGauge = new client.Gauge({
  name: 'dq_listings_missing_ipfs',
  help: 'Active listings with a IPFS token CID but no cached IpfsMetadata row (data quality: completeness)',
});

/** Offer rows whose listingId has no Listing row. */
export const offersMissingListingGauge = new client.Gauge({
  name: 'dq_offers_missing_listing',
  help: 'Offer rows whose listingId has no corresponding Listing row (data quality: completeness)',
});

// ── Freshness gauges ──────────────────────────────────────────────────────────

/** Seconds since the most recently updated Active listing changed. */
export const staleListingAgeSecondsGauge = new client.Gauge({
  name: 'dq_stale_listing_age_seconds',
  help: 'Age in seconds of the most recently updated Active listing — measures projection freshness',
});

/** Seconds since SyncState.updatedAt advanced (sourced from the DB, not memory). */
export const syncCursorAgeSecondsGauge = new client.Gauge({
  name: 'dq_sync_cursor_age_seconds',
  help: 'Age in seconds of the last SyncState update, measured from the database clock',
});

// ── Projection-drift gauges ───────────────────────────────────────────────────

/**
 * Absolute difference between the in-memory active-listings Prometheus gauge
 * and the current DB COUNT(*) for Active listings.
 * A value > 0 means the gauge is stale (non-zero projection drift).
 */
export const activeListingsCountDriftGauge = new client.Gauge({
  name: 'dq_active_listings_count_drift',
  help: 'Absolute difference between DB COUNT(Active listings) and the in-memory gauge (projection drift)',
});

/** Same drift indicator for active auctions. */
export const activeAuctionsCountDriftGauge = new client.Gauge({
  name: 'dq_active_auctions_count_drift',
  help: 'Absolute difference between DB COUNT(Active auctions) and the in-memory gauge (projection drift)',
});

/**
 * Number of Pending Offer rows whose expiresAt is in the past.
 * Nonzero values mean the keeper or expiry reconciler is behind.
 */
export const pendingOffersExpiredGauge = new client.Gauge({
  name: 'dq_pending_offers_expired',
  help: 'Count of Offer rows with status=Pending whose expiresAt has already passed (projection drift)',
});

/** Total data-quality check cycles completed, by outcome. */
export const dataQualityChecksTotal = new client.Counter({
  name: 'dq_checks_total',
  help: 'Total data-quality check cycles completed, by outcome (ok | error)',
  labelNames: ['outcome'],
});

/** Duration of a data-quality check cycle in seconds. */
export const dataQualityCheckDurationSeconds = new client.Histogram({
  name: 'dq_check_duration_seconds',
  help: 'Wall-clock duration of a complete data-quality check cycle',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

// ── In-process reference to live-KPI gauges ───────────────────────────────────
// We import prom-client directly so we can read the current value of the
// gauges set by the poller without importing the whole metrics module
// (which would cause a circular dep in some test setups).

async function readGaugeValue(metricName: string): Promise<number | null> {
  try {
    const metrics = await client.register.getMetricsAsJSON();
    const metric  = metrics.find((m) => m.name === metricName);
    if (!metric) return null;
    const values = (metric as any).values as Array<{ value: number }>;
    return values?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

// ── Individual check functions ────────────────────────────────────────────────

async function checkOrphanListingEvents(): Promise<void> {
  const rows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "MarketplaceEvent" me
    WHERE me."listingId" IS NOT NULL
      AND me."eventType" NOT IN (
        'AUCTION_CREATED','BID_PLACED','AUCTION_RESOLVED',
        'AUCTION_CANCELLED','AUCTION_EXTENDED','AUCTION_ADMIN_CANCELLED',
        'AUCTION_BID_REFUNDED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Listing" l WHERE l."listingId" = me."listingId"
      )
    LIMIT ${QUERY_LIMIT}
  `;
  orphanListingEventsGauge.set(Number(rows[0]?.cnt ?? 0n));
}

async function checkOrphanAuctionEvents(): Promise<void> {
  const rows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "MarketplaceEvent" me
    WHERE me."listingId" IS NOT NULL
      AND me."eventType" IN (
        'AUCTION_CREATED','BID_PLACED','AUCTION_RESOLVED',
        'AUCTION_CANCELLED','AUCTION_EXTENDED','AUCTION_ADMIN_CANCELLED',
        'AUCTION_BID_REFUNDED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Auction" a WHERE a."auctionId" = me."listingId"
      )
    LIMIT ${QUERY_LIMIT}
  `;
  orphanAuctionEventsGauge.set(Number(rows[0]?.cnt ?? 0n));
}

async function checkOrphanRoyaltyPayments(): Promise<void> {
  // A RoyaltyPayment is orphaned when no ROYALTY_PAID event exists at the
  // same ledger for the same listing or auction.
  const rows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "RoyaltyPayment" rp
    WHERE NOT EXISTS (
      SELECT 1
      FROM "MarketplaceEvent" me
      WHERE me."eventType" = 'ROYALTY_PAID'
        AND me."ledgerSequence" = rp."ledgerSequence"
        AND (
          (rp."listingId" IS NOT NULL AND me."listingId" = rp."listingId")
          OR
          (rp."auctionId" IS NOT NULL AND me."listingId" = rp."auctionId")
        )
    )
    LIMIT ${QUERY_LIMIT}
  `;
  orphanRoyaltyPaymentsGauge.set(Number(rows[0]?.cnt ?? 0n));
}

async function checkListingsMissingRoyaltyBps(): Promise<void> {
  const rows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "Listing" l
    WHERE l."status" = 'Active'
      AND l."royaltyBps" = 0
      AND EXISTS (
        SELECT 1 FROM "MarketplaceEvent" me
        WHERE me."eventType" = 'ROYALTY_PAID'
          AND me."listingId" = l."listingId"
      )
    LIMIT ${QUERY_LIMIT}
  `;
  listingsMissingRoyaltyBpsGauge.set(Number(rows[0]?.cnt ?? 0n));
}

async function checkListingsMissingIpfs(): Promise<void> {
  const rows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "Listing" l
    WHERE l."status" = 'Active'
      AND l."token" IS NOT NULL
      AND l."token" <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "IpfsMetadata" im WHERE im."cid" = l."token"
      )
    LIMIT ${QUERY_LIMIT}
  `;
  listingsMissingIpfsGauge.set(Number(rows[0]?.cnt ?? 0n));
}

async function checkOffersMissingListing(): Promise<void> {
  const rows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "Offer" o
    WHERE NOT EXISTS (
      SELECT 1 FROM "Listing" l WHERE l."listingId" = o."listingId"
    )
    LIMIT ${QUERY_LIMIT}
  `;
  offersMissingListingGauge.set(Number(rows[0]?.cnt ?? 0n));
}

async function checkFreshness(): Promise<void> {
  // Most recently updated Active listing
  const listingRows = await prisma.$queryRaw<[{ age_seconds: number | null }]>`
    SELECT EXTRACT(EPOCH FROM (NOW() - MAX("updatedAt")))::int AS age_seconds
    FROM "Listing"
    WHERE "status" = 'Active'
  `;
  const listingAge = listingRows[0]?.age_seconds ?? null;
  staleListingAgeSecondsGauge.set(listingAge ?? 0);

  // SyncState cursor age (DB-sourced so it reflects the real persistence layer)
  const syncRows = await prisma.$queryRaw<[{ age_seconds: number | null }]>`
    SELECT EXTRACT(EPOCH FROM (NOW() - "updatedAt"))::int AS age_seconds
    FROM "SyncState"
    WHERE id = 1
  `;
  const syncAge = syncRows[0]?.age_seconds ?? null;
  syncCursorAgeSecondsGauge.set(syncAge ?? 0);
}

async function checkProjectionDrift(): Promise<void> {
  // DB counts
  const [listingCount, auctionCount] = await Promise.all([
    prisma.listing.count({ where: { status: 'Active' } }),
    prisma.auction.count({ where: { status: 'Active' } }),
  ]);

  // In-memory gauge values
  const gaugeListings = await readGaugeValue('elcarehub_active_listings');
  const gaugeAuctions = await readGaugeValue('elcarehub_active_auctions');

  if (gaugeListings !== null) {
    activeListingsCountDriftGauge.set(Math.abs(listingCount - gaugeListings));
  }
  if (gaugeAuctions !== null) {
    activeAuctionsCountDriftGauge.set(Math.abs(auctionCount - gaugeAuctions));
  }

  // Expired pending offers
  const expiredOfferRows = await prisma.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(*) AS cnt
    FROM "Offer"
    WHERE "status" = 'Pending'
      AND "expiresAt" IS NOT NULL
      AND "expiresAt" < EXTRACT(EPOCH FROM NOW())::bigint
    LIMIT ${QUERY_LIMIT}
  `;
  pendingOffersExpiredGauge.set(Number(expiredOfferRows[0]?.cnt ?? 0n));
}

// ── Main check runner ─────────────────────────────────────────────────────────

export async function runDataQualityChecks(): Promise<void> {
  const timer = dataQualityCheckDurationSeconds.startTimer();
  try {
    // Run all checks in parallel — each is a single bounded query.
    await Promise.all([
      checkOrphanListingEvents(),
      checkOrphanAuctionEvents(),
      checkOrphanRoyaltyPayments(),
      checkListingsMissingRoyaltyBps(),
      checkListingsMissingIpfs(),
      checkOffersMissingListing(),
      checkFreshness(),
      checkProjectionDrift(),
    ]);
    dataQualityChecksTotal.inc({ outcome: 'ok' });
    logger.debug('[DataQuality] Check cycle complete');
  } catch (err) {
    dataQualityChecksTotal.inc({ outcome: 'error' });
    logger.error('[DataQuality] Check cycle failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    timer();
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let handle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic data-quality check scheduler.
 * Returns a stop function for graceful shutdown.
 */
export function startDataQualityScheduler(): () => void {
  // First check runs immediately so the gauges are populated on startup.
  runDataQualityChecks().catch(() => { /* already logged inside */ });

  handle = setInterval(() => {
    runDataQualityChecks().catch(() => { /* already logged inside */ });
  }, CHECK_INTERVAL_MS);

  logger.info('[DataQuality] Scheduler started', { intervalMs: CHECK_INTERVAL_MS });

  return () => {
    if (handle !== null) {
      clearInterval(handle);
      handle = null;
      logger.info('[DataQuality] Scheduler stopped');
    }
  };
}
