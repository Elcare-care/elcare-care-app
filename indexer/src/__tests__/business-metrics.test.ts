/**
 * business-metrics.test.ts
 *
 * Verifies all 14+ new business KPI metrics are exported from /metrics and that
 * counters increment on each corresponding event type in processEvent().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(5),
  },
  auction: {
    upsert: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(2),
  },
  offer: {
    upsert: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
  marketplaceEvent: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../db', () => ({ default: mockPrisma }));
vi.mock('../redis.js', () => ({
  default: { isReady: false, get: vi.fn(), setEx: vi.fn() },
  invalidatePattern: vi.fn().mockResolvedValue(undefined),
  invalidateKey: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/routes.js', () => ({ emitSSEEvent: vi.fn() }));
vi.mock('../ipfs-cache.js', () => ({ enqueueIpfsFetch: vi.fn().mockResolvedValue(undefined) }));

import {
  listingsCreatedTotal,
  salesTotalCounter,
  auctionFinalizationsTotal,
  offersMadeTotal,
  offersAcceptedTotal,
  sseConnectionsTotal,
  activeListingsGauge,
  activeAuctionsGauge,
  sseActiveConnectionsGauge,
  syncLagLedgersGauge,
  apiRequestDurationHistogram,
  eventProcessingDurationHistogram,
  handleMetrics,
} from '../metrics';

import { processEvent } from '../poller';

// ── /metrics endpoint exports all new metrics ─────────────────────────────────

describe('GET /metrics — all new business metrics exported', () => {
  const app = express();
  app.get('/metrics', handleMetrics);

  const expectedMetrics = [
    'elcarehub_listings_created_total',
    'elcarehub_sales_total',
    'elcarehub_auction_finalizations_total',
    'elcarehub_offers_made_total',
    'elcarehub_offers_accepted_total',
    'elcarehub_sse_connections_total',
    'elcarehub_active_listings',
    'elcarehub_active_auctions',
    'elcarehub_sse_active_connections',
    'elcarehub_sync_lag_ledgers',
    'elcarehub_api_request_duration_seconds',
    'elcarehub_event_processing_duration_seconds',
    'indexer_stalled',
    'indexer_decode_errors_by_type_total',
  ];

  it('exports all 14+ new metrics from /metrics endpoint', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    for (const metric of expectedMetrics) {
      expect(res.text).toContain(metric);
    }
  });
});

// ── Counter increments on processEvent ───────────────────────────────────────

describe('processEvent — counter increments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.listing.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.auction.updateMany.mockResolvedValue({ count: 1 });
  });

  const baseEvent = (eventType: string, extra: Record<string, unknown> = {}) => ({
    eventType,
    listingId: BigInt(1),
    actor: 'GTEST',
    ledgerSequence: 100,
    data: { artist: 'GTEST', price: '100', currency: 'XLM', collection: 'COL', token_id: 1, token: 'T', ...extra },
    eventHash: `hash-${Math.random()}`,
    contractId: 'C',
    txHash: 'TX',
    eventIndex: 0,
  });

  it('increments listingsCreatedTotal on LISTING_CREATED', async () => {
    const before = await listingsCreatedTotal.get();
    const prevVal = before.values.reduce((s, v) => s + v.value, 0);
    await processEvent(baseEvent('LISTING_CREATED'), undefined, true);
    const after = await listingsCreatedTotal.get();
    const newVal = after.values.reduce((s, v) => s + v.value, 0);
    expect(newVal).toBeGreaterThan(prevVal);
  });

  it('increments salesTotalCounter on ARTWORK_SOLD', async () => {
    const before = await salesTotalCounter.get();
    const prevVal = before.values.reduce((s, v) => s + v.value, 0);
    await processEvent(baseEvent('ARTWORK_SOLD', { buyer: 'GBUYER', token: 'XLM' }), undefined, true);
    const after = await salesTotalCounter.get();
    const newVal = after.values.reduce((s, v) => s + v.value, 0);
    expect(newVal).toBeGreaterThan(prevVal);
  });

  it('increments auctionFinalizationsTotal on AUCTION_RESOLVED', async () => {
    const before = (await auctionFinalizationsTotal.get()).values[0]?.value ?? 0;
    await processEvent(baseEvent('AUCTION_RESOLVED', { amount: '500', winner: 'GW' }), undefined, true);
    const after = (await auctionFinalizationsTotal.get()).values[0]?.value ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('increments offersMadeTotal on OFFER_MADE', async () => {
    const before = (await offersMadeTotal.get()).values[0]?.value ?? 0;
    await processEvent(baseEvent('OFFER_MADE', { offer_id: 1, listing_id: 1, offerer: 'GO', amount: '10', token: 'XLM' }), undefined, true);
    const after = (await offersMadeTotal.get()).values[0]?.value ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('increments offersAcceptedTotal on OFFER_ACCEPTED', async () => {
    const before = (await offersAcceptedTotal.get()).values[0]?.value ?? 0;
    await processEvent(baseEvent('OFFER_ACCEPTED', { offer_id: 1, listing_id: 1, offerer: 'GO', token: 'XLM' }), undefined, true);
    const after = (await offersAcceptedTotal.get()).values[0]?.value ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('records eventProcessingDurationHistogram sample on each event type', async () => {
    await processEvent(baseEvent('LISTING_CANCELLED'), undefined, true);
    const hist = await eventProcessingDurationHistogram.get();
    const sample = hist.values.find(v => v.labels.event_type === 'LISTING_CANCELLED');
    expect(sample).toBeDefined();
  });
});
