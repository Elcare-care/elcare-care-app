/**
 * financial-reconciler.test.ts
 *
 * Test fixtures for financial reconciliation scenarios including:
 * - Clean fixtures that reconcile exactly
 * - Missing payout scenarios
 * - Duplicate payout scenarios
 * - Wrong token payout scenarios
 * - Provisional data handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  marketplaceEvent: { findMany: vi.fn() },
  royaltyPayment: { findMany: vi.fn() },
  financialDrift: { groupBy: vi.fn(), findFirst: vi.fn() },
}));

const mockPrismaWrite = vi.hoisted(() => ({
  financialReconcileRun: { create: vi.fn().mockResolvedValue({ id: 1 }), update: vi.fn().mockResolvedValue({}) },
  financialAggregateSnapshot: { upsert: vi.fn().mockResolvedValue({}) },
  financialDrift: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../db', () => ({ default: mockPrisma }));
vi.mock('../prisma-write', () => ({ default: mockPrismaWrite }));

import {
  runFinancialReconciliation,
  getFinancialReconciliationStatus,
  type TolerancePolicy,
} from '../financial-reconciler';

// ── Test Data Helpers ──────────────────────────────────────────────────────────

const createMockAggregate = (overrides = {}) => ({
  protocolFeesTotal: 1000000n,
  royaltiesTotal: 500000n,
  salesTotal: 10000000n,
  refundsTotal: 100000n,
  protocolFeeCount: 10,
  royaltyCount: 5,
  saleCount: 20,
  refundCount: 2,
  ...overrides,
});

const createMockDrift = (overrides = {}) => ({
  entityType: 'royalty' as const,
  entityId: 'event:123',
  ledgerSequence: 1000,
  token: 'TOKEN_ADDRESS',
  collection: 'COLLECTION_ADDRESS',
  expectedAmount: 1000n,
  actualAmount: 0n,
  driftAmount: 1000n,
  driftBps: 10000,
  severity: 'Critical' as const,
  reason: 'missing_payout',
  isProvisional: false,
  ...overrides,
});

// ── Reset mocks before each test ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaWrite.financialReconcileRun.create.mockResolvedValue({ id: 1 });
  mockPrismaWrite.financialReconcileRun.update.mockResolvedValue({});
  mockPrismaWrite.financialAggregateSnapshot.upsert.mockResolvedValue({});
  mockPrismaWrite.financialDrift.create.mockResolvedValue({});
  mockPrisma.financialDrift.groupBy.mockResolvedValue([]);
  mockPrisma.financialDrift.findFirst.mockResolvedValue(null);
});

// ── Clean Fixture Tests ───────────────────────────────────────────────────────

describe('Clean Fixture Reconciliation', () => {
  it('should reconcile exactly when event totals match payment totals', async () => {
    // Mock aggregates from events
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        protocol_fees_total: 1000000n,
        royalties_total: 500000n,
        sales_total: 10000000n,
        refunds_total: 100000n,
        protocol_fee_count: 10n,
        royalty_count: 5n,
        sale_count: 20n,
        refund_count: 2n,
      },
    ]);

    // Mock empty per-ledger, per-token, per-collection
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    // Mock royalty payments that match events
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      {
        amount: { toString: () => '500000' },
        recipient: 'RECIPIENT_1',
        ledgerSequence: 1000,
      },
    ]);

    // Mock no drift events
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, {}, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.alertsRaised).toBe(0);
    expect(mockPrismaWrite.financialDrift.create).not.toHaveBeenCalled();
  });

  it('should handle empty ledger ranges without errors', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 0n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1000, {}, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.alertsRaised).toBe(0);
  });
});

// ── Missing Payout Tests ───────────────────────────────────────────────────────

describe('Missing Payout Scenarios', () => {
  it('should detect missing royalty payout when event exists but payment does not', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    // No royalty payments despite event
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);

    // Event exists without corresponding payment
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      {
        id: 1,
        eventHash: 'hash123',
        eventType: 'ROYALTY_PAID',
        ledgerSequence: 1000,
        confirmed: true,
        data: {
          amount: '500000',
          token: 'TOKEN_ADDRESS',
          collection: 'COLLECTION_ADDRESS',
          recipients: [{ address: 'RECIPIENT_1', amount: '500000' }],
        },
      },
    ]);

    const result = await runFinancialReconciliation(1000, 1100, { toleranceBps: 100 }, false);

    expect(result.driftsDetected).toBeGreaterThan(0);
    expect(mockPrismaWrite.financialDrift.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'royalty',
          reason: 'missing_payout',
          severity: 'Critical',
        }),
      })
    );
  });

  it('should trigger alert for missing payout above threshold', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      {
        id: 1,
        eventHash: 'hash123',
        eventType: 'ROYALTY_PAID',
        ledgerSequence: 1000,
        confirmed: true,
        data: {
          amount: '500000',
          token: 'TOKEN_ADDRESS',
          collection: 'COLLECTION_ADDRESS',
          recipients: [{ address: 'RECIPIENT_1', amount: '500000' }],
        },
      },
    ]);

    const result = await runFinancialReconciliation(1000, 1100, { toleranceBps: 100 }, false);

    expect(result.alertsRaised).toBeGreaterThan(0);
  });
});

// ── Duplicate Payout Tests ─────────────────────────────────────────────────────

describe('Duplicate Payout Scenarios', () => {
  it('should detect duplicate royalty payments', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    // More payments than events
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: { toString: () => '500000' }, recipient: 'RECIPIENT_1', ledgerSequence: 1000 },
      { amount: { toString: () => '500000' }, recipient: 'RECIPIENT_1', ledgerSequence: 1000 }, // Duplicate
    ]);

    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, { toleranceBps: 100 }, false);

    expect(result.driftsDetected).toBeGreaterThan(0);
  });
});

// ── Wrong Token Payout Tests ───────────────────────────────────────────────────

describe('Wrong Token Payout Scenarios', () => {
  it('should detect payout with wrong token address', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ token: 'WRONG_TOKEN', protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: { toString: () => '500000' }, recipient: 'RECIPIENT_1', ledgerSequence: 1000 },
    ]);

    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, { toleranceBps: 100 }, false);

    // Token mismatch would be detected in per-token comparison
    expect(result.driftsDetected).toBeGreaterThan(0);
  });
});

// ── Provisional Data Tests ─────────────────────────────────────────────────────

describe('Provisional Data Handling', () => {
  it('should not alert on provisional drifts within tolerance', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);

    // Provisional event (not confirmed)
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      {
        id: 1,
        eventHash: 'hash123',
        eventType: 'ROYALTY_PAID',
        ledgerSequence: 1000,
        confirmed: false, // Provisional
        data: {
          amount: '500000',
          token: 'TOKEN_ADDRESS',
          collection: 'COLLECTION_ADDRESS',
          recipients: [{ address: 'RECIPIENT_1', amount: '500000' }],
        },
      },
    ]);

    const result = await runFinancialReconciliation(1000, 1100, {
      toleranceBps: 100,
      provisionalToleranceBps: 500,
      includeProvisional: true,
    }, false);

    // Drift detected but not alerted due to provisional status
    expect(result.driftsDetected).toBeGreaterThan(0);
    expect(result.alertsRaised).toBe(0);
  });

  it('should exclude provisional events when includeProvisional is false', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 0n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 0n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, {
      toleranceBps: 100,
      includeProvisional: false,
    }, false);

    expect(result.driftsDetected).toBe(0);
    expect(result.alertsRaised).toBe(0);
  });
});

// ── Tolerance Policy Tests ─────────────────────────────────────────────────────

describe('Tolerance Policy', () => {
  it('should not alert on drift within tolerance', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 505000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    // Small drift within 1% tolerance
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: { toString: () => '500000' }, recipient: 'RECIPIENT_1', ledgerSequence: 1000 },
    ]);

    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, { toleranceBps: 100 }, false);

    // 505000 vs 500000 = 1% drift = 100 bps, at tolerance boundary
    expect(result.alertsRaised).toBe(0);
  });

  it('should alert on drift exceeding tolerance', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 510000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    // 2% drift exceeds 1% tolerance
    mockPrisma.royaltyPayment.findMany.mockResolvedValue([
      { amount: { toString: () => '500000' }, recipient: 'RECIPIENT_1', ledgerSequence: 1000 },
    ]);

    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);

    const result = await runFinancialReconciliation(1000, 1100, { toleranceBps: 100 }, false);

    // 510000 vs 500000 = 2% drift = 200 bps, exceeds tolerance
    expect(result.driftsDetected).toBeGreaterThan(0);
  });
});

// ── Dry Run Tests ─────────────────────────────────────────────────────────────

describe('Dry Run Mode', () => {
  it('should not persist drifts in dry run mode', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ protocol_fees_total: 0n, royalties_total: 500000n, sales_total: 0n, refunds_total: 0n, protocol_fee_count: 0n, royalty_count: 1n, sale_count: 0n, refund_count: 0n }]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    mockPrisma.royaltyPayment.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([
      {
        id: 1,
        eventHash: 'hash123',
        eventType: 'ROYALTY_PAID',
        ledgerSequence: 1000,
        confirmed: true,
        data: {
          amount: '500000',
          token: 'TOKEN_ADDRESS',
          collection: 'COLLECTION_ADDRESS',
          recipients: [{ address: 'RECIPIENT_1', amount: '500000' }],
        },
      },
    ]);

    const result = await runFinancialReconciliation(1000, 1100, {}, true);

    expect(result.dryRun).toBe(true);
    expect(result.driftsDetected).toBeGreaterThan(0);
    expect(mockPrismaWrite.financialDrift.create).not.toHaveBeenCalled();
    expect(mockPrismaWrite.financialAggregateSnapshot.upsert).not.toHaveBeenCalled();
  });
});

// ── Status Query Tests ────────────────────────────────────────────────────────

describe('Status Query', () => {
  it('should return reconciliation status', async () => {
    mockPrisma.financialReconcileRun.findFirst.mockResolvedValue({
      id: 1,
      startedAt: new Date('2024-01-01'),
      completedAt: new Date('2024-01-01T00:05:00'),
      ledgerFrom: 1000,
      ledgerTo: 1100,
      driftsDetected: 5,
      alertsRaised: 2,
      dryRun: false,
      errorMessage: null,
      drifts: [],
    });

    mockPrisma.financialDrift.count.mockResolvedValueOnce(3);
    mockPrisma.financialDrift.count.mockResolvedValueOnce(1);

    const status = await getFinancialReconciliationStatus();

    expect(status.lastRun).not.toBeNull();
    expect(status.lastRun?.driftsDetected).toBe(5);
    expect(status.lastRun?.alertsRaised).toBe(2);
    expect(status.openDrifts).toBe(3);
    expect(status.criticalDrifts).toBe(1);
  });

  it('should return null status when no runs exist', async () => {
    mockPrisma.financialReconcileRun.findFirst.mockResolvedValue(null);
    mockPrisma.financialDrift.count.mockResolvedValue(0);

    const status = await getFinancialReconciliationStatus();

    expect(status.lastRun).toBeNull();
    expect(status.openDrifts).toBe(0);
    expect(status.criticalDrifts).toBe(0);
  });
});

// ── Error Handling Tests ───────────────────────────────────────────────────────

describe('Error Handling', () => {
  it('should handle database errors gracefully', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('Database connection failed'));

    await expect(runFinancialReconciliation(1000, 1100, {}, false)).rejects.toThrow();

    expect(mockPrismaWrite.financialReconcileRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: expect.stringContaining('Database connection failed'),
        }),
      })
    );
  });

  it('should mark run as failed on error', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('Query failed'));

    await expect(runFinancialReconciliation(1000, 1100, {}, false)).rejects.toThrow();

    expect(mockPrismaWrite.financialReconcileRun.update).toHaveBeenCalled();
  });
});
