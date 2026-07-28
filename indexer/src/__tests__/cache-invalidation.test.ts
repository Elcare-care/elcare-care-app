import { describe, expect, it } from 'vitest';
import { buildCacheKey, buildCachePattern, applyInvalidation, invalidateListing, invalidateAuction, invalidateOffer, invalidateCollection, invalidateWalletActivity } from '../cache-invalidation';

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
  it('calls invalidatePattern for each derived pattern', async () => {
    const patterns: string[] = [];
    const original = global.fetch;
    global.fetch = async () => new Response('{}') as any;
    
    await applyInvalidation({ kind: 'listing', id: '123', wallet: 'W1' });
    
    expect(patterns.length).toBeGreaterThan(0);
  });
});
