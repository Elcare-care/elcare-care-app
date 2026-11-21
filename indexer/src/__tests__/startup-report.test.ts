/**
 * startup-report.test.ts — Issue #1067.
 *
 * Verifies the non-secret startup configuration report:
 *   - reports names + safe values for network, contracts, RPC, DB, Redis, poll settings
 *   - never contains credentials, URL paths/queries, or secret values
 *   - flags testnet/mainnet misconfigurations (fixtures in helpers/startup-env-fixtures.ts)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildStartupConfigReport, logStartupConfigReport, toSafeEndpoint } from '../startup-report';
import { validateRequiredEnv } from '../config';
import { logger } from '../logger';
import {
  LEAK_SENTINELS,
  VALID_TESTNET_ENV,
  VALID_MAINNET_ENV,
  MISCONFIGURED_ENVS,
} from './helpers/startup-env-fixtures';

function expectNoLeaks(value: unknown) {
  const text = JSON.stringify(value);
  for (const sentinel of LEAK_SENTINELS) {
    expect(text).not.toContain(sentinel);
  }
}

describe('toSafeEndpoint', () => {
  it('keeps scheme/host/port and drops userinfo, path, query and fragment', () => {
    expect(toSafeEndpoint('postgresql://u:p@db.example:5432/app?sslmode=require#x')).toEqual({
      scheme: 'postgresql:',
      host: 'db.example',
      port: '5432',
      invalid: false,
    });
  });

  it('returns null for absent values and flags unparseable ones', () => {
    expect(toSafeEndpoint(undefined)).toBeNull();
    expect(toSafeEndpoint('')).toBeNull();
    expect(toSafeEndpoint('nope')).toEqual({ scheme: null, host: null, port: null, invalid: true });
  });
});

describe('buildStartupConfigReport — healthy environments', () => {
  it('testnet: reports every setting by name with safe values and no warnings', () => {
    const r = buildStartupConfigReport(VALID_TESTNET_ENV);

    expect(r.network).toBe('testnet');
    expect(r.networkPassphrase).toBe('testnet');
    expect(r.rpc).toMatchObject({ scheme: 'https:', host: 'soroban-testnet.stellar.org' });
    expect(r.horizon?.host).toBe('horizon-testnet.stellar.org');
    expect(r.database).toMatchObject({ host: 'localhost', port: '5432', name: 'marketplace' });
    expect(r.redis).toMatchObject({ host: 'localhost', port: '6379', db: '0' });
    expect(r.contractSource).toBe('MARKETPLACE_CONTRACT_ID/LAUNCHPAD_CONTRACT_ID');
    expect(r.contracts.map((c) => c.type)).toEqual(['marketplace', 'launchpad']);
    expect(r.poll).toEqual({ pollIntervalMs: 5000, maxLedgersPerCycle: 1000, confirmationDepth: 10 });
    expect(r.credentialsSet).toContain('OPERATOR_TOKEN');
    expect(r.credentialsUnset).toContain('KEEPER_SECRET');
    expect(r.warnings).toEqual([]);
    expectNoLeaks(r);
  });

  it('mainnet: drops RPC path/query keys and DB/Redis credentials, no warnings', () => {
    const r = buildStartupConfigReport(VALID_MAINNET_ENV);

    expect(r.network).toBe('mainnet');
    expect(r.networkPassphrase).toBe('mainnet');
    expect(r.rpc).toEqual({ scheme: 'https:', host: 'rpc.mainnet.example.net', port: null, invalid: false });
    expect(r.database).toMatchObject({ host: 'db.internal.example', name: 'marketplace_prod' });
    expect(r.redis).toMatchObject({ host: 'cache.internal.example', port: '6380', db: '2' });
    expect(r.poll?.pollIntervalMs).toBe(3000);
    expect(r.warnings).toEqual([]);
    expectNoLeaks(r);
  });

  it('valid testnet and mainnet fixtures pass fatal validation', () => {
    const original = process.env;
    try {
      for (const env of [VALID_TESTNET_ENV, VALID_MAINNET_ENV]) {
        process.env = { ...env };
        expect(() => validateRequiredEnv()).not.toThrow();
      }
    } finally {
      process.env = original;
    }
  });
});

describe('buildStartupConfigReport — testnet/mainnet misconfiguration fixtures', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  for (const fixture of MISCONFIGURED_ENVS) {
    it(`${fixture.name} → ${fixture.expectWarning}`, () => {
      const r = buildStartupConfigReport(fixture.env);
      expect(r.warnings.map((w) => w.code)).toContain(fixture.expectWarning);
      expectNoLeaks(r);
    });

    if (fixture.fatal) {
      it(`${fixture.name} is rejected by validateRequiredEnv without leaking secrets`, () => {
        process.env = { ...fixture.env };
        let caught: Error | null = null;
        try {
          validateRequiredEnv();
        } catch (e) {
          caught = e as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toMatch(fixture.fatal!);
        expectNoLeaks(caught!.message);
      });
    }
  }

  it('never throws, even for a completely empty environment', () => {
    expect(() => buildStartupConfigReport({})).not.toThrow();
    const r = buildStartupConfigReport({});
    expect(r.network).toBeNull();
    expect(r.contractSource).toBe('none');
    expect(r.warnings.map((w) => w.code)).toContain('NO_TRACKED_CONTRACTS');
  });
});

describe('logStartupConfigReport', () => {
  it('logs one info line and one warn line per warning, without secrets', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as any);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);
    try {
      const fixture = MISCONFIGURED_ENVS.find((f) => f.expectWarning === 'RPC_NETWORK_MISMATCH')!;
      const report = buildStartupConfigReport(fixture.env);
      logStartupConfigReport(report);

      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toBe('[startup] configuration report');
      expect(warn).toHaveBeenCalledTimes(report.warnings.length);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('RPC_NETWORK_MISMATCH'))).toBe(true);
      expectNoLeaks([...info.mock.calls, ...warn.mock.calls]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
