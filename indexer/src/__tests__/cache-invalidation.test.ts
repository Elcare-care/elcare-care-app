import { describe, expect, it, vi } from 'vitest';
import {
  buildCacheKey,
  buildCachePattern,
  applyInvalidation,
  invalidateListing,
  invalidateAuction,
  invalidateOffer,
  invalidateCollection,
  invalidateWalletActivity,
} from '../cache-invalidation';

// Mock redis so invalidatePattern doesn't require a live connection.
vi.mock('../redis.js', () => ({
  default: {
    isReady: false,
    get: vi.fn(),
    on: vi.fn(),
    connect: vi.fn(),
  },
  invalidateKey: vi.fn().mockResolvedValue(undefined),
  invalidatePattern: vi.fn().mockResolvedValue(undefined),
}));

describe('buildCacheKey', () => {
  it('builds listing key with id', () => {
    expect(buildCacheKey({ kind: 'listing', id: '123' })).toBe('cache:listing:123');
  });

  it('builds wallet activity key', () => {
    expect(buildCacheKey({ kind: 'activity', wallet: 'G...' })).toBe('cache:activity:wallet:G...');
  });
});

describe('buildCachePattern', () => {
  it('builds wildcard pattern for resource type', () => {
    expect(buildCachePattern({ kind: 'listing' })).toBe('cache:listing:*');
  });

  it('builds id-prefixed pattern', () => {
    expect(buildCachePattern({ kind: 'listing', id: '123' })).toBe('cache:listing:123*');
  });
});

describe('applyInvalidation', () => {
  it('resolves without error for a listing event', async () => {
    await expect(
      applyInvalidation({ kind: 'listing', id: '123', wallet: 'W1' }),
    ).resolves.toBeUndefined();
  });

  it('resolves without error for an auction event', async () => {
    await expect(
      applyInvalidation({ kind: 'auction', id: '7' }),
    ).resolves.toBeUndefined();
  });

  it('resolves without error for a stats event', async () => {
    await expect(applyInvalidation({ kind: 'stats' })).resolves.toBeUndefined();
  });
});

describe('domain helpers', () => {
  it('invalidateListing resolves', async () => {
    await expect(invalidateListing('1', 'GARTIST')).resolves.toBeUndefined();
  });

  it('invalidateAuction resolves', async () => {
    await expect(invalidateAuction('2')).resolves.toBeUndefined();
  });

  it('invalidateOffer resolves', async () => {
    await expect(invalidateOffer('3', 'GOFFERER')).resolves.toBeUndefined();
  });

  it('invalidateCollection resolves', async () => {
    await expect(invalidateCollection('CA')).resolves.toBeUndefined();
  });

  it('invalidateWalletActivity resolves', async () => {
    await expect(invalidateWalletActivity('GWALLET')).resolves.toBeUndefined();
  });
});
