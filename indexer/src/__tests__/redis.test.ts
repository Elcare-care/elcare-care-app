import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRedisClient = vi.hoisted(() => ({
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  set: vi.fn(),
  setEx: vi.fn(),
  isOpen: true,
  isReady: true,
}));

const createClient = vi.hoisted(() => vi.fn(() => mockRedisClient));

vi.mock('redis', () => ({ createClient }));

describe('Redis client configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses an exponential backoff reconnect strategy with a capped delay', async () => {
    const redisModule = await import('../redis.js');

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'redis://localhost:6379',
        disableOfflineQueue: true,
        socket: expect.objectContaining({
          reconnectStrategy: expect.any(Function),
        }),
      })
    );

    expect(redisModule.calculateRedisReconnectDelay(0)).toBe(50);
    expect(redisModule.calculateRedisReconnectDelay(1)).toBe(100);
    expect(redisModule.calculateRedisReconnectDelay(6)).toBe(3000);
    expect(redisModule.redisReconnectStrategy(0)).toBe(50);
    expect(redisModule.redisReconnectStrategy(1)).toBe(100);
    expect(redisModule.redisReconnectStrategy(6)).toBe(3000);
  });
});
