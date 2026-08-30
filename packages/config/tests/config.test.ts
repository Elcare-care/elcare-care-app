/**
 * Tests for @elcarehub/config
 *
 * Test coverage:
 * - Network configuration validation
 * - Contract ID format validation
 * - Cross-component consistency checks
 * - Error message clarity (no secrets leaked)
 * - Missing variable detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, ValidationError } from '../src/index.js';

// Clean environment before each test
beforeEach(() => {
  // Clear relevant env vars
  delete process.env.STELLAR_NETWORK;
  delete process.env.STELLAR_RPC_URL;
  delete process.env.STELLAR_HORIZON_URL;
  delete process.env.STELLAR_NETWORK_PASSPHRASE;
  delete process.env.MARKETPLACE_CONTRACT_ID;
  delete process.env.LAUNCHPAD_CONTRACT_ID;
  delete process.env.INDEXER_URL;
  delete process.env.OPERATOR_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.PINATA_GATEWAY;
  delete process.env.PINATA_JWT;
});

afterEach(() => {
  // Restore environment
  delete process.env.STELLAR_NETWORK;
  delete process.env.STELLAR_RPC_URL;
  delete process.env.STELLAR_HORIZON_URL;
  delete process.env.STELLAR_NETWORK_PASSPHRASE;
  delete process.env.MARKETPLACE_CONTRACT_ID;
  delete process.env.LAUNCHPAD_CONTRACT_ID;
  delete process.env.INDEXER_URL;
  delete process.env.OPERATOR_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.PINATA_GATEWAY;
  delete process.env.PINATA_JWT;
});

// ── Network configuration tests ───────────────────────────────────────────────

describe('Network Configuration', () => {
  it('accepts valid testnet configuration', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C123456789012345678901234567890123456789012345678901234';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    const config = loadConfig();
    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('accepts valid mainnet configuration', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-public.rpc.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C123456789012345678901234567890123456789012345678901234';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    const config = loadConfig();
    expect(config.network).toBe('mainnet');
    expect(config.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('rejects testnet with wrong network passphrase', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C123456789012345678901234567890123456789012345678901234';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    expect(() => loadConfig()).toThrow(/Network passphrase mismatch/);
  });

  it('rejects invalid RPC URL format', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'not-a-valid-url';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C123456789012345678901234567890123456789012345678901234';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    expect(() => loadConfig()).toThrow(/STELLAR_RPC_URL must be a valid URL/);
  });
});

// ── Contract ID validation tests ──────────────────────────────────────────────

describe('Contract ID Validation', () => {
  it('accepts valid 56-character contract IDs starting with C', () => {
    const validId = 'C' + '1'.repeat(55);
    process.env.MARKETPLACE_CONTRACT_ID = validId;
    process.env.LAUNCHPAD_CONTRACT_ID = 'C' + '2'.repeat(55);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    const config = loadConfig();
    expect(config.marketplaceContractId).toBe(validId);
    expect(config.launchpadContractId).toBe('C' + '2'.repeat(55));
  });

  it('rejects contract IDs not starting with C', () => {
    process.env.MARKETPLACE_CONTRACT_ID = 'X' + '1'.repeat(55);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    expect(() => loadConfig()).toThrow(/must start with "C"/);
  });

  it('rejects contract IDs with wrong length', () => {
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(50);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    expect(() => loadConfig()).toThrow(/must be exactly 56 characters/);
  });
});

// ── Operator token validation tests ───────────────────────────────────────────

describe('Operator Token Validation', () => {
  it('rejects short operator tokens', () => {
    process.env.OPERATOR_TOKEN = 'short';
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(55);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    expect(() => loadConfig()).toThrow(/OPERATOR_TOKEN must be at least 32 characters/);
  });

  it('accepts 32-character operator tokens', () => {
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(55);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    const config = loadConfig();
    expect(config.operatorToken).toBe('a'.repeat(32));
  });
});

// ── Cross-component consistency tests ─────────────────────────────────────────

describe('Cross-Component Consistency', () => {
  it('logs redacted diagnostics without leaking secrets', () => {
    // Capture console.log output
    const logSpy = vi.spyOn(console, 'log');
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C123456789012345678901234567890123456789012345678901234';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    loadConfig();

    // Check that logs contain redacted information
    const logs = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logs).toMatch(/Network: testnet/);
    expect(logs).toMatch(/RPC: soroban-testnet.stellar.org/);
    expect(logs).toMatch(/Indexer URL: localhost/);
    expect(logs).toMatch(/Marketplace Contract: C1234567\.\.\./);
    expect(logs).not.toMatch(/pass/); // No password leak
    expect(logs).not.toMatch(/a{32}/); // No token leak
  });

  it('warns about localhost indexer URL in production context', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(55);
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    loadConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('INDEXER_URL points to localhost'),
    );
  });
});

// ── Error message clarity tests ───────────────────────────────────────────────

describe('Error Message Clarity', () => {
  it('provides specific error for missing STELLAR_NETWORK', () => {
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(55);
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    expect(() => loadConfig()).toThrow(/STELLAR_NETWORK must be "testnet" or "mainnet"/);
  });

  it('aggregates multiple errors in one message', () => {
    process.env.STELLAR_NETWORK = 'invalid-network';
    process.env.STELLAR_RPC_URL = 'not-a-url';
    process.env.MARKETPLACE_CONTRACT_ID = 'invalid';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    expect(() => loadConfig()).toThrow(ValidationError);
    const error = () => loadConfig();
    expect(error).toThrow(/Invalid network configuration/);
    expect(error).toThrow(/Invalid contract configuration/);
  });
});

// ── Optional fields tests ─────────────────────────────────────────────────────

describe('Optional Fields', () => {
  it('accepts missing LAUNCHPAD_CONTRACT_ID', () => {
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(55);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';

    const config = loadConfig();
    expect(config.launchpadContractId).toBeUndefined();
  });

  it('accepts missing PINATA_JWT (development mode)', () => {
    process.env.MARKETPLACE_CONTRACT_ID = 'C' + '1'.repeat(55);
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.INDEXER_URL = 'http://localhost:4000';
    process.env.OPERATOR_TOKEN = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PINATA_GATEWAY = 'https://gateway.pinata.cloud';
    delete process.env.PINATA_JWT;

    const config = loadConfig();
    expect(config.pinataJwt).toBeUndefined();
  });
});
