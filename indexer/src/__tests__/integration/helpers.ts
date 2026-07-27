import redisClient from '../../redis.js';

type RedisClient = typeof redisClient;

let cached: RedisClient | undefined;

export async function waitForRedisReady(): Promise<RedisClient> {
  if (cached) return cached;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = redisClient as unknown as { isReady?: boolean };
    if (client.isReady) {
      cached = redisClient;
      return redisClient;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Redis did not become ready for integration tests');
}
