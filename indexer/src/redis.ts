import { createClient } from 'redis';
import { logger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_RECONNECT_BASE_DELAY_MS = 50;
const REDIS_RECONNECT_MAX_DELAY_MS = 3000;
const REDIS_RECONNECT_JITTER_MS = 100;

export function calculateRedisReconnectDelay(retries: number, jitterMs = 0) {
    // Cap the exponent so the intermediate value never overflows to Infinity.
    const exponentialBackoff = REDIS_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(retries, 20));
    return Math.min(exponentialBackoff + jitterMs, REDIS_RECONNECT_MAX_DELAY_MS);
}

export function redisReconnectStrategy(retries: number) {
    const jitter = Math.floor(Math.random() * REDIS_RECONNECT_JITTER_MS);
    return calculateRedisReconnectDelay(retries, jitter);
}

const redis = createClient({
    url: REDIS_URL,
    disableOfflineQueue: true,
    socket: {
        reconnectStrategy: redisReconnectStrategy,
    },
});

redis.on('error', (err) => {
    logger.warn({ err, component: 'redis' }, 'Redis connection error — caching disabled');
});

redis.connect().catch((err) => {
    logger.warn({ err, component: 'redis' }, 'Redis initial connect failed — caching disabled');
});

// ── Cache invalidation helpers ────────────────────────────────────────────────

function isClientReady(client: any): boolean {
    if (typeof client.isReady === 'boolean') return client.isReady;
    if (typeof client.status === 'string') return client.status === 'ready';
    return Boolean(client.isOpen);
}

/**
 * Delete a single cache key by exact name.
 * No-op if Redis is not connected.
 */
export async function invalidateKey(key: string): Promise<void> {
    if (!isClientReady(redis as any)) return;
    try {
        await (redis as any).del(key);
    } catch (err) {
        logger.warn({ err, key, component: 'redis' }, 'Redis invalidateKey failed');
    }
}

/**
 * Delete all cache keys matching a glob pattern via SCAN + DEL.
 * Uses SCAN to avoid blocking the Redis server on large key spaces.
 * No-op if Redis is not connected.
 */
export async function invalidatePattern(pattern: string): Promise<void> {
    const client = redis as any;
    if (!isClientReady(client)) return;
    try {
        let cursor = 0;
        do {
            const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
            cursor = reply.cursor;
            if (reply.keys.length > 0) {
                await client.del(reply.keys);
            }
        } while (cursor !== 0);
    } catch (err) {
        logger.warn({ err, pattern, component: 'redis' }, 'Redis invalidatePattern failed');
    }
}

export default redis;
