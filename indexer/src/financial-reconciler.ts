/**
 * financial-reconciler.ts
 *
 * Financial reconciliation system for protocol fees, royalties, sales, and refunds.
 * Provides per-ledger, per-token, per-collection, and protocol-level aggregation
 * with tolerance policies for provisional events and chain timing.
 */

import prisma from './db.js';
import prismaWrite from './prisma-write.js';
import { logger } from './logger.js';
import {
  financialReconcileRunsTotal,
  financialDriftsDetectedTotal,
  financialAlertsRaisedTotal,
  financialDriftsOpenGauge,
  financialProtocolAggregateGauge,
  financialTokenAggregateGauge,
  financialCollectionAggregateGauge,
  financialLedgerAggregateGauge,
  financialReconcileDurationSeconds,
  financialDriftOldestAgeSeconds,
} from './metrics.js';

// ── Configuration ───────────────────────────────────────────────────────────────

const CONFIRMATION_DEPTH = parseInt(process.env.FINANCIAL_RECONCILE_CONFIRMATION_DEPTH || '32');
const DEFAULT_TOLERANCE_BPS = parseInt(process.env.FINANCIAL_RECONCILE_TOLERANCE_BPS || '100'); // 1%
const PROVISIONAL_TOLERANCE_BPS = parseInt(process.env.FINANCIAL_RECONCILE_PROVISIONAL_TOLERANCE_BPS || '500'); // 5%
const ALERT_THRESHOLD_BPS = parseInt(process.env.FINANCIAL_RECONCILE_ALERT_THRESHOLD_BPS || '200'); // 2%

// ── Public Types ───────────────────────────────────────────────────────────────

export interface FinancialReconcileResult {
  runId: number;
  ledgerFrom: number;
  ledgerTo: number;
  driftsDetected: number;
  alertsRaised: number;
  dryRun: boolean;
  aggregates: FinancialAggregates;
}

export interface FinancialAggregates {
  protocol: AggregateTotals;
  perLedger: Map<number, AggregateTotals>;
  perToken: Map<string, AggregateTotals>;
  perCollection: Map<string, AggregateTotals>;
}

export interface AggregateTotals {
  protocolFeesTotal: bigint;
  royaltiesTotal: bigint;
  salesTotal: bigint;
  refundsTotal: bigint;
  protocolFeeCount: number;
  royaltyCount: number;
  saleCount: number;
  refundCount: number;
}

export interface DriftRecord {
  entityType: 'protocol_fee' | 'royalty' | 'sale' | 'refund';
  entityId: string;
  ledgerSequence: number;
  token?: string;
  collection?: string;
  expectedAmount: bigint;
  actualAmount: bigint;
  driftAmount: bigint;
  driftBps: number;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  reason: string;
  isProvisional: boolean;
}

export interface TolerancePolicy {
  toleranceBps: number;
  includeProvisional: boolean;
  provisionalToleranceBps: number;
  confirmationDepth: number;
}

// ── Aggregate Query Functions ───────────────────────────────────────────────────

/**
 * Compute financial aggregates from confirmed events within a ledger range.
 */
async function computeAggregates(
  ledgerFrom: number,
  ledgerTo: number,
  confirmedOnly: boolean = true
): Promise<FinancialAggregates> {
  const confirmedFilter = confirmedOnly ? { confirmed: true } : {};
  
  // Protocol-wide aggregates
  const protocolAggregates = await prisma.$queryRaw<Array<{
    protocol_fees_total: bigint;
    royalties_total: bigint;
    sales_total: bigint;
    refunds_total: bigint;
    protocol_fee_count: bigint;
    royalty_count: bigint;
    sale_count: bigint;
    refund_count: bigint;
  }>>`
    SELECT
      COALESCE(SUM(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as protocol_fees_total,
      COALESCE(SUM(CASE WHEN event_type = 'ROYALTY_PAID' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as royalties_total,
      COALESCE(SUM(CASE WHEN event_type = 'ARTWORK_SOLD' 
        THEN (data->>'price')::numeric ELSE 0 END), 0) as sales_total,
      COALESCE(SUM(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as refunds_total,
      COALESCE(COUNT(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' THEN 1 END), 0) as protocol_fee_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ROYALTY_PAID' THEN 1 END), 0) as royalty_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ARTWORK_SOLD' THEN 1 END), 0) as sale_count,
      COALESCE(COUNT(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' THEN 1 END), 0) as refund_count
    FROM "MarketplaceEvent"
    WHERE ledger_sequence >= ${ledgerFrom}
      AND ledger_sequence <= ${ledgerTo}
      AND ${confirmedOnly ? prisma.$queryRaw`confirmed = true` : prisma.$queryRaw`1=1`}
  `;

  const protocol: AggregateTotals = {
    protocolFeesTotal: protocolAggregates[0]?.protocol_fees_total || 0n,
    royaltiesTotal: protocolAggregates[0]?.royalties_total || 0n,
    salesTotal: protocolAggregates[0]?.sales_total || 0n,
    refundsTotal: protocolAggregates[0]?.refunds_total || 0n,
    protocolFeeCount: Number(protocolAggregates[0]?.protocol_fee_count || 0n),
    royaltyCount: Number(protocolAggregates[0]?.royalty_count || 0n),
    saleCount: Number(protocolAggregates[0]?.sale_count || 0n),
    refundCount: Number(protocolAggregates[0]?.refund_count || 0n),
  };

  // Per-ledger aggregates
  const perLedgerRaw = await prisma.$queryRaw<Array<{
    ledger_sequence: number;
    protocol_fees_total: bigint;
    royalties_total: bigint;
    sales_total: bigint;
    refunds_total: bigint;
    protocol_fee_count: bigint;
    royalty_count: bigint;
    sale_count: bigint;
    refund_count: bigint;
  }>>`
    SELECT
      ledger_sequence,
      COALESCE(SUM(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as protocol_fees_total,
      COALESCE(SUM(CASE WHEN event_type = 'ROYALTY_PAID' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as royalties_total,
      COALESCE(SUM(CASE WHEN event_type = 'ARTWORK_SOLD' 
        THEN (data->>'price')::numeric ELSE 0 END), 0) as sales_total,
      COALESCE(SUM(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as refunds_total,
      COALESCE(COUNT(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' THEN 1 END), 0) as protocol_fee_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ROYALTY_PAID' THEN 1 END), 0) as royalty_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ARTWORK_SOLD' THEN 1 END), 0) as sale_count,
      COALESCE(COUNT(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' THEN 1 END), 0) as refund_count
    FROM "MarketplaceEvent"
    WHERE ledger_sequence >= ${ledgerFrom}
      AND ledger_sequence <= ${ledgerTo}
      AND ${confirmedOnly ? prisma.$queryRaw`confirmed = true` : prisma.$queryRaw`1=1`}
    GROUP BY ledger_sequence
    ORDER BY ledger_sequence
  `;

  const perLedger = new Map<number, AggregateTotals>();
  for (const row of perLedgerRaw) {
    perLedger.set(row.ledger_sequence, {
      protocolFeesTotal: row.protocol_fees_total,
      royaltiesTotal: row.royalties_total,
      salesTotal: row.sales_total,
      refundsTotal: row.refunds_total,
      protocolFeeCount: Number(row.protocol_fee_count),
      royaltyCount: Number(row.royalty_count),
      saleCount: Number(row.sale_count),
      refundCount: Number(row.refund_count),
    });
  }

  // Per-token aggregates
  const perTokenRaw = await prisma.$queryRaw<Array<{
    token: string;
    protocol_fees_total: bigint;
    royalties_total: bigint;
    sales_total: bigint;
    refunds_total: bigint;
    protocol_fee_count: bigint;
    royalty_count: bigint;
    sale_count: bigint;
    refund_count: bigint;
  }>>`
    SELECT
      COALESCE(data->>'token', data->>'currency', 'UNKNOWN') as token,
      COALESCE(SUM(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as protocol_fees_total,
      COALESCE(SUM(CASE WHEN event_type = 'ROYALTY_PAID' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as royalties_total,
      COALESCE(SUM(CASE WHEN event_type = 'ARTWORK_SOLD' 
        THEN (data->>'price')::numeric ELSE 0 END), 0) as sales_total,
      COALESCE(SUM(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as refunds_total,
      COALESCE(COUNT(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' THEN 1 END), 0) as protocol_fee_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ROYALTY_PAID' THEN 1 END), 0) as royalty_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ARTWORK_SOLD' THEN 1 END), 0) as sale_count,
      COALESCE(COUNT(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' THEN 1 END), 0) as refund_count
    FROM "MarketplaceEvent"
    WHERE ledger_sequence >= ${ledgerFrom}
      AND ledger_sequence <= ${ledgerTo}
      AND ${confirmedOnly ? prisma.$queryRaw`confirmed = true` : prisma.$queryRaw`1=1`}
    GROUP BY COALESCE(data->>'token', data->>'currency', 'UNKNOWN')
  `;

  const perToken = new Map<string, AggregateTotals>();
  for (const row of perTokenRaw) {
    perToken.set(row.token, {
      protocolFeesTotal: row.protocol_fees_total,
      royaltiesTotal: row.royalties_total,
      salesTotal: row.sales_total,
      refundsTotal: row.refunds_total,
      protocolFeeCount: Number(row.protocol_fee_count),
      royaltyCount: Number(row.royalty_count),
      saleCount: Number(row.sale_count),
      refundCount: Number(row.refund_count),
    });
  }

  // Per-collection aggregates
  const perCollectionRaw = await prisma.$queryRaw<Array<{
    collection: string;
    protocol_fees_total: bigint;
    royalties_total: bigint;
    sales_total: bigint;
    refunds_total: bigint;
    protocol_fee_count: bigint;
    royalty_count: bigint;
    sale_count: bigint;
    refund_count: bigint;
  }>>`
    SELECT
      COALESCE(data->>'collection', 'UNKNOWN') as collection,
      COALESCE(SUM(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as protocol_fees_total,
      COALESCE(SUM(CASE WHEN event_type = 'ROYALTY_PAID' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as royalties_total,
      COALESCE(SUM(CASE WHEN event_type = 'ARTWORK_SOLD' 
        THEN (data->>'price')::numeric ELSE 0 END), 0) as sales_total,
      COALESCE(SUM(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' 
        THEN (data->>'amount')::numeric ELSE 0 END), 0) as refunds_total,
      COALESCE(COUNT(CASE WHEN event_type = 'PROTOCOL_FEE_COLLECTED' THEN 1 END), 0) as protocol_fee_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ROYALTY_PAID' THEN 1 END), 0) as royalty_count,
      COALESCE(COUNT(CASE WHEN event_type = 'ARTWORK_SOLD' THEN 1 END), 0) as sale_count,
      COALESCE(COUNT(CASE WHEN event_type = 'AUCTION_BID_REFUNDED' THEN 1 END), 0) as refund_count
    FROM "MarketplaceEvent"
    WHERE ledger_sequence >= ${ledgerFrom}
      AND ledger_sequence <= ${ledgerTo}
      AND ${confirmedOnly ? prisma.$queryRaw`confirmed = true` : prisma.$queryRaw`1=1`}
    GROUP BY COALESCE(data->>'collection', 'UNKNOWN')
  `;

  const perCollection = new Map<string, AggregateTotals>();
  for (const row of perCollectionRaw) {
    perCollection.set(row.collection, {
      protocolFeesTotal: row.protocol_fees_total,
      royaltiesTotal: row.royalties_total,
      salesTotal: row.sales_total,
      refundsTotal: row.refunds_total,
      protocolFeeCount: Number(row.protocol_fee_count),
      royaltyCount: Number(row.royalty_count),
      saleCount: Number(row.sale_count),
      refundCount: Number(row.refund_count),
    });
  }

  return { protocol, perLedger, perToken, perCollection };
}

/**
 * Persist aggregate snapshots for later comparison.
 */
async function persistAggregateSnapshots(
  ledgerFrom: number,
  ledgerTo: number,
  aggregates: FinancialAggregates,
  confirmedOnly: boolean
): Promise<void> {
  // Protocol snapshot
  await (prismaWrite as any).financialAggregateSnapshot.upsert({
    where: {
      snapshotType_scopeKey_ledgerFrom_ledgerTo_confirmedOnly: {
        snapshotType: 'protocol',
        scopeKey: null,
        ledgerFrom,
        ledgerTo,
        confirmedOnly,
      },
    },
    create: {
      snapshotType: 'protocol',
      scopeKey: null,
      ledgerFrom,
      ledgerTo,
      protocolFeesTotal: aggregates.protocol.protocolFeesTotal.toString(),
      royaltiesTotal: aggregates.protocol.royaltiesTotal.toString(),
      salesTotal: aggregates.protocol.salesTotal.toString(),
      refundsTotal: aggregates.protocol.refundsTotal.toString(),
      protocolFeeCount: aggregates.protocol.protocolFeeCount,
      royaltyCount: aggregates.protocol.royaltyCount,
      saleCount: aggregates.protocol.saleCount,
      refundCount: aggregates.protocol.refundCount,
      confirmedOnly,
    },
    update: {
      protocolFeesTotal: aggregates.protocol.protocolFeesTotal.toString(),
      royaltiesTotal: aggregates.protocol.royaltiesTotal.toString(),
      salesTotal: aggregates.protocol.salesTotal.toString(),
      refundsTotal: aggregates.protocol.refundsTotal.toString(),
      protocolFeeCount: aggregates.protocol.protocolFeeCount,
      royaltyCount: aggregates.protocol.royaltyCount,
      saleCount: aggregates.protocol.saleCount,
      refundCount: aggregates.protocol.refundCount,
    },
  });

  // Per-ledger snapshots
  for (const [ledgerSeq, totals] of aggregates.perLedger) {
    await (prismaWrite as any).financialAggregateSnapshot.upsert({
      where: {
        snapshotType_scopeKey_ledgerFrom_ledgerTo_confirmedOnly: {
          snapshotType: 'per_ledger',
          scopeKey: ledgerSeq.toString(),
          ledgerFrom,
          ledgerTo,
          confirmedOnly,
        },
      },
      create: {
        snapshotType: 'per_ledger',
        scopeKey: ledgerSeq.toString(),
        ledgerFrom,
        ledgerTo,
        protocolFeesTotal: totals.protocolFeesTotal.toString(),
        royaltiesTotal: totals.royaltiesTotal.toString(),
        salesTotal: totals.salesTotal.toString(),
        refundsTotal: totals.refundsTotal.toString(),
        protocolFeeCount: totals.protocolFeeCount,
        royaltyCount: totals.royaltyCount,
        saleCount: totals.saleCount,
        refundCount: totals.refundCount,
        confirmedOnly,
      },
      update: {
        protocolFeesTotal: totals.protocolFeesTotal.toString(),
        royaltiesTotal: totals.royaltiesTotal.toString(),
        salesTotal: totals.salesTotal.toString(),
        refundsTotal: totals.refundsTotal.toString(),
        protocolFeeCount: totals.protocolFeeCount,
        royaltyCount: totals.royaltyCount,
        saleCount: totals.saleCount,
        refundCount: totals.refundCount,
      },
    });
  }

  // Per-token snapshots
  for (const [token, totals] of aggregates.perToken) {
    await (prismaWrite as any).financialAggregateSnapshot.upsert({
      where: {
        snapshotType_scopeKey_ledgerFrom_ledgerTo_confirmedOnly: {
          snapshotType: 'per_token',
          scopeKey: token,
          ledgerFrom,
          ledgerTo,
          confirmedOnly,
        },
      },
      create: {
        snapshotType: 'per_token',
        scopeKey: token,
        ledgerFrom,
        ledgerTo,
        protocolFeesTotal: totals.protocolFeesTotal.toString(),
        royaltiesTotal: totals.royaltiesTotal.toString(),
        salesTotal: totals.salesTotal.toString(),
        refundsTotal: totals.refundsTotal.toString(),
        protocolFeeCount: totals.protocolFeeCount,
        royaltyCount: totals.royaltyCount,
        saleCount: totals.saleCount,
        refundCount: totals.refundCount,
        confirmedOnly,
      },
      update: {
        protocolFeesTotal: totals.protocolFeesTotal.toString(),
        royaltiesTotal: totals.royaltiesTotal.toString(),
        salesTotal: totals.salesTotal.toString(),
        refundsTotal: totals.refundsTotal.toString(),
        protocolFeeCount: totals.protocolFeeCount,
        royaltyCount: totals.royaltyCount,
        saleCount: totals.saleCount,
        refundCount: totals.refundCount,
      },
    });
  }

  // Per-collection snapshots
  for (const [collection, totals] of aggregates.perCollection) {
    await (prismaWrite as any).financialAggregateSnapshot.upsert({
      where: {
        snapshotType_scopeKey_ledgerFrom_ledgerTo_confirmedOnly: {
          snapshotType: 'per_collection',
          scopeKey: collection,
          ledgerFrom,
          ledgerTo,
          confirmedOnly,
        },
      },
      create: {
        snapshotType: 'per_collection',
        scopeKey: collection,
        ledgerFrom,
        ledgerTo,
        protocolFeesTotal: totals.protocolFeesTotal.toString(),
        royaltiesTotal: totals.royaltiesTotal.toString(),
        salesTotal: totals.salesTotal.toString(),
        refundsTotal: totals.refundsTotal.toString(),
        protocolFeeCount: totals.protocolFeeCount,
        royaltyCount: totals.royaltyCount,
        saleCount: totals.saleCount,
        refundCount: totals.refundCount,
        confirmedOnly,
      },
      update: {
        protocolFeesTotal: totals.protocolFeesTotal.toString(),
        royaltiesTotal: totals.royaltiesTotal.toString(),
        salesTotal: totals.salesTotal.toString(),
        refundsTotal: totals.refundsTotal.toString(),
        protocolFeeCount: totals.protocolFeeCount,
        royaltyCount: totals.royaltyCount,
        saleCount: totals.saleCount,
        refundCount: totals.refundCount,
      },
    });
  }
}

// ── Drift Detection ─────────────────────────────────────────────────────────────

/**
 * Compare event-derived aggregates with indexed transfer totals.
 */
async function detectDrift(
  aggregates: FinancialAggregates,
  ledgerFrom: number,
  ledgerTo: number,
  policy: TolerancePolicy
): Promise<DriftRecord[]> {
  const drifts: DriftRecord[] = [];

  // Compare with RoyaltyPayment table (indexed transfer totals)
  const royaltyPayments = await prisma.royaltyPayment.findMany({
    where: {
      ledgerSequence: {
        gte: ledgerFrom,
        lte: ledgerTo,
      },
    },
  });

  // Build expected totals from RoyaltyPayment
  const expectedRoyaltiesByToken = new Map<string, bigint>();
  const expectedRoyaltiesByCollection = new Map<string, bigint>();

  for (const payment of royaltyPayments) {
    const token = payment.amount.toString(); // Simplified - should extract from context
    const collection = 'UNKNOWN'; // Would need to join with Listing/Auction
    
    expectedRoyaltiesByToken.set(
      token,
      (expectedRoyaltiesByToken.get(token) || 0n) + BigInt(payment.amount.toString())
    );
    expectedRoyaltiesByCollection.set(
      collection,
      (expectedRoyaltiesByCollection.get(collection) || 0n) + BigInt(payment.amount.toString())
    );
  }

  // Compare per-token royalties
  for (const [token, actual] of aggregates.perToken) {
    const expected = expectedRoyaltiesByToken.get(token) || 0n;
    const drift = actual.royaltiesTotal - expected;
    
    if (drift !== 0n) {
      const driftBps = expected > 0n ? Number((drift * 10000n) / expected) : 10000;
      const toleranceBps = policy.toleranceBps;
      
      if (Math.abs(driftBps) > toleranceBps) {
        drifts.push({
          entityType: 'royalty',
          entityId: `token:${token}`,
          ledgerSequence: ledgerTo, // Representative ledger
          token,
          collection: undefined,
          expectedAmount: expected,
          actualAmount: actual.royaltiesTotal,
          driftAmount: drift,
          driftBps,
          severity: getSeverity(driftBps, policy.toleranceBps),
          reason: drift > 0n ? 'excess_royalties' : 'missing_royalties',
          isProvisional: false,
        });
      }
    }
  }

  // Check for missing payouts (events without corresponding RoyaltyPayment)
  const royaltyEvents = await prisma.marketplaceEvent.findMany({
    where: {
      eventType: 'ROYALTY_PAID',
      ledgerSequence: {
        gte: ledgerFrom,
        lte: ledgerTo,
      },
      confirmed: true,
    },
  });

  for (const event of royaltyEvents) {
    const eventData = event.data as any;
    const amount = BigInt(eventData.amount || '0');
    const recipients = eventData.recipients || [];
    
    // Check if each recipient has a corresponding RoyaltyPayment
    for (const recipient of recipients) {
      const hasPayment = royaltyPayments.some(
        p => p.recipient === recipient.address && 
             p.amount.toString() === recipient.amount.toString()
      );
      
      if (!hasPayment) {
        drifts.push({
          entityType: 'royalty',
          entityId: event.eventHash || `event:${event.id}`,
          ledgerSequence: event.ledgerSequence,
          token: eventData.token,
          collection: eventData.collection,
          expectedAmount: recipient.amount,
          actualAmount: 0n,
          driftAmount: recipient.amount,
          driftBps: 10000, // 100% drift
          severity: 'Critical',
          reason: 'missing_payout',
          isProvisional: !event.confirmed,
        });
      }
    }
  }

  return drifts;
}

function getSeverity(driftBps: number, toleranceBps: number): 'Low' | 'Medium' | 'High' | 'Critical' {
  const multiple = driftBps / toleranceBps;
  if (multiple >= 10) return 'Critical';
  if (multiple >= 5) return 'High';
  if (multiple >= 2) return 'Medium';
  return 'Low';
}

// ── Main Reconciliation Function ───────────────────────────────────────────────

/**
 * Run financial reconciliation for a ledger range.
 */
export async function runFinancialReconciliation(
  ledgerFrom: number,
  ledgerTo: number,
  policy: Partial<TolerancePolicy> = {},
  dryRun: boolean = false
): Promise<FinancialReconcileResult> {
  const startTime = Date.now();
  const fullPolicy: TolerancePolicy = {
    toleranceBps: policy.toleranceBps ?? DEFAULT_TOLERANCE_BPS,
    includeProvisional: policy.includeProvisional ?? false,
    provisionalToleranceBps: policy.provisionalToleranceBps ?? PROVISIONAL_TOLERANCE_BPS,
    confirmationDepth: policy.confirmationDepth ?? CONFIRMATION_DEPTH,
  };

  logger.info('[FinancialReconciler] Starting reconciliation', {
    ledgerFrom,
    ledgerTo,
    toleranceBps: fullPolicy.toleranceBps,
    includeProvisional: fullPolicy.includeProvisional,
    dryRun,
  });

  // Create reconciliation run
  const run = await (prismaWrite as any).financialReconcileRun.create({
    data: {
      ledgerFrom,
      ledgerTo,
      confirmedDepth: fullPolicy.confirmationDepth,
      toleranceBps: fullPolicy.toleranceBps,
      includeProvisional: fullPolicy.includeProvisional,
      dryRun,
    },
  });

  const runId = run.id;

  try {
    // Compute aggregates from confirmed events
    const aggregates = await computeAggregates(
      ledgerFrom,
      ledgerTo,
      !fullPolicy.includeProvisional
    );

    // Persist snapshots
    if (!dryRun) {
      await persistAggregateSnapshots(
        ledgerFrom,
        ledgerTo,
        aggregates,
        !fullPolicy.includeProvisional
      );
    }

    // Update Prometheus metrics for aggregates
    financialProtocolAggregateGauge.set({ metric: 'protocol_fees' }, Number(aggregates.protocol.protocolFeesTotal));
    financialProtocolAggregateGauge.set({ metric: 'royalties' }, Number(aggregates.protocol.royaltiesTotal));
    financialProtocolAggregateGauge.set({ metric: 'sales' }, Number(aggregates.protocol.salesTotal));
    financialProtocolAggregateGauge.set({ metric: 'refunds' }, Number(aggregates.protocol.refundsTotal));

    for (const [token, totals] of aggregates.perToken) {
      financialTokenAggregateGauge.set({ token, metric: 'protocol_fees' }, Number(totals.protocolFeesTotal));
      financialTokenAggregateGauge.set({ token, metric: 'royalties' }, Number(totals.royaltiesTotal));
      financialTokenAggregateGauge.set({ token, metric: 'sales' }, Number(totals.salesTotal));
      financialTokenAggregateGauge.set({ token, metric: 'refunds' }, Number(totals.refundsTotal));
    }

    for (const [collection, totals] of aggregates.perCollection) {
      financialCollectionAggregateGauge.set({ collection, metric: 'protocol_fees' }, Number(totals.protocolFeesTotal));
      financialCollectionAggregateGauge.set({ collection, metric: 'royalties' }, Number(totals.royaltiesTotal));
      financialCollectionAggregateGauge.set({ collection, metric: 'sales' }, Number(totals.salesTotal));
      financialCollectionAggregateGauge.set({ collection, metric: 'refunds' }, Number(totals.refundsTotal));
    }

    for (const [ledgerSeq, totals] of aggregates.perLedger) {
      financialLedgerAggregateGauge.set({ ledger_sequence: ledgerSeq.toString(), metric: 'protocol_fees' }, Number(totals.protocolFeesTotal));
      financialLedgerAggregateGauge.set({ ledger_sequence: ledgerSeq.toString(), metric: 'royalties' }, Number(totals.royaltiesTotal));
      financialLedgerAggregateGauge.set({ ledger_sequence: ledgerSeq.toString(), metric: 'sales' }, Number(totals.salesTotal));
      financialLedgerAggregateGauge.set({ ledger_sequence: ledgerSeq.toString(), metric: 'refunds' }, Number(totals.refundsTotal));
    }

    // Detect drift
    const driftRecords = await detectDrift(aggregates, ledgerFrom, ledgerTo, fullPolicy);

    // Classify and persist drifts
    let alertsRaised = 0;
    for (const drift of driftRecords) {
      // Apply provisional tolerance if applicable
      const effectiveTolerance = drift.isProvisional 
        ? fullPolicy.provisionalToleranceBps 
        : fullPolicy.toleranceBps;
      
      const shouldAlert = Math.abs(drift.driftBps) > ALERT_THRESHOLD_BPS && !drift.isProvisional;
      
      if (shouldAlert) {
        alertsRaised++;
        logger.warn('[FinancialReconciler] Drift alert', drift as any);
        financialAlertsRaisedTotal.inc({ entity_type: drift.entityType });
      }

      financialDriftsDetectedTotal.inc({ entity_type: drift.entityType, severity: drift.severity });

      if (!dryRun) {
        await (prismaWrite as any).financialDrift.create({
          data: {
            runId,
            entityType: drift.entityType,
            entityId: drift.entityId,
            ledgerSequence: drift.ledgerSequence,
            token: drift.token,
            collection: drift.collection,
            expectedAmount: drift.expectedAmount.toString(),
            actualAmount: drift.actualAmount.toString(),
            driftAmount: drift.driftAmount.toString(),
            driftBps: drift.driftBps,
            severity: drift.severity,
            status: shouldAlert ? 'AlertRaised' : 'DriftDetected',
            reason: drift.reason,
            isProvisional: drift.isProvisional,
            confirmationDepth: drift.isProvisional ? fullPolicy.confirmationDepth : null,
          },
        });
      }
    }

    // Update open drifts gauge
    const openDrifts = await prisma.financialDrift.groupBy({
      by: ['severity'],
      where: {
        status: { in: ['DriftDetected', 'AlertRaised'] },
        resolvedAt: null,
      },
      _count: true,
    });
    
    for (const group of openDrifts) {
      financialDriftsOpenGauge.set({ severity: group.severity }, group._count);
    }

    // Update oldest drift age
    const oldestDrift = await prisma.financialDrift.findFirst({
      where: {
        status: { in: ['DriftDetected', 'AlertRaised'] },
        resolvedAt: null,
      },
      orderBy: { detectedAt: 'asc' },
    });
    
    if (oldestDrift) {
      const ageSeconds = Math.floor((Date.now() - oldestDrift.detectedAt.getTime()) / 1000);
      financialDriftOldestAgeSeconds.set(ageSeconds);
    } else {
      financialDriftOldestAgeSeconds.set(0);
    }

    // Update run
    if (!dryRun) {
      await (prismaWrite as any).financialReconcileRun.update({
        where: { id: runId },
        data: {
          completedAt: new Date(),
          driftsDetected: driftRecords.length,
          alertsRaised,
        },
      });
    }

    const duration = (Date.now() - startTime) / 1000;
    financialReconcileDurationSeconds.observe(duration);
    financialReconcileRunsTotal.inc({ outcome: 'ok', dry_run: String(dryRun) });

    logger.info('[FinancialReconciler] Reconciliation complete', {
      runId,
      driftsDetected: driftRecords.length,
      alertsRaised,
      dryRun,
    });

    return {
      runId,
      ledgerFrom,
      ledgerTo,
      driftsDetected: driftRecords.length,
      alertsRaised,
      dryRun,
      aggregates,
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    financialReconcileDurationSeconds.observe(duration);
    financialReconcileRunsTotal.inc({ outcome: 'error', dry_run: String(dryRun) });

    logger.error('[FinancialReconciler] Reconciliation failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (!dryRun) {
      await (prismaWrite as any).financialReconcileRun.update({
        where: { id: runId },
        data: {
          completedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    }

    throw error;
  }
}

// ── Status Query ───────────────────────────────────────────────────────────────

export async function getFinancialReconciliationStatus() {
  const lastRun = await prisma.financialReconcileRun.findFirst({
    orderBy: { startedAt: 'desc' },
    include: {
      drifts: {
        orderBy: { detectedAt: 'desc' },
        take: 20,
      },
    },
  });

  const openDrifts = await prisma.financialDrift.count({
    where: {
      status: { in: ['DriftDetected', 'AlertRaised'] },
      resolvedAt: null,
    },
  });

  const criticalDrifts = await prisma.financialDrift.count({
    where: {
      severity: 'Critical',
      status: { in: ['DriftDetected', 'AlertRaised'] },
      resolvedAt: null,
    },
  });

  return {
    lastRun: lastRun ? {
      id: lastRun.id,
      startedAt: lastRun.startedAt,
      completedAt: lastRun.completedAt,
      ledgerFrom: lastRun.ledgerFrom,
      ledgerTo: lastRun.ledgerTo,
      driftsDetected: lastRun.driftsDetected,
      alertsRaised: lastRun.alertsRaised,
      dryRun: lastRun.dryRun,
      errorMessage: lastRun.errorMessage,
    } : null,
    openDrifts,
    criticalDrifts,
    recentDrifts: lastRun?.drifts || [],
  };
}
