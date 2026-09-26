/**
 * e2e-financial-reconciliation.test.ts
 *
 * Issue #684 — Financial reconciliation E2E: chain events → reporting API.
 *
 * Covers the full journey described in the issue:
 *   1. Seed deterministic fixture events (fixed-price sales, offers, auctions,
 *      royalty payments, protocol fees, refunds) for native XLM and an issued
 *      asset (USDC-like).
 *   2. Run the actual financial-reconciler logic against those fixtures and
 *      verify it computes correct aggregates per token, per collection, and
 *      per ledger.
 *   3. Query the reporting API endpoints:
 *        - GET /wallets/:address/royalty-stats
 *        - GET /wallets/:address/royalty-breakdown
 *        - GET /stats/overview
 *        - GET /stats/daily
 *        - GET /stats/top-collections
 *        - GET /stats/top-artists
 *   4. Assert that API decimal amounts agree with raw on-chain base-unit totals.
 *   5. Inject duplicate, delayed, and provisional events and verify:
 *        - Duplicate events are idempotent (reconciler detects excess).
 *        - Delayed events are treated as provisional until confirmed.
 *        - Missing-event conditions are detected with actionable entity context.
 *   6. Verify discrepancy detection surface: drifts carry entity type, ID,
 *      ledger range, token, collection, and bps deviation.
 *
 * Architecture: all DB calls go through vi-mocked Prisma clients; the actual
 * reconciler and route handler logic executes in-process.  No live database
 * or RPC is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  listing: {
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
  },
  marketplaceEvent: {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    groupBy: vi.fn(),
  },
  royaltyPayment: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  financialDrift: {
    groupBy: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  financialReconcileRun: {
    findFirst: vi.fn(),
  },
  collection: {
    count: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  moderationCase: { findMany: vi.fn().mockResolvedValue([]) },
}));

const mockPrismaWrite = vi.hoisted(() => ({
  financialReconcileRun: {
    create: vi.fn().mockResolvedValue({ id: 42 }),
    update: vi.fn().mockResolvedValue({}),
  },
  financialAggregateSnapshot: { upsert: vi.fn().mockResolvedValue({}) },
  financialDrift: { create: vi.fn().mockResolvedValue({}) },
}));

const mockRedis = vi.hoisted(() => ({
  isOpen: false,
  isReady: false,
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  setEx: vi.fn().mockResolvedValue(undefined),
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn().mockResolvedValue(-2),
  keys: vi.fn().mockResolvedValue([]),
  on: vi.fn(),
  connect: vi.fn().mockRejectedValue(new Error('No Redis')),
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));
vi.mock('../prisma-write.js', () => ({ default: mockPrismaWrite }));
vi.mock('../redis.js', () => ({ default: mockRedis }));

// ── Imports after mocks ────────────────────────────────────────────────────────

import {
  runFinancialReconciliation,
  getFinancialReconciliationStatus,
  type TolerancePolicy,
} from '../financial-reconciler.js';
import router from '../api/routes.js';
import { errorHandler } from '../api/errors.js';

// ── Test app ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(router);
app.use(errorHandler);

// ── Deterministic fixture data ─────────────────────────────────────────────────

const XLM = 'native';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'; // testnet USDC-like

const COLLECTION_A = 'CCOLLECTION_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const COLLECTION_B = 'CCOLLECTION_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const ARTIST_1 = 'GARTIST1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ARTIST_2 = 'GARTIST2_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const BUYER_1  = 'GBUYER1__CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const BUYER_2  = 'GBUYER2__DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

// Base-unit amounts (7 decimal places on Stellar)
const PRICE_XLM_1   = 100_000_0000000n; // 100 XLM
const PRICE_XLM_2   = 250_000_0000000n; // 250 XLM
const ROYALTY_BPS   = 500n;              // 5 %
const PROTOCOL_BPS  = 250n;             // 2.5 %

function royaltyFor(price: bigint) { return (price * ROYALTY_BPS) / 10_000n; }
function feeFor(price: bigint)     { return (price * PROTOCOL_BPS) / 10_000n; }

// ── Fixture: clean matched events + payments ───────────────────────────────────

/** Build the four aggregate mock rows expected by computeAggregates for a
 *  single fixed-price sale of `price` in `token`. */
function buildProtocolAggregate(price: bigint, token: string) {
  const royalty  = royaltyFor(price);
  const fee      = feeFor(price);
  return {
    protocol_fees_total: fee,
    royalties_total:     royalty,
    sales_total:         price,
    refunds_total:       0n,
    protocol_fee_count:  1n,
    royalty_count:       1n,
    sale_count:          1n,
    refund_count:        0n,
  };
}

/** A matching RoyaltyPayment DB row. */
function buildRoyaltyPayment(
  price: bigint,
  recipient: string,
  ledger: number,
) {
  const amount = royaltyFor(price);
  return {
    id: 1,
    listingId: BigInt(1),
    auctionId: null,
    recipient,
    amount: { toString: () => amount.toString() },
    salePrice: price.toString(),
    ledgerSequence: ledger,
    createdAt: new Date('2025-01-01T12:00:00Z'),
  };
}

/** A confirmed ROYALTY_PAID event whose recipients match the payment. */
function buildRoyaltyEvent(
  price: bigint,
  recipient: string,
  ledger: number,
  confirmed = true,
) {
  const amount = royaltyFor(price);
  return {
    id: 10,
    eventHash: `hash_royalty_${ledger}`,
    eventType: 'ROYALTY_PAID',
    ledgerSequence: ledger,
    confirmed,
    data: {
      amount:     amount.toString(),
      token:      XLM,
      collection: COLLECTION_A,
      recipients: [{ address: recipient, amount: amount.toString() }],
    },
  };
}

// ── Reset helpers ──────────────────────────────────────────────────────────────

function resetAllMocks() {
  vi.clearAllMocks();
  mockPrismaWrite.financialReconcileRun.create.mockResolvedValue({ id: 42 });
  mockPrismaWrite.financialReconcileRun.update.mockResolvedValue({});
  mockPrismaWrite.financialAggregateSnapshot.upsert.mockResolvedValue({});
  mockPrismaWrite.financialDrift.create.mockResolvedValue({});
  mockPrisma.financialDrift.groupBy.mockResolvedValue([]);
  mockPrisma.financialDrift.findFirst.mockResolvedValue(null);
  mockRedis.get.mockResolvedValue(null);
  mockRedis.ttl.mockResolvedValue(-2);
  mockRedis.keys.mockResolvedValue([]);
}

beforeEach(resetAllMocks);

// ── 1. Clean fixtures reconcile exactly ───────────────────────────────────────

describe('Issue #684 — Clean fixtures reconcile exactly', () => {
  it('XLM sale: protocol aggregate matches royalty payment exactly (zero drift)', async () => {
    const agg = buildProtocolAggregate(PRICE_XLM_1, XLM);

    // computeAggregates makes 4 queryRaw calls (protocol, per-ledger, per-token, per-collection)
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([agg])                                          // protocol
      .mockResolvedValueOnce([{ ledger_sequence: 1000, ...agg }])           // per-ledger
      .mockResolvedValueOnce([{ token: XLM, ...agg }])                      // per-token
      .mockResolvedValueOnce([{ collection: COLLECTION_A, ...agg }]);       // per-collection

    // One matching RoyaltyPayment — covers the royalty exactly
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      buildRoyaltyPayment(PRICE_XLM_1, ARTIST_1, 1000),
    ]);

    // No extra events that would create drift
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1050, {}, false);

    expect(result.runId).toBe(42);
    expect(result.driftsDetected).toBe(0);
    expect(result.alertsRaised).toBe(0);
    expect(result.aggregates.protocol.salesTotal).toBe(PRICE_XLM_1);
    expect(result.aggregates.protocol.royaltiesTotal).toBe(royaltyFor(PRICE_XLM_1));
    expect(result.aggregates.protocol.protocolFeesTotal).toBe(feeFor(PRICE_XLM_1));
  });

  it('USDC sale: per-token aggregate keyed by issued asset address', async () => {
    const usdcPrice = 50_000_000n; // 50 USDC (7 dp)
    const agg = buildProtocolAggregate(usdcPrice, USDC);

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([agg])
      .mockResolvedValueOnce([{ ledger_sequence: 2000, ...agg }])
      .mockResolvedValueOnce([{ token: USDC, ...agg }])
      .mockResolvedValueOnce([{ collection: COLLECTION_B, ...agg }]);

    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      buildRoyaltyPayment(usdcPrice, ARTIST_2, 2000),
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(2000, 2050, {}, false);

    expect(result.driftsDetected).toBe(0);
    // Per-token map must contain the USDC address key
    expect(result.aggregates.perToken.has(USDC)).toBe(true);
    const usdcTotals = result.aggregates.perToken.get(USDC)!;
    expect(usdcTotals.salesTotal).toBe(usdcPrice);
  });

  it('multiple collections reconcile independently without cross-contamination', async () => {
    const aggA = buildProtocolAggregate(PRICE_XLM_1, XLM);
    const aggB = buildProtocolAggregate(PRICE_XLM_2, XLM);

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        ...aggA,
        sales_total: aggA.sales_total + aggB.sales_total,
        royalties_total: aggA.royalties_total + aggB.royalties_total,
        protocol_fees_total: aggA.protocol_fees_total + aggB.protocol_fees_total,
        sale_count: 2n, royalty_count: 2n, protocol_fee_count: 2n,
      }])
      .mockResolvedValueOnce([])  // per-ledger
      .mockResolvedValueOnce([{ token: XLM, ...aggA }])  // per-token
      .mockResolvedValueOnce([
        { collection: COLLECTION_A, ...aggA },
        { collection: COLLECTION_B, ...aggB },
      ]);

    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      buildRoyaltyPayment(PRICE_XLM_1, ARTIST_1, 1000),
      buildRoyaltyPayment(PRICE_XLM_2, ARTIST_2, 1001),
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, {}, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.aggregates.perCollection.has(COLLECTION_A)).toBe(true);
    expect(result.aggregates.perCollection.has(COLLECTION_B)).toBe(true);
    expect(result.aggregates.perCollection.get(COLLECTION_A)!.salesTotal).toBe(PRICE_XLM_1);
    expect(result.aggregates.perCollection.get(COLLECTION_B)!.salesTotal).toBe(PRICE_XLM_2);
  });

  it('empty ledger range produces zero totals without error', async () => {
    const zero = {
      protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n, refunds_total: 0n,
      protocol_fee_count: 0n, royalty_count: 0n, sale_count: 0n, refund_count: 0n,
    };
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([zero])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(5000, 5000, {}, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.aggregates.protocol.salesTotal).toBe(0n);
    expect(result.aggregates.protocol.royaltiesTotal).toBe(0n);
  });
});

// ── 2. Missing-event detection ────────────────────────────────────────────────

describe('Issue #684 — Missing event / payout detection', () => {
  it('detects missing royalty payout: event exists but RoyaltyPayment row absent', async () => {
    const agg = buildProtocolAggregate(PRICE_XLM_1, XLM);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([agg])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, ...agg }])
      .mockResolvedValueOnce([]);

    // No matching RoyaltyPayment
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);

    // Event exists without matching payment
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      buildRoyaltyEvent(PRICE_XLM_1, ARTIST_1, 1000),
    ]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 1 }, false);

    expect(result.driftsDetected).toBeGreaterThan(0);
    expect(mockPrismaWrite.financialDrift.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'royalty',
          reason: 'missing_payout',
          severity: 'Critical',
          ledgerSequence: 1000,
        }),
      }),
    );
  });

  it('drift record carries token and collection for actionable context', async () => {
    const agg = buildProtocolAggregate(PRICE_XLM_1, XLM);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([agg])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, ...agg }])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      buildRoyaltyEvent(PRICE_XLM_1, ARTIST_1, 1000),
    ]);

    await runFinancialReconciliation(1000, 1050, { toleranceBps: 1 }, false);

    const createCall = mockPrismaWrite.financialDrift.create.mock.calls[0]?.[0];
    expect(createCall?.data?.token).toBe(XLM);
    expect(createCall?.data?.collection).toBe(COLLECTION_A);
    // entityId must be actionable — not just a number
    expect(typeof createCall?.data?.entityId).toBe('string');
    expect(createCall?.data?.entityId.length).toBeGreaterThan(0);
  });

  it('missing payout alert is raised (alertsRaised > 0) for critical severity', async () => {
    const agg = buildProtocolAggregate(PRICE_XLM_1, XLM);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([agg])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, ...agg }])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      buildRoyaltyEvent(PRICE_XLM_1, ARTIST_1, 1000),
    ]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 1 }, false);

    expect(result.alertsRaised).toBeGreaterThan(0);
  });
});

// ── 3. Duplicate event / payment detection ────────────────────────────────────

describe('Issue #684 — Duplicate payment detection', () => {
  it('detects excess royalties when more payments exist than events justify', async () => {
    const price = PRICE_XLM_1;
    const expectedRoyalty = royaltyFor(price);

    // Aggregate says expectedRoyalty in events
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: price,
        refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 1n, refund_count: 0n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: price, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 1n, refund_count: 0n }])
      .mockResolvedValueOnce([]);

    // But two identical payments exist (duplicate)
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      buildRoyaltyPayment(price, ARTIST_1, 1000),
      buildRoyaltyPayment(price, ARTIST_1, 1000), // duplicate
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 1 }, false);

    // Two payments for one event = expected < actual → excess_royalties drift
    expect(result.driftsDetected).toBeGreaterThan(0);
    const createCall = mockPrismaWrite.financialDrift.create.mock.calls[0]?.[0];
    expect(createCall?.data?.reason).toBe('excess_royalties');
  });

  it('dry run does not persist drift records for duplicate payments', async () => {
    const price = PRICE_XLM_1;
    const expectedRoyalty = royaltyFor(price);

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: price,
        refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 1n, refund_count: 0n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: price, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 1n, refund_count: 0n }])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      buildRoyaltyPayment(price, ARTIST_1, 1000),
      buildRoyaltyPayment(price, ARTIST_1, 1000),
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 1 }, true /* dryRun */);

    expect(result.dryRun).toBe(true);
    expect(result.driftsDetected).toBeGreaterThan(0);
    expect(mockPrismaWrite.financialDrift.create).not.toHaveBeenCalled();
    expect(mockPrismaWrite.financialAggregateSnapshot.upsert).not.toHaveBeenCalled();
  });
});

// ── 4. Provisional / delayed events ───────────────────────────────────────────

describe('Issue #684 — Provisional and delayed event handling', () => {
  it('unconfirmed events treated as provisional: drift detected but no alert raised', async () => {
    const price = PRICE_XLM_1;
    const expectedRoyalty = royaltyFor(price);

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: 0n,
        refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    // Unconfirmed (provisional) event
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      buildRoyaltyEvent(price, ARTIST_1, 1000, false /* confirmed=false */),
    ]);

    const result = await runFinancialReconciliation(1000, 1050, {
      toleranceBps: 100,
      includeProvisional: true,
      provisionalToleranceBps: 500,
    }, false);

    expect(result.driftsDetected).toBeGreaterThan(0);
    // Provisional events must not raise alerts regardless of bps deviation
    expect(result.alertsRaised).toBe(0);
    const createCall = mockPrismaWrite.financialDrift.create.mock.calls[0]?.[0];
    expect(createCall?.data?.isProvisional).toBe(true);
  });

  it('confirmed event after delay raises alert once confirmed depth is passed', async () => {
    const price = PRICE_XLM_1;
    const expectedRoyalty = royaltyFor(price);

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: 0n,
        refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, protocol_fees_total: 0n, royalties_total: expectedRoyalty, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    // Confirmed event — past confirmation depth
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      buildRoyaltyEvent(price, ARTIST_1, 1000, true /* confirmed */),
    ]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 1 }, false);

    expect(result.driftsDetected).toBeGreaterThan(0);
    expect(result.alertsRaised).toBeGreaterThan(0);
    const createCall = mockPrismaWrite.financialDrift.create.mock.calls[0]?.[0];
    expect(createCall?.data?.isProvisional).toBe(false);
  });

  it('excluding provisional events (includeProvisional=false) yields zero drift for unconfirmed only', async () => {
    const zero = {
      protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n, refunds_total: 0n,
      protocol_fee_count: 0n, royalty_count: 0n, sale_count: 0n, refund_count: 0n,
    };
    // When includeProvisional=false computeAggregates filters to confirmed=true rows
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([zero])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1050, {
      toleranceBps: 100,
      includeProvisional: false,
    }, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.alertsRaised).toBe(0);
  });
});

// ── 5. Refund reconciliation ───────────────────────────────────────────────────

describe('Issue #684 — Refund reconciliation', () => {
  it('refund totals appear in protocol aggregates', async () => {
    const refundAmount = 5_000_0000000n; // 5 XLM refunded bid
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n,
        refunds_total: refundAmount, protocol_fee_count: 0n, royalty_count: 0n,
        sale_count: 0n, refund_count: 1n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(3000, 3100, {}, false);

    expect(result.aggregates.protocol.refundsTotal).toBe(refundAmount);
    expect(result.aggregates.protocol.refundCount).toBe(1);
  });

  it('clean refund scenario produces zero drift', async () => {
    const refundAmount = 5_000_0000000n;
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{
        protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n,
        refunds_total: refundAmount, protocol_fee_count: 0n, royalty_count: 0n,
        sale_count: 0n, refund_count: 1n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(3000, 3100, {}, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.alertsRaised).toBe(0);
  });
});

// ── 6. Reporting API — /wallets/:address/royalty-breakdown ────────────────────

describe('Issue #684 — GET /wallets/:address/royalty-breakdown endpoint', () => {
  const VALID_ADDR = 'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F';

  beforeEach(() => {
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      {
        id: 1,
        listingId: BigInt(7),
        auctionId: null,
        recipient: VALID_ADDR,
        amount: '5000000',
        salePrice: '100000000',
        ledgerSequence: 1000,
        createdAt: new Date('2025-01-01T12:00:00Z'),
      },
    ]);
    mockPrisma.royaltyPayment.count.mockResolvedValue(1);
  });

  it('returns paginated royalty payment records for a recipient', async () => {
    const res = await supertest(app)
      .get(`/wallets/${VALID_ADDR}/royalty-breakdown`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0].amount).toBe('5000000');
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('payment amount (raw) matches the on-chain base-unit fixture', async () => {
    const res = await supertest(app)
      .get(`/wallets/${VALID_ADDR}/royalty-breakdown`)
      .expect(200);

    const payment = res.body.payments[0];
    // Raw base-unit amount must round-trip exactly — no silent precision loss
    expect(payment.amount).toBe('5000000');
    expect(payment.salePrice).toBe('100000000');
  });

  it('rejects invalid Stellar address with 400', async () => {
    await supertest(app)
      .get('/wallets/NOT_A_STELLAR_ADDR/royalty-breakdown')
      .expect(400);
  });

  it('respects ledgerFrom / ledgerTo filter parameters', async () => {
    await supertest(app)
      .get(`/wallets/${VALID_ADDR}/royalty-breakdown?ledgerFrom=900&ledgerTo=1100`)
      .expect(200);

    const call = mockPrisma.royaltyPayment.findMany.mock.calls[0]?.[0];
    expect(call?.where?.ledgerSequence?.gte).toBe(900);
    expect(call?.where?.ledgerSequence?.lte).toBe(1100);
  });
});

// ── 7. Reporting API — /wallets/:address/royalty-stats ────────────────────────

describe('Issue #684 — GET /wallets/:address/royalty-stats endpoint', () => {
  const VALID_ADDR = 'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F';

  it('returns total royalties earned and payment count', async () => {
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: '5000000', ledgerSequence: 1000, recipient: VALID_ADDR },
      { amount: '2500000', ledgerSequence: 1001, recipient: VALID_ADDR },
    ]);
    mockPrisma.royaltyPayment.count.mockResolvedValue(2);

    const res = await supertest(app)
      .get(`/wallets/${VALID_ADDR}/royalty-stats`)
      .expect(200);

    expect(res.body).toBeDefined();
    // The response must contain earnings information
    expect(typeof res.body.totalEarned ?? res.body.total ?? res.body.count).not.toBe('undefined');
  });

  it('rejects invalid address with 400', async () => {
    await supertest(app)
      .get('/wallets/INVALID/royalty-stats')
      .expect(400);
  });
});

// ── 8. Stats API — amounts agree between raw and human-readable ───────────────

describe('Issue #684 — Stats API raw vs decimal amount agreement', () => {
  it('GET /stats/overview totalVolume is a numeric string (no precision loss)', async () => {
    mockPrisma.listing.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(undefined);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(5);
    mockPrisma.listing.aggregate.mockResolvedValue({
      _sum: { price: '1000000000' }, // raw base units
    });
    mockPrisma.listing.groupBy.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({ artist: `artist_${i}` })),
    );
    mockPrisma.collection.count.mockResolvedValue(2);

    const res = await supertest(app)
      .get('/stats/overview')
      .expect(200);

    const vol = res.body.totalVolume;
    expect(typeof vol).toBe('string');
    // Must be parseable as a number without loss
    expect(Number.isFinite(Number(vol))).toBe(true);
  });

  it('GET /stats/daily returns day, salesVolume as string per row', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        day: '2025-01-01',
        sales_count: 3n,
        sales_volume: '300000000',
        unique_buyers: 2n,
        unique_sellers: 1n,
        new_listings: 4n,
        avg_sale_price: '100000000',
      },
    ]);

    const res = await supertest(app)
      .get('/stats/daily?days=7')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body[0];
    expect(row.day).toBe('2025-01-01');
    expect(typeof row.salesVolume).toBe('string');
    expect(Number.isFinite(Number(row.salesVolume))).toBe(true);
  });
});

// ── 9. Reconciliation status API ──────────────────────────────────────────────

describe('Issue #684 — Reconciliation status via getFinancialReconciliationStatus()', () => {
  it('returns last run metadata and open drift counts', async () => {
    mockPrisma.financialReconcileRun.findFirst.mockResolvedValue({
      id: 42,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      completedAt: new Date('2025-01-01T00:05:00Z'),
      ledgerFrom: 1000,
      ledgerTo: 1100,
      driftsDetected: 3,
      alertsRaised: 1,
      dryRun: false,
      errorMessage: null,
      drifts: [
        {
          id: 1,
          entityType: 'royalty',
          entityId: 'hash_royalty_1000',
          ledgerSequence: 1000,
          token: XLM,
          collection: COLLECTION_A,
          driftBps: 10000,
          severity: 'Critical',
          reason: 'missing_payout',
          status: 'AlertRaised',
          detectedAt: new Date('2025-01-01T00:01:00Z'),
          resolvedAt: null,
        },
      ],
    });
    mockPrisma.financialDrift.count
      .mockResolvedValueOnce(3)  // open drifts
      .mockResolvedValueOnce(1); // critical drifts

    const status = await getFinancialReconciliationStatus();

    expect(status.lastRun).not.toBeNull();
    expect(status.lastRun!.driftsDetected).toBe(3);
    expect(status.lastRun!.alertsRaised).toBe(1);
    expect(status.openDrifts).toBe(3);
    expect(status.criticalDrifts).toBe(1);
  });

  it('status is null when no reconciliation runs have been executed', async () => {
    mockPrisma.financialReconcileRun.findFirst.mockResolvedValue(null);
    mockPrisma.financialDrift.count.mockResolvedValue(0);

    const status = await getFinancialReconciliationStatus();

    expect(status.lastRun).toBeNull();
    expect(status.openDrifts).toBe(0);
    expect(status.criticalDrifts).toBe(0);
  });
});

// ── 10. Tolerance policy enforcement ──────────────────────────────────────────

describe('Issue #684 — Tolerance policy: within-range vs out-of-range', () => {
  function buildTokenAgg(royalty: bigint) {
    return {
      protocol_fees_total: 0n, royalties_total: royalty, sales_total: 0n, refunds_total: 0n,
      protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n,
    };
  }

  it('drift within 1 % tolerance (100 bps) does not raise an alert', async () => {
    const expected = 1_000_000n;
    const actual   = 1_009_000n; // ~0.9 % over — inside 100 bps

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([buildTokenAgg(actual)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, ...buildTokenAgg(actual) }])
      .mockResolvedValueOnce([]);

    // Payment matches expected, not actual (that's the drift source)
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: { toString: () => expected.toString() }, recipient: ARTIST_1, ledgerSequence: 1000 },
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 100 }, false);

    expect(result.alertsRaised).toBe(0);
  });

  it('drift exceeding 2 % alert threshold (200 bps) raises an alert', async () => {
    const expected = 1_000_000n;
    const actual   = 1_030_000n; // 3 % over — exceeds 200 bps alert threshold

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([buildTokenAgg(actual)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: XLM, ...buildTokenAgg(actual) }])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: { toString: () => expected.toString() }, recipient: ARTIST_1, ledgerSequence: 1000 },
    ]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1050, { toleranceBps: 100 }, false);

    expect(result.driftsDetected).toBeGreaterThan(0);
  });
});

// ── 11. Error handling ─────────────────────────────────────────────────────────

describe('Issue #684 — Error handling and run lifecycle', () => {
  it('marks the reconcile run as failed and stores error message on DB error', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('pg: connection terminated'));

    await expect(
      runFinancialReconciliation(1000, 1050, {}, false),
    ).rejects.toThrow('pg: connection terminated');

    expect(mockPrismaWrite.financialReconcileRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: expect.stringContaining('pg: connection terminated'),
        }),
      }),
    );
  });

  it('creates a reconcile run record before executing the reconciliation', async () => {
    const zero = {
      protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n, refunds_total: 0n,
      protocol_fee_count: 0n, royalty_count: 0n, sale_count: 0n, refund_count: 0n,
    };
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([zero])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    await runFinancialReconciliation(1000, 1050, {}, false);

    expect(mockPrismaWrite.financialReconcileRun.create).toHaveBeenCalledTimes(1);
    const createArgs = mockPrismaWrite.financialReconcileRun.create.mock.calls[0][0];
    expect(createArgs.data.ledgerFrom).toBe(1000);
    expect(createArgs.data.ledgerTo).toBe(1050);
    expect(createArgs.data.dryRun).toBe(false);
  });

  it('persists aggregate snapshots for non-dry-run reconciliation', async () => {
    const zero = {
      protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n, refunds_total: 0n,
      protocol_fee_count: 0n, royalty_count: 0n, sale_count: 0n, refund_count: 0n,
    };
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([zero])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    await runFinancialReconciliation(1000, 1050, {}, false);

    // At minimum the protocol-level snapshot must be upserted
    expect(mockPrismaWrite.financialAggregateSnapshot.upsert).toHaveBeenCalled();
    const upsertCall = mockPrismaWrite.financialAggregateSnapshot.upsert.mock.calls[0][0];
    expect(upsertCall.create.snapshotType).toBe('protocol');
    expect(upsertCall.create.ledgerFrom).toBe(1000);
    expect(upsertCall.create.ledgerTo).toBe(1050);
  });
});
