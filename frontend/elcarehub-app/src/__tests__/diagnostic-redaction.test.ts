/**
 * Tests for diagnostic payload creation and secret redaction.
 * 
 * These tests verify that diagnostic payloads never leak private keys,
 * seed phrases, session tokens, or API keys.
 */

import { describe, it, expect } from '@jest/globals';
import {
  createSafeDiagnostic,
  redactPrivateKeys,
  redactMagicApiKeys,
  redactBearerTokens,
  redactSensitiveData,
} from '@/lib/diagnostic-redaction';

describe('createSafeDiagnostic', () => {
  it('creates a diagnostic payload with safe fields', () => {
    const payload = createSafeDiagnostic({
      txHash: 'abc123def456',
      publicAddress: 'GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX',
      walletType: 'Freighter',
      errorCode: 'Contract#23',
      errorMessage: 'Insufficient token balance',
      requestId: 'req_1234567890',
      route: '/checkout',
    });

    expect(payload.type).toBe('transaction_failure');
    expect(payload.txHash).toBe('abc123def456');
    expect(payload.publicAddress).toBe('GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX');
    expect(payload.walletType).toBe('Freighter');
    expect(payload.errorCode).toBe('Contract#23');
    expect(payload.errorMessage).toBe('Insufficient token balance');
    expect(payload.requestId).toBe('req_1234567890');
    expect(payload.route).toBe('/checkout');
    expect(payload.network).toBeDefined();
    expect(payload.timestamp).toBeDefined();
  });

  it('does not include private keys in serialized payload', () => {
    const payload = createSafeDiagnostic({
      txHash: 'abc123',
      publicAddress: 'GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX',
      walletType: 'Freighter',
      errorCode: 'Contract#23',
      errorMessage: 'Insufficient balance',
      requestId: 'req_123',
    });

    const serialized = JSON.stringify(payload);

    // Stellar private key format: S followed by 55 base32 characters
    expect(serialized).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });

  it('does not include Magic.link API keys in serialized payload', () => {
    const payload = createSafeDiagnostic({
      txHash: 'abc123',
      publicAddress: 'GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX',
      walletType: 'Magic.link',
      errorCode: 'wallet_connection_failed',
    });

    const serialized = JSON.stringify(payload);

    // Magic.link key format: pk_live_ or pk_test_ followed by alphanumeric
    expect(serialized).not.toMatch(/pk_live_[a-zA-Z0-9]+/);
    expect(serialized).not.toMatch(/pk_test_[a-zA-Z0-9]+/);
  });

  it('does not include Bearer tokens in serialized payload', () => {
    const payload = createSafeDiagnostic({
      txHash: 'abc123',
      publicAddress: 'GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX',
      errorMessage: 'Authorization failed',
    });

    const serialized = JSON.stringify(payload);

    expect(serialized).not.toMatch(/Bearer\s+[a-zA-Z0-9._-]+/);
  });
});

describe('redactPrivateKeys', () => {
  it('redacts Stellar private keys', () => {
    const input = 'Secret key: SBXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJK';
    const redacted = redactPrivateKeys(input);

    expect(redacted).toBe('Secret key: [REDACTED_PRIVATE_KEY]');
    expect(redacted).not.toContain('SBXYZ');
  });

  it('redacts multiple private keys', () => {
    const input = 'Key1: SBXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJK Key2: SB222333444555666777888999AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK';
    const redacted = redactPrivateKeys(input);

    expect(redacted).toBe('Key1: [REDACTED_PRIVATE_KEY] Key2: [REDACTED_PRIVATE_KEY]');
  });

  it('does not redact public keys starting with G', () => {
    const input = 'Public: GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX';
    const redacted = redactPrivateKeys(input);

    expect(redacted).toBe(input); // unchanged
  });

  it('does not redact partial matches', () => {
    const input = 'Not a key: S123'; // too short
    const redacted = redactPrivateKeys(input);

    expect(redacted).toBe(input);
  });
});

describe('redactMagicApiKeys', () => {
  it('redacts Magic.link live API keys', () => {
    const input = 'Magic key: pk_live_ABC123DEF456GHI789';
    const redacted = redactMagicApiKeys(input);

    expect(redacted).toBe('Magic key: [REDACTED_MAGIC_KEY]');
  });

  it('redacts Magic.link test API keys', () => {
    const input = 'Magic key: pk_test_XYZ999UVW888';
    const redacted = redactMagicApiKeys(input);

    expect(redacted).toBe('Magic key: [REDACTED_MAGIC_KEY]');
  });

  it('redacts multiple Magic keys', () => {
    const input = 'Live: pk_live_ABC123 Test: pk_test_XYZ789';
    const redacted = redactMagicApiKeys(input);

    expect(redacted).toBe('Live: [REDACTED_MAGIC_KEY] Test: [REDACTED_MAGIC_KEY]');
  });
});

describe('redactBearerTokens', () => {
  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const redacted = redactBearerTokens(input);

    expect(redacted).toBe('Authorization: Bearer [REDACTED_TOKEN]');
  });

  it('redacts Bearer tokens case-insensitively', () => {
    const input = 'Header: bearer abc123def456';
    const redacted = redactBearerTokens(input);

    expect(redacted).toBe('Header: Bearer [REDACTED_TOKEN]');
  });
});

describe('redactSensitiveData', () => {
  it('applies all redaction rules', () => {
    const input = `
      Private key: SBXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJK
      Magic key: pk_live_ABC123
      Token: Bearer jwt_token_abc123
    `;
    const redacted = redactSensitiveData(input);

    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
    expect(redacted).toContain('[REDACTED_MAGIC_KEY]');
    expect(redacted).toContain('[REDACTED_TOKEN]');
    expect(redacted).not.toContain('SBXYZ');
    expect(redacted).not.toContain('pk_live_ABC123');
    expect(redacted).not.toContain('jwt_token_abc123');
  });

  it('leaves safe data unchanged', () => {
    const input = 'Public address: GBUYER7XVJFCSQFBVWNFJ2LHVOSWGNLR3EMAQHK7KFG6ZQGM5TRSKQHX Tx: abc123';
    const redacted = redactSensitiveData(input);

    expect(redacted).toBe(input);
  });
});
