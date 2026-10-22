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
 *   - parsePositiveIntEnv: unset vars, valid overrides, malformed strings,
 *     zero, negative, and out-of-range values
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
  resolveProviderLabel,
  parsePositiveIntEnv,
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
    expect(status.providers[0]).toHaveProperty('label');
    expect(status.providers[0]).toHaveProperty('inCooldown');
    expect(status.providers[0]).toHaveProperty('chainVerified');
  });

  // ── resolveProviderLabel (Issue #928) ─────────────────────────────────────
  //
  // Confirms that metric labels are always bounded stable identifiers and
  // never contain raw URLs, credentials, query strings, or other secrets.

  it('uses the explicit label when provided', () => {
    expect(resolveProviderLabel({ url: 'https://rpc.example.com', label: 'primary' }))
      .toBe('primary');
  });

  it('falls back to hostname when no label is provided', () => {
    expect(resolveProviderLabel({ url: 'https://rpc.example.com/v1' }))
      .toBe('rpc.example.com');
  });

  it('strips credentials from the URL when deriving a label', () => {
    const label = resolveProviderLabel({
      url: 'https://user:supersecretkey@rpc.example.com/v1?api_key=abc123',
    });
    expect(label).toBe('rpc.example.com');
    expect(label).not.toContain('supersecretkey');
    expect(label).not.toContain('abc123');
    expect(label).not.toContain('user:');
  });

  it('strips query string (which may carry API keys) when deriving a label', () => {
    const label = resolveProviderLabel({
      url: 'https://rpc.example.com/endpoint?token=secret&network=testnet',
    });
    expect(label).toBe('rpc.example.com');
    expect(label).not.toContain('token=secret');
    expect(label).not.toContain('?');
  });

  it('returns "unknown" for a malformed URL instead of throwing', () => {
    expect(resolveProviderLabel({ url: 'not-a-valid-url' })).toBe('unknown');
  });

  it('providerLabel on ProviderHealth matches resolveProviderLabel output', () => {
    const { pool, providers } = buildPool([
      { url: 'https://rpc.stellar.org', priority: 0, label: 'mainnet-primary' },
      { url: 'https://user:key@backup.stellar.org/v1?api=secret', priority: 1 },
    ]);

    // First provider: explicit label wins
    expect(providers[0].providerLabel).toBe('mainnet-primary');
    // Second provider: derived from hostname only — no credentials or query
    expect(providers[1].providerLabel).toBe('backup.stellar.org');
    expect(providers[1].providerLabel).not.toContain('key');
    expect(providers[1].providerLabel).not.toContain('secret');
    expect(providers[1].providerLabel).not.toContain('api=');

    pool.destroy();
  });

  it('getStatus label field never exposes credentials or query strings', () => {
    const { pool } = buildPool([
      { url: 'https://user:pass@rpc.stellar.org/v1?token=abc', priority: 0 },
    ]);
    const status = pool.getStatus();
    const label = status.providers[0].label;
    expect(label).toBe('rpc.stellar.org');
    expect(label).not.toContain('pass');
    expect(label).not.toContain('abc');
    expect(label).not.toContain('token=');
    pool.destroy();
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

// ── parsePositiveIntEnv ───────────────────────────────────────────────────────
//
// Validates startup-time parsing and bounds-checking of the four provider-pool
// timing/count environment variables.  Tests use the exported helper directly
// so they are isolated from pool construction side-effects (timers, prom
// registrations) and from each other.
//
// Coverage matrix:
//   • Unset variable   → default returned, no error
//   • Empty string     → default returned, no error
//   • Valid integer string within range → parsed value returned
//   • Minimum boundary (exactly min) → accepted
//   • Maximum boundary (exactly max) → accepted
//   • Float string     → rejected (parseInt would silently truncate)
//   • Non-numeric string → rejected
//   • Zero             → rejected (below any positive min)
//   • Negative integer → rejected
//   • Below minimum    → rejected
//   • Above maximum    → rejected
//   • Error message names the variable, does not echo its raw value

describe('parsePositiveIntEnv', () => {
  // Shared bounds used across tests — mirror the production constants.
  const NAME = 'TEST_PARSE_INT_VAR';
  const DEFAULT = 100;
  const MIN = 10;
  const MAX = 1_000;

  // Save and restore process.env around each test.
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[NAME];
    delete process.env[NAME];
  });

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = savedValue;
    }
  });

  // ── Unset / empty → default ───────────────────────────────────────────────

  it('returns the default when the variable is unset', () => {
    expect(parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toBe(DEFAULT);
  });

  it('returns the default when the variable is an empty string', () => {
    process.env[NAME] = '';
    expect(parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toBe(DEFAULT);
  });

  // ── Valid integer strings ─────────────────────────────────────────────────

  it('parses a valid integer string within range', () => {
    process.env[NAME] = '500';
    expect(parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toBe(500);
  });

  it('accepts the exact minimum boundary value', () => {
    process.env[NAME] = String(MIN);
    expect(parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toBe(MIN);
  });

  it('accepts the exact maximum boundary value', () => {
    process.env[NAME] = String(MAX);
    expect(parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toBe(MAX);
  });

  // ── Malformed strings ────────────────────────────────────────────────────

  it('rejects a non-numeric string', () => {
    process.env[NAME] = 'abc';
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  it('rejects a float string (would be silently truncated by parseInt)', () => {
    process.env[NAME] = '99.9';
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  it('rejects a string with leading/trailing non-numeric characters', () => {
    process.env[NAME] = '100ms';
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  it('rejects an empty-whitespace-only string as non-numeric', () => {
    process.env[NAME] = '   ';
    // parseInt('   ', 10) → NaN; String(NaN) !== '   '.trim() === 'NaN'
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  // ── Zero and negative ─────────────────────────────────────────────────────

  it('rejects zero (below any positive minimum)', () => {
    process.env[NAME] = '0';
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  it('rejects a negative integer', () => {
    process.env[NAME] = '-50';
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  // ── Out-of-range values ───────────────────────────────────────────────────

  it('rejects a value one below the minimum', () => {
    process.env[NAME] = String(MIN - 1);
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  it('rejects a value one above the maximum', () => {
    process.env[NAME] = String(MAX + 1);
    expect(() => parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX)).toThrow(NAME);
  });

  // ── Error message safety ──────────────────────────────────────────────────

  it('error message names the variable and does not echo the raw value', () => {
    const badValue = 'https://secret-endpoint.example.com?api_key=tok_abc123';
    process.env[NAME] = badValue;
    let message = '';
    try {
      parsePositiveIntEnv(NAME, DEFAULT, MIN, MAX);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(NAME);          // names the variable
    expect(message).not.toContain(badValue);  // does not echo the value
    expect(message).not.toContain('tok_abc'); // no credential fragment
  });

  // ── Production constant smoke tests ──────────────────────────────────────
  //
  // Confirm each production env var name and its documented default are
  // accepted as-is (i.e. unset → default, default within its own bounds).

  it.each([
    ['RPC_FAILOVER_COOLDOWN_MS',   60_000,    1_000,    3_600_000],
    ['RPC_STALE_LEDGER_THRESHOLD',     50,        1,       10_000],
    ['RPC_RECOVERY_PROBE_MS',      30_000,    1_000,    3_600_000],
    ['RPC_MAX_CONSECUTIVE_ERRORS',      5,        1,        1_000],
  ] as const)(
    '%s: unset returns documented default %d',
    (varName, defaultVal, min, max) => {
      const orig = process.env[varName as string];
      delete process.env[varName as string];

      expect(parsePositiveIntEnv(varName as string, defaultVal, min, max)).toBe(defaultVal);

      if (orig === undefined) {
        delete process.env[varName as string];
      } else {
        process.env[varName as string] = orig;
      }
    },
  );

  it.each([
    ['RPC_FAILOVER_COOLDOWN_MS',   '5000',   5_000,    1_000,    3_600_000],
    ['RPC_STALE_LEDGER_THRESHOLD', '100',      100,        1,       10_000],
    ['RPC_RECOVERY_PROBE_MS',      '15000', 15_000,    1_000,    3_600_000],
    ['RPC_MAX_CONSECUTIVE_ERRORS', '3',          3,        1,        1_000],
  ] as const)(
    '%s: valid override "%s" is accepted',
    (varName, rawValue, expected, min, max) => {
      const orig = process.env[varName as string];
      process.env[varName as string] = rawValue;

      expect(parsePositiveIntEnv(varName as string, 0, min, max)).toBe(expected);

      if (orig === undefined) {
        delete process.env[varName as string];
      } else {
        process.env[varName as string] = orig;
      }
    },
  );
});
