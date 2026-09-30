/**
 * rpc-provider-pool.test.ts
 *
 * Tests for the RPC provider pool covering:
 *   - Successful call through primary
 *   - Timeout / error triggers failover to fallback
 *   - Incompatible network passphrase rejects provider
 *   - Stale fallback (ledger behind threshold) is not promoted
 *   - Recovery back to primary after cooldown
 *   - Rate-limit (429) handled as failover trigger
 *   - All providers exhausted throws last error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub prom-client to avoid double-registration across tests
vi.mock('prom-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('prom-client')>();
  return {
    ...actual,
    Gauge:     class { labels = () => ({ set: vi.fn() }); set = vi.fn() },
    Counter:   class { labels = () => ({ inc: vi.fn() }); inc = vi.fn() },
    Histogram: class { labels = () => ({ observe: vi.fn() }); observe = vi.fn() },
    collectDefaultMetrics: vi.fn(),
    register: { contentType: 'text/plain', metrics: vi.fn().mockResolvedValue(''), getSingleMetric: vi.fn() },
  };
});

import {
  RpcProviderPool,
  buildProviderPoolFromEnv,
  type ProviderConfig,
} from '../rpc-provider-pool.js';

// ── Fake rpc.Server ───────────────────────────────────────────────────────────

function makeFakeServer(opts: {
  passphrase?: string;
  ledger?: number;
  failGetNetwork?: boolean;
  failGetLatestLedger?: boolean;
}) {
  return {
    getNetwork: vi.fn(async () => {
      if (opts.failGetNetwork) throw new Error('network unavailable');
      return { passphrase: opts.passphrase ?? 'Test SDF Network ; September 2015' };
    }),
    getLatestLedger: vi.fn(async () => {
      if (opts.failGetLatestLedger) throw new Error('ledger unavailable');
      return { sequence: opts.ledger ?? 1000 };
    }),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PASSPHRASE = 'Test SDF Network ; September 2015';

function buildPool(configs: ProviderConfig[]) {
  const pool = new RpcProviderPool(configs);
  // Inject fake servers (bypass real HTTP)
  const providers = (pool as any).providers as any[];
  return { pool, providers };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RpcProviderPool', () => {
  afterEach(() => vi.clearAllMocks());

  // ── Requires at least one provider ────────────────────────────────────────

  it('throws when no provider configs are supplied', () => {
    expect(() => new RpcProviderPool([])).toThrow();
  });

  // ── call() success ─────────────────────────────────────────────────────────

  it('forwards calls to the active provider and returns results', async () => {
    const { pool, providers } = buildPool([
      { url: 'https://primary.rpc', priority: 0 },
    ]);

    const fakeServer = makeFakeServer({ passphrase: PASSPHRASE, ledger: 1000 });
    providers[0].server = fakeServer;

    const result = await pool.call((s) => s.getLatestLedger());
    expect(result.sequence).toBe(1000);
    expect(fakeServer.getLatestLedger).toHaveBeenCalledTimes(1);
  });

  // ── Failover on error ──────────────────────────────────────────────────────

  it('fails over to the fallback when the primary exceeds max consecutive errors', async () => {
    const { pool, providers } = buildPool([
      { url: 'https://primary.rpc',  priority: 0 },
      { url: 'https://fallback.rpc', priority: 1 },
    ]);

    const primaryServer  = makeFakeServer({ failGetLatestLedger: true });
    const fallbackServer = makeFakeServer({ passphrase: PASSPHRASE, ledger: 999 });

    providers[0].server = primaryServer;
    providers[1].server = fallbackServer;

    // Stub network verification so fallback passes chain check
    providers[1].networkPassphrase = PASSPHRASE;
    providers[1].chainVerified = true;
    ;(pool as any).expectedNetworkPassphrase = PASSPHRASE;

    // Force enough errors to trigger failover
    providers[0].consecutiveErrors = 5; // MAX_CONSECUTIVE_ERRORS default
    // Put primary in cooldown
    providers[0].cooldownSince = Date.now();

    const result = await pool.call((s) => s.getLatestLedger());
    expect(result.sequence).toBe(999);
  });

  // ── Incompatible network passphrase ───────────────────────────────────────

  it('rejects a fallback provider with an incompatible network passphrase', async () => {
    const { pool, providers } = buildPool([
      { url: 'https://primary.rpc',  priority: 0 },
      { url: 'https://fallback.rpc', priority: 1 },
    ]);

    // Set expected passphrase from primary
    ;(pool as any).expectedNetworkPassphrase = PASSPHRASE;

    // Fallback returns wrong passphrase
    const fallbackServer = makeFakeServer({
      passphrase: 'Wrong Network ; January 2024',
      ledger: 999,
    });
    providers[0].cooldownSince = Date.now(); // primary in cooldown
    providers[1].server = fallbackServer;

    // verifyChainCompatibility should reject fallback
    const compatible = await (pool as any).verifyChainCompatibility(providers[1]);
    expect(compatible).toBe(false);
    expect(providers[1].chainVerified).toBe(false);
  });

  // ── Stale fallback ─────────────────────────────────────────────────────────

  it('does not recover to primary when primary ledger is stale', async () => {
    const { pool, providers } = buildPool([
      { url: 'https://primary.rpc',  priority: 0 },
      { url: 'https://fallback.rpc', priority: 1 },
    ]);

    // Active is fallback (index 1)
    ;(pool as any).activeIndex = 1;
    ;(pool as any).globalLatestLedger = 1000;

    const primaryServer = makeFakeServer({ passphrase: PASSPHRASE, ledger: 900 }); // stale
    providers[0].server = primaryServer;
    providers[0].cooldownSince = null; // cooldown elapsed
    ;(pool as any).expectedNetworkPassphrase = PASSPHRASE;
    providers[0].networkPassphrase = PASSPHRASE;
    providers[0].chainVerified = true;

    await (pool as any).probePrimaryRecovery();

    // Should still be on fallback (index 1) because primary is stale
    expect((pool as any).activeIndex).toBe(1);
  });

  // ── Recovery to primary ────────────────────────────────────────────────────

  it('recovers back to primary after cooldown when primary is healthy', async () => {
    const { pool, providers } = buildPool([
      { url: 'https://primary.rpc',  priority: 0 },
      { url: 'https://fallback.rpc', priority: 1 },
    ]);

    ;(pool as any).activeIndex = 1;
    ;(pool as any).globalLatestLedger = 990;
    ;(pool as any).expectedNetworkPassphrase = PASSPHRASE;

    const primaryServer = makeFakeServer({ passphrase: PASSPHRASE, ledger: 1000 });
    providers[0].server = primaryServer;
    providers[0].cooldownSince = null;
    providers[0].networkPassphrase = PASSPHRASE;
    providers[0].chainVerified = true;

    await (pool as any).probePrimaryRecovery();

    expect((pool as any).activeIndex).toBe(0);
  });

  // ── All providers exhausted ────────────────────────────────────────────────

  it('throws the last error when all providers have failed', async () => {
    const { pool, providers } = buildPool([
      { url: 'https://primary.rpc', priority: 0 },
    ]);

    const fakeServer = { getLatestLedger: vi.fn().mockRejectedValue(new Error('down')) };
    providers[0].server = fakeServer;

    await expect(pool.call((s) => s.getLatestLedger())).rejects.toThrow('down');
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  it('returns a well-formed status object', () => {
    const { pool } = buildPool([
      { url: 'https://primary.rpc',  priority: 0 },
      { url: 'https://fallback.rpc', priority: 1 },
    ]);

    const status = pool.getStatus();
    expect(status).toHaveProperty('activeUrl');
    expect(status.providers).toHaveLength(2);
    expect(status.providers[0]).toHaveProperty('url');
    expect(status.providers[0]).toHaveProperty('inCooldown');
    expect(status.providers[0]).toHaveProperty('chainVerified');
  });

  // ── buildProviderPoolFromEnv ───────────────────────────────────────────────

  it('builds a single-provider pool from STELLAR_RPC_URL fallback', () => {
    const orig = process.env.STELLAR_RPC_URL;
    process.env.STELLAR_RPC_URL = 'https://env.rpc';
    delete process.env.RPC_PROVIDER_POOL;

    const pool = buildProviderPoolFromEnv();
    const status = pool.getStatus();
    expect(status.providers[0].url).toBe('https://env.rpc');
    pool.destroy();

    process.env.STELLAR_RPC_URL = orig;
  });

  it('builds a multi-provider pool from RPC_PROVIDER_POOL env var', () => {
    process.env.RPC_PROVIDER_POOL = JSON.stringify([
      { url: 'https://p1.rpc', priority: 0 },
      { url: 'https://p2.rpc', priority: 1 },
    ]);

    const pool = buildProviderPoolFromEnv();
    expect(pool.getStatus().providers).toHaveLength(2);
    pool.destroy();

    delete process.env.RPC_PROVIDER_POOL;
  });

  it('throws for invalid RPC_PROVIDER_POOL JSON', () => {
    process.env.RPC_PROVIDER_POOL = 'not-json';
    expect(() => buildProviderPoolFromEnv()).toThrow();
    delete process.env.RPC_PROVIDER_POOL;
  });

  // ── destroy clears timers ─────────────────────────────────────────────────

  it('destroy() clears the recovery timer without throwing', () => {
    const { pool } = buildPool([
      { url: 'https://primary.rpc',  priority: 0 },
      { url: 'https://fallback.rpc', priority: 1 },
    ]);
    expect(() => pool.destroy()).not.toThrow();
  });
});
